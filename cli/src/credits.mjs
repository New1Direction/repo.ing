import { randomBytes } from 'node:crypto'
import { DEFAULT_ORIGIN, validateOrigin } from './core.mjs'
import { DEFAULT_CREDITS_ORIGIN, lamportsToSol, networkNote, payLines, requestJson, signInForCredits, usd, validateCreditsOrigin, waitForOutcome } from './claim.mjs'

// `repoing credits key`: one key for a coding tool, paid from the builder's AI credits (repo.ing AI credits, repo-inference's
// docs/FEE-CONVERSION.md). It signs in through repo.ing like `repoing claim`, then asks the credit service for one
// inference-only key with a spending limit the builder chooses (at most the account's credits), valid 30 days. The key
// can only run inference: it cannot buy credits or make keys. The token is printed once and kept nowhere.
export const DEFAULT_INFERENCE_ORIGIN = 'https://inference.repo.ing'
const MIN_LIMIT_MICRO = 10_000

/** "20" or "$20.50" → micro-USD, exactly; at most 2 decimals. */
export function usdToMicro(text) {
  const match = /^\$?(\d{1,7})(?:\.(\d{1,2}))?$/.exec(String(text ?? '').trim())
  if (!match) throw new Error('Enter a limit in USD like 20 or 20.50.')
  const micro = Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(2, '0')) * 10_000
  if (micro < MIN_LIMIT_MICRO) throw new Error('The limit is at least $0.01.')
  return micro
}
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^rik_[0-9a-f]{64}$/
const USAGE = 'Usage: repoing credits key|list|revoke <key-id>|buy [10|25|50|100] [owner/repo] [options] (repoing credits --help)'
// SOL credit packs (repo-inference docs/PACKS.md): $10, $25, $50 or $100.
const PACKS_MICRO = [10_000_000, 25_000_000, 50_000_000, 100_000_000]
const MULTIPLIERS = [10_000, 12_000, 20_000, 50_000]
const UUID = KEY_ID
/** "25" or "$25" → micro-USD of a pack; anything else is refused. */
function packMicro(text) {
  const match = /^\$?(\d{1,4})$/.exec(text)
  const micro = match ? Number(match[1]) * 1_000_000 : null
  if (!PACKS_MICRO.includes(micro)) throw new Error('A pack is $10, $25, $50 or $100.')
  return micro
}

/** `repoing credits …` arguments (after `credits`): key, list, or revoke <key-id>. */
export function parseCreditsArgs(argv, env = process.env) {
  const args = [...argv]
  if (args[0] === '--help' || args[0] === '-h') return { command: 'credits-help' }
  const action = args.shift()
  if (!['key', 'list', 'revoke', 'buy'].includes(action)) throw new Error(USAGE)
  const out = { command: `credits-${action}`, repository: null, keyId: null, limitMicro: null, packMicro: null, label: 'coding-tool', open: true,
    origin: env.REPOING_ORIGIN || DEFAULT_ORIGIN, creditsOrigin: env.REPOING_CREDITS_ORIGIN || DEFAULT_CREDITS_ORIGIN,
    inferenceOrigin: env.REPOING_INFERENCE_ORIGIN || DEFAULT_INFERENCE_ORIGIN }
  if (action === 'revoke') {
    const id = args.shift()
    if (!KEY_ID.test(id ?? '')) throw new Error('repoing credits revoke needs a key ID (shown by repoing credits list).')
    out.keyId = id.toLowerCase()
  }
  const value = option => { const next = args.shift(); if (!next || next.startsWith('-')) throw new Error(`${option} requires a value.`); return next }
  const onlyForKey = option => { if (action !== 'key') throw new Error(`${option} is for repoing credits key.`) }
  while (args.length) {
    const arg = args.shift()
    if (action === 'buy' && /^\$?\d+$/.test(arg)) {
      if (out.packMicro !== null) throw new Error('Choose one pack: $10, $25, $50 or $100.')
      out.packMicro = packMicro(arg)
      continue
    }
    if (!arg.startsWith('-') && !out.repository) { out.repository = arg; continue }
    if (arg === '--limit') { onlyForKey(arg); out.limitMicro = usdToMicro(value(arg)) }
    else if (arg === '--label') { onlyForKey(arg); out.label = value(arg) }
    else if (arg === '--credits-origin') out.creditsOrigin = value(arg)
    else if (arg === '--inference-origin') out.inferenceOrigin = value(arg)
    else if (arg === '--origin') out.origin = value(arg)
    else if (arg === '--no-open') out.open = false
    else if (arg === '--help' || arg === '-h') return { command: 'credits-help' }
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!LABEL.test(out.label)) throw new Error('The label is 1 to 64 letters, digits, spaces, dots, dashes or underscores.')
  validateOrigin(out.origin)
  validateCreditsOrigin(out.creditsOrigin)
  out.inferenceOrigin = validateCreditsOrigin(out.inferenceOrigin)
  return out
}

