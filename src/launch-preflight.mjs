import { PublicKey } from '@solana/web3.js'
import { launchQualityReport, MIN_COVERAGE_PERCENT } from './launch-quality.mjs'
import { LOCK_STATES, BUILDER_ALLOCATION_BASE_UNITS } from './seeded-liquidity.mjs'
import { SCHEDULE_RULES } from './launch-schedules.mjs'
import { INITIAL_BUY_CAP_BPS } from './launch-buy.mjs'
import { TICKER_MESSAGE, validTicker } from './launch-symbols.mjs'
import { NoteError, sanitizeNote } from './holder-notes.mjs'
import { isBlockedWallet } from './blocked-wallets.mjs'

// Launch preflight (docs/LAUNCH_GUIDE.md): before anyone commits to a launch, the same factual checklist the public Launch
// Quality report uses (src/launch-quality.mjs), limited to what can be known before a market exists, plus every requirement a
// launch or a scheduled launch must meet, each with what to do about it. Pure: the facts are read elsewhere
// (src/launch-guide.mjs) and passed in; nothing here reads GitHub, Solana or the database.
//
// Rules this follows, the same as the public report:
// - Facts, not a rating. Each criterion names its source and time. Unknown is unknown: never scored as a pass or a zero.
// - Before launch, criteria about holders, trading and depth cannot be known. They are listed as "after launch" unknowns and
//   left out of the pre-launch score, which is computed over the pre-launch criteria only and shown with its coverage
//   (none below MIN_COVERAGE_PERCENT). The public report after launch will differ; the preflight says so.
// - Never pay-to-rank. PREFLIGHT_INPUTS are the only inputs. Nothing anyone pays, and no price, market cap or volume amount,
//   changes a criterion or a requirement; running the preflight is free and needs no wallet or sign-in.
export const PREFLIGHT_VERSION = 1
export const PREFLIGHT_INPUTS = Object.freeze(['repository', 'activity', 'lineage', 'maintainer', 'state', 'platform', 'plan', 'terms', 'wallet'])
// Criteria the preflight can assess before launch: GitHub facts, the maintainer, and the launch plan with its config.
export const PRELAUNCH_CRITERIA = Object.freeze(['repo_age', 'repo_adoption', 'repo_activity', 'original_repository', 'maintainer', 'launch_buy',
  'anti_sniper', 'scheduled', 'liquidity_lock'])
// Criteria from the plan (what the launch will do) and from the launch config (fixed on chain), rather than observed facts.
const PLAN_CRITERIA = new Set(['launch_buy', 'scheduled'])
const CONFIG_CRITERIA = new Set(['anti_sniper', 'liquidity_lock'])
// Read only after launch, by the worker's transparency job: why each is unknown now.
export const AFTER_LAUNCH_CRITERIA = Object.freeze({
  mint_authorities: 'Read from the token mint on chain once it exists.',
  holder_concentration: 'Read from the largest token accounts after launch.',
  launcher_position: 'Measured from indexed swaps by the launching wallet after launch.',
  organic_volume: 'Measured from finalized swaps once there is at least 0.5 SOL of attributed volume.',
  liquidity_depth: 'Sampled from the live pool about hourly after launch.',
})
export const SUPPLY_BPS_OPTIONS = Object.freeze([0, 100, 200, INITIAL_BUY_CAP_BPS])
// An estimate for the launch accounts and network fee (about 0.0206 SOL measured on mainnet, docs/LAUNCH_REVIEW.md) with a margin.
// Advisory only: the launch review simulates the exact transaction and refuses one the wallet cannot pay for.
export const LAUNCH_SETUP_ESTIMATE_LAMPORTS = 25_000_000n
export const APP_ACCESS_URL = 'https://github.com/apps/repo-ing/installations/new'
export const GUIDE_PATH = '/launches/new'

