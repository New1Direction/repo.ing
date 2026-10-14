import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { AFTER_LAUNCH_CRITERIA, LAUNCH_SETUP_ESTIMATE_LAMPORTS, launchPreflight, PRELAUNCH_CRITERIA, plannedBuyLamports } from '../src/launch-preflight.mjs'
import { MIN_COVERAGE_PERCENT } from '../src/launch-quality.mjs'
import { createPreflightService, normalizePlan, parseRepositoryInput, readCommitActivity, readGuideRepository, GuideError } from '../src/launch-guide.mjs'
import { GUIDE_STEPS, guideEvent, guideHref, guideSummary, parseGuideBeacon, trackingRefused } from '../app/lib/launch-guide-funnel.mjs'
import { readOnlyTools } from '../app/lib/mcp-read-tools.mjs'

// The launch preflight and guided launch (docs/LAUNCH_GUIDE.md) without services: the requirements and their remediation, the
// pre-launch Launch Quality score over pre-launch criteria only, never pay-to-rank, the GitHub reads and their cache, drafts' plan
// shape, and the privacy-respecting conversion events. PostgreSQL: launch-guide-db; validator: launch-guide-chain.
const NOW = Date.parse('2026-10-14T12:00:00Z')
const HOUR = 3_600_000
const at = ms => new Date(ms).toISOString()
const WALLET = Keypair.generate().publicKey.toBase58()
const TERMS = { config: 'Cfg1111111111111111111111111111111111111111', feeKnown: true, allocation: true,
  launchFee: { startPercent: '50.44%', endPercent: '1.75%', durationLabel: '3 minutes', launcherBuyPercent: '1.75%' },
  presets: { 100: '250000000', 200: '520000000', 300: '856011397' } }

function facts(overrides = {}) {
  return {
    repository: { status: 'ok', repoId: '42', fullName: 'octo/widget', owner: 'octo', name: 'widget', stars: 150, createdAt: '2025-01-01T00:00:00Z', observedAt: at(NOW), archived: false },
    activity: { commits: 3, authors: 2, observedAt: at(NOW) },
    lineage: { status: 'ok', forkOf: null },
    maintainer: { status: 'admin', githubLogin: 'octo', checkedAt: at(NOW) },
    state: { market: null, optOut: null, liveBundleId: null, schedule: null, symbolTaken: false },
    platform: { launchAvailable: true, schedulesEnabled: true },
    plan: { scheduledAt: at(NOW + 26 * HOUR), windowMinutes: 120, launcherWallet: WALLET, supplyBps: 100 },
    terms: TERMS,
    wallet: { balanceLamports: '5000000000', observedAt: at(NOW) },
    ...overrides,
  }
}
const run = (overrides, now = NOW) => launchPreflight(facts(overrides), { now })
const req = (preflight, id) => preflight.requirements.find(item => item.id === id)
const crit = (preflight, id) => preflight.quality.criteria.find(item => item.id === id)

test('a complete, eligible plan is ready to schedule, with every requirement met and a pre-launch score over pre-launch criteria only', () => {
  const preflight = run()
  assert.equal(preflight.verdict, 'ready')
  assert.deepEqual(preflight.ready, { schedule: true, launch: true })
  assert.deepEqual(preflight.missing, [])
  assert.ok(preflight.requirements.every(item => ['met', 'warn'].includes(item.status)), JSON.stringify(preflight.requirements.filter(item => item.status !== 'met')))
  assert.equal(preflight.plannedBuyLamports, '250000000')
  // Every criterion is classified: pre-launch ones from GitHub or the plan, the rest measured after launch and never scored now.
  const ids = preflight.quality.criteria.map(item => item.id)
  assert.deepEqual(ids.filter(id => !PRELAUNCH_CRITERIA.includes(id)).sort(), Object.keys(AFTER_LAUNCH_CRITERIA).sort())
  for (const id of Object.keys(AFTER_LAUNCH_CRITERIA)) {
    assert.equal(crit(preflight, id).basis, 'after-launch')
    assert.equal(crit(preflight, id).status, 'unknown', `${id} is never assumed before launch`)
  }
  assert.deepEqual(preflight.quality.afterLaunch.map(item => item.id).sort(), Object.keys(AFTER_LAUNCH_CRITERIA).sort())
  assert.equal(crit(preflight, 'launch_buy').basis, 'plan')
  assert.equal(crit(preflight, 'anti_sniper').basis, 'config', 'the launch fee window is the config\'s, known without a plan')
  assert.equal(crit(preflight, 'repo_age').basis, 'observed')
  assert.equal(preflight.quality.score, 100)
  assert.equal(preflight.quality.coveragePercent, 100)
  assert.equal(preflight.quality.scope, 'pre-launch')
})

