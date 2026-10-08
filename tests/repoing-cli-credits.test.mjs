import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_INFERENCE_ORIGIN, parseCreditsArgs, runCredits, runCreditsBuy, runCreditsKey, usdToMicro } from '../cli/src/credits.mjs'

// `repoing credits key` (cli/src/credits.mjs): arguments, amounts, and the whole flow with repo.ing and the credit service
// scripted (the sign-in listener is real, on 127.0.0.1).
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })
const TOKEN = `rik_${'ab'.repeat(32)}`

test('arguments: a USD limit in cents, a label, safe origins', () => {
  assert.deepEqual(parseCreditsArgs(['key', 'octo/widget'], {}), { command: 'credits-key', repository: 'octo/widget', keyId: null, limitMicro: null, packMicro: null, label: 'coding-tool',
    open: true, origin: 'https://repo.ing', creditsOrigin: 'https://credits.repo.ing', inferenceOrigin: DEFAULT_INFERENCE_ORIGIN })
  assert.equal(DEFAULT_INFERENCE_ORIGIN, 'https://inference.repo.ing')
  const custom = parseCreditsArgs(['key', '--limit', '20.5', '--label', 'cursor laptop', '--inference-origin', 'https://ai.example/x'], {})
  assert.deepEqual([custom.limitMicro, custom.label, custom.inferenceOrigin], [20_500_000, 'cursor laptop', 'https://ai.example'])
  assert.equal(parseCreditsArgs(['key'], { REPOING_INFERENCE_ORIGIN: 'https://ai.example' }).inferenceOrigin, 'https://ai.example')
  assert.deepEqual([usdToMicro('0.01'), usdToMicro('$12'), usdToMicro('1000000')], [10_000, 12_000_000, 1_000_000_000_000])
  const KEY_ID = '0F8FAD5B-D9CB-469F-A165-70867728950E'
  assert.deepEqual([parseCreditsArgs(['revoke', KEY_ID], {}).command, parseCreditsArgs(['revoke', KEY_ID], {}).keyId], ['credits-revoke', KEY_ID.toLowerCase()])
  assert.equal(parseCreditsArgs(['list', 'octo/widget'], {}).repository, 'octo/widget')
  for (const [args, message] of [[[], /key\|list\|revoke/], [['keys'], /key\|list\|revoke/], [['revoke'], /needs a key ID/], [['revoke', 'nope'], /needs a key ID/],
    [['list', '--limit', '5'], /is for repoing credits key/], [['key', '--limit', '0'], /at least \$0\.01/],
    [['key', '--limit', '1.005'], /like 20 or 20\.50/], [['key', '--limit', '-1'], /requires a value/], [['key', '--label', 'a\tb'], /label/],
    [['key', '--label', 'x'.repeat(65)], /label/], [['key', '--inference-origin', 'http://ai.example'], /HTTPS/], [['key', '--bogus'], /Unknown/]]) {
    assert.throws(() => parseCreditsArgs(args, {}), message, args.join(' '))
  }
  assert.deepEqual([parseCreditsArgs(['buy'], {}).command, parseCreditsArgs(['buy'], {}).packMicro], ['credits-buy', null])
  assert.deepEqual([parseCreditsArgs(['buy', '25'], {}).packMicro, parseCreditsArgs(['buy', '$50', 'octo/widget'], {}).repository], [25_000_000, 'octo/widget'])
  assert.deepEqual([parseCreditsArgs(['buy', 'octo/widget', '100'], {}).packMicro, parseCreditsArgs(['buy', 'octo/widget'], {}).repository], [100_000_000, 'octo/widget'])
  for (const args of [['buy', '30'], ['buy', '$5'], ['buy', '25', '50']]) assert.throws(() => parseCreditsArgs(args, {}), /\$10, \$25, \$50 or \$100/, args.join(' '))
  assert.throws(() => parseCreditsArgs(['buy', '--limit', '5'], {}), /is for repoing credits key/)
  assert.equal(parseCreditsArgs(['--help'], {}).command, 'credits-help')
  assert.equal(parseCreditsArgs(['key', '--help'], {}).command, 'credits-help')
})