const REQUIREMENT_STATUSES = new Set(['met', 'warn', 'missing', 'blocked', 'unknown', 'info'])
const REPOSITORY_BLOCKERS = new Set(['repository_public', 'fork_guard', 'no_market', 'not_opted_out', 'no_group_raise', 'launches_available'])
const iso = value => {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const sol = lamports => `${(Number(BigInt(lamports)) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
// A shortfall rounds up, so "add" never reads as 0 SOL.
const solUp = lamports => `${(Math.ceil(Number(BigInt(lamports)) / 100_000) / 10_000).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`
const utc = value => `${new Date(value).toISOString().replace('T', ' ').slice(0, 16)} UTC`
const GITHUB = 'GitHub API'

function requirement(id, group, label, status, { requiredFor = [], detail = null, remediation = null, evidence = null } = {}) {
  if (!REQUIREMENT_STATUSES.has(status)) throw new Error(`Invalid requirement status for ${id}`)
  return { id, group, label, status, requiredFor, detail, remediation, evidence }
}
const retry = text => ({ text, action: 'retry' })

export function canonicalWallet(value) {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return null
  try { return new PublicKey(value).toBase58() === value ? value : null } catch { return null }
}

// The initial buy the plan announces, in lamports: the largest buy whose tokens stay within supplyBps of supply under the
// current config (terms.presets, from src/launch-buy.mjs launchBuyPreset). The launch page computes the same preset from the same
// config, so the launch passes the scheduled-launch gate exactly. null when it cannot be priced now.
export function plannedBuyLamports(plan, terms) {
  const bps = Number(plan?.supplyBps ?? 0)
  if (bps === 0) return '0'
  const value = terms?.presets?.[String(bps)]
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null
}

function repositoryRequirements({ repository, lineage }) {
  const items = []
  const settings = repository?.fullName ? `https://github.com/${repository.fullName}/settings` : null
  const evidence = repository?.fullName ? { source: GITHUB, ref: `https://github.com/${repository.fullName}`, observedAt: iso(repository.observedAt) } : null
  if (!repository || repository.status === 'unavailable') {
    items.push(requirement('repository_public', 'Repository', 'Public GitHub repository', 'unknown', { requiredFor: ['schedule', 'launch'],
      detail: 'GitHub could not be read just now.', remediation: retry('Run the preflight again in a minute. Nothing was saved or published.') }))
  } else if (repository.status === 'not-found' || repository.private) {
    items.push(requirement('repository_public', 'Repository', 'Public GitHub repository', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: 'GitHub does not serve this repository publicly. Only public repositories can have a market.',
      remediation: { text: 'Make the repository public on GitHub (Settings → General → Change visibility), then run the preflight again.', href: settings, label: 'Repository settings' } }))
  } else if (repository.archived) {
    items.push(requirement('repository_public', 'Repository', 'Public GitHub repository', 'blocked', { requiredFor: ['schedule', 'launch'], evidence,
      detail: 'The repository is archived on GitHub. Archived repositories cannot launch.',
      remediation: { text: 'Unarchive it on GitHub (Settings → General → Danger zone), then run the preflight again.', href: settings, label: 'Repository settings' } }))
  } else {
    items.push(requirement('repository_public', 'Repository', 'Public GitHub repository', 'met', { requiredFor: ['schedule', 'launch'], evidence,
      detail: `${repository.fullName} is public and not archived.` }))
  }
  if (lineage?.status === 'blocked') {
    items.push(requirement('fork_guard', 'Repository', 'One market per project (fork guard)', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: lineage.message, remediation: { text: 'The original repository\'s market is the canonical one for this project. A copy or a fork of a launched repository cannot launch.',
        href: lineage.mint ? `/token/${lineage.mint}` : null, label: 'Open the original\'s market' } }))
  } else if (lineage?.status === 'ok') {
    items.push(requirement('fork_guard', 'Repository', 'One market per project (fork guard)', 'met', { requiredFor: ['schedule', 'launch'],
      detail: lineage.forkOf ? `A fork of ${lineage.forkOf.fullName ?? 'another repository'} that has no market: it can launch and is labeled "Fork of ${lineage.forkOf.fullName ?? 'its parent'}".`
        : 'Not a fork or copy of a launched repository.' }))
  } else if (repository && repository.status === 'ok') {
    items.push(requirement('fork_guard', 'Repository', 'One market per project (fork guard)', 'warn', { requiredFor: ['schedule', 'launch'],
      detail: 'The first commit could not be compared with launched repositories just now. Launch prepare checks it again and refuses a copy.' }))
  }
  return items
}