test('the pre-launch score uses the public report\'s points over known pre-launch criteria (values derived by hand)', () => {
  // 20 stars (5/10), no commits this week (1/5), a 3% initial buy (6/10); age, fork, maintainer, launch fee and lock are full:
  // 10 + 5 + 1 + 5 + 10 + 6 + 5 + 5 = 47 of 60 → 78.
  const preflight = run({ repository: { ...facts().repository, stars: 20 }, activity: { commits: 0, authors: 0, observedAt: at(NOW) },
    plan: { ...facts().plan, supplyBps: 300 } })
  assert.equal(preflight.quality.points, 47)
  assert.equal(preflight.quality.knownMax, 60)
  assert.equal(preflight.quality.score, 78)
  assert.equal(crit(preflight, 'launch_buy').status, 'warn')
  assert.match(crit(preflight, 'launch_buy').value, /^Planned: at most 3% of supply/)
  // A repository made last week fails the age criterion: 0 of 10.
  const fresh = run({ repository: { ...facts().repository, createdAt: at(NOW - 7 * 24 * HOUR) } })
  assert.equal(crit(fresh, 'repo_age').status, 'fail')
  assert.deepEqual(fresh.quality.flags, ['repo_age'])
  assert.equal(fresh.quality.score, Math.round(50 * 100 / 60))
})

test('unknowns are unknown: below the minimum coverage there is no score, and each unknown says why', () => {
  // Signed out, no plan: GitHub facts (30), the config's launch fee (5) and lock (5) are known: 40 of 60 pre-launch points (67%).
  const anonymous = run({ maintainer: null, plan: null, wallet: null })
  assert.equal(anonymous.quality.coveragePercent, 67)
  assert.equal(anonymous.quality.score, 100)
  assert.deepEqual(anonymous.quality.unknowns.map(item => item.id).sort(), ['launch_buy', 'maintainer'])
  assert.ok(anonymous.quality.unknowns.every(item => item.reason), 'every unknown has a reason')
  assert.equal(anonymous.verdict, 'needs-action')
  assert.equal(req(anonymous, 'github_admin').status, 'missing')
  assert.equal(req(anonymous, 'github_admin').remediation.href, '/api/github/start?mode=launch-guide')
  assert.equal(req(anonymous, 'plan').status, 'missing')
  // Without GitHub's creation date as well: 30 of 60 (50%), under the minimum, so no score, never a guess.
  const sparse = run({ maintainer: null, plan: null, wallet: null, repository: { ...facts().repository, createdAt: null } })
  assert.equal(sparse.quality.coveragePercent, 50)
  assert.ok(sparse.quality.coveragePercent < MIN_COVERAGE_PERCENT)
  assert.equal(sparse.quality.score, null)
  assert.match(sparse.quality.summary, /^Not enough evidence yet \(50% of pre-launch criteria known\)/)
  assert.deepEqual(sparse.quality.unknowns.map(item => item.id).sort(), ['launch_buy', 'maintainer', 'repo_age'])
  // An admin's check adds 10: 40 of 60 known (67%), so the score appears again.
  const admin = run({ plan: null, wallet: null, repository: { ...facts().repository, createdAt: null } })
  assert.equal(admin.quality.coveragePercent, 67)
  assert.equal(admin.quality.score, 100)
  // GitHub without commits data: activity unknown, not zero.
  assert.equal(crit(run({ activity: null }), 'repo_activity').status, 'unknown')
  assert.equal(crit(run({ activity: null }), 'repo_activity').points, 0)
})

