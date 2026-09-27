import { PublicKey } from '@solana/web3.js'
import { AccountLayout } from '@solana/spl-token'
import { chain, marketByMint } from '../../../../lib/server.mjs'
import { sumTokenAccountBalances } from '../../../../lib/token-balance.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request, { params }) {
  const { mint } = await params
  const wallet = new URL(request.url).searchParams.get('wallet')
  if (!wallet || wallet.length > 44) return Response.json({ error: 'Invalid wallet address' }, { status: 400 })
  let owner
  try {
    owner = new PublicKey(wallet)
    if (owner.toBase58() !== wallet) throw new Error('Invalid wallet address')
  } catch { return Response.json({ error: 'Invalid wallet address' }, { status: 400 }) }
  const { market, unavailable } = await marketByMint(mint)
  if (!market) return Response.json({ error: 'Market unavailable' }, { status: unavailable ? 503 : 404 })
  try {
    const accounts = await chain().getTokenAccountsByOwner(owner, { mint: new PublicKey(mint) }, {
      commitment: 'confirmed', dataSlice: { offset: AccountLayout.offsetOf('amount'), length: 8 },
    })
    return Response.json({ balanceBaseUnits: sumTokenAccountBalances(accounts.value), decimals: 6 },
      { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return Response.json({ error: 'Wallet balance is temporarily unavailable' }, { status: 503 })
  }
}
