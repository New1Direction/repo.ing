import { PublicKey } from '@solana/web3.js'
import { isMintAddress } from './route-params.mjs'
import { formatUnits } from './format.mjs'
import { readLimitedText } from './csp-report.mjs'
import { publicError } from './public-error.mjs'
import { SITE_ORIGIN, blinkApiPath, sellApiPath } from './blink-links.mjs'
import { launchFeeNotice } from '../../src/launch-fee-copy.mjs'
import { parseReferrer } from '../../src/referral.mjs'
import { EARLY_ACCESS_NOT_TRADABLE, isEarlyAccessMarket, tradingEarlyAccessConfig } from '../../src/early-access.mjs'
import { earlyAccessNotice } from './early-access-display.mjs'
import { HF_DISCLAIMER_SHORT, isModelMarket } from './hf-model-display.mjs'
import { DECLINED_TRADING, declinedLabel, declinedSummary } from './declined-display.mjs'

// Solana Actions spec v2.4 (github.com/solana-developers/solana-actions). Hand-rolled: the @solana/actions
// helpers add an identity memo we do not want next to a canonically-proven swap, and the rest is plain JSON.
// Buys and sells use the site's canonical trader at its default 1% slippage.
export const ACTION_VERSION = '2.4'
export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const BUY_PRESETS = Object.freeze(['0.1', '0.5', '1'])
export const SELL_PERCENTS = Object.freeze([25, 50, 100])
export const MAX_BUY_LAMPORTS = 50_000_000_000n
const MAX_BODY_BYTES = 4096
const LAMPORTS_PER_SOL = 1_000_000_000n
// Only app-authored trader/preflight messages reach Blink clients; RPC and DB errors are logged and replaced.
const SAFE = /^(Contributor early access|Trading is not configured|Repository has no indexed|Canonical|Input amount|No executable output|You need approximately|Trade simulation|Trade transaction|Network cost estimate|Account setup estimate|Fixed DBC)/

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

// Blinks are worded and sized in SOL ("Buy 0.1 SOL"); a stock-paired market (docs/STOCK_QUOTES.md) is never offered through them.
export const STOCK_PAIR_ACTIONS_UNAVAILABLE = 'Blink trades are available for SOL markets only. Trade this market on repo.ing.'

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

export function parseSellPercent(value) {
  const percent = SELL_PERCENTS.find(option => String(option) === value)
  if (!percent) throw new ActionError('Choose to sell 25%, 50% or 100% of your balance')
  return percent
}

// The sharer's wallet from a Blink link's ?ref: a canonical on-curve address, anything else ignored (never an error). The
// trader still decides whether it can pay a referral.
export const parseActionReferrer = value => parseReferrer(value)?.toBase58() ?? null
const withRef = (href, ref) => ref ? `${href}${href.includes('?') ? '&' : '?'}ref=${ref}` : href
const referrerArgs = referrer => referrer ? { referrer } : {}
// An early access market's curve trade pays no referral (the curve trader leaves it out), so none is passed until its migration is
// recorded (migrated); its graduated trade then pays it in SOL like any other (src/canonical-damm-trade.mjs, step 7b).
const actionReferrer = (market, referrer) => isEarlyAccessMarket(market) && !market.migrated ? null : referrer

function parseMint(value) {
  if (!isMintAddress(value)) throw new ActionError('Invalid token mint', 400)
  try { return new PublicKey(value).toBase58() } catch { throw new ActionError('Invalid token mint', 400) }
}

// Whether the site's trader takes contributor early access markets (EARLY_ACCESS_DBC_CONFIG set and well formed); the trader logs
// a malformed value itself.
const earlyAccessTradesDefault = () => tradingEarlyAccessConfig(process.env, () => {}) !== null

async function resolveMarket(mint, loadMarket, earlyAccessTrades = earlyAccessTradesDefault) {
  let market
  try { market = await loadMarket(mint) }
  catch (error) { throw new ActionError(publicError(error, () => false, 'Market lookup is temporarily unavailable', 'action market'), 503) }
  if (!market) throw new ActionError('No indexed repo.ing market for this token', 404)
  if (market.quoteMint) throw new ActionError(STOCK_PAIR_ACTIONS_UNAVAILABLE, 404)
  // A contributor early access market (docs/EARLY_ACCESS.md) trades through its transfer hook where the trader takes it.
  if (isEarlyAccessMarket(market) && !earlyAccessTrades()) throw new ActionError(EARLY_ACCESS_NOT_TRADABLE, 404)
  return market
}

const respondError = (error, context) => error instanceof ActionError
  ? actionError(error.message, error.status)
  : actionError(publicError(error, SAFE, 'Could not prepare this trade. Try again shortly.', context), SAFE.test(error?.message ?? '') ? 400 : 500)