// repo.ing and the credit service, scripted; every request recorded.
const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const QUOTE_ID = '2f8fad5b-d9cb-469f-a165-70867728950e'
const PAY_URL = `solana:7WZRJ4to98TLKhiWqoNfqWwYcxrqN8KsBJWXdTxq2KUY?amount=0.166666667&reference=Ref1111111111111111111111111111111111111111&label=repo.ing%20AI%20credits&message=Credit%20pack%20${QUOTE_ID}`
const OFFER = { sales: 'sandbox', account_room_micro: 250_000_000, quote_seconds: 900, policy: { odds_version: 'sol-pack-v1', probability_denominator: 10_000,
  outcomes: [{ multiplier_bps: 10_000, probability_bps: 9_715 }, { multiplier_bps: 12_000, probability_bps: 250 }, { multiplier_bps: 20_000, probability_bps: 30 },
    { multiplier_bps: 50_000, probability_bps: 5 }], expected_multiplier_bps: 10_100 } }
function services({ mint = 'MintWidget', paid = 75_000_000, refuse = null, token = `rik_${'cd'.repeat(32)}`, offer = OFFER, payUrl = PAY_URL, network = 'devnet' } = {}) {
  const requests = []
  const fetchImpl = async (url, init = {}) => {
    const target = new URL(url), body = init.body ? JSON.parse(init.body) : null
    requests.push({ url: target.href, method: init.method ?? 'GET', body, headers: init.headers })
    if (target.pathname === '/api/resolve') return json({ repoId: '77', mint })
    if (target.pathname === '/sessions') return json({ account_id: 'a', login: 'octocat', repo_id: '77', token: TOKEN })
    if (target.pathname === '/account') return json({ account_id: 'a', github_login: 'octocat', paid_available: paid, credits_available: paid, quotes: [] })
    if (target.pathname === '/keys' && init.method === 'POST') return refuse ? json({ error: refuse }, 400)
      : json({ key: { id: KEY_ID, scope: 'inference', label: body.label, budget_micro: body.budget_micro, expires_at: '2026-11-06T19:00:00Z' },
        token, replayed: false })
    if (target.pathname === '/keys') return json({ keys: [
      { id: KEY_ID, label: 'cursor', budget_micro: 20_000_000, spent_micro: 1_500_000, revoked: false, expires_at: '2099-01-01T00:00:00Z' },
      { id: '1f8fad5b-d9cb-469f-a165-70867728950e', label: 'evil\u001b[2Jlabel', budget_micro: 1, spent_micro: 0, revoked: true, expires_at: '2099-01-01T00:00:00Z' },
      { id: 'not-an-id', label: 'x' }] })
    if (target.pathname === `/keys/${KEY_ID}/revoke`) return json({ id: KEY_ID, revoked: true })
    if (target.pathname === '/packs' && init.method === 'POST') return json({ id: QUOTE_ID, kind: 'pack', status: 'awaiting_payment', pack_micro: body.pack_micro,
      lamports: 166_666_667, credit_micro: body.pack_micro, price_micro_per_sol: 150_000_000, expires_at: '2026-10-08T12:15:00Z', spin: null, solana_pay_url: payUrl, network })
    if (target.pathname === '/packs') return json(offer)
    return json({ error: 'not found' }, 404)
  }
  return { fetchImpl, requests }
}
const options = extra => ({ origin: 'https://repo.ing', creditsOrigin: 'http://127.0.0.1:8794', inferenceOrigin: 'http://127.0.0.1:8788', open: true,
  limitMicro: null, label: 'coding-tool', ...extra })
// The browser: approves at once and repo.ing redirects to the listener with the code and the state.
const browser = (printed, answers = []) => ({ print: line => printed.push(line), ask: async () => answers.shift() ?? '', open: async url => {
  const start = new URL(url)
  setTimeout(() => fetch(`http://127.0.0.1:${start.searchParams.get('port')}/callback?code=${'k'.repeat(43)}&state=${start.searchParams.get('state')}`), 10)
  return true
} })

test('a key: sign in through repo.ing, choose a limit within the credits, the token and the endpoint printed once', async () => {
  const { fetchImpl, requests } = services()
  const printed = []
  const result = await runCreditsKey(options(), { repository: 'https://github.com/octo/widget', io: browser(printed, ['20']), fetchImpl })
  assert.deepEqual(result, { outcome: 'key', keyId: KEY_ID, budgetMicro: 20_000_000, expiresAt: '2026-11-06T19:00:00Z' }, 'the token is not returned')
  const keys = requests.find(r => r.url.endsWith('/keys'))
  assert.deepEqual([keys.body, keys.headers.authorization], [{ label: 'coding-tool', budget_micro: 20_000_000 }, `Bearer ${TOKEN}`])
  assert.match(keys.headers['idempotency-key'], /^[A-Za-z0-9_-]{22}$/)
  assert.equal(requests.find(r => r.url.endsWith('/account')).headers.authorization, `Bearer ${TOKEN}`)
  assert.ok(printed.some(line => /You have \$75\.00 of AI credits/.test(line)), printed.join('\n'))
  assert.ok(printed.includes('OPENAI_BASE_URL=http://127.0.0.1:8788/v1'))
  assert.ok(printed.includes(`OPENAI_API_KEY=rik_${'cd'.repeat(32)}`))
  assert.ok(printed.some(line => /spending limit \$20\.00/.test(line) && /inference only/.test(line) && line.includes(KEY_ID)))
  assert.ok(printed.includes(`If it leaks, revoke it: repoing credits revoke ${KEY_ID}`))
})

