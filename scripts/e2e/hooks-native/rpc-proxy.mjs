// The two HTTPS RPC "providers" local acceptance requires (src/hooklab-local-acceptance.mjs): byte-transparent proxies in
// front of ONE local validator (topology single-local-validator-two-proxies; they are not independent providers). The
// upstream is fixed at start; nothing in a request can choose it. Every sendTransaction is counted per signature, so the
// suite can prove each signed transaction went out exactly once (no duplicate spend). Fault switches are for E2.
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:https'
import { VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { freePort } from './common.mjs'

const MAX_BODY = 4 * 1024 * 1024

export async function startRpcProxies({ upstream, tls, auditFile, log }) {
  // Fault switches (E2): drop the next send's response after it reached the validator; hold the next send's response for
  // a while (the send still goes through); one provider reporting a lastValidBlockHeight lowered by `by` blocks.
  const sends = new Map(), faults = { loseNextSendResponse: false, holdNextSendMs: 0, lowerLastValidBlockHeight: null }
  const tlsOptions = { key: readFileSync(tls.key), cert: readFileSync(tls.cert) }
  const servers = await Promise.all(['local-a', 'local-b'].map(async provider => {
    const port = await freePort()
    const server = createServer(tlsOptions, async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/') throw Error('POST / only')
        const chunks = []; let size = 0
        for await (const chunk of request) { size += chunk.length; if (size > MAX_BODY) throw Error('request too large'); chunks.push(chunk) }
        const body = Buffer.concat(chunks), input = JSON.parse(body)
        let signature = null
        for (const call of Array.isArray(input) ? input : [input]) {
          if (call?.method !== 'sendTransaction') continue
          signature = bs58.encode(VersionedTransaction.deserialize(Buffer.from(call.params[0], call.params[1]?.encoding === 'base58' ? 'base58' : 'base64')).signatures[0])
          sends.set(signature, (sends.get(signature) ?? 0) + 1)
          appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString(), provider, signature, attempt: sends.get(signature) })}\n`, { mode: 0o600 })
        }
        // A read whose upstream connection fails is retried (idempotent); a send never is, so it can never go out twice.
        const forward = () => fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body, redirect: 'error', signal: AbortSignal.timeout(30_000) })
        let upstreamResponse
        for (let attempt = 1; ; attempt++) {
          try { upstreamResponse = await forward(); break } catch (error) { if (signature || attempt >= 3) throw error }
        }
        let bytes = Buffer.from(await upstreamResponse.arrayBuffer())
        if (signature && faults.loseNextSendResponse) { faults.loseNextSendResponse = false; response.destroy(); return }
        if (signature && faults.holdNextSendMs > 0) { const ms = faults.holdNextSendMs; faults.holdNextSendMs = 0; await new Promise(resolve => setTimeout(resolve, ms)) }
        const lower = faults.lowerLastValidBlockHeight
        if (lower?.provider === provider && !Array.isArray(input) && input.method === 'getLatestBlockhash') {
          const reply = JSON.parse(bytes)
          if (reply.result?.value?.lastValidBlockHeight) { reply.result.value.lastValidBlockHeight -= lower.by; bytes = Buffer.from(JSON.stringify(reply)) }
        }
        response.writeHead(upstreamResponse.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(bytes)
      } catch (error) {
        if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: `local proxy: ${error.message}` } }))
      }
    })
    // Clients (undici) reuse keep-alive sockets; a short server idle timeout races that reuse into 'fetch failed'.
    server.keepAliveTimeout = 120_000; server.headersTimeout = 125_000
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    return { provider, server, origin: `https://127.0.0.1:${port}` }
  }))
  log?.(`rpc proxies ${servers.map(s => `${s.provider}=${s.origin}`).join(' ')} -> ${upstream}`)
  return {
    providers: servers.map(({ provider, origin }) => ({ provider, origin })),
    sends: () => Object.fromEntries(sends), faults,
    stop: () => Promise.all(servers.map(({ server }) => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }))),
  }
}