export const CREDITS_HELP = `repoing credits — keys for your coding tool, paid from your AI credits

Usage:
  repoing credits key [owner/repo|github-url] [options]
  repoing credits list [owner/repo|github-url]
  repoing credits revoke <key-id> [owner/repo|github-url]
  repoing credits buy [10|25|50|100] [owner/repo|github-url]

Each command signs in through repo.ing (as an admin of a repository with a market; the current git origin if none is
supplied). key makes one key that can only run inference, valid 30 days, with a spending limit of at most your
credits (at most 5 live). list shows your keys; revoke stops one at once. buy pays SOL for a $10, $25, $50 or $100 pack of
credits: it shows the odds, asks you to confirm, and each paid pack spins once for a bonus (never less than you pay).

Options:
  --limit <USD>           Spending limit (default: all your credits)
  --label <name>          A name for the key, like the tool or the computer (default coding-tool)
  --inference-origin <u>  The AI gateway (default ${DEFAULT_INFERENCE_ORIGIN})
  --credits-origin <u>    The AI credits service (default ${DEFAULT_CREDITS_ORIGIN})
  --no-open               Print links instead of opening the browser
  --origin <url>          Override repo.ing origin (dev/testing)

The key is shown once. Get credits first with repoing claim --convert <SOL>.`

// Signs in for one `repoing credits` command; null when the repository has no market (nothing to sign in with).
async function creditsSignIn(options, { repository, io, fetchImpl, listen, signIn }) {
  const { repoId, mint } = await requestJson(fetchImpl, `${validateOrigin(options.origin)}/api/resolve`, { method: 'POST', body: { url: repository } })
  if (!/^[1-9]\d*$/.test(String(repoId))) throw new Error('repo.ing returned an invalid repository.')
  io.print(`\nrepo.ing  ${repository.replace('https://github.com/', '')}`)
  if (!mint) { io.print('• Signing in needs a repository with a market on repo.ing; pass one you are an admin of.'); return null }
  const session = await signInForCredits(options, { repoId: String(repoId), io, fetchImpl, listen, signIn })
  return { base: validateCreditsOrigin(options.creditsOrigin), authorization: `Bearer ${session.token}` }
}
const day = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10) }

/** `repoing credits key|list|revoke|buy`. Returns what happened, never a token. */
export async function runCredits(options, deps) {
  if (options.command === 'credits-buy') return runCreditsBuy(options, deps)
  if (options.command === 'credits-list') return runCreditsList(options, deps)
  if (options.command === 'credits-revoke') return runCreditsRevoke(options, deps)
  return runCreditsKey(options, deps)
}

/**
 * The whole `repoing credits key` flow. io: { print(line), ask(question) → answer, open(url) → whether it opened }.
 * Returns what happened without the token.
 */
