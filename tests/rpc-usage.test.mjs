import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection } from '@solana/web3.js'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { backoffDelay, createRetryCircuit, createRpcMeter, creditsFor, readGenesisHash, retryAfterMs, retryRpcRead, rpcFetch,
  registerRpcEndpoint, rpcMethods, RpcLimitedError, transientRpcReason } from '../src/rpc-usage.mjs'

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

test('genesis hash is read once per connection and TTL, concurrent reads share it, failures are not kept', async () => {
  let clock = 0, calls = 0, fail = true
  const connection = { getGenesisHash: async () => { calls++; if (fail) throw Error('down'); return 'genesis' } }
  const now = () => clock
  await assert.rejects(readGenesisHash(connection, { now }), /down/)
  fail = false
  const [a, b] = await Promise.all([readGenesisHash(connection, { now }), readGenesisHash(connection, { now })])
  assert.deepEqual([a, b, calls], ['genesis', 'genesis', 2])
  assert.equal(await readGenesisHash(connection, { now }), 'genesis')
  assert.equal(calls, 2)
  clock += 3_600_000
  await readGenesisHash(connection, { now })
  assert.equal(calls, 3, 'expired after an hour')
  assert.equal(await readGenesisHash({ getGenesisHash: async () => 'other' }, { now }), 'other', 'per connection object')
})

