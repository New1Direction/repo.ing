import test from 'node:test'
import assert from 'node:assert/strict'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { clusterWallets, platformLinks, sameTransactionLinks, walletLinkPair } from '../src/wallet-clusters.mjs'
import { matchRoundTrips, ROUND_TRIP_WINDOW_MS, tradeIntegrity, integrityView } from '../src/trade-integrity.mjs'
import { largestFitting, liquidityProfile, sampleSummary, spotLamportsPerToken } from '../src/market-liquidity.mjs'
import { quoteDisplay } from '../src/trade-quote-display.mjs'
import { EXCLUDED_INPUTS, launchQualityReport, MIN_COVERAGE_PERCENT, qualitySummary } from '../src/launch-quality.mjs'
import { builderRewardAssessment, DUST_BASE_UNITS, holderDiversity, holderRetention, sustainedLiquidity } from '../src/market-health.mjs'
import { lpIncentives } from '../src/liquidity-incentives.mjs'
import { assertScheduleAllows, parseScheduleRequest, publicSchedule, SCHEDULE_CODES, scheduleState } from '../src/launch-schedules.mjs'
import { launchFailure } from '../src/launch-failure.mjs'
import { atomFeed, eventTitle, icsCalendar } from '../src/launch-feed-format.mjs'
import { parseFeedQuery } from '../src/launch-feed.mjs'
import http from 'node:http'
import { isPublicAddress, postJson, publicOnlyLookup, publicSigningKey, signDelivery, signingKey, validateWebhookUrl, WebhookError } from '../src/launch-webhooks.mjs'
import { seededLiquidity } from '../src/seeded-liquidity.mjs'

const wallet = () => Keypair.generate().publicKey.toBase58()
const SOL = 1_000_000_000n
const MIN = 60_000
const T0 = Date.parse('2026-10-01T00:00:00Z')
let slot = 1000n
const trade = (trader, direction, lamports, minutes, extra = {}) => ({ signature: extra.signature ?? `sig-${slot}`, eventIndex: 0, slot: String(slot++),
  tradedAt: new Date(T0 + minutes * MIN), trader, direction, lamports: String(lamports), tokens: String(extra.tokens ?? lamports * 1000n), ...extra })

test('wallet clusters: links merge transitively, ids are the smallest wallet whatever the link order', () => {
  const [a, b, c, d] = ['A1111111111111111111111111111111', 'B1111111111111111111111111111111', 'C1111111111111111111111111111111', 'D1111111111111111111111111111111']
  const forward = clusterWallets([a, b, c, d], [{ a: c, b: d }, { a: b, b: c }])
  const backward = clusterWallets([d, c, b, a], [{ a: b, b: c }, { a: d, b: c }])
  for (const result of [forward, backward]) {
    assert.equal(result.clusterOf.get(d), b)
    assert.equal(result.clusterOf.get(c), b)
    assert.equal(result.clusterOf.get(a), a, 'an unlinked wallet stays its own controller')
    assert.deepEqual(result.linked.get(b), [b, c, d])
  }
  const links = sameTransactionLinks([{ signature: 's1', trader: d }, { signature: 's1', trader: b }, { signature: 's1', trader: b }, { signature: 's2', trader: a }])
  assert.deepEqual(links.map(link => [link.a, link.b]), [[b, d]], 'only different owners in one transaction link')
  const labels = new Map([[c, { kind: 'platform' }], [a, { kind: 'team' }], [d, { kind: 'builder' }]])
  assert.deepEqual(platformLinks(labels).map(link => [link.a, link.b]), [[a, c]], 'repo.ing wallets are one controller; a builder wallet is not merged in')
  assert.deepEqual(walletLinkPair(d, a), { walletA: a, walletB: d })
  assert.throws(() => walletLinkPair(a, a), /itself/)
})

test('round trips: FIFO matching inside the window counts both legs; just outside the window counts nothing', () => {
  const at = minutes => ({ at: T0 + minutes * MIN })
  const matched = matchRoundTrips([{ ...at(0), direction: 'buy', lamports: 10n }, { ...at(5), direction: 'buy', lamports: 4n },
    { ...at(30), direction: 'sell', lamports: 12n }])
  assert.equal(matched, 12n)
  const edge = (minutes, ms = 0) => matchRoundTrips([{ ...at(0), direction: 'buy', lamports: 7n }, { at: T0 + minutes * MIN + ms, direction: 'sell', lamports: 7n }])
  assert.equal(edge(60), 7n, 'exactly at the window still matches')
  assert.equal(edge(60, 1), 0n, 'one millisecond past the window does not')
  // A sell first, then a re-buy, is a round trip too.
  assert.equal(matchRoundTrips([{ ...at(0), direction: 'sell', lamports: 3n }, { ...at(10), direction: 'buy', lamports: 5n }]), 3n)
})

