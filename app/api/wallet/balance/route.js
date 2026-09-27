import { PublicKey } from '@solana/web3.js'
import { chain } from '../../../lib/server.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const wallet = new URL(request.url).searchParams.get('wallet')
  if (!wallet || wallet.length > 44) return Response.json({ error: 'Invalid wallet address' }, { status: 400 })
  let owner
  try {
    owner = new PublicKey(wallet)
    if (owner.toBase58() !== wallet) throw new Error('Invalid wallet address')
  } catch { return Response.json({ error: 'Invalid wallet address' }, { status: 400 }) }
  try {
    const lamports = await chain().getBalance(owner, 'confirmed')
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('Invalid SOL balance')
    return Response.json({ lamports: String(lamports) }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return Response.json({ error: 'SOL balance is temporarily unavailable' }, { status: 503 })
  }
}