test('a malformed token from the service is never printed', async () => {
  const printed = []
  await assert.rejects(runCreditsKey(options({ limitMicro: 1_000_000 }), { repository: 'r', io: browser(printed),
    fetchImpl: services({ token: 'rik_x\nOPENAI_BASE_URL=https://evil.example' }).fetchImpl }), /invalid key.*repoing credits list/)
  assert.equal(printed.some(line => /OPENAI_/.test(line)), false)
})

test('list shows the keys without foreign text; revoke stops one', async () => {
  const listed = [], list = services()
  const result = await runCredits(options({ command: 'credits-list' }), { repository: 'r', io: browser(listed), fetchImpl: list.fetchImpl })
  assert.deepEqual(result.keys.map(key => [key.id, key.revoked]), [[KEY_ID, false], ['1f8fad5b-d9cb-469f-a165-70867728950e', true]])
  assert.ok(listed.some(line => line.startsWith(KEY_ID) && /live/.test(line) && /limit \$20\.00, spent \$1\.50, until 2099-01-01/.test(line)), listed.join('\n'))
  assert.ok(listed.some(line => /revoked +\?/.test(line)), 'a label with control characters is not printed')
  assert.equal(listed.some(line => line.includes('\u001b')), false)
  const revoked = [], revoke = services()
  assert.deepEqual(await runCredits(options({ command: 'credits-revoke', keyId: KEY_ID }), { repository: 'r', io: browser(revoked), fetchImpl: revoke.fetchImpl }),
    { outcome: 'revoked', keyId: KEY_ID })
  const call = revoke.requests.find(r => r.url.endsWith('/revoke'))
  assert.deepEqual([call.method, call.headers.authorization], ['POST', `Bearer ${TOKEN}`])
})

test('the limit: the default is all credits; above the credits is refused before the request; no credits says how to get them', async () => {
  const all = services()
  await runCreditsKey(options(), { repository: 'r', io: browser([], ['']), fetchImpl: all.fetchImpl })
  assert.equal(all.requests.find(r => r.url.endsWith('/keys')).body.budget_micro, 75_000_000)
  const over = services()
  await assert.rejects(runCreditsKey(options({ limitMicro: 80_000_000 }), { repository: 'r', io: browser([]), fetchImpl: over.fetchImpl }), /at most \$75\.00/)
  assert.equal(over.requests.some(r => r.url.endsWith('/keys')), false)
  const none = services({ paid: 0 }), printed = []
  assert.equal((await runCreditsKey(options(), { repository: 'r', io: browser(printed), fetchImpl: none.fetchImpl })).outcome, 'no_credits')
  assert.ok(printed.some(line => /repoing claim --convert/.test(line)))
  assert.equal(none.requests.some(r => r.url.endsWith('/keys')), false)
})

test('no market: no sign-in; a refusal from the ledger is shown as it is', async () => {
  const opened = []
  const io = { print: () => {}, ask: async () => '', open: async url => { opened.push(url); return true } }
  assert.equal((await runCreditsKey(options(), { repository: 'r', io, fetchImpl: services({ mint: null }).fetchImpl })).outcome, 'no_market')
  assert.deepEqual(opened, [])
  await assert.rejects(runCreditsKey(options({ limitMicro: 1_000_000 }), { repository: 'r', io: browser([]), fetchImpl: services({ refuse: 'too many live keys' }).fetchImpl }),
    /too many live keys/)
})

// `repoing credits buy`: a SOL credit pack (repo-inference docs/PACKS.md), with the payment's wait scripted.
const spun = (multiplier, extra = {}) => async () => ({ id: QUOTE_ID, status: 'credited', review_pending: false, pack_micro: 25_000_000,
  spin: { multiplier_bps: multiplier, paid_micro: 25_000_000, bonus_micro: 25_000_000 * (multiplier - 10_000) / 10_000, odds_version: 'sol-pack-v1', plush: false, ...extra } })

