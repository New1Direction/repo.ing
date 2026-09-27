import { PublicKey } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { chain, database, listMarkets } from '../../../lib/server.mjs'
import { walletMarkets, walletTokenBalances } from '../../../lib/wallet-overview.mjs'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request) {
  const wallet = new URL(request.url).searchParams.get('wallet')
  let owner
  try { if (!wallet || wallet.length > 44) throw Error(); owner = new PublicKey(wallet); if (owner.toBase58() !== wallet) throw Error() }
  catch { return Response.json({ error: 'Invalid wallet address' }, { status: 400 }) }
  try {
    const db = database()
    if (!db) throw Error()
    const [{ markets, unavailable }, rewards, sol, tokens] = await Promise.all([
      listMarkets(),
      db.query(`select m.github_repo_id::text as "repoId", m.discovery_version as version,
        coalesce((select sum(f.partner_amount) from discovery_fee_events f where f.github_repo_id=m.github_repo_id and f.discovery_eligible),0)::text as "partnerEarned",
        coalesce((select sum(c.amount) from discovery_claims c where c.github_repo_id=m.github_repo_id and c.status='settled'),0)::text as paid
        from markets m where m.launcher_wallet=$1 and m.discovery_version in (1,2) and m.indexed_at is not null
        and m.status='confirmed' and m.launch_finality='finalized'`, [wallet]),
      chain().getBalance(owner, 'confirmed').catch(() => null),
      chain().getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, { commitment: 'confirmed', dataSlice: { offset: 0, length: 72 } }).catch(() => null),
    ])
    if (unavailable) throw Error()
    const balances = tokens ? walletTokenBalances(tokens.value, wallet) : null
    return Response.json({ wallet, solBalance: Number.isSafeInteger(sol) && sol >= 0 ? String(sol) : null,
      holdingsAvailable: Boolean(balances), markets: walletMarkets(markets, balances, wallet, rewards.rows), checkedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'private, no-store' } })
  } catch { return Response.json({ error: 'Your wallet overview is temporarily unavailable. Please retry.' }, { status: 503 }) }
}
