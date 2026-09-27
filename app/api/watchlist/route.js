import { database } from '../../lib/server.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export async function GET(request) {
  const ids = [...new Set((new URL(request.url).searchParams.get('repos') || '').split(','))]
  const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
  if (!ids.length || ids.length > 50 || ids.some(id => !/^[1-9]\d{0,17}$/.test(id))) return json({ error: 'Choose up to 50 repositories.' }, 400)
  try {
    const pool = database()
    if (!pool) throw Error('Database unavailable')
    const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.mint,
        t.next_sqrt_price as "sqrtPrice", t.signature || ':' || t.event_index as event
      from markets m join lateral (
        select next_sqrt_price, signature, event_index from trade_events where pool = m.pool
        order by slot desc, event_index desc, id desc limit 1
      ) t on true
      where m.github_repo_id = any($1::bigint[]) and m.status = 'confirmed'
        and m.launch_finality = 'finalized' and m.indexed_at is not null`, [ids])
    return json({ quotes: rows })
  } catch { return json({ error: 'Price alerts are temporarily unavailable. We will retry.' }, 503) }
}
