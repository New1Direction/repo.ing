import { database, marketByMint } from '../../../../lib/server.mjs'
import { publicGraduation, graduationError } from '../../../../../src/graduation-readiness.mjs'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(_request, { params }) {
  const { mint } = await params
  const { market } = await marketByMint(mint)
  if (!market) return Response.json({ error: 'Market not found' }, { status: 404 })
  try {
    const {rows:[row]}=await database().query(`select o.*,e.evidence_hash as migration_evidence_hash from graduation_observations o
      left join graduation_events e on e.github_repo_id=o.github_repo_id where o.github_repo_id=$1`,[market.repoId])
    return Response.json(publicGraduation(row), { headers: { 'Cache-Control': 'no-store' } })
  } catch(error) { return Response.json({ error: 'Graduation progress is being verified.', code:graduationError(error) }, { status: 503,headers:{'Cache-Control':'no-store'} }) }
}