function maintainerRequirement({ maintainer, repository }) {
  const label = 'Current GitHub admin of the repository'
  const status = maintainer?.status ?? 'signed-out'
  if (status === 'admin') {
    return requirement('github_admin', 'Maintainer', label, 'met', { requiredFor: ['schedule'],
      detail: `GitHub reports ${maintainer.githubLogin} as a current admin. Publishing checks it again with GitHub.`,
      evidence: { source: 'GitHub admin permission check', ref: repository?.fullName ? `https://github.com/${repository.fullName}` : null, observedAt: iso(maintainer.checkedAt) } })
  }
  if (status === 'not-admin') {
    return requirement('github_admin', 'Maintainer', label, 'missing', { requiredFor: ['schedule'],
      detail: `GitHub reports ${maintainer.githubLogin ?? 'your account'} with ${maintainer.permission && maintainer.permission !== 'none' ? `${maintainer.permission} access` : 'no admin access'}. Only a current admin can schedule a launch.`,
      remediation: { text: 'Ask a current admin to run this guide (share this page), or sign out at github.com and sign in again with an admin account. Anyone can still launch it as a community market without a schedule.' } })
  }
  if (status === 'no-access') {
    return requirement('github_admin', 'Maintainer', label, 'missing', { requiredFor: ['schedule'],
      detail: 'repo.ing\'s read-only GitHub App cannot see this repository for your account, so your admin access cannot be confirmed.',
      remediation: { text: 'Give the repo.ing GitHub App read-only access to this repository (Metadata: read; no code access), then check again.', href: APP_ACCESS_URL, label: 'GitHub App access' } })
  }
  if (status === 'unknown') {
    return requirement('github_admin', 'Maintainer', label, 'unknown', { requiredFor: ['schedule'],
      detail: 'GitHub did not confirm your access just now.', remediation: retry('Check again. If it keeps failing, sign in with GitHub again.') })
  }
  return requirement('github_admin', 'Maintainer', label, 'missing', { requiredFor: ['schedule'],
    detail: 'Not signed in. The preflight works without signing in; scheduling a launch needs a current GitHub admin.',
    remediation: { text: 'Sign in with GitHub (read-only: it identifies you and lists repositories you administer).', href: '/api/github/start?mode=launch-guide', label: 'Sign in with GitHub' } })
}

function marketRequirements({ state, platform, maintainer }) {
  const items = []
  const market = state?.market ?? null
  if (!state) {
    items.push(requirement('no_market', 'Market', 'No market or launch in progress', 'unknown', { requiredFor: ['schedule', 'launch'],
      detail: 'repo.ing\'s records could not be read just now.', remediation: retry('Run the preflight again.') }))
    return items
  }
  if (market?.status === 'confirmed') {
    items.push(requirement('no_market', 'Market', 'No market or launch in progress', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: 'This repository already has its market. There is one market per repository.',
      remediation: { text: 'Open the market. A current GitHub admin can verify and claim its builder fees on the claim page.', href: market.mint ? `/token/${market.mint}` : null, label: 'Open the market' } }))
  } else if (market) {
    items.push(requirement('no_market', 'Market', 'No market or launch in progress', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: 'Someone is launching this repository right now.', remediation: retry('Wait a few minutes and run the preflight again: an unsigned review is released after two minutes.') }))
  } else {
    items.push(requirement('no_market', 'Market', 'No market or launch in progress', 'met', { requiredFor: ['schedule', 'launch'], detail: 'No market exists for this repository yet.' }))
  }
  if (state.optOut) {
    items.push(requirement('not_opted_out', 'Market', 'Maintainers have not opted out', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: state.optOut.kind === 'decline' ? 'A current GitHub admin declined a market for this repository.' : 'A current GitHub admin opted this repository out of repo.ing.',
      remediation: maintainer?.status === 'admin' ? { text: 'If you changed your mind, withdraw the opt-out first.', href: '/opt-out', label: 'Opt-out page' } : { text: 'Only a current GitHub admin can withdraw it.' } }))
  } else {
    items.push(requirement('not_opted_out', 'Market', 'Maintainers have not opted out', 'met', { requiredFor: ['schedule', 'launch'] }))
  }
  if (state.liveBundleId) {
    items.push(requirement('no_group_raise', 'Market', 'No Group launch raise open', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: 'A Group launch raise is funding this repository\'s launch; its market launches from the raise.', remediation: { text: 'See the raise.', href: `/group/${state.liveBundleId}`, label: 'Group launch raise' } }))
  } else {
    items.push(requirement('no_group_raise', 'Market', 'No Group launch raise open', 'met', { requiredFor: ['schedule', 'launch'] }))
  }
  if (state.schedule) {
    items.push(requirement('no_schedule', 'Market', 'Not already scheduled', 'blocked', { requiredFor: ['schedule'],
      detail: `Already scheduled for ${utc(state.schedule.scheduledAt)} by ${state.schedule.announcedBy} (${state.schedule.state}).`,
      remediation: { text: 'Keep it, or cancel it in Schedule a launch to choose another time.', href: '/launches/manage', label: 'Manage schedules' } }))
  } else {
    items.push(requirement('no_schedule', 'Market', 'Not already scheduled', 'met', { requiredFor: ['schedule'] }))
  }
  if (platform?.launchAvailable === false) {
    items.push(requirement('launches_available', 'Market', 'repo.ing launches are open', 'blocked', { requiredFor: ['schedule', 'launch'],
      detail: 'New launches are paused on repo.ing right now, so a schedule could not be honored.', remediation: retry('Check again later.') }))
  }
  if (platform?.schedulesEnabled === false) {
    items.push(requirement('schedules_enabled', 'Market', 'Scheduling is open', 'blocked', { requiredFor: ['schedule'],
      detail: 'Scheduling new launches is paused right now.', remediation: retry('Check again later.') }))
  }
  return items
}

