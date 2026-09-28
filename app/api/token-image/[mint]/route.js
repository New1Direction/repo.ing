import { PublicKey } from '@solana/web3.js'
import { database } from '../../../lib/server.mjs'
import { tokenImageResponse } from '../../../../src/token-image.mjs'

export const runtime = 'nodejs'
export async function GET(request, { params }) {
  let mint
  try { mint = new PublicKey((await params).mint).toBase58() }
  catch { return new Response(null, { status: 400 }) }
  try {
    const pool = database()
    if (!pool) return new Response(null, { status: 503 })
    const { rows } = await pool.query(`select token_image, github_repo_id::text as repo from markets
      where mint=$1 and status in ('prepared', 'submitted', 'confirmed', 'ambiguous')`, [mint])
    if (!rows[0]) return new Response(null, { status: 404 })
    // ?w= selects an avatar-sized WebP; without it the canonical 512px PNG (used by token metadata) is served.
    const width = Number(new URL(request.url).searchParams.get('w')) || null
    if (rows[0].token_image) return await tokenImageResponse(rows[0].token_image, width)
    return new Response(null, { status: 302, headers: { Location: `/api/repo-logo/${rows[0].repo}?v=3`, 'Cache-Control': 'public, max-age=300' } })
  } catch (error) {
    console.error('token-image failed', { mint, error: error.message })
    return new Response(null, { status: 503 })
  }
}
