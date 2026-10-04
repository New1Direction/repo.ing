import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { formatCount } from '../lib/pulse-format.mjs'

// Home board, Shipping tab: the repositories whose developers shipped the most code this week, from Dev Pulse.
export function ShippingLeaders({ markets }) {
  if (!markets?.length) return <p className="home-board-empty">No repository has shipped code this week yet.</p>
  return <>
    <ol className="shipping-leaders-list">{markets.map((market, index) => <li key={market.mint}><MarketLink mint={market.mint} className="shipping-card">
      <span className="shipping-rank" aria-hidden="true">{index + 1}</span><RepoAvatar repo={market}/>
      <span className="shipping-name"><strong>{market.fullName}</strong><small>${market.symbol}</small></span>
      <span className="shipping-stats"><span><b>{formatCount(market.pulse.commits7d)}</b> commits</span><span><b>{formatCount(market.pulse.merged7d)}</b> PRs merged</span>
        {market.pulse.devs7d > 0 && <span><b>{formatCount(market.pulse.devs7d)}</b> dev{market.pulse.devs7d === 1 ? '' : 's'}</span>}</span>
    </MarketLink></li>)}</ol>
    <Link href="/explore?view=shipping" className="home-board-more">Every repository by code shipped <ArrowRight size={15} aria-hidden="true"/></Link>
  </>
}