function planRequirements({ plan, terms, wallet, state, now }) {
  if (!plan) {
    return [requirement('plan', 'Plan', 'Launch plan', 'missing', { requiredFor: ['schedule'],
      detail: 'Choose when it launches, from which wallet, and how much that wallet buys in the launch transaction.',
      remediation: { text: 'Continue to the plan step.', action: 'plan' } })]
  }
  const items = []
  const at = typeof plan.scheduledAt === 'string' ? Date.parse(plan.scheduledAt) : NaN
  const window = plan.windowMinutes === undefined || plan.windowMinutes === null ? SCHEDULE_RULES.defaultWindowMinutes : Number(plan.windowMinutes)
  const timeText = { text: 'Choose a time at least one hour and at most 30 days from now.', action: 'plan' }
  if (!Number.isFinite(at)) items.push(requirement('launch_time', 'Plan', 'Launch time', 'missing', { requiredFor: ['schedule'], detail: 'No launch time chosen.', remediation: timeText }))
  else if (at < now + SCHEDULE_RULES.minNoticeMs) items.push(requirement('launch_time', 'Plan', 'Launch time', 'missing', { requiredFor: ['schedule'],
    detail: `${utc(at)} is less than one hour away. Everyone gets the same notice, so a launch is announced at least an hour ahead.`, remediation: timeText }))
  else if (at > now + SCHEDULE_RULES.maxAheadMs) items.push(requirement('launch_time', 'Plan', 'Launch time', 'missing', { requiredFor: ['schedule'],
    detail: `${utc(at)} is more than 30 days away.`, remediation: timeText }))
  else if (!Number.isSafeInteger(window) || window < SCHEDULE_RULES.minWindowMinutes || window > SCHEDULE_RULES.maxWindowMinutes) {
    items.push(requirement('launch_time', 'Plan', 'Launch time', 'missing', { requiredFor: ['schedule'], detail: 'The launch window is 15 minutes to 24 hours.',
      remediation: { text: 'Choose a window between 15 and 1,440 minutes.', action: 'plan' } }))
  } else {
    const soon = at < now + SCHEDULE_RULES.minNoticeMs + 10 * 60_000
    items.push(requirement('launch_time', 'Plan', 'Launch time', soon ? 'warn' : 'met', { requiredFor: ['schedule'],
      detail: `Window ${utc(at)} to ${utc(at + window * 60_000)} (${window} minutes).${soon ? ' Close to the one-hour minimum: publish soon or choose a later time.' : ''}` }))
  }
  const launcher = canonicalWallet(plan.launcherWallet)
  if (!plan.launcherWallet) items.push(requirement('launcher_wallet', 'Plan', 'Launching wallet', 'missing', { requiredFor: ['schedule'],
    detail: 'No wallet chosen. Only this wallet will be able to launch during the window.', remediation: { text: 'Connect the wallet that will sign the launch, or paste its address.', action: 'plan' } }))
  else if (!launcher) items.push(requirement('launcher_wallet', 'Plan', 'Launching wallet', 'missing', { requiredFor: ['schedule'],
    detail: 'That is not a valid Solana address.', remediation: { text: 'Paste the wallet\'s address exactly, or connect it.', action: 'plan' } }))
  else if (isBlockedWallet(launcher)) items.push(requirement('launcher_wallet', 'Plan', 'Launching wallet', 'blocked', { requiredFor: ['schedule'],
    detail: 'This wallet cannot launch on repo.ing.', remediation: { text: 'Choose another wallet.', action: 'plan' } }))
  else items.push(requirement('launcher_wallet', 'Plan', 'Launching wallet', 'met', { requiredFor: ['schedule'], detail: `${launcher} signs the launch.` }))

  const bps = Number(plan.supplyBps ?? 0)
  const buy = SUPPLY_BPS_OPTIONS.includes(bps) ? plannedBuyLamports(plan, terms) : null
  if (!SUPPLY_BPS_OPTIONS.includes(bps)) items.push(requirement('initial_buy', 'Plan', 'Initial buy', 'missing', { requiredFor: ['schedule'],
    detail: 'Choose no initial buy, 1%, 2% or 3% of supply.', remediation: { text: 'Choose the initial buy.', action: 'plan' } }))
  else if (buy === null) items.push(requirement('initial_buy', 'Plan', 'Initial buy', 'unknown', { requiredFor: ['schedule'],
    detail: 'The launch config could not be read to price the initial buy just now.', remediation: retry('Run the preflight again, or choose no initial buy.') }))
  else if (BigInt(buy) > SCHEDULE_RULES.maxInitialBuyLamports) items.push(requirement('initial_buy', 'Plan', 'Initial buy', 'missing', { requiredFor: ['schedule'],
    detail: `${bps / 100}% of supply costs ${sol(buy)} now, above the 1 SOL a schedule may announce.`, remediation: { text: 'Choose a smaller initial buy.', action: 'plan' } }))
  else items.push(requirement('initial_buy', 'Plan', 'Initial buy', 'met', { requiredFor: ['schedule'],
    detail: bps === 0 ? 'No initial buy: the first purchase will be an ordinary trade on the public curve.'
      : `At most ${sol(buy)} for ${bps / 100}% of supply, in the launch transaction, paying the regular fee. Announced publicly with the schedule.` }))

  if (launcher && buy !== null) {
    const need = BigInt(buy) + LAUNCH_SETUP_ESTIMATE_LAMPORTS
    if (!wallet || wallet.balanceLamports === null || wallet.balanceLamports === undefined) {
      items.push(requirement('launcher_balance', 'Plan', 'Launching wallet can pay', 'unknown', {
        detail: `It will need about ${sol(need)} when it launches (initial buy and about ${sol(LAUNCH_SETUP_ESTIMATE_LAMPORTS)} of launch accounts and fees). The balance could not be read now.` }))
    } else {
      const balance = BigInt(wallet.balanceLamports)
      items.push(requirement('launcher_balance', 'Plan', 'Launching wallet can pay', balance >= need ? 'met' : 'warn', { requiredFor: [],
        evidence: { source: 'Solana (confirmed RPC read)', ref: `https://solscan.io/account/${launcher}`, observedAt: iso(wallet.observedAt) },
        detail: balance >= need ? `Holds ${sol(balance)}; about ${sol(need)} is needed at launch.`
          : `Holds ${sol(balance)}; about ${sol(need)} is needed at launch. Not needed to publish the schedule.`,
        remediation: balance >= need ? null : { text: `Add about ${solUp(need - balance)} to the wallet before the window opens. The launch review simulates the exact cost before you sign.` } }))
    }
  }

  if (plan.tokenSymbol) {
    if (!validTicker(plan.tokenSymbol)) items.push(requirement('token_identity', 'Plan', 'Ticker', 'missing', { requiredFor: ['launch'], detail: TICKER_MESSAGE,
      remediation: { text: 'Choose another ticker. You can also choose it at launch.', action: 'plan' } }))
    else if (state?.symbolTaken) items.push(requirement('token_identity', 'Plan', 'Ticker', 'missing', { requiredFor: ['launch'],
      detail: `$${plan.tokenSymbol.toUpperCase()} is already used by another market on repo.ing.`, remediation: { text: 'Choose a different ticker.', action: 'plan' } }))
    else items.push(requirement('token_identity', 'Plan', 'Ticker', 'met', { requiredFor: ['launch'],
      detail: `$${plan.tokenSymbol.toUpperCase()} is free now. Tickers are not reserved: it is checked again when you launch.` }))
  }
  if (typeof plan.note === 'string' && plan.note.trim()) {
    try { sanitizeNote(plan.note); items.push(requirement('note', 'Plan', 'Public note', 'met', { requiredFor: ['schedule'] })) }
    catch (error) { items.push(requirement('note', 'Plan', 'Public note', 'missing', { requiredFor: ['schedule'], detail: error instanceof NoteError ? error.message : 'Invalid note.',
      remediation: { text: 'Edit the note: 280 characters, links only to github.com.', action: 'plan' } })) }
  }
  return items
}