test('trade integrity separates organic, round-trip, same-transaction, labeled and unattributed volume exactly', () => {
  const [a, b, c1, c2, d1, d2, team] = Array.from({ length: 7 }, wallet)
  const rows = [
    trade(a, 'buy', 1n * SOL, 0), trade(a, 'sell', 600_000_000n, 10),             // A: 0.6 SOL matched → 1.2 round trip, 0.4 organic
    trade(b, 'buy', 500_000_000n, 0), trade(b, 'sell', 500_000_000n, 121),        // B: outside the window → 1.0 organic
    trade(c1, 'buy', 300_000_000n, 1), trade(c2, 'sell', 300_000_000n, 6),        // C: linked wallets → 0.6 round trip
    trade(d1, 'buy', 200_000_000n, 2, { signature: 'bundle' }), trade(d2, 'sell', 150_000_000n, 2, { signature: 'bundle' }), // same tx → 0.35
    trade(team, 'buy', 2n * SOL, 3),                                               // labeled → 2.0
    trade(null, 'buy', 700_000_000n, 4),                                          // unattributed → 0.7
  ]
  const clusterOf = new Map([[c1, c1 < c2 ? c1 : c2], [c2, c1 < c2 ? c1 : c2]])
  const result = tradeIntegrity(rows, { labels: new Map([[team, { kind: 'team', label: 'repo.ing team' }]]), clusterOf })
  assert.deepEqual(result.totals, { volume: '6250000000', organic: '1400000000', roundTrip: '1800000000', sameTransaction: '350000000',
    labeled: '2000000000', unattributed: '700000000' })
  // Shares are of attributed volume (6.25 − 0.7 = 5.55 SOL), never of the unattributed part.
  assert.equal(result.organicPercent, 25.22)
  assert.equal(result.unattributedPercent, 11.2)
  assert.equal(result.traders.linkedControllers, 1)
  const view = integrityView(result)
  assert.ok(!('clusters' in view))
  assert.equal(view.flagged[0].roundTripLamports, '1200000000', 'largest flagged controller first')
  // Without the link, C's two wallets look organic: linking is what catches it.
  assert.equal(tradeIntegrity(rows, { labels: new Map([[team, { kind: 'team' }]]) }).totals.roundTrip, '1200000000')
})

// A constant-product pool with a 1% SOL-side fee: x·y = k with S lamports and T token base units.
function constantProduct(S, T, feeBps = 100n) {
  const isqrt = n => { let x = BigInt(Math.floor(Math.sqrt(Number(n)))); while (x * x > n) x--; while ((x + 1n) * (x + 1n) <= n) x++; return x }
  const sqrtPrice = isqrt(S * (1n << 128n) / T)
  const quote = (direction, amount) => {
    if (direction === 'buy') { const fee = amount * feeBps / 10_000n, net = amount - fee; return { outputAmount: T - S * T / (S + net), fee } }
    const gross = S - S * T / (T + amount), fee = gross * feeBps / 10_000n
    return { outputAmount: gross - fee, fee }
  }
  return { sqrtPrice, quote }
}

test('liquidity profile: each depth is the largest size within its impact band, and the spread includes fees on both sides', () => {
  const S = 100n * SOL, T = 1_000_000_000_000_000n
  const { sqrtPrice, quote } = constantProduct(S, T)
  const profile = liquidityProfile({ sqrtPrice, quote, maxBuyLamports: S * 4n, maxSellBaseUnits: T * 4n })
  const impact = (direction, amount) => { const q = quote(direction, amount); return quoteDisplay({ direction, input: amount, output: q.outputAmount, sqrtPrice, fee: q.fee }).priceImpactPercent }
  for (const row of profile.depth) {
    const buy = BigInt(row.buyLamports), sell = BigInt(row.sellTokens)
    assert.ok(impact('buy', buy) <= row.impactPercent && impact('buy', buy + buy / 1000n) > row.impactPercent, `buy depth at ${row.impactPercent}% is tight`)
    assert.ok(impact('sell', sell) <= row.impactPercent && impact('sell', sell + sell / 1000n) > row.impactPercent, `sell depth at ${row.impactPercent}% is tight`)
    assert.equal(BigInt(row.sellLamports), quote('sell', sell).outputAmount)
  }
  // Independently: with 1% fee on each side, a tiny round trip costs about 2%; at 1 SOL the impact (≈1% of a 100 SOL pool) adds about 2% more.
  const [small, large] = profile.spreads
  assert.ok(small.spreadBps >= 200 && small.spreadBps <= 225, `0.1 SOL spread ${small.spreadBps}`)
  assert.ok(large.spreadBps >= 390 && large.spreadBps <= 410, `1 SOL spread ${large.spreadBps}`)
  assert.equal(profile.feeBps, 100)
  assert.equal(spotLamportsPerToken(sqrtPrice).slice(0, 6), '99.999', '100 SOL over one billion tokens is 100 lamports per token')
  const summary = sampleSummary(profile)
  assert.equal(summary.buyDepthLamports, profile.depth[1].buyLamports)
  assert.equal(summary.spreadBps, small.spreadBps)
  assert.equal(summary.twoSided, true)
  // One-sided: a pool that cannot quote sells reports zero sell depth and no spread.
  const oneSided = liquidityProfile({ sqrtPrice, quote: (direction, amount) => { if (direction === 'sell') throw Error('no reserve'); return quote(direction, amount) },
    maxBuyLamports: S, maxSellBaseUnits: T })
  assert.equal(oneSided.depth[1].sellTokens, '0')
  assert.equal(oneSided.spreads[0].spreadBps, null)
  assert.equal(sampleSummary(oneSided).twoSided, false)
})

