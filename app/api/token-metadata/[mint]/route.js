import { PublicKey } from '@solana/web3.js'
import { database } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { tokenMetadataJson } from '../../../lib/token-metadata.mjs'

export const runtime = 'nodejs'

export async function GET(request, { params }) {
  let mint
  try { mint = new PublicKey((await params).mint).toBase58() }
  catch { return Response.json({ error: 'Invalid token mint' }, { status: 400 }) }
  const pool = database()
  if (!pool) return Response.json({ error: 'Metadata database unavailable' }, { status: 503 })
  try {
    // quoteAssetId: a stock pair's stamp (null for SOL), so its description names what its trades pay.
    const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", m.token_name as "name",
      m.token_symbol as "symbol", m.token_image is not null as "hasImage", r.full_name as "fullName", m.quote_asset_id as "quoteAssetId"
      from markets m left join repositories r on r.github_repo_id = m.github_repo_id
      where m.mint = $1 and m.status in ('prepared', 'submitted', 'confirmed', 'ambiguous')`, [mint])
    const market = rows[0]
    if (!market) return Response.json({ error: 'Token metadata not found' }, { status: 404 })
    return Response.json(tokenMetadataJson({ mint, origin: publicOrigin(request.url), market }),
      { headers: { 'Cache-Control': 'public, max-age=300' } })
  } catch (error) {
    console.error('token-metadata failed', { mint, error: error.message })
    return Response.json({ error: 'Token metadata unavailable' }, { status: 503 })
  }
}
