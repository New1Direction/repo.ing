import { database } from '../../../lib/server.mjs'
import { earningsBadge } from '../../../lib/readme-badge.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const reply = (body, status) => new Response(body, { status, headers: {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': status === 200 ? 'public, max-age=300, s-maxage=300' : 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
} })
export async function GET(_request, { params }) {
  const { repo } = await params
  if (!/^[1-9]\d{0,17}$/.test(repo)) return reply(earningsBadge({ unavailable: true }), 404)
  try {
    const pool = database()
    if (!pool) throw Error('Database unavailable')
    const { rows } = await pool.query(`select r.full_name as "fullName",
      (select coalesce(sum(f.amount_base_units), 0)::text from builder_fee_credits f
       where f.github_repo_id = m.github_repo_id and f.pool = m.pool) as earned
      from markets m join repositories r on r.github_repo_id = m.github_repo_id
      where m.github_repo_id = $1 and m.status = 'confirmed'
        and m.launch_finality = 'finalized' and m.indexed_at is not null`, [repo])
    return rows[0] ? reply(earningsBadge(rows[0]), 200) : reply(earningsBadge({ unavailable: true }), 404)
  } catch { return reply(earningsBadge({ unavailable: true }), 503) }
}