test('never pay-to-rank: fees, tips, promotion, raises, price, market cap and volume change nothing', () => {
  const base = run()
  const paid = launchPreflight({ ...facts(), feesPaid: '100000000000', tips: 99, promotion: { featured: true, paid: true }, price: 1e6, marketCap: 1e12,
    volume: '999999999999999', groupRaiseLamports: '10000000000', credits: 500 }, { now: NOW })
  assert.deepEqual(paid, base)
  assert.ok(base.quality.excludedInputs.includes('fees or payments to repo.ing'))
  assert.ok(base.quality.excludedInputs.includes('promotion or placement'))
})

test('every blocker names the cause and a remediation, and blocks the repository for everyone', () => {
  const cases = [
    ['private', { repository: { status: 'not-found', private: true } }, 'repository_public', /Change visibility/],
    ['archived', { repository: { ...facts().repository, archived: true } }, 'repository_public', /Unarchive/],
    ['launched', { state: { ...facts().state, market: { status: 'confirmed', mint: 'MintAAA' } } }, 'no_market', /verify and claim/],
    ['launching', { state: { ...facts().state, market: { status: 'prepared', mint: null } } }, 'no_market', /two minutes/],
    ['opted out', { state: { ...facts().state, optOut: { kind: 'opt_out' } } }, 'not_opted_out', /withdraw the opt-out/],
    ['group raise', { state: { ...facts().state, liveBundleId: '7' } }, 'no_group_raise', /See the raise/],
    ['copy', { lineage: { status: 'blocked', message: 'This repository is a fork of a/b, which already has a market on repo.ing.', mint: 'MintParent' } }, 'fork_guard', /canonical/],
    ['paused', { platform: { launchAvailable: false, schedulesEnabled: true } }, 'launches_available', /later/],
  ]
  for (const [name, overrides, id, remedy] of cases) {
    const preflight = run(overrides)
    assert.equal(preflight.verdict, 'blocked', name)
    assert.equal(req(preflight, id).status, 'blocked', name)
    assert.match(req(preflight, id).remediation.text, remedy, name)
    assert.equal(preflight.ready.schedule, false, name)
    assert.ok(preflight.missing.includes(id), name)
  }
  assert.equal(req(run(cases[2][1]), 'no_market').remediation.href, '/token/MintAAA')
  assert.equal(req(run(cases[6][1]), 'fork_guard').remediation.href, '/token/MintParent')
  assert.equal(req(run({ state: { ...facts().state, liveBundleId: '7' } }), 'no_group_raise').remediation.href, '/group/7')
  // A GitHub hiccup is unknown with a retry, not a block; an unread first commit is a caution, not a block.
  const down = run({ repository: { status: 'unavailable' }, activity: null, lineage: null })
  assert.equal(req(down, 'repository_public').status, 'unknown')
  assert.equal(req(down, 'repository_public').remediation.action, 'retry')
  assert.notEqual(down.verdict, 'blocked')
  assert.equal(req(run({ lineage: { status: 'unknown' } }), 'fork_guard').status, 'warn')
  assert.equal(run({ lineage: { status: 'unknown' } }).ready.schedule, true)
  // An existing schedule or a blocked wallet blocks this plan only.
  const scheduled = run({ state: { ...facts().state, schedule: { scheduledAt: at(NOW + 3 * HOUR), announcedBy: 'octo', state: 'upcoming' } } })
  assert.equal(scheduled.verdict, 'needs-action')
  assert.equal(req(scheduled, 'no_schedule').status, 'blocked')
  assert.equal(scheduled.ready.schedule, false)
  assert.equal(scheduled.ready.launch, true)
})

