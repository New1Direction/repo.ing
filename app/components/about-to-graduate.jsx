import { ChevronRight } from 'lucide-react'
import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { graduationSummary, ABOUT_TO_GRADUATE_LIMIT } from '../lib/about-to-graduate.mjs'

// Renders nothing when no market qualifies, so the page never shows an empty box.
export function AboutToGraduate({ markets = [] }) {
  if (!markets.length) return null
  return <section className="graduating" aria-labelledby="graduating-title">
    <div className="section-heading"><div><h2 id="graduating-title">About to graduate</h2><p>These markets are close to their graduation target. At graduation, trading moves into a Meteora DAMM pool.</p></div></div>
    <ol className="graduating-rail">{markets.map(market => <li className="graduating-card" key={market.mint}>
      <MarketLink mint={market.mint} className="graduating-repo"><RepoAvatar repo={market}/><span><strong>{market.fullName}</strong><small>${market.symbol}</small></span></MarketLink>
      <div className="bonding-track" role="progressbar" aria-label={`${market.fullName} progress to graduation`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={market.progressPercent}><span style={{ width: `${market.progressPercent}%` }}/></div>
      <p className="graduating-summary">{graduationSummary(market)}</p>
      <MarketLink mint={market.mint} className="button outline table-action" aria-label={`Trade ${market.symbol}`}>Trade<ChevronRight size={15}/></MarketLink>
    </li>)}</ol>
  </section>
}

// Same outer height as a populated section, so streaming the rail in does not move the page.
export function AboutToGraduateFallback() {
  return <div className="graduating graduating-fallback" role="status" aria-busy="true"><span className="sr-only">Loading markets about to graduate</span>
    <div className="graduating-fallback-heading" aria-hidden="true"><span className="skeleton-line"/><span className="skeleton-line short"/></div>
    <div className="graduating-rail" aria-hidden="true">{Array.from({ length: ABOUT_TO_GRADUATE_LIMIT }, (_, i) => <span className="graduating-card" key={i}><span className="skeleton-line"/><span className="skeleton-line short"/></span>)}</div>
  </div>
}