const tokenIcon = market => `${SITE_ORIGIN}/api/token-image/${market.mint}`
const repoName = market => market.fullName || `repository ${market.repoId}`
const disabledUnless = tradingEnabled => tradingEnabled ? {} : { disabled: true, error: { message: 'Trading is temporarily unavailable' } }
// ref: the sharer's wallet, carried into every linked buy and sell so the trade can pay it a referral.
const sellLinks = (market, ref) => SELL_PERCENTS.map(percent => ({ type: 'transaction', label: percent === 100 ? 'Sell all' : `Sell ${percent}%`,
  href: withRef(`${sellApiPath(market.mint)}?percent=${percent}`, ref) }))

// A declined market's Blink (market.declined, loadActionMarket) leads its title and description with the decline, in the token page
// banner's words, and no longer says that trades pay the builders; its buttons stay, as on the token page, so holders can exit.
const declinedTitle = (market, title) => market.declined ? `${declinedLabel(market)} · ${title}` : title
const declinedLead = market => `${declinedSummary(market)} ${DECLINED_TRADING}`

// The market Blink (actions.json maps /token/* here): buy presets, a custom amount and, for holders, sell buttons. While a contributor
// early access window is open the description leads with it, as the token page's note does (app/lib/early-access-display.mjs).
export function buyAction(market, { tradingEnabled = true, ref = null, now = Date.now() } = {}) {
  const href = blinkApiPath(market.mint)
  const repo = repoName(market)
  const notice = earlyAccessNotice(market, now)
  const windowNote = notice && `Contributor early access until ${notice.endsLabel}: only this repository's linked contributors can buy. Anyone can sell.`
  const pool = 'Trades use the canonical repo.ing pool with 1% max slippage.'
  return {
    type: 'action',
    icon: tokenIcon(market),
    title: declinedTitle(market, `$${market.symbol} · ${repo}`),
    // A Hugging Face model market's Blink leads with the disclaimer and names who its fees pay.
    description: market.declined
      ? `${declinedLead(market)} ${windowNote ? `${windowNote} ` : ''}${isModelMarket(market) ? `${HF_DISCLAIMER_SHORT}. ` : ''}${pool}`
      : `${windowNote ? `${windowNote} ` : ''}${isModelMarket(market)
        ? `${HF_DISCLAIMER_SHORT}. Market for the Hugging Face model ${repo}. Every trade pays the model's owner. ${pool}`
        : `${(market.description || `Open source market for ${repo}.`).slice(0, 180)} Every trade pays the builders. ${pool}`}`,
    label: 'Buy',
    ...disabledUnless(tradingEnabled),
    links: { actions: [
      ...BUY_PRESETS.map(amount => ({ type: 'transaction', label: `Buy ${amount} SOL`, href: withRef(`${href}?amount=${amount}`, ref) })),
      { type: 'transaction', label: 'Buy', href: withRef(`${href}?amount={amount}`, ref), parameters: [
        { type: 'number', name: 'amount', label: 'SOL amount', required: true, min: 0.000000001, max: Number(MAX_BUY_LAMPORTS / LAMPORTS_PER_SOL) },
      ] },
      ...sellLinks(market, ref),
    ] },
  }
}

export function sellAction(market, { tradingEnabled = true, ref = null } = {}) {
  return {
    type: 'action',
    icon: tokenIcon(market),
    title: declinedTitle(market, `Sell $${market.symbol} · ${repoName(market)}`),
    description: market.declined
      ? `${declinedLead(market)} Sell part or all of your $${market.symbol} to the canonical repo.ing pool with 1% max slippage.${isModelMarket(market) ? ` ${HF_DISCLAIMER_SHORT}.` : ''}`
      : isModelMarket(market)
        ? `Sell part or all of your $${market.symbol} to the canonical repo.ing pool with 1% max slippage. Every trade pays the model's owner. ${HF_DISCLAIMER_SHORT}.`
        : `Sell part or all of your $${market.symbol} to the canonical repo.ing pool with 1% max slippage. Every trade pays the builders.`,
    label: 'Sell',
    ...disabledUnless(tradingEnabled),
    links: { actions: sellLinks(market, ref) },
  }
}

async function actionGet(rawMint, { loadMarket, tradingEnabled = () => true, ref = null, earlyAccessTrades }, build) {
  try {
    const market = await resolveMarket(parseMint(rawMint), loadMarket, earlyAccessTrades)
    return actionJson(build(market, { tradingEnabled: tradingEnabled(), ref: parseActionReferrer(ref) }), { cache: 'public, max-age=60' })
  } catch (error) { return respondError(error, 'action get') }
}
export const handleBuyGet = (rawMint, options) => actionGet(rawMint, options, buyAction)
export const handleSellGet = (rawMint, options) => actionGet(rawMint, options, sellAction)

// The signing wallet from a POST body: { account } as the spec requires, size-capped before parsing.
async function readAccount(request) {
  const text = await readLimitedText(request, MAX_BODY_BYTES)
  if (text === null) throw new ActionError('Request body is too large', 413)
  let body
  try { body = JSON.parse(text) } catch { throw new ActionError('Request body must be JSON with an account') }
  return parseAccount(body?.account)
}

