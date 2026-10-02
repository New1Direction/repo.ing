import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { formatSolDisplay } from '../lib/format.mjs'
import { MORE_MARKETS_LIMIT } from '../lib/more-markets.mjs'
import { NewRepoLabel, OfficialBadge } from './market-signals'
import { isModelMarket } from '../lib/hf-model-display.mjs'
import { ModelCardBadge, ModelDisclaimer, ModelSourceChip } from './hf/model-ui'

// Renders nothing when there is no other market, so the token page never shows an empty box. One chip fits a card: New repo
// (a caution) before Official, before New (launched this week). A Hugging Face model's card carries its source label
// instead, and a strip with any model in it names both kinds and ends with the full disclaimer.
export function MoreMarkets({ markets = [], featured = false }) {
  if (!markets.length) return null
  const models = markets.some(isModelMarket)
  return <section className={`more-markets${featured ? ' featured' : ''}${models ? ' has-models' : ''}`} aria-labelledby="more-markets-title">
    <div className="more-markets-heading"><h2 id="more-markets-title">{models ? 'More markets' : 'More repo markets'}</h2><p>{models ? 'Every trade pays the builders in SOL.' : 'Every trade pays the repo\'s builders in SOL.'}</p></div>
    <ol className="more-markets-rail">{markets.map(market => <li className="more-markets-card" key={market.mint}>
      <MarketLink mint={market.mint} className="more-markets-repo"><RepoAvatar repo={market}/><span><strong>{market.fullName}</strong><small><span className="more-markets-symbol">${market.symbol}</span>{isModelMarket(market) ? <ModelSourceChip compact/> : market.newRepo ? <NewRepoLabel compact/> : market.officialLaunch ? <OfficialBadge compact/> : market.isNew && <span className="more-markets-new">New</span>}</small></span></MarketLink>
      {isModelMarket(market) && <ModelCardBadge/>}
      <p className="more-markets-volume"><span>24h vol</span>{formatSolDisplay(market.volume24hLamports)} SOL</p>
      <MarketLink mint={market.mint} hash="#trade-panel" className="button primary more-markets-buy" aria-label={`Buy $${market.symbol}`}>Buy</MarketLink>
    </li>)}</ol>
    {models && <ModelDisclaimer/>}
  </section>
}

// Same outer height as a populated strip, so streaming it in does not move the page.
export function MoreMarketsFallback({ featured = false }) {
  return <div className={`more-markets more-markets-fallback${featured ? ' featured' : ''}`} role="status" aria-busy="true"><span className="sr-only">Loading more repo markets</span>
    <div className="more-markets-heading" aria-hidden="true"><span className="skeleton-line"/><span className="skeleton-line short"/></div>
    <div className="more-markets-rail" aria-hidden="true">{Array.from({ length: MORE_MARKETS_LIMIT }, (_, i) => <span className="more-markets-card" key={i}><span className="skeleton-line"/><span className="skeleton-line short"/></span>)}</div>
  </div>
}
