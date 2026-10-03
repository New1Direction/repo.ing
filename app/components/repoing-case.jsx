import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { buybackReceipts, buybackStatus } from '../lib/buyback-feed.mjs'
import { platformTotals } from '../lib/platform-totals.mjs'
import { hfMarketsEnabled } from '../lib/hf-markets.mjs'
import { repoingCase } from '../lib/repoing-case.mjs'
import { OFFICIAL_TOKEN } from '../lib/official-token.mjs'
import '../repoing-case.css'

const SLOTS = 4

// $REPOING page, under the hero: why the platform token gains from every market, in live figures (lib/repoing-case.mjs).
// Every read is shared and cached (buybacks 30 s, protocol totals 5 min) and never rejects; pulse is the page's own Dev
// Pulse read. A figure that is not verified right now is left out rather than shown stale.
export async function RepoingCase({ pulse = null }) {
  const [receipts, status, totals] = await Promise.all([buybackReceipts(), buybackStatus(), platformTotals()])
  const facts = repoingCase({ status, receipts, totals, pulse, models: hfMarketsEnabled() })
  if (!facts.length) return null
  return <RepoingCaseFrame>{facts.map(fact => <div key={fact.id} className={`repoing-case-fact is-${fact.id}`}>
    <dt>{fact.label}</dt>
    <dd><strong>{fact.value}</strong><span>{fact.detail}</span>{fact.note && <small>{fact.note}</small>}</dd>
  </div>)}</RepoingCaseFrame>
}

// Same box and heights as the resolved card, so streaming the figures in never shifts the page.
export function RepoingCaseFallback() {
  return <RepoingCaseFrame busy>{Array.from({ length: SLOTS }, (_, index) => <div key={index} className="repoing-case-fact" aria-hidden="true">
    <dt><span className="skeleton-line"/></dt><dd><strong><span className="skeleton-line"/></strong><span className="skeleton-line"/></dd>
  </div>)}</RepoingCaseFrame>
}

function RepoingCaseFrame({ children, busy = false }) {
  const symbol = `$${OFFICIAL_TOKEN.symbol}`
  return <section className="repoing-case" aria-labelledby="repoing-case-title" aria-busy={busy || undefined}>
    <div className="repoing-case-intro">
      <span className="repoing-case-eyebrow">Why hold {symbol}</span>
      <h2 id="repoing-case-title">Every repo.ing market feeds {symbol}.</h2>
      <div className="repoing-case-actions">
        <a className="button primary" href="#trade-panel">Buy {symbol}</a>
        <Link className="repoing-case-link" href="/stats#repo-title">Buyback receipts<ArrowRight size={14} aria-hidden="true"/></Link>
      </div>
    </div>
    <dl className="repoing-case-facts">{children}</dl>
    {busy && <p className="sr-only" role="status">Loading {symbol} figures…</p>}
    <p className="repoing-case-foot">From repo.ing&apos;s ledger and on-chain receipts. Facts, not advice.</p>
  </section>
}