test('largestFitting treats a throwing check as not fitting and handles an empty range', () => {
  assert.equal(largestFitting(1000n, amount => amount <= 377n), 377n)
  assert.equal(largestFitting(1000n, amount => { if (amount > 500n) throw Error('beyond curve'); return true }), 500n)
  assert.equal(largestFitting(0n, () => true), 0n)
})

const NOW = Date.parse('2026-10-13T00:00:00Z')
const fullFacts = () => ({
  repo: { fullName: 'acme/tool', stars: 250, forks: 10, githubCreatedAt: '2025-01-01T00:00:00Z', syncedAt: '2026-10-12T00:00:00Z' },
  pulse: { commits7d: 4, devs7d: 2, checkedAt: '2026-10-12T00:00:00Z' },
  forkParent: null,
  maintainer: { verified: true, verifiedAt: '2026-10-02T00:00:00Z', declined: false },
  launch: { signature: 'sig', launchedAt: '2026-10-01T00:00:00Z', mint: 'Mint111', bundle: false, launchBuyPercent: 2.5, launchFee: true, config: 'Cfg', scheduled: null },
  holders: { mint: { fixedSupply: true, mintAuthorityRevoked: true, freezeAuthorityRevoked: true }, holders: { topPercent: 41 }, observedAt: '2026-10-12T00:00:00Z' },
  launcher: { heldPercent: 2.5, state: 'holding', wallet: 'W' },
  integrity: { totals: { volume: '5000000000', unattributed: '0' }, organicPercent: 90, roundTripPercent: 8, sameTransactionPercent: 2, windowMinutes: 60 },
  liquidity: { buyDepthLamports: '600000000', sellDepthLamports: '200000000', venue: 'curve', pool: 'P', sampledAt: '2026-10-12T00:00:00Z' },
  lpLock: { graduated: false, config: 'Cfg' },
})

test('launch quality: points add up per criterion, the score covers known criteria only, and fails are flagged', () => {
  const report = launchQualityReport(fullFacts(), { now: NOW })
  const points = Object.fromEntries(report.criteria.map(item => [item.id, [item.status, item.points, item.max]]))
  assert.deepEqual(points, {
    repo_age: ['pass', 10, 10], repo_adoption: ['pass', 10, 10], repo_activity: ['pass', 5, 5], original_repository: ['pass', 5, 5],
    maintainer: ['pass', 10, 10], launch_buy: ['warn', 6, 10], anti_sniper: ['pass', 5, 5], scheduled: ['info', 0, 0],
    mint_authorities: ['pass', 10, 10], holder_concentration: ['warn', 5, 10], launcher_position: ['pass', 5, 5],
    organic_volume: ['pass', 10, 10], liquidity_depth: ['warn', 6, 10], liquidity_lock: ['pass', 5, 5],
  })
  // 92 of 105 points, every criterion known.
  assert.equal(report.coveragePercent, 100)
  assert.equal(report.points, 92)
  assert.equal(report.score, 88)
  assert.deepEqual(report.unknowns, [])
  for (const item of report.criteria.filter(row => row.status !== 'info')) assert.ok(item.evidence.length > 0, `${item.id} names its evidence`)
  assert.deepEqual(qualitySummary(report), { version: 1, score: 88, coveragePercent: 100, assessedAt: report.assessedAt, unknowns: [], flags: [] })
})