// Quality facts the preflight can know: GitHub's, the maintainer check, and the plan with its config. Holders, the launcher's
// indexed position, trading integrity and depth stay null (unknown).
function qualityFacts({ repository, activity, maintainer, plan, terms }, now) {
  const repo = repository?.status === 'ok' ? { fullName: repository.fullName, githubCreatedAt: repository.createdAt ?? null,
    stars: repository.stars, syncedAt: repository.observedAt } : null
  const bps = plan ? Number(plan.supplyBps ?? 0) : null
  return {
    repo,
    pulse: activity ? { commits7d: activity.commits, devs7d: activity.authors, checkedAt: activity.observedAt } : null,
    forkParent: repository?.status === 'ok' ? (repository.fork?.parent?.fullName ?? null) : undefined,
    maintainer: maintainer?.status === 'admin' ? { verified: true, verifiedAt: maintainer.checkedAt }
      : maintainer?.status === 'not-admin' ? { verified: false } : null,
    // The launch fee window is the config's, known without a plan; the initial buy and the announcement are the plan's.
    launch: { signature: null, launchedAt: null, mint: null, bundle: false, launchBuyPercent: plan && SUPPLY_BPS_OPTIONS.includes(bps) ? bps / 100 : null,
      launchFee: terms?.feeKnown ? Boolean(terms.launchFee) : null, config: terms?.config ?? null,
      scheduled: plan?.scheduledAt && Number.isFinite(Date.parse(plan.scheduledAt)) ? { scheduledAt: plan.scheduledAt, createdAt: new Date(now).toISOString() } : null },
    holders: null, launcher: null, integrity: null, liquidity: null,
    lpLock: terms?.config ? { graduated: false, config: terms.config } : null,
  }
}

