import { PublicKey } from '@solana/web3.js'
import { chain } from '../../../lib/server.mjs'
import { stockBalance } from '../../../lib/stock-balance.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PRIVATE = { 'Cache-Control': 'private, no-store' }

export async function GET(request) {
  const params = new URL(request.url).searchParams
  const wallet = params.get('wallet'), assetId = params.get('asset')
  if (!wallet || wallet.length > 44) return Response.json({ error: 'Invalid wallet address' }, { status: 400 })
  let owner
  try {
    owner = new PublicKey(wallet)
    if (owner.toBase58() !== wallet) throw new Error('Invalid wallet address')
  } catch { return Response.json({ error: 'Invalid wallet address' }, { status: 400 }) }
  // ?asset=<stock asset id>: the wallet's balance of a stock pair's quote (docs/STOCK_QUOTES.md), in raw units.
  if (assetId !== null) {
    const result = await stockBalance(chain, owner, assetId)
    return Response.json(result.body, { status: result.status, headers: PRIVATE })
  }
  try {
    const lamports = await chain().getBalance(owner, 'confirmed')
    if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('Invalid SOL balance')
    return Response.json({ lamports: String(lamports) }, { headers: PRIVATE })
  } catch {
    return Response.json({ error: 'SOL balance is temporarily unavailable' }, { status: 503 })
  }
}
