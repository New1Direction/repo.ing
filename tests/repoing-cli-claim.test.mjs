import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DEFAULT_CREDITS_ORIGIN, claimHelp, claimStatus, handoffUrl, lamportsToSol, listenForCode, parseClaimArgs, payLines, runClaim, solToLamports, usd,
  validateCreditsOrigin } from '../cli/src/claim.mjs'

// `repoing claim` (cli/src/claim.mjs): arguments, amounts, the one-time loopback listener, and the whole flow with repo.ing and
// the credit service scripted (the listener is real, on 127.0.0.1).
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })
const TREASURY = '7WZRJ4to98TLKhiWqoNfqWwYcxrqN8KsBJWXdTxq2KUY'
const ON = { REPOING_AI_CREDITS: '1' } // AI credits are off unless this is set

test('a Solana Pay link: its QR code, then the link; anything that is not a plain link is refused', () => {
  const url = `solana:${TREASURY}?amount=0.166666667&reference=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin&label=repo.ing%20AI%20credits&message=Credit%20pack%202f8fad5b-d9cb-469f-a165-70867728950e`
  const lines = payLines(url)
  assert.equal(lines.at(-1), url)
  const qr = lines.slice(0, -1)
  assert.ok(qr.length >= 20 && qr.length <= 40, `${qr.length} rows`)
  assert.ok(qr.every(line => /^[█▀▄ ]+$/.test(line) && [...line].length === [...qr[0]].length), 'square, block characters only')
  assert.ok([...qr[0]].length <= 70, 'fits a terminal')
  for (const bad of ['solana:x?amount=1', `solana:${TREASURY}?amount=1\n\u001b[2J`, `https://evil.example/?${TREASURY}`, `solana:${TREASURY}`, null]) {
    assert.throws(() => payLines(bad), /invalid payment link/, String(bad))
  }
})

test('convert: a malformed payment link from the credit service is never printed', async () => {
  const printed = []
  const io = { print: line => printed.push(line), ask: async () => '', open: async url => {
    const start = new URL(url)
    setTimeout(() => fetch(`http://127.0.0.1:${start.searchParams.get('port')}/callback?code=${'k'.repeat(43)}&state=${start.searchParams.get('state')}`), 10)
    return true
  } }
  await assert.rejects(runClaim(options({ mode: 'convert', lamports: 500_000_000n }), { repository: 'r', io,
    fetchImpl: services({ payUrl: 'solana:x?amount=1\n\u001b[2Jpay https://evil.example' }).fetchImpl, wait: async () => null }), /invalid payment link/)
  assert.equal(printed.some(line => /evil|\u001b/.test(line)), false)
})

test('arguments: wallet or convert (not both), exact SOL amounts, safe origins', () => {
  assert.deepEqual(parseClaimArgs(['octo/widget'], ON), { command: 'claim', repository: 'octo/widget', mode: null, lamports: null, open: true,
    aiCredits: true, origin: 'https://repo.ing', creditsOrigin: DEFAULT_CREDITS_ORIGIN })
  assert.equal(parseClaimArgs(['--to-wallet'], ON).mode, 'wallet')
  assert.deepEqual([parseClaimArgs(['--convert', '0.5'], ON).mode, parseClaimArgs(['--convert', '0.5'], ON).lamports], ['convert', 500_000_000n])
  assert.equal(parseClaimArgs([], { ...ON, REPOING_CREDITS_ORIGIN: 'https://credits.example' }).creditsOrigin, 'https://credits.example')
  for (const [args, message] of [[['--to-wallet', '--convert', '1'], /either/], [['--convert', '0.001'], /0\.01 to 100/], [['--convert', '101'], /0\.01 to 100/],
    [['--convert', '1.0000000001'], /9 decimals/], [['--convert'], /requires a value/], [['--credits-origin', 'http://credits.example'], /HTTPS/], [['--bogus'], /Unknown/]]) {
    assert.throws(() => parseClaimArgs(args, ON), message, args.join(' '))
  }
  assert.equal(parseClaimArgs(['--help'], {}).command, 'claim-help')
  assert.deepEqual([solToLamports('1'), solToLamports('0.000000001'), lamportsToSol(1_500_000_000n), lamportsToSol(10_000_000n), usd(75_000_000), usd(150_123_457)],
    [1_000_000_000n, 1n, '1.5', '0.01', '$75.00', '$150.12'])
  assert.equal(validateCreditsOrigin('http://localhost:8794/x'), 'http://localhost:8794')
})

