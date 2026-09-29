import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { buybackReceipts } from '../lib/buyback-feed.mjs'
import { buybackSummary } from '../lib/buyback-summary.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

// Lifetime total of every published buyback (platform revenue and team wallet), from the receipts /stats
// lists. The fallback reserves the same box, so streaming the figures in causes no layout shift.
export async function BuybackCounter() {
  const summary = buybackSummary(await buybackReceipts(), null)
  return <BuybackFrame>{summary
    ? <><strong>{summary.sol} SOL</strong> spent buying back <strong>{summary.tokens} ${OFFICIAL_TOKEN.symbol}</strong> all time</>
    : <>${OFFICIAL_TOKEN.symbol} buybacks are published with on-chain receipts.</>}</BuybackFrame>
}

export function BuybackFrame({ children = <span className="buyback-counter-pending">Loading buyback totals…</span> }) {
  return <aside className="buyback-counter" aria-label={`${OFFICIAL_TOKEN.symbol} buybacks`}>
    <span className="buyback-counter-label">Buybacks</span>
    <div className="buyback-counter-body"><p>{children}</p></div>
    <Link href="/stats#repo-title">Receipts <ArrowRight size={14} aria-hidden="true"/></Link>
  </aside>
}
