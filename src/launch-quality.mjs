// Launch Quality report (docs/LAUNCH_TRANSPARENCY.md#launch-quality-score): a factual checklist for one market. Every criterion
// states what was observed, where it came from and when, and whether it passes, warns, fails or is UNKNOWN. The score is
// computed over known criteria only and always shown with its coverage; with less than MIN_COVERAGE_PERCENT known there is no
// score. Never pay-to-rank: the inputs below are the only inputs. Nothing anyone pays (fees, tips, promotion, raises, credits),
// and no price, market cap or trading volume amount, can change a criterion. Volume appears only as a sample-size floor for
// the integrity check. A report is a description, not advice or an endorsement.

export const QUALITY_VERSION = 1
export const MIN_COVERAGE_PERCENT = 60
// Below this much attributed volume, organic share is not measured (too little evidence).
export const INTEGRITY_MIN_VOLUME_LAMPORTS = 500_000_000n
const DAY = 86_400_000

// The inputs a report may read. Anything else passed in is ignored (and tests prove it changes nothing).
export const QUALITY_INPUTS = Object.freeze(['repo', 'pulse', 'forkParent', 'maintainer', 'launch', 'holders', 'launcher', 'integrity', 'liquidity', 'lpLock'])
export const EXCLUDED_INPUTS = Object.freeze(['fees or payments to repo.ing', 'promotion or placement', 'price', 'market cap',
  'trading volume amount', 'Group launch raise size', 'tips and credits'])

export const RISK_DISCLOSURES = Object.freeze([
  'Repository tokens are speculative. Their price can fall to zero and there may be no buyer when you want to sell.',
  'A market can be created by anyone for any public repository. It does not mean the maintainers endorse it, unless the report says a current GitHub admin verified it.',
  'This report describes public facts at the time shown. It is not investment advice, an audit, or a prediction, and a high score is not a promise of any return.',
  'Liquidity figures are snapshots. Other trades change the price before yours executes.',
])

const GITHUB = 'GitHub API'
const CHAIN = 'Solana (finalized/confirmed RPC reads)'
const LEDGER = 'repo.ing ledger of finalized swaps'

const iso = value => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const pctLabel = value => (value === null ? '—' : `${Number(value.toFixed(value >= 10 ? 1 : 2))}%`)
const sol = lamports => `${(Number(BigInt(lamports)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 3 })} SOL`

function criterion(id, group, label, max, { status, points = 0, value = null, evidence = [], note = null }) {
  if (!['pass', 'warn', 'fail', 'unknown', 'info'].includes(status)) throw new Error(`Invalid status for ${id}`)
  const known = status !== 'unknown' && status !== 'info'
  return { id, group, label, max: status === 'info' ? 0 : max, points: known ? Math.max(0, Math.min(max, points)) : 0, status, value,
    evidence: evidence.filter(item => item && item.source), note }
}

function repoCriteria({ repo, pulse, forkParent }, now) {
  const created = repo?.githubCreatedAt ? new Date(repo.githubCreatedAt).getTime() : NaN
  const ageDays = Number.isFinite(created) ? (now - created) / DAY : null
  const url = repo?.fullName ? `https://github.com/${repo.fullName}` : null
  const github = { source: GITHUB, ref: url, observedAt: iso(repo?.syncedAt) }
  const stars = Number.isSafeInteger(repo?.stars) ? repo.stars : null
  const commits = Number.isSafeInteger(pulse?.commits7d) ? pulse.commits7d : null
  return [
    criterion('repo_age', 'Repository', 'Repository age', 10, ageDays === null ? { status: 'unknown', note: 'GitHub creation date unavailable.' }
      : { status: ageDays >= 180 ? 'pass' : ageDays >= 30 ? 'warn' : 'fail', points: ageDays >= 180 ? 10 : ageDays >= 30 ? 5 : 0,
        value: `${Math.floor(ageDays)} days`, evidence: [github],
        note: ageDays < 30 ? 'Created less than 30 days ago: repositories made only to launch a token are usually new.' : null }),
    criterion('repo_adoption', 'Repository', 'GitHub stars', 10, stars === null ? { status: 'unknown', note: 'Star count unavailable.' }
      : { status: stars >= 100 ? 'pass' : stars >= 10 ? 'warn' : 'fail', points: stars >= 100 ? 10 : stars >= 10 ? 5 : 0,
        value: `${stars.toLocaleString('en-US')} stars`, evidence: [github] }),
    criterion('repo_activity', 'Repository', 'Commits in the last 7 days', 5, commits === null ? { status: 'unknown', note: 'No Dev Pulse reading for this repository yet.' }
      : { status: commits > 0 ? 'pass' : 'warn', points: commits > 0 ? 5 : 1, value: `${commits} commits, ${pulse?.devs7d ?? 0} developers`,
        evidence: [{ source: `${GITHUB} (Dev Pulse)`, ref: url, observedAt: iso(pulse?.checkedAt) }] }),
    criterion('original_repository', 'Repository', 'Original repository (not a fork or copy of a launched one)', 5, forkParent === undefined
      ? { status: 'unknown' } : forkParent ? { status: 'warn', points: 0, value: `Fork of ${forkParent}`, evidence: [github],
        note: 'GitHub reports this repository as a fork.' } : { status: 'pass', points: 5, value: 'Not a fork', evidence: [github] }),
  ]
}

