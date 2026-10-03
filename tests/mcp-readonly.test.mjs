import test from 'node:test'
import assert from 'node:assert/strict'
import * as z from 'zod/v4'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { PROTOCOL_VERSIONS, allowedOrigin, boundedRead, createStatelessMcpHandler } from '../app/lib/mcp.mjs'
import { READ_ONLY_SERVER, readOnlyTools } from '../app/lib/mcp-read-tools.mjs'
import { HF_DISCLAIMER } from '../src/hf-copy.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

// The read-only MCP endpoint (app/api/mcp/readonly): JSON-RPC and Streamable HTTP rules on a one-tool server, the route's
// wiring with a fake PostgreSQL pool, and the official MCP client end to end. Tool answers: tests/mcp-read-tools.test.mjs.
const URL_ = 'https://repo.ing/api/mcp/readonly'
const echoInput = z.object({ text: z.string().max(10) }).strict()
const echo = { input: echoInput, call: async ({ text }) => text === 'boom' ? Promise.reject(Error('database password=secret')) : { content: [{ type: 'text', text }] },
  definition: { name: 'echo', description: 'Echo text.', inputSchema: z.toJSONSchema(echoInput, { io: 'input' }), annotations: { readOnlyHint: true } } }
const server = { name: 'repo.ing', title: 'repo.ing (read-only)', version: '1.0.0', instructions: 'Read-only.' }
const handler = (options = {}) => createStatelessMcpHandler({ server, tools: [echo], allowOrigin: origin => origin === 'https://repo.ing', ...options })
const post = (body, headers = {}) => new Request(URL_, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } })
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params !== undefined && { params }) })
const init = protocolVersion => rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } })
const send = async (body, headers, options) => { const response = await handler(options)(post(body, headers)); return { response, body: await response.text() } }
const json = async (body, headers, options) => { const { response, body: text } = await send(body, headers, options); return { status: response.status, message: JSON.parse(text), response } }

test('initialize answers with the server identity, the tools capability and instructions, and opens no session', async () => {
  const { status, message, response } = await json(init('2025-06-18'))
  assert.equal(status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal(response.headers.get('mcp-session-id'), null)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(message, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'repo.ing', title: 'repo.ing (read-only)', version: '1.0.0' }, instructions: 'Read-only.' } })
})

test('version negotiation: a supported version is echoed, any other gets the newest supported', async () => {
  assert.deepEqual(PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26'])
  for (const [requested, answered] of [['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2025-11-25', '2025-06-18'],
    ['2026-07-28', '2025-06-18'], ['2024-11-05', '2025-06-18'], ['1900-01-01', '2025-06-18']]) {
    assert.equal((await json(init(requested))).message.result.protocolVersion, answered, requested)
  }
})

test('notifications and replies to the server are accepted with 202 and no body', async () => {
  for (const message of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', method: 'notifications/anything-else' }, { jsonrpc: '2.0', id: 7, result: {} }, { jsonrpc: '2.0', id: 8, error: { code: -1, message: 'no' } }]) {
    const { response, body } = await send(message)
    assert.equal(response.status, 202, JSON.stringify(message)); assert.equal(body, '')
  }
})

test('ping answers {} and tools/list lists the tools as defined', async () => {
  assert.deepEqual((await json(rpc('ping', undefined, 'p-1'))).message, { jsonrpc: '2.0', id: 'p-1', result: {} })
  assert.deepEqual((await json(rpc('tools/list', {}))).message.result, { tools: [echo.definition] })
  assert.equal((await json(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }))).message.result.content[0].text, 'hi')
})

