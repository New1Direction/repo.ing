import { readLimitedText } from './csp-report.mjs'

// Model Context Protocol over Streamable HTTP for read-only tool servers (app/api/mcp/readonly/route.js): stateless and
// JSON-only, one JSON-RPC message per POST, no SSE stream and no session, so any replica answers any request. Hand-rolled
// rather than the SDK's createMcpHandler (src/agent-launch-http.mjs), whose handshake-era leg answers over SSE.
// Speaks the handshake revisions below (https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). A
// client of the per-request revision (2026-07-28) that also speaks these probes with a modern request first and falls back
// to initialize on a 400 whose body is not UnsupportedProtocolVersionError (-32022): exactly what an unsupported
// MCP-Protocol-Version header gets here. A batch gets -32600: 2025-06-18 removed them, and although 2025-03-26 allowed
// them, no client sends them.
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26'])
const MAX_REQUEST_BYTES = 16 * 1024
const RPC = Object.freeze({ PARSE_ERROR: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603, SERVER_ERROR: -32000 })

const NO_STORE = { 'Cache-Control': 'no-store' }
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))
const reply = (message, status = 200, headers = {}) => Response.json(message, { status, headers: { ...NO_STORE, ...headers } })
const fail = (id, code, message, status = 200, headers) => reply({ jsonrpc: '2.0', id: isId(id) ? id : null, error: { code, message } }, status, headers)
const clip = value => String(value).slice(0, 100)
const cause = error => error?.code ?? error?.name ?? 'error'

class InvalidParams extends Error {}

// The DNS-rebinding rule: server-to-server clients send no Origin; a browser's must be the site's configured origin (site,
// or null when none is configured), or any localhost port outside production.
const LOCALHOST = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/
export function allowedOrigin(origin, site, env = process.env) {
  return (site !== null && origin === site) || (env.NODE_ENV !== 'production' && LOCALHOST.test(origin))
}

// At most max calls of read in flight, each answered within waitMs; past either, busy. A late call still runs to its end
// (filling whatever cache read keeps), so a slow upstream holds at most max of whatever read holds, never a queue.
export function boundedRead(read, { max, waitMs, busy }) {
  let inFlight = 0
  return (...args) => {
    if (inFlight >= max) return Promise.resolve(busy)
    inFlight++
    // Started now; a synchronous throw becomes a rejection like any other failure.
    const call = new Promise(resolve => resolve(read(...args))).finally(() => { inFlight-- })
    let timer
    const late = new Promise(resolve => { timer = setTimeout(resolve, waitMs, busy); timer.unref?.() })
    return Promise.race([call, late]).finally(() => clearTimeout(timer))
  }
}

// Zod issues as one line the calling agent can act on: "limit: Too big: expected number to be <=20".
const issuesText = error => error.issues.map(issue => `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`).join('; ')

