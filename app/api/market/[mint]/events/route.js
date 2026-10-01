import { database } from '../../../../lib/server.mjs'
import { marketNotificationHub } from '../../../../lib/market-hub.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const { mint } = await params
  const db = database()
  const headers = { 'Cache-Control': 'no-store' }
  if (!db || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return new Response(null, { status: 404, headers })
  try {
    const result = await db.query("select 1 from markets where mint=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'", [mint])
    if (!result.rowCount) return new Response(null, { status: 404, headers })
  } catch { return new Response(null, { status: 503, headers }) }
  const hub = marketNotificationHub()
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream({
    start(controller) {
      let ended = false, unsubscribe, heartbeat, expiry, pending, queuedKind
      function end() {
        if (ended) return
        ended = true; unsubscribe?.(); clearInterval(heartbeat); clearTimeout(expiry); clearTimeout(pending)
        request.signal.removeEventListener('abort', end)
        try { controller.close() } catch { /* Consumer may already have cancelled. */ }
      }
      cleanup = end
      function send(text) {
        if (ended) return
        if (controller.desiredSize <= 0) { end(); return }
        controller.enqueue(encoder.encode(text))
      }
      function changed({ kind }) {
        if (ended) return
        // Collapse indexing bursts into at most one refresh per 750 ms.
        if (!queuedKind || kind !== 'curve') queuedKind = kind
        if (!pending) pending = setTimeout(() => {
          const value = queuedKind; queuedKind = null; pending = null
          send(`event: market\ndata: ${JSON.stringify({ mint, kind: value })}\n\n`)
        }, 750)
      }
      try { unsubscribe = hub.subscribe(mint, changed) }
      catch { end(); return }
      request.signal.addEventListener('abort', end, { once: true })
      if (request.signal.aborted) { end(); return }
      send('retry: 5000\n: connected\n\n')
      changed({ kind: 'resync' })
      heartbeat = setInterval(() => send(': heartbeat\n\n'), 15000)
      expiry = setTimeout(end, 55000)
    },
    cancel() { cleanup() },
  })
  return new Response(stream, { headers: { ...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' } })
}