test('maintainer states: not an admin, no App access and unknown each say what to do; only an admin is ready to schedule', () => {
  const notAdmin = run({ maintainer: { status: 'not-admin', githubLogin: 'helper', permission: 'write' } })
  assert.equal(req(notAdmin, 'github_admin').status, 'missing')
  assert.match(req(notAdmin, 'github_admin').detail, /helper with write access/)
  assert.equal(crit(notAdmin, 'maintainer').status, 'fail', 'a market launched by a non-admin is community-created')
  assert.equal(notAdmin.ready.schedule, false)
  const noAccess = run({ maintainer: { status: 'no-access', githubLogin: 'octo' } })
  assert.equal(req(noAccess, 'github_admin').remediation.href, 'https://github.com/apps/repo-ing/installations/new')
  assert.equal(req(run({ maintainer: { status: 'unknown' } }), 'github_admin').remediation.action, 'retry')
  const admin = run()
  assert.match(crit(admin, 'maintainer').note, /claim page after launch/, 'the public report needs a recorded verification')
})

test('plan requirements: time bounds, wallet, initial buy pricing and cap, balance advice, ticker and note', () => {
  const plan = facts().plan
  const tooSoon = run({ plan: { ...plan, scheduledAt: at(NOW + 59 * 60_000) } })
  assert.equal(req(tooSoon, 'launch_time').status, 'missing')
  assert.match(req(tooSoon, 'launch_time').detail, /less than one hour/)
  assert.equal(req(run({ plan: { ...plan, scheduledAt: at(NOW + 61 * 60_000) } }), 'launch_time').status, 'warn', 'just over the minimum is allowed, with a caution')
  assert.equal(req(run({ plan: { ...plan, scheduledAt: at(NOW + 31 * 24 * HOUR) } }), 'launch_time').status, 'missing')
  assert.equal(req(run({ plan: { ...plan, windowMinutes: 10 } }), 'launch_time').status, 'missing')
  assert.equal(req(run({ plan: { ...plan, launcherWallet: 'not-a-wallet' } }), 'launcher_wallet').status, 'missing')
  const previous = process.env.BLOCKED_WALLETS
  process.env.BLOCKED_WALLETS = WALLET
  try { assert.equal(req(run(), 'launcher_wallet').status, 'blocked') } finally { if (previous === undefined) delete process.env.BLOCKED_WALLETS; else process.env.BLOCKED_WALLETS = previous }
  // The buy announced is the config's exact preset; above the 1 SOL a schedule may announce it is refused; unpriced it is unknown.
  assert.equal(run({ plan: { ...plan, supplyBps: 300 } }).plannedBuyLamports, '856011397')
  const pricey = run({ plan: { ...plan, supplyBps: 300 }, terms: { ...TERMS, presets: { ...TERMS.presets, 300: '1000000001' } } })
  assert.equal(req(pricey, 'initial_buy').status, 'missing')
  assert.equal(req(run({ plan: { ...plan, supplyBps: 200 }, terms: { ...TERMS, presets: {} } }), 'initial_buy').status, 'unknown')
  assert.equal(req(run({ plan: { ...plan, supplyBps: 0 }, terms: null }), 'initial_buy').status, 'met', 'no buy needs no pricing')
  assert.equal(plannedBuyLamports({ supplyBps: 0 }, null), '0')
  // Balance: advisory only. Short by exactly one lamport is a caution with the shortfall; it never blocks publishing.
  const need = 250_000_000n + LAUNCH_SETUP_ESTIMATE_LAMPORTS
  const short = run({ wallet: { balanceLamports: String(need - 1n), observedAt: at(NOW) } })
  assert.equal(req(short, 'launcher_balance').status, 'warn')
  assert.deepEqual(req(short, 'launcher_balance').requiredFor, [])
  assert.match(req(short, 'launcher_balance').remediation.text, /^Add about 0\.0001 SOL to the wallet/, 'a shortfall rounds up')
  assert.equal(short.ready.schedule, true)
  assert.equal(req(run({ wallet: { balanceLamports: String(need), observedAt: at(NOW) } }), 'launcher_balance').status, 'met')
  assert.equal(req(run({ wallet: null }), 'launcher_balance').status, 'unknown')
  // Ticker: checked for launch, not part of the schedule.
  const taken = run({ plan: { ...plan, tokenSymbol: 'WIDGET' }, state: { ...facts().state, symbolTaken: true } })
  assert.equal(req(taken, 'token_identity').status, 'missing')
  assert.equal(taken.ready.schedule, true)
  assert.equal(taken.ready.launch, false)
  assert.equal(req(run({ plan: { ...plan, tokenSymbol: 'WIDGET!' } }), 'token_identity').status, 'missing')
  assert.equal(req(run({ plan: { ...plan, note: '<b>hi</b>' } }), 'note').status, 'missing')
  assert.equal(req(run({ plan: { ...plan, note: 'See https://github.com/octo/widget' } }), 'note').status, 'met')
})