test('buy: the odds before the price, a confirmed pack, the Solana Pay link, then the spin', async () => {
  const { fetchImpl, requests } = services()
  const printed = []
  const result = await runCreditsBuy(options({ command: 'credits-buy', packMicro: null }), { repository: 'r', io: browser(printed, ['25', 'y']), fetchImpl, wait: spun(12_000) })
  assert.deepEqual(result, { outcome: 'credited', quote: QUOTE_ID, multiplierBps: 12_000, paidMicro: 25_000_000, bonusMicro: 5_000_000 })
  const text = printed.join('\n')
  for (const line of [/97\.15% +1x/, /2\.50% +1\.2x/, /0\.30% +2x/, /0\.05% +5x/, /never less than you pay/i, /never turn into cash/i]) assert.match(text, line)
  const pack = requests.find(r => r.url.endsWith('/packs') && r.method === 'POST')
  assert.deepEqual([pack.body, pack.headers.authorization], [{ pack_micro: 25_000_000 }, `Bearer ${TOKEN}`])
  assert.match(pack.headers['idempotency-key'], /^[A-Za-z0-9_-]{22}$/)
  const link = printed.indexOf(PAY_URL)
  assert.ok(link > 20 && printed.slice(link - 20, link).every(line => /^[█▀▄ ]+$/.test(line)), 'the link on its own line, after its QR code')
  assert.match(text, /Pay exactly 0\.166666667 SOL/)
  assert.match(text, /1\.2x.*\$25\.00 of AI credits \+ \$5\.00 bonus/)
})

test('buy: nothing is asked for when the buyer says no, sales are off, or the day has no room', async () => {
  const no = services()
  assert.equal((await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser([], ['n']), fetchImpl: no.fetchImpl, wait: spun(10_000) })).outcome, 'cancelled')
  assert.equal(no.requests.some(r => r.url.endsWith('/packs') && r.method === 'POST'), false)
  const off = services({ offer: { sales: 'off', account_room_micro: 0, policy: OFFER.policy } }), offPrinted = []
  assert.equal((await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(offPrinted, ['y']), fetchImpl: off.fetchImpl, wait: spun(10_000) })).outcome, 'off')
  assert.ok(offPrinted.some(line => /not on sale yet/.test(line)))
  const full = services({ offer: { ...OFFER, account_room_micro: 10_000_000 } }), fullPrinted = []
  assert.equal((await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(fullPrinted, ['y']), fetchImpl: full.fetchImpl, wait: spun(10_000) })).outcome, 'no_room')
  assert.ok(fullPrinted.some(line => /\$10\.00 left today/.test(line)))
  for (const s of [off, full]) assert.equal(s.requests.some(r => r.url.endsWith('/packs') && r.method === 'POST'), false)
})

test('buy: review, expiry and a malformed link or spin are reported without foreign text', async () => {
  const review = []
  const waitReview = async () => ({ id: QUOTE_ID, status: 'awaiting_payment', review_pending: true, spin: null })
  assert.equal((await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(review, ['y']), fetchImpl: services().fetchImpl, wait: waitReview })).outcome, 'review')
  assert.ok(review.some(line => /review/.test(line) && /no spin/.test(line)))
  const expired = []
  assert.equal((await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(expired, ['y']), fetchImpl: services().fetchImpl,
    wait: async () => ({ id: QUOTE_ID, status: 'expired', review_pending: false, spin: null }) })).outcome, 'expired')
  const evil = []
  await assert.rejects(runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(evil, ['y']),
    fetchImpl: services({ payUrl: 'solana:x?amount=1\n\u001b[2Jpay https://evil.example' }).fetchImpl, wait: spun(10_000) }), /invalid (quote|payment link)/)
  assert.equal(evil.some(line => /evil|\u001b/.test(line)), false)
  await assert.rejects(runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser([], ['y']), fetchImpl: services().fetchImpl,
    wait: spun(12_000, { bonus_micro: 999 }) }), /invalid spin/)
})

test('buy: live sales are on sale too; a devnet quote says to set the wallet to devnet, a mainnet one does not', async () => {
  const live = services({ offer: { ...OFFER, sales: 'live' }, network: 'mainnet' }), printed = []
  const result = await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(printed, ['y']), fetchImpl: live.fetchImpl, wait: spun(10_000) })
  assert.equal(result.outcome, 'credited')
  assert.equal(printed.some(line => /devnet/i.test(line)), false, 'mainnet: no devnet note')
  const test = services(), testPrinted = []
  await runCreditsBuy(options({ packMicro: 25_000_000 }), { repository: 'r', io: browser(testPrinted, ['y']), fetchImpl: test.fetchImpl, wait: spun(10_000) })
  assert.ok(testPrinted.some(line => /devnet test quote: set your wallet to Devnet/.test(line)), testPrinted.join('\n'))
})
