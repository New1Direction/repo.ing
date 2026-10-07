import { randomBytes } from 'node:crypto'
import { DEFAULT_ORIGIN, validateOrigin } from './core.mjs'
import { DEFAULT_CREDITS_ORIGIN, requestJson, signInForCredits, usd, validateCreditsOrigin } from './claim.mjs'

// `repoing credits key`: one key for a coding tool, paid from the builder's AI credits (repo.ing AI credits, repo-inference's
// docs/FEE-CONVERSION.md). It signs in through repo.ing like `repoing claim`, then asks the credit service for one
// inference-only key with a spending limit the builder chooses (at most the account's credits), valid 30 days. The key
// can only run inference: it cannot buy credits or make keys. The token is printed once and kept nowhere.
export const DEFAULT_INFERENCE_ORIGIN = 'http://127.0.0.1:8788'
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
const USAGE = 'Usage: repoing credits key|list|revoke <key-id> [owner/repo] [options] (repoing credits --help)'

/** `repoing credits …` arguments (after `credits`): key, list, or revoke <key-id>. */
export function parseCreditsArgs(argv, env = process.env) {
  const args = [...argv]
  if (args[0] === '--help' || args[0] === '-h') return { command: 'credits-help' }
  const action = args.shift()
  if (!['key', 'list', 'revoke'].includes(action)) throw new Error(USAGE)
  const out = { command: `credits-${action}`, repository: null, keyId: null, limitMicro: null, label: 'coding-tool', open: true,
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

Each command signs in through repo.ing (as an admin of a repository with a market; the current git origin if none is
supplied). key makes one key that can only run inference, valid 30 days, with a spending limit of at most your
credits (at most 5 live). list shows your keys; revoke stops one at once.

Options:
  --limit <USD>           Spending limit (default: all your credits)
  --label <name>          A name for the key, like the tool or the computer (default coding-tool)
  --inference-origin <u>  The AI gateway (default ${DEFAULT_INFERENCE_ORIGIN}; a sandbox for now)
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

/** `repoing credits key|list|revoke`. Returns what happened, never a token. */
export async function runCredits(options, deps) {
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