test('disclosure: seeded positions with lock states and the launch controls the system enforces', () => {
  const preflight = run({ plan: { ...facts().plan, supplyBps: 300 } })
  const [buy, allocation, curve, migrated, platform] = preflight.seeding
  assert.equal(buy.kind, 'launch-buy')
  assert.equal(buy.wallet, WALLET)
  assert.equal(buy.lock, 'unlocked')
  assert.equal(buy.solLamports, '856011397')
  assert.match(buy.lockText, /no lock or vesting/)
  assert.equal(allocation.kind, 'builder-allocation')
  assert.equal(allocation.percentOfSupply, 1)
  assert.equal(allocation.lock, 'claimable-after-graduation')
  assert.equal(curve.lock, 'program-held')
  assert.equal(migrated.lock, 'permanently-locked')
  assert.match(platform.lockText, /None at launch/)
  assert.ok(!run({ terms: { ...TERMS, allocation: false } }).seeding.some(row => row.kind === 'builder-allocation'), 'no allocation row where the config has none')
  const controls = Object.fromEntries(preflight.controls.map(control => [control.id, control]))
  assert.deepEqual(Object.keys(controls), ['announcement', 'time_lock', 'launcher_only', 'buy_cap', 'no_side_doors', 'launch_fee', 'window', 'cancel'])
  assert.match(controls.launcher_only.value, new RegExp(WALLET))
  assert.match(controls.buy_cap.value, /0\.856 SOL \(3% of supply\)/)
  assert.match(controls.launch_fee.value, /50\.44% at first, falling to 1\.75% over 3 minutes/)
  assert.match(run({ plan: { ...facts().plan, supplyBps: 0 } }).controls.find(control => control.id === 'buy_cap').value, /^No initial buy/)
})

test('draft plans keep only known, bounded fields', () => {
  assert.deepEqual(normalizePlan({ scheduledAt: '2026-10-20T10:00:00+02:00', windowMinutes: '90', launcherWallet: ` ${WALLET} `, supplyBps: '200', note: ' hi ',
    tokenSymbol: '$wid', acknowledged: true, admin: true, maxInitialBuyLamports: '9' }),
  { scheduledAt: '2026-10-20T08:00:00.000Z', windowMinutes: 90, launcherWallet: WALLET, supplyBps: 200, note: 'hi', tokenSymbol: 'WID', acknowledged: true })
  assert.deepEqual(normalizePlan({ scheduledAt: '', launcherWallet: null }), {})
  for (const bad of [{ supplyBps: 150 }, { scheduledAt: 'soon' }, { windowMinutes: 1.5 }, { acknowledged: 'yes' }, { note: 'x'.repeat(1201) }, []]) {
    assert.throws(() => normalizePlan(bad), GuideError, JSON.stringify(bad))
  }
})

test('repository input: ids, owner/name and github.com links (a file or branch link names its repository)', () => {
  assert.deepEqual(parseRepositoryInput('1388219884'), { repoId: '1388219884' })
  assert.deepEqual(parseRepositoryInput('octo/widget'), { owner: 'octo', name: 'widget' })
  assert.deepEqual(parseRepositoryInput('https://github.com/octo/widget/tree/main/src'), { owner: 'octo', name: 'widget' })
  assert.deepEqual(parseRepositoryInput('github.com/octo/widget.git'), { owner: 'octo', name: 'widget' })
  for (const bad of ['', '0', 'https://gitlab.com/octo/widget', 'octo', '9'.repeat(17), 'x'.repeat(300)]) assert.equal(parseRepositoryInput(bad), null, bad)
})