const PLANNED_VALUES = {
  launch_buy: (criterion, plan) => Number(plan?.supplyBps ?? 0) === 0 ? 'Planned: no initial buy' : `Planned: at most ${Number(plan.supplyBps) / 100}% of supply in the launch transaction`,
  scheduled: (criterion, plan) => (plan?.scheduledAt ? `Planned: announced now for ${utc(plan.scheduledAt)}` : 'Not scheduled in advance'),
}

export function preflightQuality(facts, now) {
  const report = launchQualityReport(qualityFacts(facts, now), { now })
  const criteria = report.criteria.map(item => {
    const afterLaunch = Object.hasOwn(AFTER_LAUNCH_CRITERIA, item.id)
    const basis = afterLaunch ? 'after-launch' : PLAN_CRITERIA.has(item.id) ? 'plan' : CONFIG_CRITERIA.has(item.id) ? 'config' : 'observed'
    const value = basis === 'plan' && item.status !== 'unknown' && PLANNED_VALUES[item.id] ? PLANNED_VALUES[item.id](item, facts.plan) : item.value
    let note = afterLaunch ? AFTER_LAUNCH_CRITERIA[item.id] : item.note
    if (item.id === 'maintainer' && facts.maintainer?.status === 'admin') {
      note = 'You are a current GitHub admin. The public report shows "Verified" once an admin verifies on the market\'s claim page after launch.'
    } else if (item.id === 'maintainer' && item.status === 'unknown') note = 'Sign in as a GitHub admin of the repository to check.'
    else if (item.id === 'launch_buy' && item.status === 'unknown') note = 'Choose the initial buy in the plan.'
    // The preflight reads the last week's commits itself (the public report reads them from Dev Pulse).
    const evidence = item.id === 'repo_activity' ? item.evidence.map(entry => ({ ...entry, source: 'GitHub API (commits in the last 7 days)' })) : item.evidence
    return { ...item, basis, value, note, evidence }
  })
  const scored = criteria.filter(item => item.basis !== 'after-launch' && item.max > 0)
  const totalMax = scored.reduce((sum, item) => sum + item.max, 0)
  const known = scored.filter(item => item.status !== 'unknown')
  const knownMax = known.reduce((sum, item) => sum + item.max, 0)
  const points = known.reduce((sum, item) => sum + item.points, 0)
  const coveragePercent = totalMax ? Math.round(knownMax * 100 / totalMax) : 0
  const score = coveragePercent >= MIN_COVERAGE_PERCENT && knownMax > 0 ? Math.round(points * 100 / knownMax) : null
  return {
    version: report.version, scope: 'pre-launch',
    score, coveragePercent, points, knownMax, totalMax, minCoveragePercent: MIN_COVERAGE_PERCENT,
    summary: score === null ? `Not enough evidence yet (${coveragePercent}% of pre-launch criteria known)` : `${score}/100 on the ${coveragePercent}% of pre-launch criteria known`,
    unknowns: criteria.filter(item => item.status === 'unknown' && item.basis !== 'after-launch').map(item => ({ id: item.id, label: item.label, reason: item.note ?? null })),
    afterLaunch: criteria.filter(item => item.basis === 'after-launch').map(item => ({ id: item.id, label: item.label, reason: item.note })),
    flags: criteria.filter(item => item.status === 'fail').map(item => item.id),
    criteria,
    excludedInputs: report.excludedInputs,
    disclosures: report.disclosures,
  }
}

