import Link from 'next/link'
import { ArrowRight, Heart } from 'lucide-react'
import { MarketLink } from '../market-link'
import { RepoAvatar } from '../ui'
import { formatSolDisplay } from '../../lib/format.mjs'
import { compactCount } from '../../lib/hf-model-display.mjs'
import { ModelCardBadge, ModelDisclaimer, likesTitle } from './model-ui'

// Home: Hugging Face model markets (rows from selectModelStrip), in the token page's "More markets" card shape. Renders
// nothing without a model market, so the home page never shows an empty section.
export function ModelsStrip({ markets = [] }) {
  if (!markets.length) return null
  return <section className="section-wrap models-strip" aria-labelledby="models-strip-title">
    <div className="section-heading"><div><h2 id="models-strip-title">Hugging Face models</h2>
      <p>Community launches for public AI models. Every trade pays the model’s owner in SOL.</p></div>
      <Link href="/explore?source=models" className="view-all">View all <ArrowRight size={20} aria-hidden="true"/></Link></div>
    <ol className="more-markets-rail">{markets.map(market => <li className="more-markets-card" key={market.mint}>
      <MarketLink mint={market.mint} className="more-markets-repo"><RepoAvatar repo={market}/><span><strong title={market.fullName}>{market.fullName}</strong>
        <small><span className="more-markets-symbol">${market.symbol}</span><span className="models-strip-likes" title={likesTitle(market.likes)}><Heart size={11} aria-hidden="true"/>{compactCount(market.likes)}</span></small></span></MarketLink>
      <ModelCardBadge/>
      <p className="more-markets-volume"><span>24h vol</span>{formatSolDisplay(market.volume24hLamports)} SOL</p>
      <MarketLink mint={market.mint} hash="#trade-panel" className="button primary more-markets-buy" aria-label={`Buy $${market.symbol}`}>Buy</MarketLink>
    </li>)}</ol>
    <ModelDisclaimer/>
  </section>
}
