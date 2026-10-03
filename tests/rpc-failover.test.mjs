import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, PublicKey } from '@solana/web3.js'
import { createFailoverFetch, verificationRpcUrls } from '../src/rpc-failover.mjs'
import { createRpcMeter, RpcLimitedError } from '../src/rpc-usage.mjs'

const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] })
const answer = (status, text = '{}') => new Response(text, { status })

// A provider whose answers are scripted per call; it records the URL and init it was asked with.
function provider(url, ...answers) {
  const asked = []
  return { url, asked, fetch: async (target, init) => {
    asked.push({ target, init })
    const next = answers.shift() ?? answer(200)
    if (next instanceof Error) throw next
    return next
  } }
}

test('verification URLs: the main one first, then fallbacks in order, trimmed and deduplicated', () => {
  assert.deepEqual(verificationRpcUrls({}), [])
  assert.deepEqual(verificationRpcUrls({ GRADUATION_VERIFICATION_FALLBACK_RPC_URLS: 'https://b.test' }), [])
  assert.deepEqual(verificationRpcUrls({ SOLANA_RPC_URL: 'https://primary.test', GRADUATION_VERIFICATION_RPC_URL: 'https://a.test',
    GRADUATION_VERIFICATION_FALLBACK_RPC_URLS: ' https://b.test , ,https://c.test,https://b.test,https://a.test' }),
  ['https://a.test', 'https://b.test', 'https://c.test'])
})

test('verification URLs: a fallback on the primary provider\'s host or an invalid one is dropped', () => {
  assert.deepEqual(verificationRpcUrls({ SOLANA_RPC_URL: 'https://mainnet.primary.test/?api-key=one', GRADUATION_VERIFICATION_RPC_URL: 'https://a.test',
    GRADUATION_VERIFICATION_FALLBACK_RPC_URLS: 'https://mainnet.primary.test/?api-key=two,not a url,https://b.test' }), ['https://a.test', 'https://b.test'])
})

test('the first provider that answers is used, each asked at its own URL with the same request', async () => {
  const a = provider('https://a.test'), b = provider('https://b.test')
  const init = { method: 'POST', body }
  const response = await createFailoverFetch([a, b])('https://a.test', init)
  assert.equal(response.status, 200)
  assert.deepEqual(a.asked, [{ target: 'https://a.test', init }])
  assert.equal(b.asked.length, 0)
})

test('a refusal passes the same request to the next provider, whatever the status', async () => {
  for (const status of [429, 403, 400, 500, 503]) {
    const refused = answer(status, '{"error":"no"}')
    const a = provider('https://a.test', refused), b = provider('https://b.test', answer(200, '{"result":1}'))
    const init = { method: 'POST', body }
    const response = await createFailoverFetch([a, b])('https://a.test', init)
    assert.equal(await response.text(), '{"result":1}')
    assert.deepEqual(b.asked, [{ target: 'https://b.test', init }])
    assert.equal(refused.bodyUsed, true, `the refused ${status} body is released`)
  }
})

test('transient errors pass to the next provider: a meter backoff refusal, a timeout, a dropped connection', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  for (const error of [new RpcLimitedError('verification', 60_000), timeout, new TypeError('fetch failed')]) {
    const b = provider('https://b.test')
    const response = await createFailoverFetch([provider('https://a.test', error), b])('https://a.test', { body })
    assert.equal(response.status, 200)
    assert.equal(b.asked.length, 1)
  }
})

test('a non-transient error is thrown at once; later providers are not asked', async () => {
  const b = provider('https://b.test')
  await assert.rejects(createFailoverFetch([provider('https://a.test', new Error('bad request body')), b])('https://a.test', { body }), /bad request body/)
  assert.equal(b.asked.length, 0)
})

test('the last provider\'s own refusal or error is returned unchanged; one provider behaves as without failover', async () => {
  const response = await createFailoverFetch([provider('https://a.test', answer(429)), provider('https://b.test', answer(429, 'last'))])('https://a.test', { body })
  assert.equal(response.status, 429)
  assert.equal(await response.text(), 'last')
  const single = await createFailoverFetch([provider('https://a.test', answer(403, 'only'))])('https://a.test', { body })
  assert.equal(await single.text(), 'only')
  await assert.rejects(createFailoverFetch([provider('https://a.test', new TypeError('fetch failed'))])('https://a.test', { body }), /fetch failed/)
  assert.throws(() => createFailoverFetch([]), /At least one RPC provider/)
})

test('a caller\'s own abort is never failed over', async () => {
  const controller = new AbortController()
  controller.abort()
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'TimeoutError' })
  const b = provider('https://b.test')
  await assert.rejects(createFailoverFetch([provider('https://a.test', aborted), b])('https://a.test', { body, signal: controller.signal }), /aborted/)
  assert.equal(b.asked.length, 0)
})

// The production case behind failover: from a shared cloud IP, the first free provider rate-limits address history
// (HTTP 429, Retry-After 10) and the second blocks batched account reads (HTTP 403). Through metered fetches and a real
// web3.js Connection, every read is still answered, and each provider's calls are counted under its own name.
test('per-request failover through the meter answers every read when each provider refuses a different call', async () => {
  let clock = 0
  const lines = []
  const meter = createRpcMeter({ now: () => clock, random: () => 0.5, log: line => lines.push(JSON.parse(line)), sleep: async ms => { clock += ms },
    baseFetch: async (url, init) => {
      const { id, method } = JSON.parse(init.body)
      const refuse = url === 'https://a.test' ? method === 'getSignaturesForAddress' : method === 'getMultipleAccounts'
      if (refuse) return new Response('{"jsonrpc":"2.0","error":{"code":429,"message":"refused"}}',
        { status: url === 'https://a.test' ? 429 : 403, headers: url === 'https://a.test' ? { 'retry-after': '10' } : {} })
      const result = method === 'getSignaturesForAddress'
        ? [{ signature: `from-${new URL(url).host}`, slot: 7, err: null, memo: null, blockTime: 1, confirmationStatus: 'finalized' }]
        : { context: { slot: 7 }, value: [null] }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } })
  const urls = ['https://a.test', 'https://b.test']
  const fetch = createFailoverFetch(urls.map((url, index) => ({ url, fetch: meter.fetchFor(index ? `verification${index + 1}` : 'verification') })))
  const connection = new Connection(urls[0], { commitment: 'finalized', disableRetryOnRateLimit: true, fetch })
  const address = new PublicKey('FHw49kTEEjzBhRuMff9F1Xw1bLcBpwvsaSboaAWpAcaT')

  const history = await connection.getSignaturesForAddress(address, { limit: 100 }, 'finalized')
  assert.deepEqual(history.map(item => item.signature), ['from-b.test'])
  // The first provider is now backing off for 10 s; its next call waits that out instead of failing over.
  assert.deepEqual(await connection.getMultipleAccountsInfo([address], 'finalized'), [null])
  assert.equal(clock, 10_000)

  const { rpcUsage } = meter.flush()
  assert.deepEqual(rpcUsage.byMethod, { verification: { getSignaturesForAddress: 1, getMultipleAccounts: 1 }, verification2: { getSignaturesForAddress: 1 } })
  assert.deepEqual(rpcUsage.limited, { verification: 1 })
})