test('launch quality is never pay-to-rank: payments, promotion, price and volume amounts cannot change it', () => {
  const base = launchQualityReport(fullFacts(), { now: NOW })
  const paid = launchQualityReport({ ...fullFacts(), feesPaidLamports: '999000000000', promoted: true, sponsor: 'acme', price: 12, marketCap: 1e9,
    volume24hLamports: '50000000000000', raiseLamports: '10000000000', tipsLamports: '5' }, { now: NOW })
  assert.deepEqual(paid, base)
  // The integrity criterion reads organic share, not the amount: ten times the volume at the same share scores the same.
  const bigger = fullFacts()
  bigger.integrity = { ...bigger.integrity, totals: { volume: '50000000000', unattributed: '0' } }
  assert.equal(launchQualityReport(bigger, { now: NOW }).score, base.score)
  assert.ok(EXCLUDED_INPUTS.includes('fees or payments to repo.ing'))
})

test('launch quality: unknown criteria lower coverage, below the floor there is no score, and a declined market fails', () => {
  const facts = fullFacts()
  delete facts.holders; delete facts.liquidity; delete facts.integrity; delete facts.pulse; delete facts.launcher
  const report = launchQualityReport(facts, { now: NOW })
  assert.deepEqual(report.unknowns.sort(), ['holder_concentration', 'launcher_position', 'liquidity_depth', 'mint_authorities', 'organic_volume', 'repo_activity'])
  assert.equal(report.coveragePercent, Math.round(55 * 100 / 105))
  assert.ok(report.coveragePercent < MIN_COVERAGE_PERCENT)
  assert.equal(report.score, null)
  assert.match(report.summary, /Not enough evidence/)
  const small = fullFacts()
  small.integrity = { ...small.integrity, totals: { volume: '400000000', unattributed: '0' } }
  assert.equal(launchQualityReport(small, { now: NOW }).criteria.find(item => item.id === 'organic_volume').status, 'unknown', 'too little volume is not judged')
  const declined = fullFacts()
  declined.maintainer = { verified: true, declined: true, decidedAt: '2026-10-05T00:00:00Z' }
  const view = launchQualityReport(declined, { now: NOW })
  assert.equal(view.criteria.find(item => item.id === 'maintainer').status, 'fail')
  assert.deepEqual(view.flags, ['maintainer'])
})

test('market health: effective holders, retention cohorts and sustained liquidity from samples', () => {
  const [a, b, c, team] = Array.from({ length: 4 }, wallet)
  const launch = T0
  const tokens = units => ({ tokens: units })
  const rows = [
    trade(a, 'buy', SOL, 60, tokens(3n * DUST_BASE_UNITS * 100n)),             // first week: still holds
    trade(b, 'buy', SOL, 120, tokens(DUST_BASE_UNITS * 100n)),                 // first week: still holds
    trade(c, 'buy', SOL, 180, tokens(DUST_BASE_UNITS * 100n)),                 // first week: sold out
    trade(c, 'sell', SOL, 60 * 24 * 10, tokens(DUST_BASE_UNITS * 100n)),
    trade(team, 'buy', SOL, 200, tokens(DUST_BASE_UNITS * 1000n)),             // labeled: never a holder
  ]
  const labels = new Map([[team, { kind: 'team' }]])
  const now = T0 + 40 * 86_400_000
  const diversity = holderDiversity(rows, { labels, now })
  assert.equal(diversity.holders, 2)
  // Holdings 3:1 → (4²)/(3²+1²) = 1.6 effective holders; the top 10 hold everything.
  assert.equal(diversity.effectiveHolders, 1.6)
  assert.equal(diversity.top10PercentOfHolders, 100)
  const retention = holderRetention(rows, { labels, launchAt: new Date(launch), now })
  assert.equal(retention.earlyCohort, 3)
  assert.equal(retention.earlyRetained, 2)
  assert.equal(retention.earlyRetentionPercent, 66.67)
  // Thirty days ago (day 10) C had already sold at day 10 exactly: A and B held then and still do.
  assert.equal(retention.holdersThirtyDaysAgo, 2)
  assert.equal(retention.holderRetentionPercent, 100)
  assert.equal(holderRetention(rows, { labels, launchAt: new Date(launch), now: T0 + 10 * 86_400_000 }).earlyRetentionPercent, null, 'not judged before 30 days')
  const hour = 3_600_000
  const samples = Array.from({ length: 10 }, (_, i) => ({ sampledAt: new Date(now - (i + 1) * hour), buyDepthLamports: String((i + 1) * 100_000_000),
    sellDepthLamports: String(i < 8 ? 900_000_000 : 50_000_000), spreadBps: 400, twoSided: true, quoteReserveLamports: '1000' }))
  const liquidity = sustainedLiquidity(samples, { launchAt: new Date(launch), now })
  assert.equal(liquidity.samples, 10)
  // min(buy, sell) per sample: 0.1..0.8 SOL, then 0.05, 0.05 → sorted, the lower median (5th of 10) is 0.3 SOL.
  assert.equal(liquidity.medianDepthLamports, '300000000')
  // Uptime: both sides ≥ 0.1 SOL and spread ≤ 10%: samples 0..7 → 80%.
  assert.equal(liquidity.uptimePercent, 80)
  assert.equal(liquidity.coveragePercent, Math.round(10 * 10_000 / 720) / 100)
  const assessment = builderRewardAssessment({ liquidity, diversity, retention, organicPercent: 95 })
  assert.equal(assessment.status, 'preview')
  assert.equal(assessment.paid, false)
  assert.equal(assessment.eligible, false)
  assert.deepEqual(assessment.criteria.filter(item => item.status === 'pass').map(item => item.id).sort(), ['age', 'early_retention', 'organic_volume'])
  assert.ok(assessment.excluded.includes('first-hour volume'))
})