// A fake GitHub that counts requests by path.
function fakeGithub(routes) {
  const calls = []
  const fetchImpl = async url => {
    const path = new URL(url).pathname
    calls.push(path)
    const answer = routes(path, new URL(url))
    if (answer instanceof Error) throw answer
    const { status = 200, body = null } = answer ?? { status: 404 }
    return { status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers() }
  }
  return { fetchImpl, calls }
}
const repoJson = { id: 42, full_name: 'octo/widget', name: 'widget', owner: { login: 'octo', avatar_url: 'https://avatars/x' }, private: false, archived: false,
  stargazers_count: 150, forks_count: 3, created_at: '2025-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', pushed_at: '2026-10-13T00:00:00Z',
  default_branch: 'main', license: { spdx_id: 'MIT' }, language: 'Rust' }

test('GitHub reads: public, private, archived, renamed, empty and unavailable repositories', async () => {
  const headers = {}
  const read = (body, status = 200) => readGuideRepository({ repoId: '42' }, { headers, now: NOW, fetchImpl: fakeGithub(() => ({ status, body })).fetchImpl })
  assert.equal((await read(repoJson)).status, 'ok')
  assert.equal((await read(repoJson)).license, 'MIT')
  assert.deepEqual(await read({ ...repoJson, private: true }), { status: 'not-found', private: true, repoId: '42', observedAt: at(NOW) })
  assert.equal((await read({ ...repoJson, archived: true })).archived, true)
  assert.equal((await read({ ...repoJson, id: 43 })).status, 'unavailable', 'an id that changed is never trusted')
  assert.equal((await read(null, 404)).status, 'not-found')
  assert.equal((await read(null, 502)).status, 'unavailable')
  assert.equal((await readGuideRepository({ repoId: '42' }, { headers, fetchImpl: async () => { throw new Error('ECONNRESET') } })).status, 'unavailable')
  assert.equal((await readGuideRepository({ repoId: '4503599627370497' }, { headers, fetchImpl: async () => assert.fail('a model id never reaches GitHub') })).status, 'not-found')
  const fork = await read({ ...repoJson, fork: true, parent: { id: 7, full_name: 'up/widget' }, source: { id: 7, full_name: 'up/widget' } })
  assert.deepEqual(fork.fork, { parent: { id: '7', fullName: 'up/widget' }, source: { id: '7', fullName: 'up/widget' } })
  const commits = (list, status = 200) => readCommitActivity('octo/widget', { headers, now: NOW, fetchImpl: fakeGithub(() => ({ status, body: list })).fetchImpl })
  assert.deepEqual(await commits([{ author: { id: 1 } }, { author: { id: 1 } }, { author: null, commit: { author: { email: 'a@b' } } }]),
    { commits: 3, authors: 2, truncated: false, observedAt: at(NOW) })
  assert.deepEqual(await commits(null, 409), { commits: 0, authors: 0, truncated: false, observedAt: at(NOW) })
  assert.equal(await commits(null, 500), null)
})

