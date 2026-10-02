import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { chain, database, listMarkets } from '../../../lib/server.mjs'
import { SPL_ACCOUNT_SLICE, TOKEN_2022_ACCOUNT_SLICE, launcherRewardTotals, walletMarkets, walletTokenBalances } from '../../../lib/wallet-overview.mjs'
import { latestMarketPrices } from '../../../lib/portfolio-prices.mjs'
import { portfolioSummary, withHoldingValues } from '../../../lib/portfolio.mjs'
import { walletTrades, withHoldingPnl } from '../../../lib/holding-pnl.mjs'
import { solUsdPrice } from '../../../lib/sol-usd.mjs'
import { readWalletVerificationBonuses } from '../../../../src/verification-bonus.mjs'
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
    const [{ markets, unavailable }, rewards, sol, tokens, tokens2022, usdPerSol, bonuses] = await Promise.all([
      listMarkets(),
      db.query(`select m.github_repo_id::text as "repoId", m.discovery_version as version,
        coalesce((select sum(f.partner_amount) from discovery_fee_events f where f.github_repo_id=m.github_repo_id and f.discovery_eligible),0)::text as "partnerEarned",
        coalesce((select sum(c.amount) from discovery_claims c where c.github_repo_id=m.github_repo_id and c.status='settled'),0)::text as paid
        from markets m where m.launcher_wallet=$1 and m.discovery_version in (1,2) and m.indexed_at is not null
        and m.status='confirmed' and m.launch_finality='finalized'`, [wallet]),
      chain().getBalance(owner, 'confirmed').catch(() => null),
      chain().getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, { commitment: 'confirmed', dataSlice: SPL_ACCOUNT_SLICE }).catch(() => null),
      chain().getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, { commitment: 'confirmed', dataSlice: TOKEN_2022_ACCOUNT_SLICE }).catch(() => null),
      solUsdPrice().catch(() => null),
      // One-time verification bonus per launched market; best effort, never blocks the overview.
      readWalletVerificationBonuses(db, wallet).catch(() => new Map()),
    ])
    if (unavailable) throw Error()
    // Holdings are all-or-nothing: a missing program's accounts would silently understate balances.
    const balances = tokens && tokens2022 ? walletTokenBalances(tokens.value, wallet, tokens2022.value) : null
    const rows = walletMarkets(markets, balances, wallet, rewards.rows)
      .map(row => row.launchedByYou && bonuses.get(row.repoId) ? { ...row, verificationBonus: bonuses.get(row.repoId) } : row)
    const held = markets.filter(m => (balances?.get(m.mint) ?? 0n) > 0n)
    // Prices and P&L are best-effort: balances, launches and rewards still render if either fails.
    const [prices, trades] = await Promise.all([latestMarketPrices(db, held).catch(() => null),
      walletTrades(db, wallet, held).catch(() => null)])
    const valued = withHoldingValues(rows, prices ?? new Map())
    const priced = trades ? withHoldingPnl(valued, trades) : valued
    return Response.json({ wallet, solBalance: Number.isSafeInteger(sol) && sol >= 0 ? String(sol) : null,
      holdingsAvailable: Boolean(balances), pricesAvailable: Boolean(prices), usdPerSol,
      portfolio: portfolioSummary(priced), launcherRewards: launcherRewardTotals(rows), markets: priced, checkedAt: new Date().toISOString() },
    { headers: { 'Cache-Control': 'private, no-store' } })
  } catch { return Response.json({ error: 'Your wallet overview is temporarily unavailable. Please retry.' }, { status: 503 }) }
}