function maintainerCriteria({ maintainer, repo }) {
  if (!maintainer) return [criterion('maintainer', 'Maintainer', 'Maintainer verification', 10, { status: 'unknown' })]
  const ref = repo?.fullName ? `https://github.com/${repo.fullName}` : null
  if (maintainer.declined) {
    return [criterion('maintainer', 'Maintainer', 'Maintainer verification', 10, { status: 'fail', value: 'Maintainer declined this market',
      evidence: [{ source: 'repo.ing maintainer decision (current GitHub admin)', ref, observedAt: iso(maintainer.decidedAt) }],
      note: 'A current GitHub admin declined the market. It keeps trading so holders can exit, but repo.ing never promotes it.' })]
  }
  return [criterion('maintainer', 'Maintainer', 'Maintainer verification', 10, maintainer.verified
    ? { status: 'pass', points: 10, value: 'Verified by a current GitHub admin',
      evidence: [{ source: 'GitHub admin permission check', ref, observedAt: iso(maintainer.verifiedAt) }] }
    : { status: 'fail', points: 0, value: 'Not verified', note: 'Community-created market: no current GitHub admin has verified it. That is not an endorsement.',
      evidence: [{ source: 'repo.ing verification records', ref, observedAt: null }] })]
}

function launchCriteria({ launch }) {
  if (!launch) return [criterion('launch_buy', 'Launch', 'Initial buy at launch', 10, { status: 'unknown' })]
  const tx = launch.signature ? { source: CHAIN, ref: `https://solscan.io/tx/${launch.signature}`, observedAt: iso(launch.launchedAt) } : null
  const buy = num(launch.launchBuyPercent)
  const items = []
  if (launch.bundle) {
    items.push(criterion('launch_buy', 'Launch', 'Initial buy at launch', 10, { status: 'warn', points: 5, value: `Group launch vault bought ${pctLabel(buy)}`,
      evidence: [tx], note: 'A Group launch raise bought the first tokens into a program vault that cannot withdraw them; operators trade it within on-chain limits.' }))
  } else {
    items.push(criterion('launch_buy', 'Launch', 'Initial buy at launch', 10, buy === null ? { status: 'unknown', note: 'Launch transaction not indexed yet.' }
      : { status: buy <= 1 ? 'pass' : buy <= 3 ? 'warn' : 'fail', points: buy <= 1 ? 10 : buy <= 3 ? 6 : 0,
        value: buy === 0 ? 'No initial buy' : `Launcher bought ${pctLabel(buy)} of supply`, evidence: [tx],
        note: buy > 0 ? 'The launcher\'s initial buy is the only purchase in the launch transaction, capped at 3% and paying the regular fee.' : null }))
  }
  items.push(criterion('anti_sniper', 'Launch', 'Launch fee window against first-block bots', 5, launch.launchFee === null || launch.launchFee === undefined
    ? { status: 'unknown' } : launch.launchFee
      ? { status: 'pass', points: 5, value: 'Fee starts at 50.44% and falls to 1.75% over 180 s', evidence: [{ source: 'DBC pool config (on chain)', ref: launch.config ? `https://solscan.io/account/${launch.config}` : null, observedAt: null }] }
      : { status: 'warn', points: 2, value: 'Flat 1.75% fee from the first block', note: 'Launched on an older config without the launch fee window.',
        evidence: [{ source: 'DBC pool config (on chain)', ref: launch.config ? `https://solscan.io/account/${launch.config}` : null, observedAt: null }] }))
  items.push(criterion('scheduled', 'Launch', 'Announced launch time', 0, launch.scheduled
    ? { status: 'info', value: `Scheduled publicly ${Math.round((new Date(launch.scheduled.scheduledAt) - new Date(launch.scheduled.createdAt)) / 3_600_000)} h ahead`,
      evidence: [{ source: 'repo.ing launch calendar', ref: null, observedAt: iso(launch.scheduled.createdAt) }] }
    : { status: 'info', value: 'Not scheduled in advance' }))
  return items
}

