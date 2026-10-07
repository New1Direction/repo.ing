import { PublicKey } from '@solana/web3.js'
import { tokenMetadataResponse } from '../../../lib/token-metadata-read.mjs'

export const runtime = 'nodejs'

export async function GET(request, { params }) {
  let mint
  try { mint = new PublicKey((await params).mint).toBase58() }
  catch { return Response.json({ error: 'Invalid token mint' }, { status: 400 }) }
  return tokenMetadataResponse(request, { mint })
}
