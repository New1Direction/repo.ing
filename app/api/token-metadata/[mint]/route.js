import { PublicKey } from '@solana/web3.js'
import { database } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'

export const runtime = 'nodejs'

export async function GET(request, { params }) {
  let mint
  try { mint = new PublicKey((await params).mint).toBase58() }
  catch { return Response.json({ error: 'Invalid token mint' }, { status: 400 }) }
  const pool = database()
  if (!pool) return Response.json({ error: 'Metadata database unavailable' }, { status: 503 })
  try {
    const { rows } = await pool.query(`select github_repo_id::text as "repoId", token_name as "name",
      token_symbol as "symbol", token_image is not null as "hasImage" from markets where mint = $1 and status in ('prepared', 'submitted', 'confirmed', 'ambiguous')`, [mint])
    const market = rows[0]
    if (!market) return Response.json({ error: 'Token metadata not found' }, { status: 404 })
    const origin = publicOrigin(request.url)
    return Response.json({ name: market.name, symbol: market.symbol,
      description: `Token for public GitHub repository ${market.repoId} on repo.ing.`,
      image: market.hasImage ? `${origin}/api/token-image/${mint}` : `${origin}/api/repo-logo/${market.repoId}?v=3`, external_url: `${origin}/token/${mint}` },
    { headers: { 'Cache-Control': 'public, max-age=300' } })
  } catch { return Response.json({ error: 'Token metadata unavailable' }, { status: 503 }) }
}