function holderCriteria({ holders, launcher, launch }) {
  const observedAt = iso(holders?.observedAt)
  const mintRef = launch?.mint ? `https://solscan.io/token/${launch.mint}` : null
  const mint = holders?.mint
  const items = [criterion('mint_authorities', 'Token', 'Fixed supply, mint and freeze authority revoked', 10, !mint ? { status: 'unknown' }
    : mint.fixedSupply && mint.mintAuthorityRevoked && mint.freezeAuthorityRevoked
      ? { status: 'pass', points: 10, value: 'Fixed supply; nobody can mint or freeze', evidence: [{ source: CHAIN, ref: mintRef, observedAt }] }
      : { status: 'fail', points: 0, value: [!mint.fixedSupply && 'supply differs', !mint.mintAuthorityRevoked && 'mint authority set',
        !mint.freezeAuthorityRevoked && 'freeze authority set'].filter(Boolean).join(', '), evidence: [{ source: CHAIN, ref: mintRef, observedAt }] })]
  const top = num(holders?.holders?.topPercent)
  items.push(criterion('holder_concentration', 'Token', 'Top 10 holders (excluding curve, pool and lock escrows)', 10, top === null ? { status: 'unknown' }
    : { status: top <= 30 ? 'pass' : top <= 50 ? 'warn' : 'fail', points: top <= 30 ? 10 : top <= 50 ? 5 : 0, value: `${pctLabel(top)} of supply`,
      evidence: [{ source: `${CHAIN}: largest token accounts`, ref: mintRef, observedAt }] }))
  const held = num(launcher?.heldPercent)
  items.push(criterion('launcher_position', 'Token', 'Launcher\'s indexed holding', 5, held === null ? { status: 'unknown' }
    : { status: held <= 3 ? 'pass' : held <= 10 ? 'warn' : 'fail', points: held <= 3 ? 5 : held <= 10 ? 2 : 0, value: `${pctLabel(held)} of supply`,
      evidence: [{ source: LEDGER, ref: launcher?.wallet ? `https://solscan.io/account/${launcher.wallet}` : null, observedAt: null }],
      note: 'Net of the launcher wallet\'s indexed buys and sells; tokens moved by transfer are not visible here.' }))
  return items
}

function integrityCriteria({ integrity }) {
  if (!integrity) return [criterion('organic_volume', 'Trading', 'Organic share of volume', 10, { status: 'unknown' })]
  const attributed = BigInt(integrity.totals?.volume ?? 0) - BigInt(integrity.totals?.unattributed ?? 0)
  const organic = num(integrity.organicPercent)
  const evidence = [{ source: LEDGER, ref: null, observedAt: iso(integrity.observedAt) }]
  if (attributed < INTEGRITY_MIN_VOLUME_LAMPORTS || organic === null) {
    return [criterion('organic_volume', 'Trading', 'Organic share of volume', 10, { status: 'unknown', value: `${sol(attributed > 0n ? attributed : 0n)} attributed`,
      evidence, note: `Not measured below ${sol(INTEGRITY_MIN_VOLUME_LAMPORTS)} of attributed volume.` })]
  }
  return [criterion('organic_volume', 'Trading', 'Organic share of volume', 10, {
    status: organic >= 80 ? 'pass' : organic >= 50 ? 'warn' : 'fail', points: organic >= 80 ? 10 : organic >= 50 ? 5 : 0,
    value: `${pctLabel(organic)} organic; ${pctLabel(num(integrity.roundTripPercent) ?? 0)} round trips, ${pctLabel(num(integrity.sameTransactionPercent) ?? 0)} both sides in one transaction`,
    evidence, note: `Round trip: one wallet or linked cluster buying and selling back within ${integrity.windowMinutes ?? 60} minutes. Labeled repo.ing and builder wallets are excluded.` })]
}

