import test from 'node:test'
import assert from 'node:assert/strict'
import { ABOUT_TO_GRADUATE_MIN_PERCENT, GRADUATION_RACE_LIMIT, GRADUATION_RACE_MIN_PERCENT, graduationSummary, newestLaunches, raceLabel, rankGraduationRace,
  remainingLabel, topOfRace, WATCH_LIMIT } from '../app/lib/graduation-race.mjs'
import { graduationColumns, SOL } from './fixtures/graduation-rows.mjs'

const now = Date.parse('2026-09-29T12:00:00Z')
const row = (mint, options) => ({ repoId: String(mint.length), mint, fullName: `acme/${mint}`, symbol: mint.toUpperCase(), tokenName: mint,
  ...graduationColumns({ mint, now, ...options }) })
const mints = race => race.map(market => market.mint)

test('ranks fresh active curves by exact progress, from a 1% floor of each market\'s own target', () => {
  assert.equal(GRADUATION_RACE_MIN_PERCENT, 1)
  const race = rankGraduationRace([
    row('dust', { reserveLamports: 849_999_999n, thresholdSol: 85n }), // 0.99%: would read "0%"
    row('floor', { reserveLamports: 850_000_000n, thresholdSol: 85n }), // exactly 1% of 85 SOL
    row('deep', { reserveLamports: 3_400_000_000n, thresholdSol: 340n }), // exactly 1% of 340 SOL
    row('deepdust', { reserveLamports: 3_399_999_999n, thresholdSol: 340n }),
    row('rcat', { reserveLamports: 17_510_000_000n, thresholdSol: 85n }), // 20.6%
    row('half', { reserveSol: 50n, thresholdSol: 100n }),
    row('big', { reserveSol: 1_290n, thresholdSol: 2_000n }), // 64.5%
  ], { now })
  assert.deepEqual(mints(race), ['big', 'half', 'rcat', 'deep', 'floor'])
  assert.deepEqual(Object.keys(race[0]).sort(), ['aboutToGraduate', 'fullName', 'mint', 'progressPercent', 'remainingLamports', 'repoId', 'reserveLamports',
    'symbol', 'thresholdLamports', 'tokenName'], 'no raw observation or evidence leaves the server')
  assert.equal(race.find(m => m.mint === 'rcat').remainingLamports, String(85n * SOL - 17_510_000_000n))
})

test('marks racers at or above 50% as about to graduate, using the exact ratio', () => {
  assert.equal(ABOUT_TO_GRADUATE_MIN_PERCENT, 50)
  const race = rankGraduationRace([row('below', { reserveLamports: 49_999_999_999n, thresholdSol: 100n }), row('at', { reserveSol: 50n, thresholdSol: 100n }),
    row('high', { reserveSol: 90n, thresholdSol: 100n })], { now })
  assert.deepEqual(race.map(m => [m.mint, m.aboutToGraduate]), [['high', true], ['at', true], ['below', false]])
})

test('stale, future, unverified, unreadable, migrating and graduated markets never race', () => {
  const race = rankGraduationRace([row('stale', { reserveSol: 40n, age: 301_000 }), row('future', { reserveSol: 40n, age: -60_000 }),
    row('unverified', { reserveSol: 40n, rowStatus: 'REVIEW' }), { ...row('broken', { reserveSol: 40n }), observation: null },
    row('migrating', { reserveSol: 85n }), row('graduated', { reserveSol: 85n, graduated: true }), row('unproven', { reserveSol: 85n, graduated: true, proven: false }),
    row('fresh', { reserveSol: 40n })], { now })
  assert.deepEqual(mints(race), ['fresh'])
})

