import { PublicKey } from '@solana/web3.js'
import { isMintAddress } from './route-params.mjs'
import { formatUnits } from './format.mjs'
import { readLimitedText } from './csp-report.mjs'
import { publicError } from './public-error.mjs'
import { SITE_ORIGIN, blinkApiPath } from './blink-links.mjs'

// Solana Actions spec v2.4 (github.com/solana-developers/solana-actions). Hand-rolled: the @solana/actions
// helpers add an identity memo we do not want next to a canonically-proven swap, and the rest is plain JSON.
export const ACTION_VERSION = '2.4'
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const BUY_PRESETS = Object.freeze(['0.1', '0.5', '1'])
export const MAX_BUY_LAMPORTS = 50_000_000_000n
const MAX_BODY_BYTES = 4096
const LAMPORTS_PER_SOL = 1_000_000_000n
// Only app-authored trader/preflight messages reach Blink clients; RPC and DB errors are logged and replaced.
const SAFE = /^(Trading is not configured|Repository has no indexed|Canonical|Input amount|No executable output|You need approximately|Trade simulation|Trade transaction|Network cost estimate|Account setup estimate|Fixed DBC)/

// Allow-origin * is scoped to actions.json and /api/actions only (spec requirement for cross-origin Blink clients).
export const ACTION_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids',
  'Access-Control-Expose-Headers': 'X-Action-Version, X-Blockchain-Ids',
  'Content-Type': 'application/json',
  'X-Action-Version': ACTION_VERSION,
  'X-Blockchain-Ids': SOLANA_MAINNET,
})

// Maps shared market pages to the buy action; the second rule makes the API URLs themselves unfurl too.
export const ACTIONS_JSON = Object.freeze({ rules: [
  { pathPattern: '/token/*', apiPath: '/api/actions/buy/*' },
  { pathPattern: '/api/actions/**', apiPath: '/api/actions/**' },
] })

export class ActionError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

export const actionJson = (body, { status = 200, cache = 'no-store' } = {}) =>
  Response.json(body, { status, headers: { ...ACTION_HEADERS, 'Cache-Control': cache } })
export const actionOptions = () => new Response(null, { status: 204, headers: { ...ACTION_HEADERS, 'Cache-Control': 'public, max-age=86400' } })
const actionError = (message, status) => actionJson({ message }, { status })

// Decimal SOL -> lamports, exact (no floats). Positive, at most 9 decimals, capped so a typo cannot drain a wallet.
export function parseBuyAmount(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^(?:\d{1,6}(?:\.\d{0,9})?|\.\d{1,9})$/.test(text)) throw new ActionError('Enter a SOL amount like 0.5 (up to 9 decimals)')
  const [whole, fraction = ''] = text.split('.')
  const lamports = BigInt(whole || '0') * LAMPORTS_PER_SOL + BigInt(fraction.padEnd(9, '0'))
  if (lamports <= 0n) throw new ActionError('Amount must be greater than 0 SOL')
  if (lamports > MAX_BUY_LAMPORTS) throw new ActionError(`Amount must be at most ${formatUnits(MAX_BUY_LAMPORTS)} SOL`)
  return lamports
}

