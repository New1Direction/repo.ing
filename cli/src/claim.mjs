import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { renderUnicodeCompact } from 'uqr'
import { AI_CREDITS_OFF, DEFAULT_ORIGIN, VERSION, aiCreditsOn, validateOrigin } from './core.mjs'

// `repoing claim`: a builder's fees, either claimed to the bound wallet on repo.ing (unchanged) or converted into AI credits
// (repo.ing AI credits, repo-inference's docs/FEE-CONVERSION.md). Converting signs in through repo.ing with PKCE (the browser
// approves; repo.ing sends a single-use code to a one-time listener on 127.0.0.1), then asks the credit service for a quote
// and shows its Solana Pay link. The credit service is credits.repo.ing (staging: --credits-origin
// https://staging-credits.repo.ing, on Solana devnet). Converting is offered unless REPOING_AI_CREDITS=0 (core.mjs,
// aiCreditsOn); then `repoing claim` claims to the wallet without asking.
export const DEFAULT_CREDITS_ORIGIN = 'https://credits.repo.ing'
export const HANDOFF_AUDIENCE = 'repo-inference'
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const LAMPORTS_PER_SOL = 1_000_000_000n

/** The credit service: HTTPS, or HTTP on this computer only. */
export function validateCreditsOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid credits origin.') }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((!local && url.protocol !== 'https:') || (local && !['http:', 'https:'].includes(url.protocol)) || url.username || url.password) {
    throw new Error('The credits origin must use HTTPS (HTTP is allowed only on this computer).')
  }
  return url.origin
}
/** "0.5" SOL → 500000000n lamports, exactly; at most 9 decimals. */
export function solToLamports(text) {
  const match = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(String(text ?? '').trim())
  if (!match) throw new Error('Enter an amount of SOL like 0.5 (at most 9 decimals).')
  return BigInt(match[1]) * LAMPORTS_PER_SOL + BigInt((match[2] ?? '').padEnd(9, '0'))
}
export function lamportsToSol(lamports) {
  const value = BigInt(lamports), whole = value / LAMPORTS_PER_SOL, part = (value % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '')
  return part ? `${whole}.${part}` : `${whole}`
}
export const usd = micro => `$${(Number(BigInt(micro) / 10_000n) / 100).toFixed(2)}`
// A Solana Pay link from the credit service: shown only when it has nothing but URL characters.
const PAY_URL = /^solana:[1-9A-HJ-NP-Za-km-z]{32,44}\?[A-Za-z0-9%=&._-]{1,600}$/
/** A Solana Pay link cannot name its network: a devnet quote (staging) says so before anything is paid. */
export function networkNote(quote) {
  return quote?.network === 'devnet' ? ['This is a devnet test quote: set your wallet to Devnet before you pay. SOL sent on mainnet to this link is not seen.'] : []
}
/** The lines that show a Solana Pay link: a QR code for a phone wallet (light on a dark terminal), then the link. */
export function payLines(url) {
  if (typeof url !== 'string' || !PAY_URL.test(url)) throw new Error('The credit service returned an invalid payment link. Nothing was paid; run the command again.')
  return [...renderUnicodeCompact(url, { ecc: 'L', border: 2 }).split('\n').filter(Boolean), url]
}

