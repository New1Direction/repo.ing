import { marketTransparency } from '../lib/market-transparency.mjs'
import { depthScale } from '../lib/public-launch.mjs'
import '../transparency.css'
import '../public-launch.css'

// Token page "Launch quality" tab (docs/LAUNCH_TRANSPARENCY.md): the worker's stored report with every criterion's evidence and
// unknowns, the staged launch mechanism, seeded liquidity with labels and lock states, executable liquidity, trading integrity,
// and the reward and incentive previews. Facts and disclosures only: no buy or sell call to action lives here.
const STATUS_LABEL = { pass: 'Pass', warn: 'Caution', fail: 'Fail', unknown: 'Unknown', info: 'Info' }
const STAGE_LABEL = { done: 'Done', active: 'Now', upcoming: 'Next', skipped: 'Not used' }
const LINK_KINDS = { 'same-transaction': 'same transaction', operator: 'operator record', funding: 'funding source' }
const EXCLUSIONS = { 'migrated-locked': "repo.ing's locked migration liquidity", labeled: 'labeled repo.ing or builder wallet',
  'circular-volume': 'circular volume in this market', 'owner-unknown': 'owner unknown' }
const short = value => (value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '—')
const sol = lamports => (lamports === null || lamports === undefined ? '—' : `${(Number(BigInt(lamports)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`)
const pct = value => (value === null || value === undefined ? '—' : `${Number(Number(value).toFixed(value >= 10 ? 1 : 2))}%`)
const bps = value => (value === null || value === undefined ? '—' : `${(value / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`)
const utc = value => (value ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—')
const explorer = (kind, value) => `https://solscan.io/${kind}/${value}`

export function MarketTransparencyFallback() {
  return <div id="transparency" className="inner-card transparency-card" aria-busy="true"><h3>Launch quality</h3><p role="status" className="loading-placeholder">Reading the transparency report…</p></div>
}

export async function MarketTransparency({ market }) {
  const view = await marketTransparency(market)
  if (!view) return <div id="transparency" className="inner-card transparency-card"><h3>Launch quality</h3><p className="subtle-notice" role="status">The transparency report is temporarily unavailable.</p></div>
  const { report, liquidity, seeded, mechanism, disclosures } = view
  return <div id="transparency" className="transparency">
    <QualityCard report={report}/>
    <section className="inner-card transparency-card" aria-labelledby="mechanism-title">
      <h3 id="mechanism-title">How this market opened</h3>
      <p className="transparency-lede">Same terms for every wallet: one public price curve, no allowlist, no hidden allocation.</p>
      <ol className="transparency-stages">{mechanism.stages.map(stage => <li key={stage.id} className={`is-${stage.status}`}>
        <span className="transparency-stage-status">{STAGE_LABEL[stage.status]}</span>
        <div><strong>{stage.title}</strong>{stage.facts.map(fact => <p key={fact}>{fact}</p>)}
          {stage.evidence && <a href={explorer('tx', stage.evidence)} target="_blank" rel="noreferrer">Transaction ↗</a>}</div>
      </li>)}</ol>
      <details className="transparency-notlive"><summary>Not live yet</summary><ul>{mechanism.notLive.map(item => <li key={item.id}><strong>{item.title}.</strong> {item.text}</li>)}</ul></details>
    </section>
    {seeded && <section className="inner-card transparency-card" aria-labelledby="seeded-title">
      <h3 id="seeded-title">Seeded liquidity and reserved supply</h3>
      <div className="transparency-table-wrap"><table className="transparency-table">
        <thead><tr><th scope="col">What</th><th scope="col">Wallet</th><th scope="col">Amount</th><th scope="col">Lock state</th></tr></thead>
        <tbody>{seeded.map((row, index) => <tr key={`${row.kind}-${index}`}>
          <th scope="row">{row.label}</th>
          <td>{row.wallet ? <a href={explorer('account', row.wallet)} target="_blank" rel="noreferrer" title={row.wallet}>{short(row.wallet)}</a>
            : row.positions ? row.positions.map(position => <a key={position} href={explorer('account', position)} target="_blank" rel="noreferrer" title={position}>{short(position)} </a>) : '—'}</td>
          <td>{row.tokenBaseUnits !== null && row.tokenBaseUnits !== undefined && row.percentOfSupply !== null ? `${pct(row.percentOfSupply)} of supply` : ''}
            {BigInt(row.solLamports ?? 0) > 0n ? <small>{sol(row.solLamports)}</small> : null}
            {row.currentIndexedPercent !== undefined && row.currentIndexedPercent !== null && <small>Holds {pct(row.currentIndexedPercent)} now (indexed swaps)</small>}</td>
          <td>{row.lockText}{row.evidence && <> <a href={explorer('tx', row.evidence)} target="_blank" rel="noreferrer">Evidence ↗</a></>}</td>
        </tr>)}</tbody></table></div>
    </section>}
    <LiquidityCard liquidity={liquidity} sustained={report?.health?.liquidity ?? null} mint={market.mint}/>
    {report?.integrity && <IntegrityCard integrity={report.integrity}/>}
    {report?.health?.builderReward && <RewardPreview health={report.health}/>}
    {report?.incentives && <IncentivesCard incentives={report.incentives}/>}
    <section className="inner-card transparency-card transparency-risks" aria-labelledby="risks-title">
      <h3 id="risks-title">Risks</h3><ul>{disclosures.map(item => <li key={item}>{item}</li>)}</ul>
      <p className="transparency-api">Machine-readable: <a href={`/api/v1/markets/${market.mint}/transparency`}>transparency JSON</a> · <a href={`/api/v1/markets/${market.mint}/liquidity`}>live liquidity</a> · <a href="https://github.com/new1direction/repo.ing/blob/main/docs/LAUNCH_TRANSPARENCY.md" target="_blank" rel="noreferrer">methodology ↗</a></p>
    </section>
  </div>
}

function QualityCard({ report }) {
  if (!report) return <section className="inner-card transparency-card" aria-labelledby="quality-title"><h3 id="quality-title">Launch quality</h3>
    <p className="transparency-lede">Not assessed yet. The worker assesses each market about once an hour after it is indexed.</p></section>
  const groups = [...new Set(report.criteria.map(item => item.group))]
  return <section className="inner-card transparency-card" aria-labelledby="quality-title">
    <div className="transparency-score-head"><h3 id="quality-title">Launch quality</h3>
      <div className="transparency-score"><strong>{report.score === null ? '—' : report.score}<span>/100</span></strong>
        <small>{report.coveragePercent}% of criteria known · assessed {utc(report.assessedAt)}</small></div></div>
    <p className="transparency-lede">{report.summary}. Facts with their sources, not a rating to buy. Nothing anyone pays, and no price or volume amount, can change it.</p>
    {report.unknowns.length > 0 && <p className="transparency-unknowns"><strong>Unknown:</strong> {report.criteria.filter(item => item.status === 'unknown').map(item => item.label).join(' · ')}</p>}
    {groups.map(group => <div key={group} className="transparency-group"><h4>{group}</h4><ul className="transparency-criteria">
      {report.criteria.filter(item => item.group === group).map(item => <li key={item.id} className={`is-${item.status}`}>
        <span className="transparency-status">{STATUS_LABEL[item.status]}</span>
        <div><strong>{item.label}</strong>{item.value && <span className="transparency-value">{item.value}</span>}
          {item.note && <p>{item.note}</p>}
          {item.evidence.length > 0 && <small>{item.evidence.map((evidence, index) => <span key={index}>{evidence.ref ? <a href={evidence.ref} target="_blank" rel="noreferrer">{evidence.source} ↗</a> : evidence.source}{evidence.observedAt ? ` · ${utc(evidence.observedAt)}` : ''}</span>)}</small>}</div>
        {item.max > 0 && <span className="transparency-points">{item.status === 'unknown' ? '—' : item.points}/{item.max}</span>}
      </li>)}</ul></div>)}
    <p className="transparency-excluded">Never an input: {report.excludedInputs.join(', ')}.</p>
  </section>
}

export function LiquidityCard({ liquidity, sustained }) {
  if (!liquidity) return <section className="inner-card transparency-card" aria-labelledby="liquidity-title"><h3 id="liquidity-title">Sampled liquidity</h3>
    <p className="transparency-lede">Liquidity evidence unavailable. This does not mean zero liquidity. The worker samples each market about hourly.</p></section>
  const profile = liquidity.profile ?? {}
  const scale = depthScale(profile.depth)
  return <section className="inner-card transparency-card" aria-labelledby="liquidity-title">
    <h3 id="liquidity-title">Sampled liquidity <small>{liquidity.venue === 'damm' ? 'graduated pool' : 'bonding curve'} · sampled {utc(liquidity.sampledAt)}</small></h3>
    <p className="transparency-lede">Historical depth, not a live quote. Bars share one SOL scale across buys and sells; short or missing sell depth can make an exit costly or impossible.</p>
    <div className="transparency-table-wrap"><table className="transparency-table numeric depth-table">
      <caption className="sr-only">Sampled buy and sell depth in SOL, within each price-impact threshold</caption>
      <thead><tr><th scope="col">Within</th><th scope="col">Buy up to</th><th scope="col">Sell up to</th></tr></thead>
      <tbody>{(profile.depth ?? []).map(row => <tr key={row.impactPercent}><th scope="row">{row.impactPercent}% of spot</th>
        {[['buy', row.buyLamports], ['sell', row.sellLamports]].map(([side, value]) => <td key={side}><span className="depth-value">{scale(value) === null ? 'Unknown' : sol(value)}</span>
          {scale(value) !== null && <span className={`depth-track is-${side}`} aria-hidden="true"><i style={{ width: `${scale(value)}%` }}/></span>}</td>)}</tr>)}</tbody>
    </table></div>
    {!profile.depth?.length && <p className="transparency-note">Depth measurements unavailable in this sample.</p>}
    <dl className="transparency-facts">
      <div><dt>Fee at sample</dt><dd>{bps(liquidity.feeBps)}</dd></div>
      {(profile.spreads ?? []).map(row => <div key={row.sizeLamports}><dt>Round trip at {sol(row.sizeLamports)}</dt><dd>{row.spreadBps === null ? 'One-sided' : bps(row.spreadBps)}</dd></div>)}
      <div><dt>SOL in {liquidity.venue === 'damm' ? 'pool' : 'curve'}</dt><dd>{sol(liquidity.quoteReserveLamports)}</dd></div>
      {sustained && <><div><dt>Two-sided, 30 days</dt><dd>{pct(sustained.uptimePercent)} of {sustained.samples} sample{sustained.samples === 1 ? '' : 's'}</dd></div>
        <div><dt>Median depth (2%)</dt><dd>{sol(sustained.medianDepthLamports)}</dd></div></>}
    </dl>
    <p className="transparency-note">Depth: the largest trade whose average price, before fees, stays within that distance of spot. Round trip: buying that much and selling it back at the sample time, fees included. Snapshots from Meteora SDK quotes; other trades change execution.</p>
  </section>
}

function IntegrityCard({ integrity }) {
  const rows = [['Organic', integrity.organicPercent], ['Round trips (one controller buys and sells back within an hour)', integrity.roundTripPercent],
    ['Both sides in one transaction', integrity.sameTransactionPercent], ['Labeled repo.ing and builder wallets', integrity.labeledPercent]]
  return <section className="inner-card transparency-card" aria-labelledby="integrity-title">
    <h3 id="integrity-title">Trading integrity <small>all finalized swaps</small></h3>
    <dl className="transparency-facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{pct(value)}</dd></div>)}
      <div><dt>Not yet attributed to a wallet</dt><dd>{pct(integrity.unattributedPercent)} of volume</dd></div>
      <div><dt>Controllers</dt><dd>{integrity.traders.controllers} ({integrity.traders.linkedControllers} with linked wallets)</dd></div>
      {integrity.linkEvidence && Object.keys(integrity.linkEvidence).length > 0 && <div><dt>Wallet links found</dt><dd>{Object.entries(integrity.linkEvidence)
        .map(([kind, count]) => `${count} ${LINK_KINDS[kind] ?? kind}`).join(' · ')}</dd></div>}</dl>
    {integrity.flagged.length > 0 && <details><summary>Largest round-trip and same-transaction controllers</summary><ul className="transparency-flagged">
      {integrity.flagged.map(row => <li key={row.cluster}>{row.wallets.map(wallet => <a key={wallet} href={explorer('account', wallet)} target="_blank" rel="noreferrer" title={wallet}>{short(wallet)}</a>)}
        <span>{sol(row.roundTripLamports)} round trips · {sol(row.sameTransactionLamports)} same transaction</span></li>)}</ul></details>}
    <p className="transparency-note">Shares are of volume attributed to a wallet. Wallets are linked only on public evidence: two owners in one transaction, a shared first funder that is not an exchange-like service, funding by another trader of this market, or an operator record. Linked activity is undercounted, never invented.</p>
  </section>
}

function RewardPreview({ health }) {
  const { builderReward, diversity, retention } = health
  return <section className="inner-card transparency-card" aria-labelledby="reward-title">
    <h3 id="reward-title">Post-launch builder reward <small>preview · nothing is paid</small></h3>
    <p className="transparency-lede">Measured on sustained liquidity, holder diversity and retention. First-hour volume, total volume and price never count.</p>
    <dl className="transparency-facts"><div><dt>Effective holders</dt><dd>{diversity.effectiveHolders} of {diversity.holders}</dd></div>
      <div><dt>First-week buyers still holding</dt><dd>{retention.earlyRetentionPercent === null ? `${retention.earlyRetained}/${retention.earlyCohort} (judged after 30 days)` : pct(retention.earlyRetentionPercent)}</dd></div></dl>
    <ul className="transparency-criteria compact">{builderReward.criteria.map(item => <li key={item.id} className={`is-${item.status}`}><span className="transparency-status">{STATUS_LABEL[item.status]}</span><div><strong>{item.label}</strong></div></li>)}</ul>
  </section>
}

function IncentivesCard({ incentives }) {
  return <section className="inner-card transparency-card" aria-labelledby="incentives-title">
    <h3 id="incentives-title">Liquidity providers <small>incentive preview · nothing is paid</small></h3>
    <p className="transparency-lede">Only LP positions in the graduated pool qualify: they quote both sides. Trading volume never does.</p>
    {incentives.providers.length === 0 ? <p className="transparency-note">No LP positions sampled yet.</p> :
      <div className="transparency-table-wrap"><table className="transparency-table">
        <thead><tr><th scope="col">Owner</th><th scope="col">Share (7 days)</th><th scope="col">Uptime</th><th scope="col">Preview share</th></tr></thead>
        <tbody>{incentives.providers.map(row => <tr key={row.owner ?? row.positions[0]}>
          <th scope="row">{row.owner ? <a href={explorer('account', row.owner)} target="_blank" rel="noreferrer" title={row.owner}>{row.label ?? short(row.owner)}</a> : 'Unknown'}</th>
          <td>{pct(row.timeWeightedSharePercent)}</td><td>{pct(row.uptimePercent)}</td>
          <td>{row.exclusion ? <span className="transparency-excluded-tag">Excluded: {EXCLUSIONS[row.exclusion] ?? row.exclusion}</span> : pct(row.incentiveSharePercent)}</td></tr>)}</tbody>
      </table></div>}
  </section>
}