test('LP incentives: only two-sided LP positions qualify; labeled and circular owners are excluded; volume never counts', () => {
  const [mm, washer, platform] = Array.from({ length: 3 }, wallet)
  const at = hours => new Date(T0 + hours * 3_600_000)
  const samples = []
  for (let h = 0; h < 4; h++) {
    samples.push({ sampledAt: at(h), position: 'P-platform', owner: platform, liquidity: '600', permanentLockedLiquidity: '600', poolLiquidity: '1000' })
    if (h < 2) samples.push({ sampledAt: at(h), position: 'P-mm', owner: mm, liquidity: '300', permanentLockedLiquidity: '0', poolLiquidity: '1000' })
    samples.push({ sampledAt: at(h), position: 'P-wash', owner: washer, liquidity: h < 2 ? '100' : '400', permanentLockedLiquidity: '0', poolLiquidity: '1000' })
  }
  const integrity = { clusters: [{ cluster: washer, volume: 2n * SOL, roundTrip: SOL, sameTransaction: 0n }, { cluster: mm, volume: 10n * SOL, roundTrip: 0n, sameTransaction: 0n }] }
  // The market's migration position is excluded by address even when its owner carries no label (the worker holds no partner key).
  const unlabeled = wallet()
  for (let h = 0; h < 4; h++) samples.push({ sampledAt: at(h), position: 'P-migrated', owner: unlabeled, liquidity: '200', permanentLockedLiquidity: '200', poolLiquidity: '1000' })
  const result = lpIncentives(samples, { labels: new Map([[platform, { kind: 'platform', label: 'repo.ing partner wallet' }]]), integrity,
    migratedPositions: new Set(['P-migrated']) })
  assert.equal(result.providers.find(row => row.positions.includes('P-migrated')).exclusion, 'migrated-locked')
  const by = Object.fromEntries(result.providers.map(row => [row.owner, row]))
  assert.equal(by[platform].exclusion, 'labeled')
  assert.equal(by[washer].exclusion, 'circular-volume')
  assert.equal(by[mm].exclusion, null)
  // MM: 30% of the pool in 2 of 4 samples → 15% time-weighted, 50% uptime, and the whole incentive share.
  assert.equal(by[mm].timeWeightedSharePercent, 15)
  assert.equal(by[mm].uptimePercent, 50)
  assert.equal(by[mm].incentiveSharePercent, 100)
  assert.equal(by[washer].incentiveSharePercent, 0)
  assert.equal(result.paid, false)
})

test('scheduled launches: request validation at the boundaries', () => {
  const now = NOW, launcher = wallet()
  const request = (extra = {}) => ({ repoId: '123', scheduledAt: new Date(now + 2 * 3_600_000).toISOString(), launcherWallet: launcher, ...extra })
  assert.equal(parseScheduleRequest(request(), now).windowMinutes, 120)
  assert.throws(() => parseScheduleRequest(request({ scheduledAt: new Date(now + 59 * MIN).toISOString() }), now), /at least one hour/)
  assert.equal(parseScheduleRequest(request({ scheduledAt: new Date(now + 60 * MIN).toISOString() }), now).scheduledAt.getTime(), now + 60 * MIN)
  assert.throws(() => parseScheduleRequest(request({ scheduledAt: new Date(now + 31 * 86_400_000).toISOString() }), now), /30 days/)
  assert.throws(() => parseScheduleRequest(request({ windowMinutes: 14 }), now), /15 minutes/)
  assert.equal(parseScheduleRequest(request({ windowMinutes: 1440 }), now).windowMinutes, 1440)
  assert.throws(() => parseScheduleRequest(request({ launcherWallet: 'not-a-wallet' }), now), /Solana wallet/)
  assert.throws(() => parseScheduleRequest(request({ maxInitialBuyLamports: '1000000001' }), now), /at most 1 SOL/)
  assert.equal(parseScheduleRequest(request({ maxInitialBuyLamports: '1000000000' }), now).maxInitialBuyLamports, SOL)
  assert.throws(() => parseScheduleRequest(request({ maxInitialBuyLamports: '0.5' }), now), /whole number/)
  assert.throws(() => parseScheduleRequest(request({ note: 'buy at https://evil.example.com' }), now), /Links are not allowed/)
  assert.throws(() => parseScheduleRequest(request({ repoId: '4503599627370496' }), now), /Invalid repository/)
})