/** A PKCE pair (S256) and a state for one sign-in. */
export function newSignIn() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(16).toString('base64url') }
}
// The short code the consent page shows for this sign-in (repo.ing: src/repo-inference-handoff.mjs, handoffCheckCode).
const CHECK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function checkCode(challenge) {
  const digest = createHash('sha256').update(`repoing-handoff-check\n${challenge}`).digest()
  const letters = [...digest.subarray(0, 8)].map(byte => CHECK_ALPHABET[byte % 32]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}
export function handoffUrl(origin, { repoId, challenge, port, state }) {
  const query = new URLSearchParams({ audience: HANDOFF_AUDIENCE, repo: String(repoId), challenge, port: String(port), state })
  return `${validateOrigin(origin)}/api/handoff/start?${query}`
}
/**
 * A one-time listener on 127.0.0.1 (a free port) for repo.ing's redirect: it accepts only /callback with this sign-in's state,
 * answers the browser with a short page, and resolves to the code (or rejects with the refusal).
 */
export async function listenForCode({ state, timeoutMs = SIGN_IN_TIMEOUT_MS }) {
  let settle
  const result = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return
    }
    const code = url.searchParams.get('code'), error = url.searchParams.get('error')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    res.end(`<!doctype html><meta charset="utf-8"><title>repo.ing</title><body style="font-family:system-ui;padding:40px">${code
      ? 'Signed in. You can close this tab and go back to the terminal.' : 'Sign-in cancelled. You can close this tab.'}</body>`)
    if (code && /^[A-Za-z0-9_-]{43}$/.test(code)) settle.resolve(code)
    else settle.reject(new Error(error === 'not_admin' ? 'GitHub does not list this account as an admin of the repository.'
      : error === 'slow_down' ? 'Too many sign-ins; wait a minute and try again.' : 'Sign-in cancelled.'))
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const timer = setTimeout(() => settle.reject(new Error('Sign-in timed out. Run the command again.')), timeoutMs)
  const done = result.finally(() => { clearTimeout(timer); server.close() })
  done.catch(() => {})
  return { port: server.address().port, code: done }
}

async function call(fetchImpl, url, { method = 'GET', body, headers = {}, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { method, signal: controller.signal, redirect: 'error',
      headers: { 'user-agent': `repoing-cli/${VERSION}`, ...body === undefined ? {} : { 'content-type': 'application/json' }, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) })
    let value
    try { value = await response.json() } catch { value = null }
    if (!response.ok) throw Object.assign(new Error(value?.error || `${new URL(url).host} returned HTTP ${response.status}.`), { status: response.status })
    if (!value || typeof value !== 'object') throw new Error(`${new URL(url).host} returned an invalid response.`)
    return value
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`${new URL(url).host} did not respond in time.`)
    if (error?.name === 'TypeError' && error.message === 'fetch failed') throw new Error(`${new URL(url).host} could not be reached.`)
    throw error
  } finally { clearTimeout(timer) }
}
export const requestJson = call
/** The repository's id and market on repo.ing, and what the next claim pays (lamports, or null). */
export async function claimStatus({ origin, repository, fetchImpl = fetch }) {
  const base = validateOrigin(origin)
  const { repoId, mint } = await call(fetchImpl, `${base}/api/resolve`, { method: 'POST', body: { url: repository } })
  if (!/^[1-9]\d*$/.test(String(repoId))) throw new Error('repo.ing returned an invalid repository.')
  if (!mint) return { repoId: String(repoId), mint: null, available: null }
  const preview = await call(fetchImpl, `${base}/api/claim/${repoId}/preview`).catch(error => {
    if (error.status === 409) return { available: null, note: error.message }
    throw error
  })
  return { repoId: String(repoId), mint, available: preview.available === null || preview.available === undefined ? null : BigInt(preview.available), note: preview.note }
}
export const claimPageUrl = (origin, repoId) => `${validateOrigin(origin)}/claim/${repoId}`

