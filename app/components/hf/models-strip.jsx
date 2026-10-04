import Link from 'next/link'
import { ArrowRight, Heart } from 'lucide-react'
import { MarketLink } from '../market-link'
import { RepoAvatar } from '../ui'
import { formatSolDisplay } from '../../lib/format.mjs'
import { compactCount } from '../../lib/hf-model-display.mjs'
import { ModelCardBadge, ModelDisclaimer, likesTitle } from './model-ui'

// Home board, Models tab: Hugging Face model markets (rows from selectModelStrip), in the token page's "More markets" card
// shape (hf-models.css sizes those cards under .models-strip). The tab is there whenever model markets are on, so with none
// to show it says so.
export function ModelsStrip({ markets = [] }) {
  if (!markets.length) return <p className="home-board-empty">No model markets yet.</p>
  return <div className="models-strip">
    <ol className="more-markets-rail">{markets.map(market => <li className="more-markets-card" key={market.mint}>
      <MarketLink mint={market.mint} className="more-markets-repo"><RepoAvatar repo={market}/><span><strong title={market.fullName}>{market.fullName}</strong>
        <small><span className="more-markets-symbol">${market.symbol}</span><span className="models-strip-likes" title={likesTitle(market.likes)}><Heart size={11} aria-hidden="true"/>{compactCount(market.likes)}</span></small></span></MarketLink>
      <ModelCardBadge/>
      <p className="more-markets-volume"><span>24h vol</span>{formatSolDisplay(market.volume24hLamports)} SOL</p>
      <MarketLink mint={market.mint} hash="#trade-panel" className="button primary more-markets-buy" aria-label={`Buy $${market.symbol}`}>Buy</MarketLink>
    </li>)}</ol>
    <ModelDisclaimer/>
    <Link href="/explore?source=models" className="home-board-more">Every model market <ArrowRight size={15} aria-hidden="true"/></Link>
  </div>
}