test('scheduled launches: the gate refuses before the time, the wrong wallet, a larger buy and a Group launch; lapses after the window', async () => {
  const launcher = wallet(), other = wallet()
  const row = { id: 7, githubRepoId: '42', status: 'scheduled', scheduledAt: new Date(NOW), windowMinutes: 30, launcherWallet: launcher,
    maxInitialBuyLamports: '500000000', githubLogin: 'maintainer', createdAt: new Date(NOW - 7_200_000) }
  const db = { query: async () => ({ rows: [row] }) }
  const refused = async (options, code) => assert.rejects(assertScheduleAllows(db, '42', options), error => error.code === code)
  await refused({ wallet: launcher, initialBuyLamports: '0', now: NOW - 1 }, SCHEDULE_CODES.BEFORE)
  await refused({ wallet: other, initialBuyLamports: '0', now: NOW }, SCHEDULE_CODES.LAUNCHER)
  await refused({ wallet: launcher, initialBuyLamports: '500000001', now: NOW }, SCHEDULE_CODES.BUY)
  await refused({ wallet: launcher, initialBuyLamports: '0', bundle: true, now: NOW }, SCHEDULE_CODES.BUNDLE)
  await refused({ wallet: launcher, initialBuyLamports: '0', earlyAccess: true, now: NOW }, SCHEDULE_CODES.EARLY_ACCESS)
  assert.equal(await assertScheduleAllows(db, '42', { wallet: launcher, initialBuyLamports: '500000000', now: NOW + 29 * MIN }), row)
  assert.equal(await assertScheduleAllows(db, '42', { wallet: other, initialBuyLamports: '900000000', now: NOW + 30 * MIN }), null, 'after the window anyone may launch')
  assert.equal(scheduleState(row, NOW - 1), 'upcoming')
  assert.equal(scheduleState(row, NOW), 'open')
  assert.equal(scheduleState(row, NOW + 30 * MIN), 'lapsed')
  assert.equal(publicSchedule(row, NOW).windowEndsAt, new Date(NOW + 30 * MIN).toISOString())
  // A database before migration 0071 has no schedules: launches are unaffected.
  assert.equal(await assertScheduleAllows({ query: async () => { throw Object.assign(Error('missing'), { code: '42P01' }) } }, '42', { wallet: other }), null)
  const failure = launchFailure(Object.assign(Error('scheduled'), { code: SCHEDULE_CODES.BEFORE }), 'prepare')
  assert.deepEqual(failure, { error: 'scheduled', canRetry: false, code: SCHEDULE_CODES.BEFORE })
})

test('launch feed formats: iCalendar lines are folded at 75 octets with CRLF and escaped; Atom escapes markup', () => {
  const schedule = { id: '9', repoId: '42', fullName: 'acme/tool, "fast"; <b>', scheduledAt: '2026-10-20T15:00:00.000Z', windowEndsAt: '2026-10-20T17:00:00.000Z',
    windowMinutes: 120, launcherWallet: 'L'.repeat(44), maxInitialBuyLamports: '250000000', announcedBy: 'maintainer', note: 'Launch día 🚀' }
  const ics = icsCalendar({ scheduled: [schedule], groupLaunches: [] }, { origin: 'https://repo.ing', now: NOW })
  assert.ok(ics.endsWith('\r\n') && !/[^\r]\n/.test(ics), 'CRLF only')
  for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, `folded: ${line}`)
  const unfolded = ics.replace(/\r\n /g, '')
  assert.match(unfolded, /SUMMARY:acme\/tool\\, "fast"\\; <b> market launch window \(repo\.ing\)/)
  assert.match(unfolded, /DTSTART:20261020T150000Z/)
  assert.match(unfolded, /UID:schedule-9@repo\.ing/)
  assert.match(unfolded, /at most 0\.25 SOL/)
  const event = { id: '5', kind: 'launch.scheduled', repoId: '42', occurredAt: '2026-10-13T00:00:00.000Z', data: { fullName: schedule.fullName, schedule, path: '/launches#schedule-9' } }
  assert.equal(eventTitle(event), 'acme/tool, "fast"; <b>: launch scheduled for 2026-10-20 15:00 UTC')
  const atom = atomFeed([event], { origin: 'https://repo.ing' })
  assert.match(atom, /<title>acme\/tool, &quot;fast&quot;; &lt;b&gt;: launch scheduled/)
  assert.ok(!atom.includes('<b>'))
  assert.throws(() => parseFeedQuery(new URLSearchParams('kind=market.rugged')), /kind must be one of/)
  assert.throws(() => parseFeedQuery(new URLSearchParams('limit=500')), /limit/)
  assert.deepEqual(parseFeedQuery(new URLSearchParams('after=10&repo=1,2')), { after: '10', limit: 50, kinds: [], repos: ['1', '2'] })
})