test('JSON-RPC errors: parse error, batch, invalid request, unknown method and invalid params', async () => {
  const cases = [
    ['{"jsonrpc":"2.0",', 400, -32700, null], ['', 400, -32700, null],
    [[rpc('ping'), rpc('ping', undefined, 2)], 400, -32600, null],
    [{ id: 1, method: 'ping' }, 400, -32600, 1], [{ jsonrpc: '1.0', id: 1, method: 'ping' }, 400, -32600, 1], ['"text"', 400, -32600, null],
    [{ jsonrpc: '2.0', id: null, method: 'ping' }, 400, -32600, null], [{ jsonrpc: '2.0', id: {}, method: 'ping' }, 400, -32600, null],
    [{ jsonrpc: '2.0', id: 1, method: 5 }, 400, -32600, 1], [{ jsonrpc: '2.0', id: 1 }, 400, -32600, 1], [rpc('ping', 'x'), 400, -32600, 1],
    [rpc('resources/list', {}), 200, -32601, 1], [rpc('constructor'), 200, -32601, 1], [rpc('sign_transaction', {}), 200, -32601, 1],
    [rpc('initialize', {}), 200, -32602, 1], [rpc('initialize', { protocolVersion: 20250618 }), 200, -32602, 1],
    [rpc('tools/call', {}), 200, -32602, 1], [rpc('tools/call', { name: 'launch_token', arguments: {} }), 200, -32602, 1],
    [rpc('tools/call', { name: 'echo', arguments: 'hi' }), 200, -32602, 1], [rpc('tools/call', { name: 'echo', arguments: { text: 'x'.repeat(11) } }), 200, -32602, 1],
    [rpc('tools/call', { name: 'echo', arguments: { text: 'hi', privateKey: 'must-not-be-accepted' } }), 200, -32602, 1],
  ]
  for (const [body, status, code, id] of cases) {
    const { status: actual, message } = await json(body)
    assert.equal(actual, status, JSON.stringify(body)); assert.equal(message.error.code, code, JSON.stringify(body)); assert.equal(message.id, id, JSON.stringify(body))
    assert.equal(message.jsonrpc, '2.0'); assert.equal(message.result, undefined)
  }
  assert.match((await json(rpc('tools/call', { name: 'echo', arguments: { text: 'hi', privateKey: 'x' } }))).message.error.message, /Unrecognized key: "privateKey"/)
})

test('a failing tool is a tool error result that does not leak its cause', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { status, message } = await json(rpc('tools/call', { name: 'echo', arguments: { text: 'boom' } }))
  assert.equal(status, 200); assert.equal(message.result.isError, true)
  assert.doesNotMatch(JSON.stringify(message), /password|secret/)
})

test('GET, DELETE and other methods answer 405 with Allow: POST', async () => {
  for (const method of ['GET', 'DELETE', 'PUT']) {
    const response = await handler()(new Request(URL_, { method, headers: { accept: 'text/event-stream' } }))
    assert.equal(response.status, 405, method); assert.equal(response.headers.get('allow'), 'POST')
  }
})

test('Origin: a foreign origin gets 403 before the quota counts it; the site and server-to-server clients pass', async () => {
  let counted = 0
  const quota = async () => { counted++; return true }
  for (const origin of ['https://evil.example', 'null', 'http://repo.ing', 'https://repo.ing.evil.example']) {
    const { status, message } = await json(rpc('ping'), { origin }, { quota })
    assert.equal(status, 403, origin); assert.equal(message.id, null)
  }
  assert.equal(counted, 0)
  assert.equal((await json(rpc('ping'), { origin: 'https://repo.ing' }, { quota })).status, 200)
  assert.equal((await json(rpc('ping'), {}, { quota })).status, 200)
  assert.equal(counted, 2)
  // The route's rule: the configured site origin, and localhost only outside production; without a configured origin a
  // DNS-rebinding page (any other host pointed at a developer's machine) is refused.
  assert.equal(allowedOrigin('https://repo.ing', 'https://repo.ing', { NODE_ENV: 'production' }), true)
  assert.equal(allowedOrigin('http://localhost:6274', 'https://repo.ing', { NODE_ENV: 'production' }), false)
  assert.equal(allowedOrigin('http://localhost:6274', 'https://repo.ing', { NODE_ENV: 'development' }), true)
  assert.equal(allowedOrigin('http://127.0.0.1:3001', null, {}), true)
  assert.equal(allowedOrigin('http://rebind.example:3001', null, {}), false)
  assert.equal(allowedOrigin('http://localhost.evil.example', null, { NODE_ENV: 'development' }), false)
  assert.equal(allowedOrigin('https://repo.ing', null, { NODE_ENV: 'production' }), false)
})

