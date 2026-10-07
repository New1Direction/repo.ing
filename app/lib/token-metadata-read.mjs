import { database } from './server.mjs'
import { publicOrigin } from './origin.mjs'
import { tokenMetadataJson } from './token-metadata.mjs'

// The token metadata response for the market with this mint (/api/token-metadata/<mint>) or this GitHub repository id
// (/m/<id>, the short link early access launches carry so their one transaction fits: a repository id has one market for
// ever, so the link names one token). quoteAssetId: a stock pair's stamp (null for SOL), so its description names what its
// trades pay.
export async function tokenMetadataResponse(request, { mint = null, repoId = null }) {
  const pool = database()
  if (!pool) return Response.json({ error: 'Metadata database unavailable' }, { status: 503 })
  try {
    const { rows } = await pool.query(`select m.mint, m.github_repo_id::text as "repoId", m.token_name as "name",
      m.token_symbol as "symbol", m.token_image is not null as "hasImage", r.full_name as "fullName", m.quote_asset_id as "quoteAssetId"
      from markets m left join repositories r on r.github_repo_id = m.github_repo_id
      where ${mint ? 'm.mint = $1' : 'm.github_repo_id = $1::bigint'} and m.status in ('prepared', 'submitted', 'confirmed', 'ambiguous')`,
    [mint ?? repoId])
    const market = rows[0]
    if (!market?.mint) return Response.json({ error: 'Token metadata not found' }, { status: 404 })
    return Response.json(tokenMetadataJson({ mint: market.mint, origin: publicOrigin(request.url), market }),
      { headers: { 'Cache-Control': 'public, max-age=300' } })
  } catch (error) {
    console.error('token-metadata failed', { mint, repoId, error: error.message })
    return Response.json({ error: 'Token metadata unavailable' }, { status: 503 })
  }
}