test('webhooks: only public HTTPS URLs; every resolved address must be public; deliveries verify with the published key', async () => {
  for (const [url, message] of [['http://hooks.example.com/x', /https/], ['https://user:pw@hooks.example.com', /user name/], ['https://hooks.example.com:8443/', /standard HTTPS port/],
    ['https://localhost/hook', /public host/], ['https://10.0.0.5/hook', /public address/], ['https://[::1]/hook', /public address/], ['https://svc.internal/x', /public host/]]) {
    assert.throws(() => validateWebhookUrl(url), error => error instanceof WebhookError && message.test(error.message), url)
  }
  assert.equal(validateWebhookUrl('https://hooks.example.com/repoing#frag'), 'https://hooks.example.com/repoing')
  const table = { '8.8.8.8': true, '10.1.2.3': false, '172.16.0.1': false, '172.31.255.255': false, '172.32.0.1': true, '100.64.0.1': false, '169.254.169.254': false,
    '192.168.1.1': false, '127.0.0.1': false, '0.0.0.0': false, '::1': false, '::': false, 'fe80::1': false, 'fd00::1': false, '::ffff:127.0.0.1': false,
    '::ffff:8.8.8.8': true, '64:ff9b::a00:1': false, '2606:4700:4700::1111': true, '2001:db8::1': false, 'not-an-ip': false,
    // IPv4 embedded in IPv6 is judged by the IPv4 address; outside global unicast nothing is public.
    '::127.0.0.1': false, '::169.254.169.254': false, '::ffff:0:10.0.0.1': false, '64:ff9b:1::1': false, '2002:c0a8:101::1': false,
    '2002:808:808::1': true, '64:ff9b::808:808': true, '100::1': false, 'fec0::1': false }
  for (const [ip, expected] of Object.entries(table)) assert.equal(isPublicAddress(ip), expected, ip)
  const lookup = addresses => new Promise(resolve => publicOnlyLookup((host, options, callback) => callback(null, addresses))('hooks.example.com', {}, (error, address) => resolve({ error, address })))
  assert.equal((await lookup([{ address: '93.184.216.34', family: 4 }])).address, '93.184.216.34')
  assert.equal((await lookup([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])).error.code, 'WEBHOOK_PRIVATE_ADDRESS', 'one private answer refuses the host')
  const env = { LAUNCH_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64') }
  const key = signingKey(env), published = publicSigningKey(env)
  const body = '{"id":"1"}', signature = signDelivery(body, 1760000000, key)
  assert.ok(verifySignature(null, Buffer.from(`1760000000.${body}`), createPublicKey(published.pem), Buffer.from(signature, 'base64')))
  assert.ok(!verifySignature(null, Buffer.from(`1760000001.${body}`), createPublicKey(published.pem), Buffer.from(signature, 'base64')), 'the timestamp is signed')
  assert.equal(Buffer.from(published.publicKeyBase64, 'base64').length, 32)
  assert.equal(signingKey({ LAUNCH_WEBHOOK_SIGNING_KEY: 'short' }), null)
})

test('seeded liquidity discloses each position with its label, amount and lock state', () => {
  const launcher = wallet()
  const market = { launcherWallet: launcher, launchSignature: 'launch-sig', bundleId: null, builderAllocationVersion: 1 }
  const rows = seededLiquidity({ market, launchTrades: [{ trader: launcher, direction: 'buy', lamports: '856011397', tokens: '30000000000000' }],
    launcherPosition: { heldPercent: 1.5, state: 'sold-some' }, labels: new Map([[launcher, { label: 'Builder' }]]),
    proof: { creatorPosition: 'C', partnerPosition: 'P', signature: 'mig' },
    liquidityIntents: [{ lpOwner: 'Partner', position: 'X', sourceAmount: '1000', lockMode: 'platform-authority', signature: 's' }] })
  assert.deepEqual(rows.map(row => [row.kind, row.lock]), [['launch-buy', 'unlocked'], ['builder-allocation', 'claimable-after-graduation'],
    ['migrated-lp', 'permanently-locked'], ['protocol-liquidity', 'withdrawable-by-platform']])
  assert.equal(rows[0].label, 'Builder')
  assert.equal(rows[0].percentOfSupply, 3)
  assert.equal(rows[0].currentIndexedPercent, 1.5)
  const group = seededLiquidity({ market: { ...market, bundleId: '5', builderAllocationVersion: null }, launchTrades: [{ trader: 'signer', direction: 'buy', lamports: '4750000000', tokens: '150000000000000' }] })
  assert.deepEqual(group.map(row => [row.kind, row.lock, row.percentOfSupply]), [['group-vault', 'program-controlled', 15]])
})

test('webhooks: a delivery ends when the status line arrives, so a receiver that never finishes its body cannot hold it open', async () => {
  const server = http.createServer((request, response) => { response.writeHead(200); response.flushHeaders(); const drip = setInterval(() => response.write('.'), 50); response.on('close', () => clearInterval(drip)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const silent = http.createServer(() => {})
  await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
  try {
    const started = Date.now()
    const allowLoopback = (host, options, callback) => (options?.all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4))
    assert.deepEqual(await postJson(`http://127.0.0.1:${server.address().port}/`, '{}', {}, { timeoutMs: 2000, lookup: allowLoopback, request: http.request }), { status: 200 })
    assert.ok(Date.now() - started < 1000, 'answered at the status line')
    const quiet = Date.now()
    await assert.rejects(postJson(`http://127.0.0.1:${silent.address().port}/`, '{}', {}, { timeoutMs: 300, lookup: allowLoopback, request: http.request }),
      error => error.code === 'WEBHOOK_TIMEOUT')
    assert.ok(Date.now() - quiet < 1500, 'a silent receiver is cut off at the deadline')
  } finally {
    server.closeAllConnections(); silent.closeAllConnections()
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => silent.close(resolve))])
  }
})