// What will be seeded at launch and its lock state: the same kinds and lock words as the public seeded-liquidity disclosure
// (src/seeded-liquidity.mjs), as planned rather than observed.
export function plannedSeeding({ plan, terms }) {
  const rows = []
  const buy = plan ? plannedBuyLamports(plan, terms) : null
  const bps = Number(plan?.supplyBps ?? 0)
  const wallet = canonicalWallet(plan?.launcherWallet ?? '')
  if (bps > 0) {
    rows.push({ kind: 'launch-buy', label: 'Your initial buy', wallet, solLamports: buy, percentOfSupply: bps / 100, lock: 'unlocked',
      lockText: `${LOCK_STATES.unlocked} repo.ing adds no lock or vesting. The public report tracks this wallet's indexed holding.` })
  } else {
    rows.push({ kind: 'launch-buy', label: 'Initial buy', wallet, solLamports: '0', percentOfSupply: 0, lock: null, lockText: 'None: the launch transaction buys nothing.' })
  }
  if (terms?.allocation) {
    rows.push({ kind: 'builder-allocation', label: 'Builder allocation (1%)', wallet: null, solLamports: '0',
      percentOfSupply: Number(BUILDER_ALLOCATION_BASE_UNITS * 10_000n / 1_000_000_000_000_000n) / 100, lock: 'claimable-after-graduation',
      lockText: `${LOCK_STATES['claimable-after-graduation']} It is part of the fixed supply, not new tokens.` })
  }
  rows.push({ kind: 'curve', label: 'Bonding curve reserve', wallet: null, solLamports: null, percentOfSupply: null, lock: 'program-held',
    lockText: 'Held by the Meteora bonding-curve program. It changes only through trades on the public curve; nobody can withdraw it.' })
  rows.push({ kind: 'migrated-lp', label: 'Liquidity at graduation', wallet: null, solLamports: null, percentOfSupply: null, lock: 'permanently-locked',
    lockText: `At graduation the curve's SOL and reserved tokens move to a Meteora DAMM v2 pool. ${LOCK_STATES['permanently-locked']}` })
  rows.push({ kind: 'platform', label: 'repo.ing or team liquidity', wallet: null, solLamports: '0', percentOfSupply: 0, lock: null,
    lockText: 'None at launch. repo.ing adds no liquidity of its own to a new market and reserves no tokens for itself.' })
  return rows
}