test('MCP-Protocol-Version: an unsupported version gets 400 with no modern error, so dual-era clients fall back', async () => {
  for (const version of ['2026-07-28', '2025-11-25', 'garbage']) {
    const { status, message } = await json(rpc('tools/list', {}), { 'mcp-protocol-version': version })
    assert.equal(status, 400, version); assert.equal(message.error.code, -32600)
    assert.notEqual(message.error.code, -32022) // UnsupportedProtocolVersionError would tell a dual-era client this is a modern server
    assert.equal((await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-protocol-version': version })).response.status, 400)
  }
  for (const headers of [{ 'mcp-protocol-version': '2025-06-18' }, { 'mcp-protocol-version': '2025-03-26' }, {}]) assert.equal((await json(rpc('tools/list', {}), headers)).status, 200)
  // initialize negotiates in its params; a stray header does not block the handshake.
  assert.equal((await json(init('2025-06-18'), { 'mcp-protocol-version': '2026-07-28' })).status, 200)
})

test('rate limit: a refused quota is 429; a failed quota read fails closed and is logged; bodies are capped and read safely', async (t) => {
  const refused = await json(rpc('ping'), {}, { quota: async () => false })
  assert.equal(refused.status, 429); assert.equal(refused.response.headers.get('retry-after'), '60'); assert.equal(refused.message.error.code, -32000)
  const logged = t.mock.method(console, 'error', () => {})
  const broken = await send(rpc('ping'), {}, { quota: async () => { throw Object.assign(Error('connect ECONNREFUSED 10.0.0.5:5432 password=secret'), { code: 'ECONNREFUSED' }) } })
  assert.equal(broken.response.status, 503); assert.doesNotMatch(broken.body, /ECONNREFUSED|password/)
  assert.deepEqual(logged.mock.calls.map(call => call.arguments), [['mcp quota unavailable', { error: 'ECONNREFUSED' }]])
  assert.equal((await send({ ...rpc('ping'), padding: 'x'.repeat(17_000) })).response.status, 413)
  // A client that drops the connection mid-body.
  const aborted = new ReadableStream({ pull(controller) { controller.error(Error('client aborted')) } })
  assert.equal((await handler()(new Request(URL_, { method: 'POST', body: aborted, duplex: 'half' }))).status, 400)
})

test('boundedRead: at most max calls in flight, each answered within waitMs; a late call still runs to its end', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const releases = [], done = []
  const read = boundedRead(id => new Promise(resolve => releases.push(() => { done.push(id); resolve(`read ${id}`) })), { max: 2, waitMs: 8000, busy: 'busy' })
  const first = read(1), second = read(2)
  assert.equal(await read(3), 'busy'); assert.equal(releases.length, 2)
  releases[0](); assert.equal(await first, 'read 1')
  t.mock.timers.tick(8000)
  assert.equal(await second, 'busy')
  releases[1](); assert.deepEqual(done, [1, 2])
  await new Promise(resolve => setImmediate(resolve)) // the late read's slot frees once its promise chain settles
  const third = read(4); assert.equal(releases.length, 3); releases[2](); assert.equal(await third, 'read 4')
  const failing = boundedRead(async () => { throw Error('rpc down') }, { max: 1, waitMs: 8000, busy: 'busy' })
  await assert.rejects(failing(), /rpc down/)
  await assert.rejects(failing(), /rpc down/) // a failure frees its slot
})

// The route on a fake pool: GitHub, model and maintainer-declined markets, as listMarkets(), graduationRace() and the
// maintainer decision reads load them, with Hugging Face model markets on and off.
// The declined market leads both lists on volume and progress, so only the do-not-promote set keeps it out.
const REPO_ROW = { repoId: '1266706783', mint: '3tcPoGD2xeZEkLYr3yMqtZxNQF5iThhsDjZ7u7TkJoSF', fullName: 'New1Direction/OntologyEX', symbol: 'ONTO', stars: 120, reserveSol: 30n, volume: '2500000000' }
const MODEL_ROW = { repoId: '4503599627370497', mint: 'GptMint22222222222222222222222222222222222', fullName: 'openai-community/gpt2', symbol: 'GPT2', stars: 0, source: 'huggingface', reserveSol: 40n, volume: '9000000000' }
const DECLINED_ROW = { repoId: '777', mint: 'NopeMint11111111111111111111111111111111', fullName: 'acme/declined', symbol: 'NOPE', stars: 900, reserveSol: 60n, volume: '50000000000' }
function listedRow({ repoId, mint, fullName, symbol, stars, source = 'github', reserveSol, volume }) {
  const { status, observation, error_code, migration_evidence_hash } = graduationColumns({ mint, reserveSol })
  return { repoId, mint, pool: `pool-${mint}`, tokenName: symbol, symbol, indexedAt: new Date('2026-09-01T00:00:00Z'), owner: fullName.split('/')[0],
    name: fullName.split('/')[1], fullName, description: `About ${fullName}`, stars, forks: 0, githubCreatedAt: '2024-01-01T00:00:00Z', source,
    earned: '1000000000', claimed: '0', volume24hLamports: volume, beneficiaryWallet: null, wasVerified: false, lastSqrtPrice: null,
    graduationStatus: status, observation, graduationError: error_code, migrationEvidenceHash: migration_evidence_hash }
}
const racerRow = ({ repoId, mint, fullName, symbol, reserveSol }) => ({ repoId, mint, fullName, symbol, tokenName: symbol, ...graduationColumns({ mint, reserveSol }) })

test('route: live reads behind the site cache, the model-market flag, exclusions, declines, quotas and the origin rule', async (t) => {
  const saved = { url: process.env.DATABASE_URL, origin: process.env.APP_ORIGIN, hf: process.env.HF_MARKETS_ENABLED, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  const quotas = [], rows = [REPO_ROW, MODEL_ROW, DECLINED_ROW]
  let allow = true, swept = 0
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'; process.env.APP_ORIGIN = 'https://repo.ing'; process.env.HF_MARKETS_ENABLED = 'true'
  globalThis.fetch = async () => { throw Error('offline') } // the SOL/USD price sources
  t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {})
  globalThis.__gitfunPool = { query: async (sql, params = []) => {
    if (/insert into agent_request_limits/.test(sql)) { quotas.push(params); return { rows: allow ? [{ hits: 1 }] : [] } }
    if (/delete from agent_request_limits/.test(sql)) { swept++; return { rows: [] } }
    if (/order by m\.indexed_at desc/.test(sql)) return { rows: rows.map(listedRow) }
    if (/o\.status = 'VERIFIED'/.test(sql)) return { rows: rows.map(racerRow) }
    if (/from maintainer_opt_outs/.test(sql)) {
      const decline = { repoId: '777', kind: 'decline', note: 'We did not ask for this.', createdAt: new Date('2026-09-15T10:00:00Z') }
      return { rows: /github_repo_id = \$1/.test(sql) ? (params[0] === '777' ? [decline] : []) : [{ repoId: '777' }] }
    }
    return { rows: [] }
  } }
  t.after(() => {
    for (const [key, value] of [['DATABASE_URL', saved.url], ['APP_ORIGIN', saved.origin], ['HF_MARKETS_ENABLED', saved.hf]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
  })
  const { POST, GET, DELETE } = await import('../app/api/mcp/readonly/route.js')
  const call = (body, headers) => POST(post(body, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...headers }))
  const tool = async (name, args = {}) => (await (await call(rpc('tools/call', { name, arguments: args }))).json()).result
  const ready = await call(init('2025-06-18'))
  assert.equal(ready.status, 200); assert.equal((await ready.json()).result.serverInfo.name, 'repo.ing')
  // Global scope first, then the client's HMAC key (never the address itself); expired windows are swept once.
  assert.deepEqual(quotas.slice(0, 2).map(([scope, limit, seconds]) => [scope.replace(/[0-9a-f]{32}$/, '<key>'), limit, seconds]),
    [['mcp-read:global', 600, 60], ['mcp-read:client:<key>', 60, 60]])
  assert.doesNotMatch(JSON.stringify(quotas), /203\.0\.113\.7/)

  const repo = await tool('find_market', { project: 'https://github.com/new1direction/ontologyex' })
  assert.equal(repo.structuredContent.markets[0].marketUrl, `https://repo.ing/token/${REPO_ROW.mint}`)
  assert.equal(repo.structuredContent.markets[0].graduation.progressPercent, 35)
  const declined = await tool('find_market', { project: 'acme/declined' })
  assert.deepEqual(declined.structuredContent.markets[0].declined, { at: '2026-09-15', note: 'We did not ask for this.' })
  assert.match(declined.content[0].text, /The maintainer of acme\/declined has declined this market \(2026-09-15\)/)
  assert.match((await tool('builder_earnings', { project: 'acme/declined' })).content[0].text, /^No verified builder earnings for acme\/declined \(\$NOPE\) yet\./)
  const model = await tool('find_market', { project: 'https://huggingface.co/openai-community/gpt2' })
  assert.equal(model.structuredContent.markets[0].disclaimer, HF_DISCLAIMER)
  const projects = async sort => (await tool('trending_markets', { sort })).structuredContent.markets.map(market => market.project)
  // The declined market is in neither list (opt-outs feed the do-not-promote set); the model is in both while models are open.
  assert.deepEqual(await projects('volume'), ['openai-community/gpt2', 'New1Direction/OntologyEX'])
  assert.deepEqual(await projects('graduation'), ['openai-community/gpt2', 'New1Direction/OntologyEX'])
  assert.equal((await tool('platform_stats')).isError, true) // the totals read needs a real pool

  process.env.HF_MARKETS_ENABLED = 'false'
  assert.match((await tool('find_market', { project: 'https://huggingface.co/openai-community/gpt2' })).content[0].text, /not open on repo\.ing right now/)
  assert.equal((await tool('find_market', { project: MODEL_ROW.mint })).structuredContent.found, false)
  assert.deepEqual(await projects('volume'), ['New1Direction/OntologyEX'])
  assert.deepEqual(await projects('graduation'), ['New1Direction/OntologyEX'])
  assert.equal(swept, 1)

  assert.equal((await call(rpc('ping'), { origin: 'https://evil.example' })).status, 403)
  allow = false
  assert.equal((await call(rpc('ping'))).status, 429)
  for (const handle of [GET, DELETE]) { const response = await handle(new Request(URL_)); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'POST') }
  // In-process first: past 60 a minute a client is refused before the database is asked.
  allow = true
  const before = quotas.length
  for (let i = 0; i < 60; i++) await POST(post(rpc('ping'), { 'x-forwarded-for': '198.51.100.9' }))
  assert.equal(quotas.length, before + 120)
  assert.equal((await POST(post(rpc('ping'), { 'x-forwarded-for': '198.51.100.9' }))).status, 429)
  assert.equal(quotas.length, before + 120)
})

// The official MCP client, against the repo.ing tools on fake reads: the plain handshake, and a dual-era client that probes
// the per-request revision first and falls back.
const MARKET = { ...REPO_ROW, tokenName: 'ONTO', source: 'github', indexedAt: '2026-09-01T00:00:00.000Z', earned: '1000000000', claimed: '0',
  volume24hLamports: '2500000000', graduated: false, bondingPercent: 31.4, promoted: true, newRepo: false, beneficiaryWallet: null }
const fakeSources = { origin: () => 'https://repo.ing', modelsEnabled: () => true, markets: async () => ({ markets: [MARKET] }), race: async () => ({ markets: [] }),
  excluded: async () => new Set(), decision: async () => null, fees: async () => ({ status: 'MATCH', onchainCreatorFee: 1000000000n }), usdPerSol: async () => null,
  totals: async () => null }
async function connect(options = {}) {
  const seen = []
  const live = createStatelessMcpHandler({ server: READ_ONLY_SERVER, tools: readOnlyTools(fakeSources), allowOrigin: () => false })
  const client = new Client({ name: 'repoing-readonly-test', version: '1' }, options)
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { fetch: async (url, init) => {
    const request = new Request(url, init), body = request.method === 'POST' ? JSON.parse(await request.clone().text()) : {}
    const response = await live(request)
    seen.push([request.method, request.headers.get('mcp-protocol-version'), body.method ?? null, response.status])
    return response
  } }))
  return { client, seen }
}