test('funding source: the first SOL transfer into the wallet, top-level or inner, names its funder; outgoing transfers do not', async () => {
  const { firstFunding } = await import('../src/wallet-funding.mjs')
  const SYSTEM = '11111111111111111111111111111111'
  const ix = (type, info) => ({ programId: SYSTEM, program: 'system', parsed: { type, info } })
  const tx = (top, inner = []) => ({ meta: { err: null, innerInstructions: inner.length ? [{ index: 0, instructions: inner }] : [] }, transaction: { message: { instructions: top } } })
  assert.deepEqual(firstFunding(tx([ix('transfer', { source: 'W', destination: 'X', lamports: 5 }), ix('transfer', { source: 'F', destination: 'W', lamports: 2_000_000 })]), 'W'),
    { funder: 'F', lamports: 2_000_000n })
  assert.deepEqual(firstFunding(tx([{ programId: 'Other', parsed: null }], [ix('transfer', { source: 'Exchange', destination: 'W', lamports: 7 })]), 'W'), { funder: 'Exchange', lamports: 7n })
  assert.deepEqual(firstFunding(tx([ix('createAccount', { source: 'Parent', newAccount: 'W', lamports: 890880 })]), 'W'), { funder: 'Parent', lamports: 890880n })
  assert.equal(firstFunding(tx([ix('transfer', { source: 'W', destination: 'F', lamports: 1 })]), 'W'), null)
  assert.equal(firstFunding({ ...tx([ix('transfer', { source: 'F', destination: 'W', lamports: 1 })]), meta: { err: { InstructionError: [0, 'x'] } } }, 'W'), null, 'a failed transaction funds nothing')
})

test('launch quality: a burned supply is no risk; only supply above one billion or a live authority fails', () => {
  const facts = fullFacts()
  facts.holders = { ...facts.holders, mint: { fixedSupply: false, supplyBaseUnits: '985000000000000', burnedBaseUnits: '15000000000000', mintAuthorityRevoked: true, freezeAuthorityRevoked: true } }
  const burned = launchQualityReport(facts, { now: NOW }).criteria.find(item => item.id === 'mint_authorities')
  assert.equal(burned.status, 'pass')
  assert.equal(burned.value, 'Nobody can mint or freeze; 15,000,000 tokens burned so far')
  facts.holders.mint = { ...facts.holders.mint, supplyBaseUnits: '1000000000000001', burnedBaseUnits: '0' }
  assert.equal(launchQualityReport(facts, { now: NOW }).criteria.find(item => item.id === 'mint_authorities').value, 'supply above one billion')
  facts.holders.mint = { ...facts.holders.mint, supplyBaseUnits: '1000000000000000', mintAuthorityRevoked: false }
  assert.equal(launchQualityReport(facts, { now: NOW }).criteria.find(item => item.id === 'mint_authorities').value, 'mint authority set')
})