// The launch controls the current system enforces for a scheduled launch, as they would apply to this plan.
export function launchControls({ plan, terms }) {
  const at = plan?.scheduledAt && Number.isFinite(Date.parse(plan.scheduledAt)) ? Date.parse(plan.scheduledAt) : null
  const window = Number(plan?.windowMinutes ?? SCHEDULE_RULES.defaultWindowMinutes)
  const buy = plan ? plannedBuyLamports(plan, terms) : null
  const wallet = canonicalWallet(plan?.launcherWallet ?? '')
  const fee = terms?.launchFee
  return [
    { id: 'announcement', label: 'Public announcement', value: 'Published at once on the launch calendar, its JSON, Atom and iCalendar feeds, and webhooks.',
      enforcedBy: 'Database constraint: at least one hour and at most 30 days ahead' },
    { id: 'time_lock', label: 'Nobody launches early', value: at ? `Until ${utc(at)} every launch of this repository is refused, yours included.` : 'Until the time you choose, every launch is refused.',
      enforcedBy: 'Launch coordinator reservation gate' },
    { id: 'launcher_only', label: 'Only your wallet in the window', value: wallet ? `During the window only ${wallet} can launch it.` : 'During the window only the announced wallet can launch it.',
      enforcedBy: 'Launch coordinator reservation gate' },
    { id: 'buy_cap', label: 'Announced initial buy cap', value: buy === null ? 'At most the announced buy, never above 3% of supply.'
      : BigInt(buy) > 0n ? `At most ${sol(buy)} (${Number(plan.supplyBps) / 100}% of supply), the only purchase the launch transaction can make.` : 'No initial buy.',
    enforcedBy: 'Launch coordinator gate and the 3% supply cap in the launch quote' },
    { id: 'no_side_doors', label: 'No Group launch, allowlist or early access', value: 'During the window a Group launch and contributor early access are refused; nobody gets an allowlist.',
      enforcedBy: 'Launch coordinator reservation gate' },
    { id: 'launch_fee', label: 'Launch fee against bots', value: fee ? `Every wallet pays ${fee.startPercent} at first, falling to ${fee.endPercent} over ${fee.durationLabel}. Your own launch buy pays ${fee.launcherBuyPercent ?? fee.endPercent}.`
      : terms?.feeKnown ? 'This launch config charges one flat fee from the first block.' : 'Read from the launch config; shown on the launch page.', enforcedBy: 'Meteora pool config (on chain, cannot change)' },
    { id: 'window', label: 'Window lapses', value: `${window} minutes. If it has not launched by then, the schedule lapses and anyone can launch the repository as usual.`, enforcedBy: 'Launch coordinator and the worker' },
    { id: 'cancel', label: 'Cancel any time before launch', value: 'A current GitHub admin can cancel it in Schedule a launch. Cancelling is public too.', enforcedBy: 'GitHub admin check at cancel' },
  ]
}

// facts: { repository, activity, lineage, maintainer, state, platform, plan, terms, wallet } (PREFLIGHT_INPUTS; anything else is
// ignored). Returns the full preflight (JSON-safe).
export function launchPreflight(facts = {}, { now = Date.now() } = {}) {
  const input = Object.fromEntries(PREFLIGHT_INPUTS.map(key => [key, facts[key]]))
  const requirements = [
    ...repositoryRequirements(input), maintainerRequirement(input), ...marketRequirements(input), ...planRequirements({ ...input, now }),
  ]
  const readyFor = target => requirements.filter(item => item.requiredFor.includes(target)).every(item => item.status === 'met' || item.status === 'warn')
  // Blocked: the repository cannot launch at all right now, whoever asks. A blocked wallet or an existing schedule only blocks this plan.
  const blocked = requirements.some(item => item.status === 'blocked' && REPOSITORY_BLOCKERS.has(item.id))
  const verdict = blocked ? 'blocked' : readyFor('schedule') ? 'ready' : 'needs-action'
  return {
    version: PREFLIGHT_VERSION,
    checkedAt: new Date(now).toISOString(),
    repoId: input.repository?.repoId ?? null,
    fullName: input.repository?.fullName ?? null,
    verdict,
    ready: { schedule: readyFor('schedule'), launch: !blocked && readyFor('launch') },
    requirements,
    missing: requirements.filter(item => ['missing', 'blocked', 'unknown'].includes(item.status) && item.requiredFor.length).map(item => item.id),
    quality: preflightQuality(input, now),
    seeding: plannedSeeding(input),
    controls: launchControls(input),
    plannedBuyLamports: input.plan ? plannedBuyLamports(input.plan, input.terms) : null,
    // Each initial-buy option's price under the current config (null: cannot be priced now).
    buyOptions: SUPPLY_BPS_OPTIONS.map(bps => ({ bps, lamports: plannedBuyLamports({ supplyBps: bps }, input.terms) })),
    launchFee: input.terms?.launchFee ?? null,
  }
}