test('the preflight service reads GitHub once per repository and caches it; database state is always fresh', async () => {
  let clock = NOW
  const github = fakeGithub(path => path === '/repositories/42' || path === '/repos/octo/widget' ? { body: repoJson }
    : path === '/repos/octo/widget/commits' ? { body: [{ author: { id: 1 } }] } : { status: 404 })
  const queries = []
  const pool = { query: async (sql, params) => {
    queries.push(sql)
    if (/launch_schedules/.test(sql)) return { rows: [] }
    return { rows: [{ market: null, optOut: null, liveBundleId: null, symbolTaken: false }] }
  } }
  let lineageReads = 0
  const service = createPreflightService({ pool, fetchImpl: github.fetchImpl, now: () => clock, readTerms: async ({ meter }) => { meter.rpc += 0; return TERMS },
    readBalance: async (wallet, { meter }) => { meter.rpc += 1; return 5_000_000_000 },
    lineage: async ({ fetchImpl }) => { lineageReads += 1; await fetchImpl('https://api.github.com/repos/octo/widget/commits?per_page=1'); return { forkOf: null } } })
  assert.equal(service.isCached({ repoId: '42' }), false)
  const first = await service.run({ repoId: '42' })
  assert.equal(service.isCached({ owner: 'octo', name: 'WIDGET' }), true, 'cached by id and by name')
  assert.equal(first.profile.githubRequests, 3, 'repository, last week\'s commits and the first-commit read')
  assert.equal(first.profile.githubCached, false)
  assert.equal(first.profile.databaseQueries, 2)
  assert.equal(first.profile.rpcRequests, 0, 'no plan: no balance read')
  assert.equal(first.preflight.verdict, 'needs-action')
  // Again, by name: answered from the cache (GitHub untouched), with fresh database reads.
  const second = await service.run({ owner: 'Octo', name: 'Widget' }, { plan: facts().plan, maintainer: facts().maintainer })
  assert.equal(second.profile.githubRequests, 0)
  assert.equal(second.profile.githubCached, true)
  assert.equal(second.profile.databaseQueries, 2)
  assert.equal(second.profile.rpcRequests, 1, 'a full plan reads the launching wallet\'s balance once')
  assert.equal(second.preflight.verdict, 'ready')
  assert.equal(lineageReads, 1)
  assert.equal(service.cachedRepository('42').fullName, 'octo/widget')
  // balance: false (publish) skips the RPC read.
  assert.equal((await service.run({ repoId: '42' }, { plan: facts().plan, balance: false })).profile.rpcRequests, 0)
  // refresh, or an expired cache, reads GitHub again.
  assert.equal((await service.run({ repoId: '42' }, { refresh: true })).profile.githubRequests, 3)
  clock += 11 * 60_000
  assert.equal((await service.run({ repoId: '42' })).profile.githubRequests, 3)
  // A GitHub outage is not cached: the next run reads again.
  const flaky = fakeGithub(() => ({ status: 502 }))
  const outage = createPreflightService({ pool, fetchImpl: flaky.fetchImpl, now: () => clock, lineage: async () => ({ forkOf: null }) })
  const down = await outage.run({ repoId: '42' })
  assert.equal(down.repository, null)
  assert.equal(req(down.preflight, 'repository_public').status, 'unknown')
  await outage.run({ repoId: '42' })
  assert.equal(flaky.calls.length, 2)
  // An unreadable database is unknown with a retry, never "no market".
  const broken = createPreflightService({ pool: { query: async () => { throw Object.assign(new Error('down'), { code: '57P01' }) } }, fetchImpl: github.fetchImpl,
    now: () => clock, lineage: async () => ({ forkOf: null }) })
  assert.equal(req((await broken.run({ repoId: '42' })).preflight, 'no_market').status, 'unknown')
})

