// A tiny HTTPS JSON client that trusts exactly the stack's throwaway certificate (the stack process starts before the
// certificate exists, so NODE_EXTRA_CA_CERTS cannot cover it).
import { readFileSync } from 'node:fs'
import { request } from 'node:https'

export function httpsClient(certPath) {
  const ca = readFileSync(certPath)
  return function call(url, { method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
      const req = request(url, { method, ca, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers }, timeout: 120_000 }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null; try { json = JSON.parse(text) } catch { /* not JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
      })
      req.on('timeout', () => req.destroy(Error(`timeout ${url}`)))
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }
}