export async function runCreditsKey(options, { repository, io, fetchImpl = fetch, listen, signIn }) {
  const signedIn = await creditsSignIn(options, { repository, io, fetchImpl, listen, signIn })
  if (!signedIn) return { outcome: 'no_market' }
  const { base: creditsBase, authorization } = signedIn
  const account = await requestJson(fetchImpl, `${creditsBase}/account`, { headers: { authorization } })
  const available = Number(account.credits_available ?? account.paid_available ?? 0)
  if (!Number.isSafeInteger(available) || available < MIN_LIMIT_MICRO) {
    io.print('• No AI credits yet. Get some with repoing claim --convert <SOL>, then run this again.')
    return { outcome: 'no_credits' }
  }
  io.print(`✓ You have ${usd(available)} of AI credits.`)
  let limit = options.limitMicro
  if (limit === null) {
    const answer = (await io.ask(`Spending limit for this key in USD (up to ${usd(available)}) [${usd(available).slice(1)}]: `)).trim()
    limit = answer ? usdToMicro(answer) : available
  }
  if (limit > available) throw new Error(`The limit is at most ${usd(available)} (your credits).`)
  const made = await requestJson(fetchImpl, `${creditsBase}/keys`, { method: 'POST', body: { label: options.label, budget_micro: limit },
    headers: { authorization, 'idempotency-key': randomBytes(16).toString('base64url') } })
  // Only a well-formed key is printed: never text from the service that could add lines or terminal codes.
  if (!TOKEN.test(made.token ?? '') || !KEY_ID.test(made.key?.id ?? '') || !Number.isSafeInteger(made.key.budget_micro)) {
    throw new Error('The credit service returned an invalid key. If one was made, revoke it: repoing credits list.')
  }
  io.print(`\n✓ key "${options.label}" (${made.key.id}): spending limit ${usd(made.key.budget_micro)}, inference only, valid until ${day(made.key.expires_at)}`)
  io.print('Set these in your coding tool (OpenAI-compatible; the AI gateway must be running). The key is shown only now:')
  io.print(`OPENAI_BASE_URL=${options.inferenceOrigin}/v1`)
  io.print(`OPENAI_API_KEY=${made.token}`)
  io.print(`If it leaks, revoke it: repoing credits revoke ${made.key.id}`)
  return { outcome: 'key', keyId: made.key.id, budgetMicro: made.key.budget_micro, expiresAt: made.key.expires_at }
}

/** `repoing credits list`: the account's coding-tool keys, newest first. */
export async function runCreditsList(options, { repository, io, fetchImpl = fetch, listen, signIn }) {
  const signedIn = await creditsSignIn(options, { repository, io, fetchImpl, listen, signIn })
  if (!signedIn) return { outcome: 'no_market' }
  const listed = await requestJson(fetchImpl, `${signedIn.base}/keys`, { headers: { authorization: signedIn.authorization } })
  const keys = (Array.isArray(listed.keys) ? listed.keys : []).filter(key => KEY_ID.test(key?.id ?? ''))
  if (!keys.length) io.print('• No coding-tool keys yet. Make one with repoing credits key.')
  const now = Date.now()
  for (const key of keys) {
    const state = key.revoked ? 'revoked' : new Date(key.expires_at).getTime() <= now ? 'expired' : 'live'
    const label = LABEL.test(key.label ?? '') ? key.label : '?'
    io.print(`${key.id}  ${state.padEnd(7)}  ${label}  limit ${usd(key.budget_micro ?? 0)}, spent ${usd(key.spent_micro ?? 0)}, until ${day(key.expires_at)}`)
  }
  return { outcome: 'list', keys: keys.map(key => ({ id: key.id, revoked: Boolean(key.revoked), expiresAt: key.expires_at })) }
}

/** `repoing credits revoke <key-id>`: stops the key at once (requests already running finish and are charged). */
export async function runCreditsRevoke(options, { repository, io, fetchImpl = fetch, listen, signIn }) {
  const signedIn = await creditsSignIn(options, { repository, io, fetchImpl, listen, signIn })
  if (!signedIn) return { outcome: 'no_market' }
  await requestJson(fetchImpl, `${signedIn.base}/keys/${options.keyId}/revoke`, { method: 'POST', body: {}, headers: { authorization: signedIn.authorization } })
  io.print(`✓ revoked ${options.keyId}`)
  return { outcome: 'revoked', keyId: options.keyId }
}

const percent = bps => `${(bps / 100).toFixed(2)}%`
const times = bps => `${bps / 10_000}x`
/** The pack's odds, from the offer's numbers only (never text from the service); null when they are not well-formed. */
function oddsLines(policy) {
  const outcomes = Array.isArray(policy?.outcomes) ? policy.outcomes : []
  const ok = outcomes.length > 0 && outcomes.every(o => MULTIPLIERS.includes(o?.multiplier_bps) && Number.isInteger(o?.probability_bps) && o.probability_bps > 0)
    && outcomes.reduce((sum, o) => sum + o.probability_bps, 0) === 10_000
  return ok ? outcomes.map(o => `  ${percent(o.probability_bps).padStart(7)}  ${times(o.multiplier_bps)}`) : null
}
const PACK_TERMS = [
  'Each paid pack spins once, on the server, when the payment is final. You get at least the pack in paid credits, never less than you pay;',
  'a win adds bonus credits, spent after paid credits. Credits never turn into cash and do not expire.',
  'A payment that does not match the quote waits for a review by repo.ing: a refund, or credits with no spin.',
]

