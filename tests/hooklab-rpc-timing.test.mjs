import test from 'node:test'
import assert from 'node:assert/strict'
import { timedFetch, withRpcTiming, rpcLabel, noteRpcRetry } from '../src/hooklab-rpc-timing.mjs'

const body = (method, params = []) => ({ method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
const reply = (status, text) => async () => new Response(text, { status })

test('each RPC call inside a request scope is recorded by host and method, never by URL or key', async () => {
  const lines = []
  const fetch = timedFetch(reply(200, '{"jsonrpc":"2.0","id":1,"result":{"value":[]}}'))
  await withRpcTiming(async () => {
    rpcLabel('native-launch review')
    await fetch('https://rpc.example.test/?api-key=SECRETKEY', body('getMultipleAccounts', [['a', 'b', 'c'], {}]))
    await fetch('https://other.example.test/', body('getSlot'))
    noteRpcRetry()
  }, line => lines.push(line))
  assert.equal(lines.length, 1)
  const [line] = lines
  assert.match(line, /^Hook Lab rpc native-launch review: 2 calls \d+ms/)
  assert.match(line, /rpc\.example\.test \d+ms\/1/)
  assert.match(line, /getMultipleAccounts\(3\)/)
  assert.match(line, /retries 1/)
  assert.doesNotMatch(line, /SECRETKEY|api-key|https?:/)
})

test('a 429 is counted, outside a scope nothing is recorded, and the response is passed through unchanged', async () => {
  const lines = []
  const fetch = timedFetch(reply(429, 'slow down'))
  const outside = await fetch('https://rpc.example.test/', body('getSlot'))
  assert.equal(outside.status, 429)
  await withRpcTiming(async () => {
    const response = await fetch('https://rpc.example.test/', body('getBlockHeight'))
    assert.equal(response.status, 429)
    assert.equal(await response.text(), 'slow down')
  }, line => lines.push(line))
  assert.match(lines[0], /429s 1/)
})

test('two concurrent scopes keep their own calls', async () => {
  const lines = []
  const fetch = timedFetch(reply(200, '{}'))
  await Promise.all(['a', 'b'].map(name => withRpcTiming(async () => {
    rpcLabel(name)
    await fetch('https://rpc.example.test/', body(name === 'a' ? 'getSlot' : 'getBalance'))
  }, line => lines.push(line))))
  assert.ok(lines.some(l => /rpc a: 1 calls/.test(l) && /getSlot/.test(l) && !/getBalance/.test(l)))
  assert.ok(lines.some(l => /rpc b: 1 calls/.test(l) && /getBalance/.test(l) && !/getSlot/.test(l)))
})
