import { database } from '../../lib/server.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }
const DB_TIMEOUT_MS = 2000

// Deploy healthcheck (Railway routes traffic to a new deployment only after a 2xx here). Cheap: the process serves
// requests and, when configured, the database answers, since prepared trade sessions live there. No details exposed.
export async function GET() {
  const db = database()
  if (!db) return Response.json({ ok: true }, { headers })
  let timer
  try {
    await Promise.race([db.query('select 1'), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), DB_TIMEOUT_MS) })])
    return Response.json({ ok: true }, { headers })
  } catch {
    return Response.json({ ok: false }, { status: 503, headers })
  } finally { clearTimeout(timer) }
}