/**
 * `repoing credits buy [10|25|50|100]`: a SOL credit pack. Signs in, shows the odds, asks to confirm, asks the credit
 * service for the pack's quote, shows the Solana Pay link, waits for the payment and shows the spin.
 */
export async function runCreditsBuy(options, { repository, io, fetchImpl = fetch, listen, signIn, wait = waitForOutcome }) {
  const signedIn = await creditsSignIn(options, { repository, io, fetchImpl, listen, signIn })
  if (!signedIn) return { outcome: 'no_market' }
  const { base, authorization } = signedIn
  const offer = await requestJson(fetchImpl, `${base}/packs`, { headers: { authorization } })
  if (!['sandbox', 'live'].includes(offer.sales)) { io.print('• Credit packs are not on sale yet.'); return { outcome: 'off' } }
  const odds = oddsLines(offer.policy)
  if (!odds) throw new Error('The credit service returned invalid odds.')
  io.print('\nCredit packs: $10, $25, $50 or $100, paid in SOL. Odds for each paid pack:')
  for (const line of odds) io.print(line)
  for (const line of PACK_TERMS) io.print(line)
  const pack = options.packMicro ?? packMicro((await io.ask('Pack: $10, $25, $50 or $100 [25]: ')).trim() || '25')
  const room = Number.isSafeInteger(offer.account_room_micro) ? offer.account_room_micro : 0
  if (pack > room) { io.print(`• You have ${usd(room)} left today for packs ($250 a day). Try a smaller pack or tomorrow.`); return { outcome: 'no_room' } }
  const yes = (await io.ask(`Buy a ${usd(pack)} pack, paid in SOL at the price of the moment? [y/N]: `)).trim().toLowerCase()
  if (!['y', 'yes'].includes(yes)) { io.print('• Nothing was bought.'); return { outcome: 'cancelled' } }
  const quote = await requestJson(fetchImpl, `${base}/packs`, { method: 'POST', body: { pack_micro: pack },
    headers: { authorization, 'idempotency-key': randomBytes(16).toString('base64url') } })
  if (!UUID.test(quote.id ?? '') || !Number.isSafeInteger(quote.lamports) || quote.lamports < 1 || quote.pack_micro !== pack) {
    throw new Error('The credit service returned an invalid quote. Nothing was paid; run the command again.')
  }
  const pay = payLines(quote.solana_pay_url)
  io.print(`\nPay exactly ${lamportsToSol(BigInt(quote.lamports))} SOL from your wallet: scan the code with your phone wallet, or open the Solana Pay link:`)
  for (const line of [...networkNote(quote), ...pay]) io.print(line)
  const expires = new Date(quote.expires_at)
  io.print(`The quote expires ${Number.isNaN(expires.getTime()) ? 'in 15 minutes' : expires.toLocaleTimeString()}. Waiting for the payment to finalize on chain…`)
  const final = await wait({ creditsOrigin: options.creditsOrigin, token: authorization.slice('Bearer '.length), id: quote.id, fetchImpl })
  if (final?.status === 'credited' && final.spin) {
    const { multiplier_bps: m, paid_micro: paid, bonus_micro: bonus } = final.spin
    if (!MULTIPLIERS.includes(m) || paid !== pack || bonus !== pack * (m - 10_000) / 10_000) throw new Error(`The credit service returned an invalid spin for quote ${quote.id}.`)
    io.print('Spinning…')
    io.print(m === 10_000 ? `✓ 1x: ${usd(paid)} of AI credits.` : `✓ ${times(m)}! ${usd(paid)} of AI credits + ${usd(bonus)} bonus = ${usd(paid + bonus)}.`)
    return { outcome: 'credited', quote: quote.id, multiplierBps: m, paidMicro: paid, bonusMicro: bonus }
  }
  if (final?.review_pending) io.print('• a payment for this pack needs a review by repo.ing (wrong amount, late, or shared): a refund, or credits with no spin.')
  else if (final?.status === 'expired') io.print('• the quote expired without a payment. Nothing was charged.')
  else io.print(`• still waiting; check later with the quote ID ${quote.id}.`)
  return { outcome: final?.review_pending ? 'review' : final?.status ?? 'waiting', quote: quote.id }
}
