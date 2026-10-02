import Link from 'next/link'
import { ArrowRight, BadgeCheck } from 'lucide-react'
import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { formatSolDisplay } from '../lib/format.mjs'
import '../market-signals.css'

// Home: markets their repository's own verified maintainer launched (officialLaunches in official-launch.mjs), newest
// first. Renders nothing while there are none.
export function OfficialLaunches({ markets }) {
  if (!markets?.length) return null
  return <section className="official-launches" aria-labelledby="official-launches-title">
    <div className="official-launches-head">
      <h2 id="official-launches-title"><BadgeCheck size={17} strokeWidth={2.4} aria-hidden="true"/>Official launches</h2>
      <p>Launched by the repository&apos;s own verified maintainer</p>
      <Link href="/explore?owner=official" aria-label="See every official launch">See all <ArrowRight size={15} aria-hidden="true"/></Link>
    </div>
    <ol className="official-launches-list">{markets.map(market => <li key={market.mint}><MarketLink mint={market.mint} className="official-card">
      <RepoAvatar repo={market}/>
      <span className="official-card-name"><strong>{market.fullName}</strong><small>${market.symbol}</small></span>
      <span className="official-card-meta">{market.launched && <span>Launched {market.launched}</span>}
        <span><b>{formatSolDisplay(market.volume24hLamports)} SOL</b> 24h vol</span></span>
    </MarketLink></li>)}</ol>
  </section>
}