function liquidityCriteria({ liquidity, lpLock }) {
  const items = []
  if (!liquidity) items.push(criterion('liquidity_depth', 'Liquidity', 'Executable depth within 2% of spot', 10, { status: 'unknown' }))
  else {
    const buy = BigInt(liquidity.buyDepthLamports), sell = BigInt(liquidity.sellDepthLamports), low = buy < sell ? buy : sell
    items.push(criterion('liquidity_depth', 'Liquidity', 'Executable depth within 2% of spot', 10, {
      status: low >= 500_000_000n ? 'pass' : low > 0n ? 'warn' : 'fail', points: low >= 500_000_000n ? 10 : low >= 100_000_000n ? 6 : low > 0n ? 3 : 0,
      value: `${sol(buy)} to buy, ${sol(sell)} to sell (${liquidity.venue === 'damm' ? 'graduated pool' : 'bonding curve'})`,
      evidence: [{ source: `${CHAIN}: pool state, SDK quotes`, ref: liquidity.pool ? `https://solscan.io/account/${liquidity.pool}` : null, observedAt: iso(liquidity.sampledAt) }] }))
  }
  if (!lpLock) items.push(criterion('liquidity_lock', 'Liquidity', 'Pool liquidity cannot be withdrawn by the team', 5, { status: 'unknown' }))
  else if (lpLock.graduated) {
    items.push(criterion('liquidity_lock', 'Liquidity', 'Pool liquidity cannot be withdrawn by the team', 5, lpLock.proof
      ? { status: 'pass', points: 5, value: 'Migrated liquidity permanently locked (verified migration)', evidence: [{ source: `${CHAIN}: migration transaction`, ref: lpLock.signature ? `https://solscan.io/tx/${lpLock.signature}` : null, observedAt: iso(lpLock.observedAt) }] }
      : { status: 'unknown', note: 'Graduation recorded, lock proof not read yet.' }))
  } else {
    items.push(criterion('liquidity_lock', 'Liquidity', 'Pool liquidity cannot be withdrawn by the team', 5, { status: 'pass', points: 5,
      value: 'Bonding-curve reserve is held by the Meteora program; at graduation the config permanently locks the migrated liquidity',
      evidence: [{ source: 'DBC pool config (on chain)', ref: lpLock.config ? `https://solscan.io/account/${lpLock.config}` : null, observedAt: null }] }))
  }
  return items
}

// facts: see QUALITY_INPUTS. now: ms. Returns the full report (JSON-safe).
export function launchQualityReport(facts = {}, { now = Date.now() } = {}) {
  const input = Object.fromEntries(QUALITY_INPUTS.map(key => [key, facts[key]]))
  const criteria = [
    ...repoCriteria(input, now), ...maintainerCriteria(input), ...launchCriteria(input), ...holderCriteria(input),
    ...integrityCriteria(input), ...liquidityCriteria(input),
  ]
  const scored = criteria.filter(item => item.max > 0)
  const total = scored.reduce((sum, item) => sum + item.max, 0)
  const knownMax = scored.filter(item => item.status !== 'unknown').reduce((sum, item) => sum + item.max, 0)
  const points = scored.reduce((sum, item) => sum + item.points, 0)
  const coveragePercent = total ? Math.round(knownMax * 100 / total) : 0
  const score = coveragePercent >= MIN_COVERAGE_PERCENT && knownMax > 0 ? Math.round(points * 100 / knownMax) : null
  return {
    version: QUALITY_VERSION,
    assessedAt: new Date(now).toISOString(),
    score, coveragePercent, points, knownMax, totalMax: total,
    summary: score === null ? `Not enough evidence yet (${coveragePercent}% of criteria known)` : `${score}/100 on the ${coveragePercent}% of criteria known`,
    unknowns: criteria.filter(item => item.status === 'unknown').map(item => item.id),
    flags: criteria.filter(item => item.status === 'fail').map(item => item.id),
    criteria,
    excludedInputs: EXCLUDED_INPUTS,
    disclosures: RISK_DISCLOSURES,
  }
}

// The compact list/feed form of a stored report.
export function qualitySummary(report) {
  if (!report) return null
  return { version: report.version, score: report.score ?? null, coveragePercent: report.coveragePercent ?? 0, assessedAt: report.assessedAt,
    unknowns: report.unknowns ?? [], flags: report.flags ?? [] }
}
