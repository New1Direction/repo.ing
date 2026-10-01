import test from 'node:test'
import assert from 'node:assert/strict'
import { backoffDelay, createRpcMeter, creditsFor, retryAfterMs, rpcFetch, registerRpcEndpoint,
  rpcMethods, RpcLimitedError } from '../src/rpc-usage.mjs'

const call = (method, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params: [] })
const reply = (status, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(headers) })

function harness({ statuses = [], random = () => 0.5 } = {}) {
  let clock = 1_000_000
  const lines = [], slept = [], sent = []
  const meter = createRpcMeter({ now: () => clock, random, log: line => lines.push(JSON.parse(line)),
    sleep: async ms => { slept.push(ms); clock += ms },
    baseFetch: async (url, init) => { sent.push(rpcMethods(init.body)); return statuses.length ? statuses.shift() : reply(200) } })
  return { meter, lines, slept, sent, advance: ms => { clock += ms }, now: () => clock }
}

test('backoff doubles per consecutive failure with bounded jitter and a cap', () => {
  assert.equal(backoffDelay(1, { random: () => 0 }), 500)
  assert.equal(backoffDelay(1, { random: () => 1 }), 1000)
  assert.equal(backoffDelay(3, { random: () => 0 }), 2000)
  assert.equal(backoffDelay(3, { random: () => 1 }), 4000)
  assert.equal(backoffDelay(30, { random: () => 1 }), 300_000)
  assert.equal(backoffDelay(30, { random: () => 0 }), 150_000)
})

test('Retry-After seconds and HTTP dates are honoured; junk is ignored', () => {
  assert.equal(retryAfterMs('3'), 3000)
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4000), 6000)
  assert.equal(retryAfterMs('soon'), null)
  assert.equal(retryAfterMs(null), null)
})

test('JSON-RPC methods are read from single and batch bodies', () => {
  assert.deepEqual(rpcMethods(call('getSlot')), ['getSlot'])
  assert.deepEqual(rpcMethods(`[${call('getBalance')},${call('getBlockTime', 2)}]`), ['getBalance', 'getBlockTime'])
  assert.deepEqual(rpcMethods(Buffer.from(call('getTransaction'))), ['getTransaction'])
  assert.deepEqual(rpcMethods('not json'), ['unknown'])
  assert.equal(creditsFor('getProgramAccounts'), 10)
  assert.equal(creditsFor('getTransaction'), 1)
})

test('usage is counted per provider, method and job, then flushed as one compact line', async () => {
  const { meter, lines, advance } = harness()
  const primary = meter.fetchFor('primary'), verification = meter.fetchFor('verification')
  await meter.track('fees', async () => {
    await primary('https://primary.example', { body: call('getSignaturesForAddress') })
    await primary('https://primary.example', { body: call('getProgramAccounts') })
  })
  await meter.track('graduation', () => verification('https://public.example', { body: `[${call('getSlot')},${call('getSlot', 2)}]` }))
  await primary('https://primary.example', { body: call('getBalance') })
  advance(60_000)
  const usage = meter.flush().rpcUsage
  assert.equal(usage.calls, 5)
  assert.equal(usage.seconds, 60)
  assert.deepEqual(usage.byMethod, { primary: { getSignaturesForAddress: 1, getProgramAccounts: 1, getBalance: 1 }, verification: { getSlot: 2 } })
  assert.deepEqual(usage.byJob, { fees: { primary: 2 }, graduation: { verification: 2 }, other: { primary: 1 } })
  assert.deepEqual(usage.credits, { primary: 12, verification: 2 })
  assert.equal(meter.flush(), null, 'nothing new: no line')
  const stop = meter.report(10)
  await new Promise(resolve => setTimeout(resolve, 30))
  stop()
  assert.equal(lines.length, 0, 'idle periods log nothing')
})

test('HTTP 429 opens an exponential backoff: short waits are waited out, long ones fail fast without a request', async () => {
  const { meter, slept, sent, lines, advance } = harness({ statuses: [reply(429), reply(429), reply(429), reply(429), reply(429)] })
  const primary = meter.fetchFor('primary')
  const send = () => primary('https://primary.example', { body: call('getAccountInfo') })
  assert.equal((await send()).status, 429, 'the limited response still reaches the caller')
  assert.equal(meter.backoff('primary'), 750)
  assert.equal((await send()).status, 429)
  assert.deepEqual(slept, [750], 'a short backoff is waited out before sending')
  assert.equal(meter.backoff('primary'), 1500)
  for (let i = 0; i < 3; i++) await send()
  assert.equal(meter.backoff('primary'), 12_000)
  const before = sent.length
  await assert.rejects(send(), error => error instanceof RpcLimitedError && error.code === 'RPC_RATE_LIMITED' && error.provider === 'primary')
  assert.equal(sent.length, before, 'no request while backing off')
  assert.equal(lines.length, 1, 'rpcLimited is logged once per period')
  assert.deepEqual(Object.keys(lines[0]), ['rpcLimited'])
  assert.equal(lines[0].rpcLimited.provider, 'primary')
  assert.equal(lines[0].rpcLimited.status, 429)
  advance(60_000)
  assert.equal((await send()).status, 200, 'after the window one request probes the provider')
  assert.equal(meter.backoff('primary'), 0)
  const usage = meter.flush().rpcUsage
  assert.deepEqual(usage.limited, { primary: 5 })
  assert.deepEqual(usage.rejected, { primary: 1 })
})

test('a success resets the failure streak; Retry-After extends the window; other providers are unaffected', async () => {
  const { meter, advance } = harness({ statuses: [reply(429), reply(200), reply(429, { 'retry-after': '30' })] })
  const primary = meter.fetchFor('primary'), verification = meter.fetchFor('verification')
  await primary('u', { body: call('getSlot') })
  advance(1000)
  await primary('u', { body: call('getSlot') })
  await primary('u', { body: call('getSlot') })
  assert.equal(meter.backoff('primary'), 30_000, 'streak restarted at one failure, Retry-After wins')
  await assert.rejects(primary('u', { body: call('getSlot') }), RpcLimitedError)
  assert.equal((await verification('v', { body: call('getSlot') })).status, 200)
})

test('later limits while already backing off do not escalate the streak again', async () => {
  const { meter } = harness({ statuses: [reply(429), reply(429)] })
  const primary = meter.fetchFor('primary')
  // Two requests already in flight when the provider started limiting.
  await Promise.all([primary('u', { body: call('getSlot') }), primary('u', { body: call('getSlot') })])
  assert.equal(meter.backoff('primary'), 750)
})

test('raw fetches find their provider by endpoint; unknown endpoints use the global fetch', () => {
  const metered = async () => reply(200)
  registerRpcEndpoint('https://rpc.example/', metered)
  assert.equal(rpcFetch('https://rpc.example'), metered)
  assert.equal(rpcFetch('https://other.example'), globalThis.fetch)
})