test('the listener answers only its own state on /callback, then closes; a refusal or a timeout rejects', async () => {
  const listening = await listenForCode({ state: 's'.repeat(22) })
  const base = `http://127.0.0.1:${listening.port}`
  assert.equal((await fetch(`${base}/callback?code=${'c'.repeat(43)}&state=other`)).status, 404)
  assert.equal((await fetch(`${base}/elsewhere?code=${'c'.repeat(43)}&state=${'s'.repeat(22)}`)).status, 404)
  const page = await fetch(`${base}/callback?code=${'c'.repeat(43)}&state=${'s'.repeat(22)}`)
  assert.match(await page.text(), /Signed in\. You can close this tab/)
  assert.equal(await listening.code, 'c'.repeat(43))
  await assert.rejects(fetch(`${base}/callback`), 'closed after one code')
  const refused = await listenForCode({ state: 't'.repeat(22) })
  await fetch(`http://127.0.0.1:${refused.port}/callback?error=not_admin&state=${'t'.repeat(22)}`)
  await assert.rejects(refused.code, /not list this account as an admin/)
  const slow = await listenForCode({ state: 'u'.repeat(22), timeoutMs: 50 })
  await assert.rejects(slow.code, /timed out/)
})

// repo.ing and the credit service, scripted; every request recorded.
function services({ available = '600000000', mint = 'MintWidget', outcome = { status: 'credited', credit_micro: 75_000_000 }, payUrl = null } = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url), body = init.body ? JSON.parse(init.body) : null
    requests.push({ url: target.href, method: init.method ?? 'GET', body, headers: init.headers })
    if (target.pathname === '/api/resolve') return json({ repoId: '77', mint })
    if (target.pathname === '/api/claim/77/preview') return json({ available })
    if (target.pathname === '/sessions') return json({ account_id: 'a', login: 'octocat', repo_id: '77', token: `rik_${'ab'.repeat(32)}` })
    if (target.pathname === '/quotes') return json({ id: 'q1', lamports: Number(body.lamports), credit_micro: 75_000_000, price_micro_per_sol: 150_000_000,
      expires_at: new Date(Date.now() + 900_000).toISOString(), solana_pay_url: payUrl ?? `solana:${TREASURY}?amount=${body.lamports}`, status: 'awaiting_payment', network: 'devnet' })
    if (target.pathname === '/quotes/q1') return json({ id: 'q1', ...outcome })
    return json({ error: 'not found' }, 404)
  }
  return { fetchImpl, requests }
}
const options = extra => ({ origin: 'https://repo.ing', creditsOrigin: 'http://127.0.0.1:8794', open: true, mode: null, lamports: null, aiCredits: true, ...extra })

test('convert: sign in through repo.ing with PKCE, a quote for the chosen SOL, its Solana Pay link, then the credit', async () => {
  const { fetchImpl, requests } = services()
  const printed = [], asked = []
  const io = { print: line => printed.push(line), ask: async question => { asked.push(question); return asked.length === 1 ? '2' : '0.5' },
    // The browser: approves at once and repo.ing redirects to the listener with the code and the state.
    open: async url => {
      const start = new URL(url)
      assert.equal(start.origin + start.pathname, 'https://repo.ing/api/handoff/start')
      setTimeout(() => fetch(`http://127.0.0.1:${start.searchParams.get('port')}/callback?code=${'k'.repeat(43)}&state=${start.searchParams.get('state')}`), 10)
      return true
    } }
  const result = await runClaim(options(), { repository: 'https://github.com/octo/widget', io, fetchImpl, wait: async () => ({ status: 'credited', credit_micro: 75_000_000 }) })
  assert.deepEqual(result.outcome, 'credited')
  assert.match(asked[1], /SOL to convert \(0\.01 to 100\) \[0\.6\]/, 'the claimable amount is suggested')
  const session = requests.find(r => r.url.endsWith('/sessions'))
  const start = new URL(handoffUrl('https://repo.ing', { repoId: 77, challenge: 'x', port: 1, state: 'y' }))
  assert.equal(start.searchParams.get('audience'), 'repo-inference')
  assert.equal(session.body.code, 'k'.repeat(43))
  assert.equal(session.body.code_verifier.length, 43)
  const quote = requests.find(r => r.url.endsWith('/quotes'))
  assert.deepEqual([quote.body, quote.headers.authorization], [{ lamports: '500000000' }, `Bearer rik_${'ab'.repeat(32)}`])
  assert.match(quote.headers['idempotency-key'], /^[A-Za-z0-9_-]{22}$/)
  assert.ok(printed.some(line => /Pay exactly 0\.5 SOL/.test(line)))
  assert.ok(printed.some(line => /devnet test quote: set your wallet to Devnet/.test(line)), 'a devnet quote says so')
  const link = printed.indexOf(`solana:${TREASURY}?amount=500000000`)
  const rows = printed.slice(0, link).reverse().findIndex(line => !/^[█▀▄ ]+$/.test(line))
  assert.ok(rows >= 12, `the link on its own line, after its QR code (${rows} rows)`)
  assert.ok(printed.some(line => /You get \$75\.00 of AI credits \(SOL at \$150\.00\)/.test(line)))
  assert.ok(printed.includes('✓ credited: $75.00 of AI credits'))
})

