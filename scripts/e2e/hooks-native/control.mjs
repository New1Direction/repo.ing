// A loopback-only control API for the e2e tests, guarded by a per-run bearer token: the tests act as the OWNER through
// it (type a command into the owner agent, run the owner driver's customer-grant with the stack's disposable keys) and
// read the RPC send audit. The owner keys never leave the stack process.
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { freePort } from './common.mjs'

export async function startControl({ token, routes, log }) {
  const port = await freePort(), expected = Buffer.from(`Bearer ${token}`)
  const server = createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)) }
    try {
      const given = Buffer.from(request.headers.authorization ?? '')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return reply(401, { error: 'control token required' })
      const url = new URL(request.url, 'http://127.0.0.1'), route = routes[`${request.method} ${url.pathname}`]
      if (!route) return reply(404, { error: `no route ${request.method} ${url.pathname}` })
      let body = ''
      for await (const chunk of request) { body += chunk; if (body.length > 65536) throw Error('body too large') }
      reply(200, await route(body ? JSON.parse(body) : {}, url.searchParams))
    } catch (error) { reply(500, { error: error.message }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  log?.(`control api http://127.0.0.1:${port}`)
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }) }
}
