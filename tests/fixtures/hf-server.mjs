// A local stand-in for https://huggingface.co: replays the responses recorded in tests/fixtures/hf (matched by path; the
// query is recorded but ignored) unless a test routes the path itself. The client keeps its fixed host: fetchImpl only
// rewrites that origin to this server, so redirects and headers go through real HTTP. Nothing here reaches the network.
import http from 'node:http'
import { readdirSync, readFileSync } from 'node:fs'

const DIR = new URL('./hf/', import.meta.url)
export const recorded = Object.freeze(Object.fromEntries(readdirSync(DIR).filter(name => name.endsWith('.json'))
  .map(name => [name.slice(0, -'.json'.length), JSON.parse(readFileSync(new URL(name, DIR), 'utf8'))])))

// reply: { status, headers, body } (body null for none; raw: an unencoded string body; delayMs: hold the response;
// stallMs: send the headers and one byte of the body, then hold the rest), or a function (url, request) returning one.
export async function startFakeHf() {
  const routes = new Map(Object.values(recorded).map(reply => [new URL(reply.request, 'https://huggingface.co').pathname, reply]))
  const requests = []
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    requests.push({ path: url.pathname, query: decodeURIComponent(url.search), headers: request.headers })
    const route = routes.get(url.pathname)
    const reply = typeof route === 'function' ? await route(url, request) : route
    if (!reply) {
      response.writeHead(599, { 'content-type': 'application/json' })
      return response.end(JSON.stringify({ error: `no fixture for ${url.pathname}` }))
    }
    if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs))
    if (response.destroyed) return
    const body = reply.raw ?? (reply.body == null ? '' : JSON.stringify(reply.body))
    response.writeHead(reply.status, { ...body && reply.raw === undefined ? { 'content-type': 'application/json; charset=utf-8' } : {}, ...reply.headers })
    if (reply.stallMs) {
      response.write(body.slice(0, 1))
      await new Promise(resolve => setTimeout(resolve, reply.stallMs))
      if (response.destroyed) return
    }
    response.end(reply.stallMs ? body.slice(1) : body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    requests,
    route: (path, reply) => routes.set(path, reply),
    fetchImpl: (url, init) => {
      if (!String(url).startsWith('https://huggingface.co/')) throw Error(`test fetch outside huggingface.co: ${url}`)
      return fetch(`${origin}${String(url).slice('https://huggingface.co'.length)}`, init)
    },
    close: () => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) },
  }
}
