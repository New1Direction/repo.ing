import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { buybackReceipts, buybackStatus } from '../lib/buyback-feed.mjs'
import { buybackSummary, formatTokenCompact } from '../lib/buyback-summary.mjs'
import { formatSolDisplay } from '../lib/format.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import { LastBuybackTime, receiptUrl } from './buyback-status'

// Server-rendered from the receipts /stats lists. The fallback reserves the same box, so streaming
// the figures in causes no layout shift.
export async function BuybackCounter() {
  const [receipts, status] = await Promise.all([buybackReceipts(), buybackStatus()])
  const summary = buybackSummary(receipts)
  return <BuybackFrame status={<BuybackLatest status={status}/>}>{summary
    ? <><strong>{summary.sol} SOL</strong> of platform fees <span aria-hidden="true">→</span><span className="sr-only">bought</span> <strong>{summary.tokens} ${OFFICIAL_TOKEN.symbol}</strong> bought back</>
    : <>Platform-fee buybacks of ${OFFICIAL_TOKEN.symbol} are published with on-chain receipts.</>}</BuybackFrame>
}

// One line: the last platform-revenue buyback (linked to its receipt) and the buyback share of fees since.
function BuybackLatest({ status }) {
  const last = status?.last, since = status?.since
  if (!last) return <>Executed manually by the team; each one is published with its receipt.</>
  return <>Last <a href={receiptUrl(last.signature)} target="_blank" rel="noopener noreferrer"><LastBuybackTime last={last}/></a>: {formatSolDisplay(last.spentLamports)} SOL → {formatTokenCompact(last.tokenBaseUnits)} ${OFFICIAL_TOKEN.symbol}
    {since && <> · {formatSolDisplay(since.lamports)} SOL {since.basis === 'policy' ? 'allocated to buybacks' : 'in platform fees'} since</>}</>
}

export function BuybackFrame({ children = <span className="buyback-counter-pending">Loading buyback totals…</span>, status = <span className="buyback-counter-pending">&nbsp;</span> }) {
  return <aside className="buyback-counter" aria-label={`${OFFICIAL_TOKEN.symbol} buybacks`}>
    <span className="buyback-counter-label">Buybacks</span>
    <div className="buyback-counter-body"><p>{children}</p><p className="buyback-counter-latest">{status}</p></div>
    <Link href="/stats#repo-title">Receipts <ArrowRight size={14} aria-hidden="true"/></Link>
  </aside>
}
