import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { buybackReceipts } from '../lib/buyback-feed.mjs'
import { buybackSummary } from '../lib/buyback-summary.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'

// Server-rendered from the receipts /stats lists. The fallback reserves the same box, so streaming
// the figures in causes no layout shift.
export async function BuybackCounter() {
  const summary = buybackSummary(await buybackReceipts())
  return <BuybackFrame>{summary
    ? <><strong>{summary.sol} SOL</strong> of platform fees <span aria-hidden="true">→</span><span className="sr-only">bought</span> <strong>{summary.tokens} ${OFFICIAL_TOKEN.symbol}</strong> bought back</>
    : <>Platform-fee buybacks of ${OFFICIAL_TOKEN.symbol} are published with on-chain receipts.</>}</BuybackFrame>
}

export function BuybackFrame({ children = <span className="buyback-counter-pending">Loading buyback totals…</span> }) {
  return <aside className="buyback-counter" aria-label={`${OFFICIAL_TOKEN.symbol} buybacks`}>
    <span className="buyback-counter-label">Buybacks</span>
    <p>{children}</p>
    <Link href="/stats#repo-title">Receipts <ArrowRight size={14} aria-hidden="true"/></Link>
  </aside>
}
