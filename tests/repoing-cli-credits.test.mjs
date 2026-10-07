import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_INFERENCE_ORIGIN, parseCreditsArgs, runCredits, runCreditsKey, usdToMicro } from '../cli/src/credits.mjs'

// `repoing credits key` (cli/src/credits.mjs): arguments, amounts, and the whole flow with repo.ing and the credit service
// scripted (the sign-in listener is real, on 127.0.0.1).
const json = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value })
const TOKEN = `rik_${'ab'.repeat(32)}`

test('arguments: a USD limit in cents, a label, safe origins', () => {
  assert.deepEqual(parseCreditsArgs(['key', 'octo/widget'], {}), { command: 'credits-key', repository: 'octo/widget', keyId: null, limitMicro: null, label: 'coding-tool',
    open: true, origin: 'https://repo.ing', creditsOrigin: 'http://127.0.0.1:8794', inferenceOrigin: DEFAULT_INFERENCE_ORIGIN })
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
  assert.equal(parseCreditsArgs(['--help'], {}).command, 'credits-help')
  assert.equal(parseCreditsArgs(['key', '--help'], {}).command, 'credits-help')
})

// repo.ing and the credit service, scripted; every request recorded.
const KEY_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
function services({ mint = 'MintWidget', paid = 75_000_000, refuse = null, token = `rik_${'cd'.repeat(32)}` } = {}) {
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
