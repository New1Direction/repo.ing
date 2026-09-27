import { PublicKey } from '@solana/web3.js'
import { database } from '../../../lib/server.mjs'
import { tokenImageResponse } from '../../../../src/token-image.mjs'

export const runtime = 'nodejs'
export async function GET(_request, { params }) {
  let mint
  try { mint = new PublicKey((await params).mint).toBase58() }
  catch { return new Response(null, { status: 400 }) }
  try {
    const pool = database()
    if (!pool) return new Response(null, { status: 503 })
    const { rows } = await pool.query(`select token_image, github_repo_id::text as repo from markets
      where mint=$1 and status in ('prepared', 'submitted', 'confirmed', 'ambiguous')`, [mint])
    if (!rows[0]) return new Response(null, { status: 404 })
    if (rows[0].token_image) return tokenImageResponse(rows[0].token_image)
    return new Response(null, { status: 302, headers: { Location: `/api/repo-logo/${rows[0].repo}?v=3`, 'Cache-Control': 'public, max-age=300' } })
  } catch { return new Response(null, { status: 503 }) }
}