// tools: [{ definition: { name, inputSchema, ... }, input: a zod schema of the arguments, call(args, request) }].
// allowOrigin(origin, request) → boolean. quota(request) → boolean, and a rejection fails closed (503).
export function createStatelessMcpHandler({ server, tools, allowOrigin, quota = async () => true, maxBytes = MAX_REQUEST_BYTES }) {
  const byName = new Map(tools.map(tool => [tool.definition.name, tool]))
  const listed = { tools: tools.map(tool => tool.definition) }
  const { name, title, version, instructions } = server
  const methods = new Map([
    ['initialize', params => {
      if (!isObject(params) || typeof params.protocolVersion !== 'string') throw new InvalidParams('initialize requires params.protocolVersion.')
      // The client's version when this server speaks it, otherwise the newest here; the client decides whether to go on.
      const protocolVersion = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0]
      return { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name, ...(title && { title }), version }, ...(instructions && { instructions }) }
    }],
    ['ping', () => ({})],
    ['tools/list', () => listed],
    ['tools/call', async (params, request) => {
      if (!isObject(params) || typeof params.name !== 'string') throw new InvalidParams('tools/call requires params.name.')
      const tool = byName.get(params.name)
      if (!tool) throw new InvalidParams(`Unknown tool: ${clip(params.name)}`)
      if (params.arguments !== undefined && !isObject(params.arguments)) throw new InvalidParams('tools/call arguments must be an object.')
      const parsed = tool.input.safeParse(params.arguments ?? {})
      if (!parsed.success) throw new InvalidParams(`Invalid arguments for ${tool.definition.name}: ${issuesText(parsed.error)}`)
      // A failed read is a tool result the agent can relay, not a protocol error; the cause stays in the server log.
      try { return await tool.call(parsed.data, request) }
      catch (error) {
        console.error('mcp tool failed', { tool: tool.definition.name, error: cause(error) })
        return { content: [{ type: 'text', text: 'This lookup is temporarily unavailable. Try again shortly.' }], isError: true }
      }
    }],
  ])

  return async function handle(request) {
    if (request.method !== 'POST') return fail(null, RPC.SERVER_ERROR, 'Method not allowed: send JSON-RPC messages with POST.', 405, { Allow: 'POST' })
    const origin = request.headers.get('origin')
    if (origin && !allowOrigin(origin, request)) return fail(null, RPC.SERVER_ERROR, 'Origin not allowed.', 403)
    try {
      if (!await quota(request)) return fail(null, RPC.SERVER_ERROR, 'Too many requests. Try again in a minute.', 429, { 'Retry-After': '60' })
    } catch (error) {
      console.error('mcp quota unavailable', { error: cause(error) })
      return fail(null, RPC.SERVER_ERROR, 'Temporarily unavailable. Try again shortly.', 503)
    }
    let text
    // A client that drops the connection mid-body is answered, not thrown at the framework.
    try { text = await readLimitedText(request, maxBytes) } catch { return fail(null, RPC.INVALID_REQUEST, 'The request body could not be read.', 400) }
    if (text === null) return fail(null, RPC.INVALID_REQUEST, 'Request body too large.', 413)
    let message
    try { message = JSON.parse(text) } catch { return fail(null, RPC.PARSE_ERROR, 'Parse error: the body is not valid JSON.', 400) }
    if (Array.isArray(message)) return fail(null, RPC.INVALID_REQUEST, 'Batches are not supported: send one JSON-RPC message per request.', 400)
    if (!isObject(message) || message.jsonrpc !== '2.0') return fail(message?.id, RPC.INVALID_REQUEST, 'Invalid request: expected a JSON-RPC 2.0 message.', 400)
    const { id, method, params } = message, hasId = Object.hasOwn(message, 'id')
    const notification = typeof method === 'string' && !hasId
    const response = method === undefined && hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    if (!notification && !response && (typeof method !== 'string' || !isId(id))) {
      return fail(id, RPC.INVALID_REQUEST, 'Invalid request: a request needs a string method and a string or number id.', 400)
    }
    if (params !== undefined && (typeof params !== 'object' || params === null)) return fail(id, RPC.INVALID_REQUEST, 'Invalid request: params must be an object.', 400)
    // After initialize every message carries the negotiated version; none means a 2025-03-26 client, which had no header.
    const declared = request.headers.get('mcp-protocol-version')?.trim()
    if (declared && method !== 'initialize' && !PROTOCOL_VERSIONS.includes(declared)) {
      return fail(id, RPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${clip(declared)}. Supported: ${PROTOCOL_VERSIONS.join(', ')}.`, 400)
    }
    // Notifications (initialized, cancelled, …) and replies to server requests (this server sends none) need no answer.
    if (notification || response) return new Response(null, { status: 202, headers: NO_STORE })
    const run = methods.get(method)
    if (!run) return fail(id, RPC.METHOD_NOT_FOUND, `Method not found: ${clip(method)}`)
    try { return reply({ jsonrpc: '2.0', id, result: await run(params ?? {}, request) }) }
    catch (error) {
      if (error instanceof InvalidParams) return fail(id, RPC.INVALID_PARAMS, error.message)
      console.error('mcp request failed', { method, error: cause(error) })
      return fail(id, RPC.INTERNAL_ERROR, 'Internal error.')
    }
  }
}
