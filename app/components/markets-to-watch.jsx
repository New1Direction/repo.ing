import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { MarketLink } from './market-link'
import { RepoAvatar } from './ui'
import { GraduationRaceBoard, GraduationRaceFallback } from './graduation-race'
import { WATCH_LIMIT } from '../lib/graduation-race.mjs'

// $REPOING page, side column: where to look next among repo markets. Static frame; both lists stream in at a fixed
// height (three rows each; open rows fill gaps), so nothing around the card moves.
export function MarketsToWatch({ children }) {
  return <section className="inner-card watch-card" aria-labelledby="watch-title">
    <div className="watch-heading"><h3 id="watch-title">Repo markets to watch</h3>
      <Link href="/explore" className="watch-all">Explore all<ArrowRight size={14} aria-hidden="true"/></Link></div>
    <p className="watch-intro">Every trade in a repo market pays that repo&apos;s builders.</p>
    {children}
  </section>
}

const NewestHeading = () => <h4 className="watch-label" id="watch-new-title">Newest launches</h4>
const RaceHeading = () => <h4 className="watch-label">Closest to graduation</h4>

export function MarketsToWatchLists({ race = [], newest = [], raceUnavailable = null, newestUnavailable = null }) {
  const listed = newest.slice(0, WATCH_LIMIT)
  return <>
    <RaceHeading/><GraduationRaceBoard markets={race} limit={WATCH_LIMIT} unavailable={raceUnavailable}/>
    <NewestHeading/>
    <ol className="watch-list" aria-labelledby="watch-new-title">
      {listed.map(market => <li key={market.mint}>
        <MarketLink mint={market.mint} className="watch-row" aria-label={`${market.fullName} ($${market.symbol}), launched ${market.launched}`}>
          <RepoAvatar repo={market}/>
          <span className="watch-name"><strong>{market.fullName}</strong><small>${market.symbol}</small></span>
          <span className="watch-when">{market.launched}</span>
        </MarketLink></li>)}
      {Array.from({ length: WATCH_LIMIT - listed.length }, (_, index) => <li key={`open-${index}`} className="watch-row is-open" aria-hidden={listed.length > 0 || undefined}>
        {!listed.length && !index ? newestUnavailable ?? 'No other markets yet' : ''}</li>)}
    </ol>
  </>
}

export function MarketsToWatchFallback() {
  return <div role="status" aria-busy="true"><span className="sr-only">Loading repo markets to watch</span>
    <RaceHeading/><GraduationRaceFallback limit={WATCH_LIMIT} announce={false}/>
    <h4 className="watch-label" aria-hidden="true">Newest launches</h4>
    <ol className="watch-list" aria-hidden="true">{Array.from({ length: WATCH_LIMIT }, (_, index) => <li key={index} className="watch-row is-loading">
      <span className="skeleton-avatar"/><span className="watch-name"><span className="skeleton-line"/><span className="skeleton-line short"/></span></li>)}</ol>
  </div>
}