test('the verifier sent to the credit service is the one whose S256 was in the sign-in link', async () => {
  const { fetchImpl, requests } = services()
  let challenge
  const io = { print: () => {}, ask: async () => '', open: async url => {
    const start = new URL(url); challenge = start.searchParams.get('challenge')
    setTimeout(() => fetch(`http://127.0.0.1:${start.searchParams.get('port')}/callback?code=${'k'.repeat(43)}&state=${start.searchParams.get('state')}`), 10)
    return true } }
  await runClaim(options({ mode: 'convert', lamports: 100_000_000n }), { repository: 'https://github.com/octo/widget', io, fetchImpl, wait: async () => null })
  const verifier = requests.find(r => r.url.endsWith('/sessions')).body.code_verifier
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge)
})

test('claim to wallet opens the claim page; no market or a stock pair says so; review and expiry are reported', async () => {
  const opened = []
  const io = { print: () => {}, ask: async () => '1', open: async url => { opened.push(url); return true } }
  const wallet = await runClaim(options(), { repository: 'https://github.com/octo/widget', io, fetchImpl: services().fetchImpl })
  assert.deepEqual([wallet.outcome, opened], ['claim_page', ['https://repo.ing/claim/77']])
  assert.equal((await runClaim(options(), { repository: 'r', io, fetchImpl: services({ mint: null }).fetchImpl })).outcome, 'no_market')
  const stock = async url => url.endsWith('/preview') ? json({ error: 'Stock pairs have no owner claim.' }, 409) : services().fetchImpl(url, {})
  assert.deepEqual((await claimStatus({ origin: 'https://repo.ing', repository: 'r', fetchImpl: stock })), { repoId: '77', mint: 'MintWidget', available: null, note: 'Stock pairs have no owner claim.' })
  for (const [outcome, expected] of [[{ status: 'awaiting_payment', review_pending: true }, /needs a review/], [{ status: 'expired' }, /expired without a payment/]]) {
    const printed = []
    const browser = { print: line => printed.push(line), ask: async () => '', open: async url => {
      const start = new URL(url)
      setTimeout(() => fetch(`http://127.0.0.1:${start.searchParams.get('port')}/callback?code=${'k'.repeat(43)}&state=${start.searchParams.get('state')}`), 10)
      return true } }
    await runClaim(options({ mode: 'convert', lamports: 100_000_000n }), { repository: 'r', io: browser, fetchImpl: services().fetchImpl, wait: async () => outcome })
    assert.ok(printed.some(line => expected.test(line)), printed.join('\n'))
  }
})

test('the credit service is credits.repo.ing unless another is given', () => {
  assert.equal(DEFAULT_CREDITS_ORIGIN, 'https://credits.repo.ing')
  assert.equal(parseClaimArgs([], { REPOING_CREDITS_ORIGIN: 'https://staging-credits.repo.ing' }).creditsOrigin, 'https://staging-credits.repo.ing')
})

test('AI credits off (the default): claim goes to the wallet without asking, and convert or credits say they are not open', async () => {
  const off = parseClaimArgs(['octo/widget'], {})
  assert.equal(off.aiCredits, false)
  for (const args of [['--convert', '0.5'], ['--credits-origin', 'https://staging-credits.repo.ing']]) {
    assert.throws(() => parseClaimArgs(args, {}), /AI credits are not open yet/, args.join(' '))
  }
  assert.throws(() => parseClaimArgs(['--convert', '0.5'], { REPOING_AI_CREDITS: 'true' }), /not open yet/, 'only exactly 1 turns them on')
  const opened = [], asked = []
  const io = { print: () => {}, ask: async question => { asked.push(question); return '2' }, open: async url => { opened.push(url); return true } }
  const result = await runClaim(off, { repository: 'https://github.com/octo/widget', io, fetchImpl: services().fetchImpl })
  assert.deepEqual([result.outcome, opened, asked], ['claim_page', ['https://repo.ing/claim/77'], []])
  assert.doesNotMatch(claimHelp(false), /convert|credits/i)
  assert.match(claimHelp(true), /--convert <SOL>/)
  const bin = new URL('../cli/bin/repoing.mjs', import.meta.url).pathname
  const env = { ...process.env, REPOING_AI_CREDITS: '' }
  const credits = await promisify(execFile)(process.execPath, [bin, 'credits', 'list'], { env }).catch(error => error)
  assert.equal(credits.code, 1)
  assert.match(credits.stderr, /^repoing: AI credits are not open yet\. repoing claim --to-wallet claims your fees to your wallet\.\n$/)
  const help = await promisify(execFile)(process.execPath, [bin, '--help'], { env })
  assert.doesNotMatch(help.stdout, /credits/)
})

test('a credit service that cannot be reached is named, not "fetch failed"', async () => {
  const unreachable = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(claimStatus({ origin: 'https://repo.ing', repository: 'r', fetchImpl: unreachable }), /^Error: repo\.ing could not be reached\.$/)
})