/** `repoing claim` arguments (after the command). */
export function parseClaimArgs(argv, env = process.env) {
  const args = [...argv]
  const out = { command: 'claim', repository: null, mode: null, lamports: null, open: true, aiCredits: aiCreditsOn(env),
    origin: env.REPOING_ORIGIN || DEFAULT_ORIGIN, creditsOrigin: env.REPOING_CREDITS_ORIGIN || DEFAULT_CREDITS_ORIGIN }
  const creditsOnly = () => { if (!out.aiCredits) throw new Error(AI_CREDITS_OFF) }
  const value = option => { const next = args.shift(); if (!next || next.startsWith('-')) throw new Error(`${option} requires a value.`); return next }
  while (args.length) {
    const arg = args.shift()
    if (!arg.startsWith('-') && !out.repository) { out.repository = arg; continue }
    if (arg === '--to-wallet') out.mode = out.mode && out.mode !== 'wallet' ? fail() : 'wallet'
    else if (arg === '--convert') { creditsOnly(); out.mode = out.mode && out.mode !== 'convert' ? fail() : 'convert'; out.lamports = solToLamports(value(arg)) }
    else if (arg === '--credits-origin') { creditsOnly(); out.creditsOrigin = value(arg) }
    else if (arg === '--origin') out.origin = value(arg)
    else if (arg === '--no-open') out.open = false
    else if (arg === '--help' || arg === '-h') return { command: 'claim-help', aiCredits: out.aiCredits }
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (out.lamports !== null && (out.lamports < 10_000_000n || out.lamports > 100n * LAMPORTS_PER_SOL)) throw new Error('A conversion is 0.01 to 100 SOL.')
  validateOrigin(out.origin)
  validateCreditsOrigin(out.creditsOrigin)
  return out
}
function fail() { throw new Error('Choose either --to-wallet or --convert.') }

/** The credit service: a session from the handoff code, a quote, and its status. */
export const creditsSession = ({ creditsOrigin, code, verifier, fetchImpl = fetch }) =>
  call(fetchImpl, `${validateCreditsOrigin(creditsOrigin)}/sessions`, { method: 'POST', body: { code, code_verifier: verifier } })
export const requestQuote = ({ creditsOrigin, token, lamports, key = randomBytes(16).toString('base64url'), fetchImpl = fetch }) =>
  call(fetchImpl, `${validateCreditsOrigin(creditsOrigin)}/quotes`, { method: 'POST', body: { lamports: lamports.toString() },
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key } })
export const quoteStatus = ({ creditsOrigin, token, id, fetchImpl = fetch }) =>
  call(fetchImpl, `${validateCreditsOrigin(creditsOrigin)}/quotes/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } })
/** Waits until the quote is credited, expired, or has a payment in review; null if the wait ends first. */
export async function waitForOutcome({ creditsOrigin, token, id, fetchImpl = fetch, intervalMs = 5000, timeoutMs = 35 * 60_000, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const quote = await quoteStatus({ creditsOrigin, token, id, fetchImpl }).catch(() => null)
    if (quote && (quote.status !== 'awaiting_payment' || quote.review_pending)) return quote
    await sleep(intervalMs)
  }
  return null
}

export const claimHelp = (aiCredits = false) => `repoing claim — your fees${aiCredits ? ' as SOL, or as AI credits' : ' to your wallet'}

Usage:
  repoing claim [owner/repo|github-url] [options]

If no repository is supplied, repoing reads the current git origin.

Options:
  --to-wallet           Claim to your bound wallet on repo.ing (opens the claim page)${aiCredits ? `
  --convert <SOL>       Convert: sign in through repo.ing, then pay this much SOL for AI credits
  --credits-origin <u>  The AI credits service (default ${DEFAULT_CREDITS_ORIGIN})` : ''}
  --no-open             Print links instead of opening the browser
  --origin <url>        Override repo.ing origin (dev/testing)
${aiCredits ? `
Converting never moves your claimed fees by itself: you pay the quote from your own wallet, and credits come only after
the payment is finalized on chain.` : `
The claim page shows what the claim pays, and your wallet approves it.`}`

/**
 * Signs in to the credit service through repo.ing: the browser approves; the code comes back to this computer only and is
 * redeemed with the PKCE verifier. Returns the session (a conversion key that lives one hour).
 */
export async function signInForCredits(options, { repoId, io, fetchImpl = fetch, listen = listenForCode, signIn = newSignIn }) {
  const pkce = signIn()
  const listener = await listen({ state: pkce.state })
  const url = handoffUrl(options.origin, { repoId, challenge: pkce.challenge, port: listener.port, state: pkce.state })
  const opened = options.open && await io.open(url)
  io.print(opened ? '→ approve on repo.ing in your browser (opened)…' : `→ open this link and approve on repo.ing:\n${url}`)
  io.print(`  check code ${checkCode(pkce.challenge)}: approve only if repo.ing shows the same code`)
  const code = await listener.code
  const session = await creditsSession({ creditsOrigin: options.creditsOrigin, code, verifier: pkce.verifier, fetchImpl })
  if (!session.token) throw new Error(session.note ?? 'The sign-in was already used. Run the command again.')
  io.print(`✓ signed in as @${session.login}`)
  return session
}

/**
 * The whole `repoing claim` flow. io: { print(line), ask(question) → answer, open(url) → whether it opened }.
 * Returns what happened, for --json and tests.
 */
export async function runClaim(options, { repository, io, fetchImpl = fetch, listen = listenForCode, signIn = newSignIn, wait = waitForOutcome }) {
  const status = await claimStatus({ origin: options.origin, repository, fetchImpl })
  io.print(`\nrepo.ing  ${repository.replace('https://github.com/', '')}`)
  if (!status.mint) { io.print('• No market on repo.ing for this repository yet.'); return { outcome: 'no_market', ...status } }
  io.print(status.available === null ? `• ${status.note ?? 'Nothing to claim for this market.'}` : `✓ claimable now: ${lamportsToSol(status.available)} SOL`)
  let mode = options.mode ?? (options.aiCredits ? null : 'wallet')
  if (!mode) {
    const answer = (await io.ask('\n  1  Claim to your wallet on repo.ing\n  2  Convert to AI credits (pay from your wallet)\nChoose 1 or 2: ')).trim()
    mode = answer === '1' ? 'wallet' : answer === '2' ? 'convert' : null
    if (!mode) throw new Error('Choose 1 or 2.')
  }
  if (mode === 'wallet') {
    const url = claimPageUrl(options.origin, status.repoId)
    const opened = options.open && await io.open(url)
    io.print(`→ claim to your bound wallet: ${url}${opened ? '\n  opened in browser' : ''}`)
    return { outcome: 'claim_page', url, ...status }
  }
  let lamports = options.lamports
  if (lamports === null) {
    const suggested = status.available && status.available >= 10_000_000n ? lamportsToSol(status.available) : '0.1'
    const answer = (await io.ask(`SOL to convert (0.01 to 100) [${suggested}]: `)).trim() || suggested
    lamports = solToLamports(answer)
    if (lamports < 10_000_000n || lamports > 100n * LAMPORTS_PER_SOL) throw new Error('A conversion is 0.01 to 100 SOL.')
  }
  const session = await signInForCredits(options, { repoId: status.repoId, io, fetchImpl, listen, signIn })
  const quote = await requestQuote({ creditsOrigin: options.creditsOrigin, token: session.token, lamports, fetchImpl })
  const pay = payLines(quote.solana_pay_url)
  io.print(`\nPay exactly ${lamportsToSol(quote.lamports)} SOL from your wallet: scan the code with your phone wallet, or open the Solana Pay link:`)
  for (const line of [...networkNote(quote), ...pay]) io.print(line)
  io.print(`You get ${usd(quote.credit_micro)} of AI credits (SOL at ${usd(quote.price_micro_per_sol)}). The quote expires ${new Date(quote.expires_at).toLocaleTimeString()}.`)
  io.print('Waiting for the payment to finalize on chain…')
  const final = await wait({ creditsOrigin: options.creditsOrigin, token: session.token, id: quote.id, fetchImpl })
  if (final?.status === 'credited') io.print(`✓ credited: ${usd(final.credit_micro)} of AI credits`)
  else if (final?.review_pending) io.print('• a payment for this quote needs a review by repo.ing (wrong amount, late, or shared); nothing is lost.')
  else if (final?.status === 'expired') io.print('• the quote expired without a payment. Nothing was charged.')
  else io.print(`• still waiting; check later with the quote ID ${quote.id}.`)
  return { outcome: final?.status === 'credited' ? 'credited' : final?.review_pending ? 'review' : final?.status ?? 'waiting', quote: quote.id, ...status }
}