const serializeUnsigned = prepared => prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
const completed = (market, title, description) => ({ next: { type: 'inline', action: { type: 'completed', icon: tokenIcon(market),
  title, label: 'Done', description: `${description} See the market at ${SITE_ORIGIN}/token/${market.mint}` } } })

// Builds the unsigned buy through the same canonical trader as the site; nothing is signed or sent here.
export async function handleBuyPost(request, rawMint, { loadMarket, prepareBuy, earlyAccessTrades }) {
  try {
    const mint = parseMint(rawMint)
    const query = new URL(request.url).searchParams
    const lamports = parseBuyAmount(query.get('amount'))
    const referrer = parseActionReferrer(query.get('ref'))
    const account = await readAccount(request)
    const market = await resolveMarket(mint, loadMarket, earlyAccessTrades)
    const prepared = await prepareBuy({ githubRepoId: market.repoId, wallet: account.toBase58(), amountLamports: lamports.toString(),
      ...referrerArgs(actionReferrer(market, referrer)) })
    if (prepared.mint !== market.mint || prepared.direction !== 'buy' || prepared.amountIn !== lamports ||
        !prepared.transaction.feePayer?.equals(account)) throw new Error('Prepared action trade does not match the request')
    const sol = formatUnits(lamports)
    // A buy inside a new market's launch-fee window says so: the minimum output already includes that fee.
    const launchFee = launchFeeNotice(prepared.launchFee)
    return actionJson({ type: 'transaction', transaction: serializeUnsigned(prepared),
      message: `Buying $${market.symbol} with ${sol} SOL · at least ${formatUnits(prepared.minimumAmountOut, 6)} $${market.symbol} (1% max slippage).${launchFee ? ` ${launchFee}` : ''}`,
      links: completed(market, `$${market.symbol} bought`, `Your ${sol} SOL buy is confirmed on Solana.`) })
  } catch (error) { return respondError(error, 'action post') }
}

// Sells a share of the wallet's own token account, read here from the account in the POST: the client never names an
// amount. Same canonical trader, preflight and 1% slippage as buys. A contributor early access token is read from its Token-2022 account.
export async function handleSellPost(request, rawMint, { loadMarket, tokenBalance, prepareSell, earlyAccessTrades }) {
  try {
    const mint = parseMint(rawMint)
    const query = new URL(request.url).searchParams
    const percent = parseSellPercent(query.get('percent'))
    const referrer = parseActionReferrer(query.get('ref'))
    const account = await readAccount(request)
    const market = await resolveMarket(mint, loadMarket, earlyAccessTrades)
    let balance
    try { balance = BigInt(await tokenBalance(account, market.mint, { token2022: isEarlyAccessMarket(market) })) }
    catch (error) { throw new ActionError(publicError(error, () => false, 'Your token balance is temporarily unavailable. Try again shortly.', 'action balance'), 503) }
    if (balance <= 0n) throw new ActionError(`This wallet holds no $${market.symbol} to sell.`)
    const amount = balance * BigInt(percent) / 100n
    if (amount <= 0n) throw new ActionError(`Your $${market.symbol} balance is too small to sell ${percent}%. Try selling all of it.`)
    const prepared = await prepareSell({ githubRepoId: market.repoId, wallet: account.toBase58(), amountBaseUnits: amount.toString(),
      ...referrerArgs(actionReferrer(market, referrer)) })
    if (prepared.mint !== market.mint || prepared.direction !== 'sell' || prepared.amountIn !== amount ||
        !prepared.transaction.feePayer?.equals(account)) throw new Error('Prepared action trade does not match the request')
    const tokens = formatUnits(amount, 6)
    return actionJson({ type: 'transaction', transaction: serializeUnsigned(prepared),
      message: `Selling ${tokens} $${market.symbol} (${percent}% of your balance) · at least ${formatUnits(prepared.minimumAmountOut, 9, 6)} SOL (1% max slippage).`,
      links: completed(market, `$${market.symbol} sold`, `Your sale of ${tokens} $${market.symbol} is confirmed on Solana.`) })
  } catch (error) { return respondError(error, 'action post') }
}

// Canonical, finalized markets only: the same gate the traders apply before quoting. declined: a maintainer's (or a model owner's)
// decline is active (maintainer_opt_outs, src/maintainer-opt-outs.mjs), read in the same query.
export async function loadActionMarket(pool, mint) {
  if (!pool) throw new ActionError('Market lookup is temporarily unavailable', 503)
  const { rows: [row] } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint, m.token_symbol as symbol,
      m.quote_mint as "quoteMint", m.early_access_end as "earlyAccessEnd", m.transfer_hook_program as "transferHookProgram", r.full_name as "fullName", r.description,
      exists(select 1 from graduation_events g where g.github_repo_id = m.github_repo_id) as migrated,
      exists(select 1 from maintainer_opt_outs o where o.github_repo_id = m.github_repo_id and o.withdrawn_at is null) as declined
    from markets m left join repositories r on r.github_repo_id = m.github_repo_id
    where m.mint = $1 and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'`, [mint])
  return row ?? null
}