test('ties break by mint; callers take the top five, or three without the official market', () => {
  const rows = ['e', 'b', 'f', 'a', 'd', 'c', 'g'].map(mint => row(mint, { reserveSol: 10n }))
  const race = rankGraduationRace(rows, { now })
  assert.deepEqual(mints(race), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert.equal(GRADUATION_RACE_LIMIT, 5)
  assert.deepEqual(mints(topOfRace(race)), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(mints(topOfRace(race, { limit: WATCH_LIMIT, excludeMints: ['a', 'c'] })), ['b', 'd', 'e'])
  assert.deepEqual(topOfRace([]), [])
})

test('labels floor the percent and format remaining SOL from lamports', () => {
  const [market] = rankGraduationRace([row('rcat', { reserveLamports: 17_510_000_000n, thresholdSol: 85n })], { now })
  assert.equal(graduationSummary(market), '20% · 67.49 SOL to go')
  assert.equal(remainingLabel(market), '67.49 SOL to go')
  assert.equal(raceLabel(market), 'acme/rcat ($RCAT): 20% · 67.49 SOL to go')
  assert.equal(raceLabel({ ...market, aboutToGraduate: true }), 'acme/rcat ($RCAT): 20% · 67.49 SOL to go, about to graduate')
  assert.equal(graduationSummary({ progressPercent: 99.99, remainingLamports: '1234567890123' }), '99% · 1,234.57 SOL to go')
  const [whale] = rankGraduationRace([row('whale', { reserveSol: 2_766n, thresholdSol: 4_000n })], { now })
  assert.equal(graduationSummary(whale), '69% · 1,234 SOL to go')
})

test('repositories on the do-not-promote list never race and are never listed as new launches', t => {
  const racer = (mint, repoId, reserveSol) => ({ ...row(mint, { reserveSol }), repoId })
  const rows = [racer('leader', '1103012935', 70n), racer('second', '7', 20n)]
  assert.deepEqual(mints(rankGraduationRace(rows, { now, excluded: new Set(['1103012935']) })), ['second'])
  assert.deepEqual(mints(rankGraduationRace(rows, { now })), ['leader', 'second'])
  const launch = (mint, repoId, minutesAgo) => ({ repoId, mint, fullName: `acme/${mint}`, symbol: mint.toUpperCase(), indexedAt: new Date(now - minutesAgo * 60_000) })
  const markets = [launch('newest', '1103012935', 1), launch('older', '7', 30)]
  assert.deepEqual(newestLaunches(markets, { now, excluded: new Set(['1103012935']) }).map(m => m.mint), ['older'])
  const saved = process.env.PROMOTION_EXCLUDED_REPO_IDS
  t.after(() => { if (saved === undefined) delete process.env.PROMOTION_EXCLUDED_REPO_IDS; else process.env.PROMOTION_EXCLUDED_REPO_IDS = saved })
  process.env.PROMOTION_EXCLUDED_REPO_IDS = ' 1103012935 ,abc'
  assert.deepEqual(newestLaunches(markets, { now }).map(m => m.mint), ['older'], 'defaults to PROMOTION_EXCLUDED_REPO_IDS')
  delete process.env.PROMOTION_EXCLUDED_REPO_IDS
  assert.deepEqual(newestLaunches(markets, { now }).map(m => m.mint), ['newest', 'older'])
})

test('newest launches: newest first, never the official market, three at most, with a relative launch time', () => {
  const market = (mint, minutesAgo) => ({ repoId: mint, mint, fullName: `acme/${mint}`, symbol: mint.toUpperCase(), indexedAt: new Date(now - minutesAgo * 60_000), volume24hLamports: '9' })
  const markets = [market('old', 3 * 1440), market('official', 1), market('fresh', 0), market('hour', 90), market('day', 1500), market('bad', 5)]
  markets[5].indexedAt = 'not a date' // never listed: no known launch time
  const newest = newestLaunches(markets, { excludeMints: ['official'], now })
  assert.deepEqual(newest, [
    { repoId: 'fresh', mint: 'fresh', fullName: 'acme/fresh', symbol: 'FRESH', launched: 'just now' },
    { repoId: 'hour', mint: 'hour', fullName: 'acme/hour', symbol: 'HOUR', launched: '1h ago' },
    { repoId: 'day', mint: 'day', fullName: 'acme/day', symbol: 'DAY', launched: '1d ago' },
  ])
  assert.equal(newestLaunches([market('x', 5)], { now })[0].launched, '5m ago')
  assert.deepEqual(newestLaunches([], { now }), [])
})