test('transient RPC errors: 429 and 5xx (also inside a method message), meter limits, timeouts, dropped connections', async () => {
  // Raw transaction reads (finalized-transaction.mjs) report the HTTP status on the error.
  const rawRead = status => loadFinalizedTransaction({ rpcEndpoint: 'http://rpc.test' }, 'signature',
    async () => ({ ok: false, status, headers: new Headers() }), []).catch(error => error)
  const reasons = [
    Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":-32429,"message":"rate limited"}}'),
    Error('429 : rate limited'),
    Error('failed to get info about account So11111111111111111111111111111111111111112: Error: 503 Service Unavailable: upstream'),
    Error('524 : origin timed out'),
    await rawRead(429),
    await rawRead(503),
    new RpcLimitedError('primary', 20_000),
    Error('failed to get balance of account X: Error: RPC_RATE_LIMITED'),
    Object.assign(Error('failed to get info for accounts X: Node is behind by 42 slots'), { code: -32005 }),
    Error('failed to get info about account X: SolanaJSONRPCError: failed to get info about account X: Node is unhealthy'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    new TypeError('fetch failed', { cause: Object.assign(Error('read ECONNRESET'), { code: 'ECONNRESET' }) }),
    Error('failed to get info about account X: TypeError: fetch failed'),
  ].map(transientRpcReason)
  assert.deepEqual(reasons, ['HTTP 429', 'HTTP 429', 'HTTP 503', 'HTTP 524', 'HTTP 429', 'HTTP 503', 'rate limited', 'rate limited',
    'node unhealthy', 'node unhealthy', 'timeout', 'network', 'network'])
  assert.equal((await rawRead(404)).message, 'Solana RPC transaction read returned HTTP 404', 'the message is unchanged')
  assert.equal(transientRpcReason(await rawRead(404)), null)
  for (const error of [Error('400 Bad Request: {"error":"429 later"}'), Error('Market is not finalized and indexed'),
    Error('Invalid canonical DBC account'), Object.assign(Error('failed to get genesis hash: Invalid params'), { code: -32602 }),
    Error('Signature X has expired: block height exceeded.'), new TypeError("Cannot read properties of undefined (reading 'data')"), null]) {
    assert.equal(transientRpcReason(error), null, String(error?.message))
  }
})

const rateLimited = () => Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"}}')
function retryHarness(outcomes, { random = () => 0.5 } = {}) {
  const slept = [], retries = []
  let reads = 0
  const read = async () => { const next = outcomes[Math.min(reads++, outcomes.length - 1)]; if (next instanceof Error) throw next; return next }
  const options = { random, sleep: async ms => { slept.push(ms) }, onRetry: info => retries.push(info) }
  return { read, options, slept, retries, reads: () => reads }
}

test('a read that hits HTTP 429 once is retried after a jittered backoff and succeeds', async () => {
  const { read, options, slept, retries, reads } = retryHarness([rateLimited(), 'value'])
  assert.equal(await retryRpcRead(read, options), 'value')
  assert.equal(reads(), 2)
  assert.deepEqual(slept, [1500], 'first wait: half of 2 s fixed, half random')
  assert.deepEqual(retries, [{ attempt: 1, attempts: 4, delayMs: 1500, reason: 'HTTP 429' }])
})

test('a persistent 429 is tried four times with 1-2 s, 2-4 s, 4-8 s waits, then its error is thrown unchanged', async () => {
  const last = rateLimited()
  const slow = retryHarness([rateLimited(), rateLimited(), rateLimited(), last], { random: () => 1 })
  await assert.rejects(retryRpcRead(slow.read, slow.options), error => error === last)
  assert.equal(slow.reads(), 4)
  assert.deepEqual(slow.slept, [2000, 4000, 8000])
  assert.deepEqual(slow.retries.map(r => r.attempt), [1, 2, 3])
  const fast = retryHarness([rateLimited()], { random: () => 0 })
  await assert.rejects(retryRpcRead(fast.read, fast.options), /^Error: 429 Too Many Requests/)
  assert.deepEqual(fast.slept, [1000, 2000, 4000])
})

test('a backing-off meter is waited out (RpcLimitedError.retryInMs), each wait capped at 10 s', async () => {
  const short = retryHarness([new RpcLimitedError('primary', 6500), 'value'])
  assert.equal(await retryRpcRead(short.read, short.options), 'value')
  assert.deepEqual(short.slept, [6500], 'the provider asked for longer than the backoff step')
  const long = retryHarness([new RpcLimitedError('verification', 60_000), 'value'])
  await retryRpcRead(long.read, long.options)
  assert.deepEqual(long.slept, [10_000])
  assert.deepEqual(long.retries.map(r => r.reason), ['rate limited'])
  // getAccountInfo, getBalance and getLatestBlockhash re-wrap the refusal and lose retryInMs: wait the longest single wait.
  const wrapped = retryHarness([Error('failed to get recent blockhash: Error: RPC_RATE_LIMITED'), 'value'])
  await retryRpcRead(wrapped.read, wrapped.options)
  assert.deepEqual(wrapped.slept, [10_000])
})

test('a run circuit: after three reads in a row used up their retries, reads get one try until one succeeds', async () => {
  const opened = []
  const circuit = createRetryCircuit({ onOpen: info => opened.push(info) })
  const options = { circuit, random: () => 0.5, sleep: async () => {} }
  let tries = 0
  const limited = async () => { tries++; throw rateLimited() }
  for (let i = 0; i < 3; i++) await assert.rejects(retryRpcRead(limited, options), /^Error: 429/)
  assert.deepEqual([tries, opened], [12, [{ breakAfter: 3 }]])
  await assert.rejects(retryRpcRead(limited, options), /^Error: 429/)
  assert.equal(tries, 13, 'one try while open')
  await assert.rejects(retryRpcRead(async () => { throw Error('Invalid canonical DBC account') }, options), /Invalid canonical/)
  assert.equal(circuit.isOpen(), true, 'a non-transient error neither opens nor closes it')
  assert.equal(await retryRpcRead(async () => 'value', options), 'value')
  assert.equal(circuit.isOpen(), false, 'a success closes it')
  tries = 0
  await assert.rejects(retryRpcRead(limited, options), /^Error: 429/)
  assert.equal(tries, 4)
  assert.equal(opened.length, 1)
})

test('a non-transient error is thrown at once without a retry or a wait', async () => {
  const invalid = Error('Invalid canonical DBC account')
  const { read, options, slept, retries, reads } = retryHarness([invalid, 'never'])
  await assert.rejects(retryRpcRead(read, options), error => error === invalid)
  assert.equal(reads(), 1)
  assert.deepEqual([slept, retries], [[], []])
})

// A real web3.js Connection through the meter, as the sweep builds it; only the HTTP transport is scripted.
function meteredChain(script) {
  let clock = 0
  const sentAt = [], waits = []
  const sleep = who => async ms => { waits.push([who, ms]); clock += ms }
  const meter = createRpcMeter({ now: () => clock, random: () => 0.5, log: () => {}, sleep: sleep('meter'),
    baseFetch: async (url, init) => {
      const { id } = JSON.parse(init.body)
      sentAt.push(clock)
      const step = script.shift() ?? { status: 200 }
      if (step.status !== 200) return new Response('{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"}}',
        { status: step.status, statusText: 'Too Many Requests', headers: step.headers })
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: 'genesis-hash' }))
    } })
  const connection = new Connection('http://rpc.test', { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: meter.fetchFor('primary') })
  return { connection, sentAt, waits, sleep: sleep('retry') }
}

test('Retry-After on a real 429 is honoured: the read is not sent again until it has passed', async () => {
  const chain = meteredChain([{ status: 429, headers: { 'retry-after': '3' } }])
  const retries = []
  const hash = await retryRpcRead(() => chain.connection.getGenesisHash(), { random: () => 0.5, sleep: chain.sleep, onRetry: info => retries.push(info) })
  assert.equal(hash, 'genesis-hash')
  assert.deepEqual(chain.sentAt, [0, 3000])
  assert.deepEqual(retries.map(r => r.reason), ['HTTP 429'])
  assert.deepEqual(chain.waits, [['retry', 1500], ['meter', 1500]], 'the meter holds the retry until Retry-After')

  // Longer than a request may wait: the meter refuses without sending and the retries wait it out, 10 s at a time.
  const long = meteredChain([{ status: 429, headers: { 'retry-after': '25' } }])
  assert.equal(await retryRpcRead(() => long.connection.getGenesisHash(), { random: () => 0.5, sleep: long.sleep }), 'genesis-hash')
  assert.deepEqual(long.sentAt, [0, 25_000])
  assert.deepEqual(long.waits, [['retry', 1500], ['retry', 10_000], ['retry', 10_000], ['meter', 3500]])
})