test('official MCP client: handshake, tool list and calls', async () => {
  const { client } = await connect()
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-06-18')
    assert.equal(client.getInstructions(), READ_ONLY_SERVER.instructions)
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map(tool => tool.name), ['find_market', 'builder_earnings', 'trending_markets', 'platform_stats'])
    assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false))
    const found = await client.callTool({ name: 'find_market', arguments: { project: 'New1Direction/OntologyEX' } })
    assert.equal(found.structuredContent.markets[0].ticker, '$ONTO')
    assert.match(found.content[0].text, /^New1Direction\/OntologyEX has a repo\.ing market: \$ONTO\./)
    const earnings = await client.callTool({ name: 'builder_earnings', arguments: { project: 'New1Direction/OntologyEX' } })
    assert.equal(earnings.structuredContent.markets[0].claimableLamports, '1000000000')
    await assert.rejects(client.callTool({ name: 'launch_token', arguments: {} }), /Unknown tool/)
    await assert.rejects(client.callTool({ name: 'trending_markets', arguments: { limit: 50 } }), /limit/)
  } finally { await client.close() }
})

test('a dual-era MCP client probes the 2026-07-28 revision, gets a plain 400 and falls back to the handshake', async () => {
  const { client, seen } = await connect({ versionNegotiation: { mode: 'auto' } })
  try {
    assert.equal(client.getNegotiatedProtocolVersion(), '2025-06-18')
    const found = await client.callTool({ name: 'find_market', arguments: { project: 'https://github.com/New1Direction/OntologyEX' } })
    assert.equal(found.structuredContent.markets[0].mint, REPO_ROW.mint)
    const [probe, handshake, ...rest] = seen
    assert.deepEqual(probe, ['POST', '2026-07-28', 'server/discover', 400])
    assert.deepEqual(handshake, ['POST', null, 'initialize', 200])
    // Then the negotiated version on every message; the client's standalone SSE stream (GET) is declined with 405.
    for (const [method, version, rpcMethod, status] of rest) assert.ok(method === 'GET' ? status === 405 : version === '2025-06-18' && status < 300, rpcMethod)
    assert.ok(rest.some(([, , rpcMethod]) => rpcMethod === 'tools/call'))
  } finally { await client.close() }
})