// A fee payer must be able to sign, so off-curve (PDA) addresses are rejected as well as malformed ones.
export function parseAccount(value) {
  let key
  try { key = typeof value === 'string' && value.length <= 44 ? new PublicKey(value) : null } catch { key = null }
  if (!key || key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw new ActionError('Invalid account: expected a Solana wallet address')
  return key
}

function parseMint(value) {
  if (!isMintAddress(value)) throw new ActionError('Invalid token mint', 400)
  try { return new PublicKey(value).toBase58() } catch { throw new ActionError('Invalid token mint', 400) }
}

async function resolveMarket(mint, loadMarket) {
  let market
  try { market = await loadMarket(mint) }
  catch (error) { throw new ActionError(publicError(error, () => false, 'Market lookup is temporarily unavailable', 'action market'), 503) }
  if (!market) throw new ActionError('No indexed repo.ing market for this token', 404)
  return market
}

const respondError = (error, context) => error instanceof ActionError
  ? actionError(error.message, error.status)
  : actionError(publicError(error, SAFE, 'Could not prepare this buy. Try again shortly.', context), SAFE.test(error?.message ?? '') ? 400 : 500)

export function buyAction(market, { tradingEnabled = true } = {}) {
  const href = blinkApiPath(market.mint)
  const repo = market.fullName || `repository ${market.repoId}`
  return {
    type: 'action',
    icon: `${SITE_ORIGIN}/api/token-image/${market.mint}`,
    title: `$${market.symbol} · ${repo}`,
    description: `${(market.description || `Open source market for ${repo}.`).slice(0, 180)} Every trade pays the builders. Buys use the canonical repo.ing pool with 1% max slippage.`,
    label: 'Buy',
    ...(tradingEnabled ? {} : { disabled: true, error: { message: 'Trading is temporarily unavailable' } }),
    links: { actions: [
      ...BUY_PRESETS.map(amount => ({ type: 'transaction', label: `Buy ${amount} SOL`, href: `${href}?amount=${amount}` })),
      { type: 'transaction', label: 'Buy', href: `${href}?amount={amount}`, parameters: [
        { type: 'number', name: 'amount', label: 'SOL amount', required: true, min: 0.000000001, max: Number(MAX_BUY_LAMPORTS / LAMPORTS_PER_SOL) },
      ] },
    ] },
  }
}

export async function handleBuyGet(rawMint, { loadMarket, tradingEnabled = () => true }) {
  try {
    const market = await resolveMarket(parseMint(rawMint), loadMarket)
    return actionJson(buyAction(market, { tradingEnabled: tradingEnabled() }), { cache: 'public, max-age=60' })
  } catch (error) { return respondError(error, 'action get') }
}

// Builds the unsigned buy through the same canonical trader as the site; nothing is signed or sent here.
export async function handleBuyPost(request, rawMint, { loadMarket, prepareBuy }) {
  try {
    const mint = parseMint(rawMint)
    const lamports = parseBuyAmount(new URL(request.url).searchParams.get('amount'))
    const text = await readLimitedText(request, MAX_BODY_BYTES)
    if (text === null) throw new ActionError('Request body is too large', 413)
    let body
    try { body = JSON.parse(text) } catch { throw new ActionError('Request body must be JSON with an account') }
    const account = parseAccount(body?.account)
    const market = await resolveMarket(mint, loadMarket)
    const prepared = await prepareBuy({ githubRepoId: market.repoId, wallet: account.toBase58(), amountLamports: lamports.toString() })
    if (prepared.mint !== market.mint || prepared.direction !== 'buy' || prepared.amountIn !== lamports ||
        !prepared.transaction.feePayer?.equals(account)) throw new Error('Prepared action trade does not match the request')
    const transaction = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
    const sol = formatUnits(lamports)
    return actionJson({ type: 'transaction', transaction,
      message: `Buying $${market.symbol} with ${sol} SOL · at least ${formatUnits(prepared.minimumAmountOut, 6)} $${market.symbol} (1% max slippage).`,
      links: { next: { type: 'inline', action: { type: 'completed', icon: `${SITE_ORIGIN}/api/token-image/${market.mint}`,
        title: `$${market.symbol} bought`, label: 'Done',
        description: `Your ${sol} SOL buy is confirmed on Solana. See the market at ${SITE_ORIGIN}/token/${market.mint}` } } } })
  } catch (error) { return respondError(error, 'action post') }
}

// Canonical, finalized markets only: the same gate the traders apply before quoting.
export async function loadActionMarket(pool, mint) {
  if (!pool) throw new ActionError('Market lookup is temporarily unavailable', 503)
  const { rows: [row] } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.token_symbol as symbol,
      r.full_name as "fullName", r.description
    from markets m left join repositories r on r.github_repo_id = m.github_repo_id
    where m.mint = $1 and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'`, [mint])
  return row ?? null
}
