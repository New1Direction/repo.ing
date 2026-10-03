import { MarketLink } from './market-link'
import { NewRepoLabel } from './market-signals'
import { PulseBadge, RepoAvatar } from './ui'
import { ABOUT_TO_GRADUATE_MIN_PERCENT, GRADUATION_RACE_LIMIT, GRADUATION_RACE_MIN_PERCENT, graduationPercentLabel, raceLabel, remainingLabel } from '../lib/graduation-race.mjs'
import { isModelMarket } from '../lib/hf-model-display.mjs'
import { ModelDisclaimer, ModelSourceChip } from './hf/model-ui'
import '../graduation-race.css'

// Progress lane: the shared bonding-track bar plus a tick where "About to graduate" starts. Rows state the numbers in
// text and in their link label, so the bar itself is decorative.
function RaceTrack({ percent = 0, open = false }) {
  return <span className={`bonding-track race-track${open ? ' is-open' : ''}`} aria-hidden="true">
    {!open && <span style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}/>}
  </span>
}

// Static heading; the board streams in below it (GraduationRaceBoard, or GraduationRaceFallback while loading).
export function GraduationRace({ children }) {
  return <section className="race" aria-labelledby="race-title">
    <div className="section-heading race-heading"><div><h2 id="race-title">Graduation race</h2>
      <p>Markets closest to their graduation target, from verified on-chain reserves. At graduation, trading moves to a Meteora pool.</p></div>
      <p className="race-key" aria-hidden="true"><span className="race-key-tick"/>{ABOUT_TO_GRADUATE_MIN_PERCENT}%+ about to graduate</p></div>
    {children}
  </section>
}

// The whole row is one link to the token page.
function RaceRow({ market, rank }) {
  return <li><MarketLink mint={market.mint} className={`race-row${market.aboutToGraduate ? ' is-near' : ''}`} aria-label={raceLabel(market)}>
    <span className="race-rank" aria-hidden="true">{rank}</span>
    <RepoAvatar repo={market}/>
    <span className="race-name"><strong>{market.fullName}</strong>
      <small>${market.symbol}{isModelMarket(market) && <ModelSourceChip compact/>}{market.aboutToGraduate && <span className="race-near">About to graduate</span>}{market.newRepo && !isModelMarket(market) && <NewRepoLabel compact/>}<PulseBadge badge={market.pulse?.badge}/></small></span>
    <RaceTrack percent={market.progressPercent}/>
    <span className="race-summary"><strong>{graduationPercentLabel(market.progressPercent)}</strong> · {remainingLabel(market)}</span>
  </MarketLink></li>
}

const openNote = (racers, unavailable) => unavailable ? 'Graduation progress is temporarily unavailable'
  : racers ? `Open lane: the next market past ${GRADUATION_RACE_MIN_PERCENT}% of its target appears here`
    : `No market has passed ${GRADUATION_RACE_MIN_PERCENT}% of its target yet`

// Always `limit` lanes tall: open lanes fill the rest, so streaming the board in never moves the page. Used on /explore
// (five lanes) and in the $REPOING "Repo markets to watch" card (three). compact (the home page, below the first screen):
// only the racers and one note row, so a thin race does not show as a column of empty lanes.
export function GraduationRaceBoard({ markets = [], limit = GRADUATION_RACE_LIMIT, unavailable = null, compact = false }) {
  const racers = markets.slice(0, limit), open = compact ? Math.min(1, limit - racers.length) : limit - racers.length
  return <div className="race-board">
    {racers.length > 0 && <ol className="race-list">{racers.map((market, index) => <RaceRow key={market.mint} market={market} rank={index + 1}/>)}</ol>}
    {open > 0 && <div className="race-open" aria-hidden={racers.length > 0 || undefined}>
      {Array.from({ length: open }, (_, index) => <div className="race-row is-open" key={index}>
        <span className="race-rank" aria-hidden="true">{racers.length + index + 1}</span>
        <span className="race-open-note">{index === 0 ? openNote(racers.length, unavailable) : ''}</span>
        <RaceTrack open/>
      </div>)}
    </div>}
    {racers.some(isModelMarket) && <ModelDisclaimer/>}
  </div>
}

// announce=false inside a loading region that already announces itself (the $REPOING card), so screen readers hear one.
export function GraduationRaceFallback({ limit = GRADUATION_RACE_LIMIT, announce = true }) {
  return <div className="race-board" role={announce ? 'status' : undefined} aria-busy={announce || undefined}>
    {announce && <span className="sr-only">Loading the graduation race</span>}
    <div className="race-open" aria-hidden="true">{Array.from({ length: limit }, (_, index) => <div className="race-row is-loading" key={index}>
      <span className="race-rank">{index + 1}</span><span className="skeleton-avatar"/>
      <span className="race-name"><span className="skeleton-line"/><span className="skeleton-line short"/></span>
      <RaceTrack open/><span className="race-summary"><span className="skeleton-line"/></span>
    </div>)}</div>
  </div>
}