test('conversion events: fixed lists only, nothing identifying, and Global Privacy Control or Do Not Track records nothing', () => {
  assert.deepEqual(parseGuideBeacon('{"event":"step_view","step":"plan","source":"launch","repoId":"42"}'), { event: 'step_view', step: 'plan', source: 'launch', repoId: '42', outcome: null })
  assert.deepEqual(parseGuideBeacon('{"event":"guide_view","source":null,"repoId":null}'), { event: 'guide_view', step: null, source: null, repoId: null, outcome: null })
  for (const bad of ['{"event":"step_view","source":null}', '{"event":"guide_view","step":"plan"}', '{"event":"publish"}', '{"event":"guide_view","wallet":"x"}',
    '{"event":"guide_view","source":"ads"}', '{"event":"guide_view","repoId":42}', `{"event":"guide_view","source":"${'x'.repeat(300)}"}`, 'nope', '[]']) {
    assert.throws(() => parseGuideBeacon(bad), /INVALID_GUIDE_EVENT/, bad)
  }
  assert.deepEqual(guideEvent({ event: 'publish', outcome: 'scheduled', source: 'evil', repoId: '42', step: 'nope', githubLogin: 'octo' }),
    { event: 'publish', step: null, source: null, repoId: '42', outcome: 'scheduled' })
  assert.throws(() => guideEvent({ event: 'claim_view' }), /INVALID_GUIDE_EVENT/)
  assert.equal(trackingRefused(new Headers({ 'sec-gpc': '1' })), true)
  assert.equal(trackingRefused(new Headers({ dnt: '1' })), true)
  assert.equal(trackingRefused(new Headers()), false)
  assert.equal(guideHref('repo', '42'), '/launches/new?repo=42&src=repo')
  assert.equal(guideHref('nope', 'x'), '/launches/new')
  const summary = guideSummary([
    { event: 'guide_view', step: null, outcome: null, source: 'launch', day: 2, week: 5, month: 9 },
    { event: 'step_view', step: 'plan', outcome: null, source: 'launch', day: 1, week: 2, month: 4 },
    { event: 'preflight_run', step: null, outcome: 'ready', source: null, day: 0, week: 1, month: 3 },
    { event: 'publish', step: null, outcome: 'scheduled', source: 'launch', day: 0, week: 1, month: 2 },
    { event: 'publish', step: null, outcome: 'refused', source: 'launch', day: 1, week: 1, month: 1 },
  ])
  assert.equal(summary.count('guide_view', 'week'), 5)
  assert.equal(summary.count('publish:scheduled'), 2)
  assert.equal(summary.step('plan', 'day'), 1)
  assert.deepEqual(summary.sources.map(row => [row.source, row.views.month, row.preflights.month, row.published.month]), [['launch', 9, 0, 2], ['direct', 0, 3, 0]])
  assert.deepEqual(GUIDE_STEPS, ['github', 'repository', 'preflight', 'plan', 'disclose', 'preview', 'publish'])
})

test('migration 0073 matches the event and step lists and stays expand-only and idempotent', () => {
  const sql = readFileSync(new URL('../drizzle/0073_launch_guide.sql', import.meta.url), 'utf8')
  assert.doesNotMatch(sql, /\bDROP\b|\bALTER TABLE\b|\bUPDATE\b|\bDELETE\b/i)
  assert.equal((sql.match(/CREATE (UNIQUE )?(TABLE|INDEX) IF NOT EXISTS/g) ?? []).length, (sql.match(/CREATE (UNIQUE )?(TABLE|INDEX)/g) ?? []).length)
  for (const step of GUIDE_STEPS) assert.ok(sql.includes(`'${step}'`), step)
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
  assert.equal(journal.entries.at(-1).tag, '0073_launch_guide')
})

test('read-only MCP launch_preflight: verdict, pre-launch score, what to do, and the guide link; failures say so', async () => {
  const tool = readOnlyTools({ origin: () => 'https://repo.ing', preflight: async input => {
    assert.deepEqual(input, { owner: 'octo', name: 'widget' })
    return { preflight: run({ maintainer: null, plan: null, wallet: null, lineage: { status: 'blocked', message: 'This repository is a fork of up/widget, which already has a market on repo.ing.', mint: null } }),
      repository: { repoId: '42', fullName: 'octo/widget' } }
  } }).find(item => item.definition.name === 'launch_preflight')
  assert.equal(tool.definition.annotations.readOnlyHint, true)
  const { content, structuredContent } = await tool.call({ project: 'git@github.com:octo/widget.git' }, new Request('https://repo.ing/api/mcp/readonly'))
  assert.match(content[0].text, /cannot launch right now/)
  assert.match(content[0].text, /Blocked: One market per project/)
  assert.match(content[0].text, /Measured only after launch: /)
  assert.equal(structuredContent.guideUrl, 'https://repo.ing/launches/new?repo=42&src=agents')
  assert.equal(structuredContent.verdict, 'blocked')
  const unavailable = readOnlyTools({ origin: () => 'https://repo.ing', preflight: async () => null }).find(item => item.definition.name === 'launch_preflight')
  assert.equal((await unavailable.call({ project: 'octo/widget' }, new Request('https://repo.ing/x'))).isError, true)
  assert.equal((await unavailable.call({ project: 'https://gitlab.com/a/b' }, new Request('https://repo.ing/x'))).isError, true)
})
