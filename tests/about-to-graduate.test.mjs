import test from 'node:test'
import assert from 'node:assert/strict'
import { selectAboutToGraduate, graduationSummary, ABOUT_TO_GRADUATE_LIMIT } from '../app/lib/about-to-graduate.mjs'

const now = Date.parse('2026-09-29T12:00:00Z'), SOL = 1_000_000_000n
function row(mint, reserveSol, { thresholdSol = 100n, age = 10_000, phase = 'CURVE', status, rowStatus = 'VERIFIED' } = {}) {
  const reserve = reserveSol * SOL, threshold = thresholdSol * SOL, at = new Date(now - age).toISOString()
  const observation = { phase, status: status ?? (reserve >= threshold ? 'migrating' : 'active'), reserveLamports: String(reserve),
    thresholdLamports: String(threshold), remainingLamports: String(reserve >= threshold ? 0n : threshold - reserve),
    progressPercent: Number(reserve * 10000n / threshold) / 100, checkedAt: at, chainTime: at }
  return { repoId: mint.length.toString(), mint, fullName: `acme/${mint}`, symbol: mint.toUpperCase(), tokenName: mint,
    status: rowStatus, observation: JSON.stringify(observation), migration_evidence_hash: null }
}

test('keeps fresh active curves at or above 50%, sorted by progress', () => {
  const picked = selectAboutToGraduate([row('low', 49n), row('half', 50n), row('high', 90n), row('mid', 70n)], now)
  assert.deepEqual(picked.map(m => m.mint), ['high', 'mid', 'half'])
  assert.deepEqual(Object.keys(picked[0]).sort(), ['fullName', 'mint', 'progressPercent', 'remainingLamports', 'repoId', 'reserveLamports', 'symbol', 'thresholdLamports', 'tokenName'])
  assert.equal(picked[0].remainingLamports, String(10n * SOL))
})

test('sorts by exact ratio across different thresholds and caps at six', () => {
  const rows = [row('a', 60n), row('b', 61n), row('c', 62n), row('d', 63n), row('e', 64n), row('f', 65n), row('g', 66n),
    row('big', 1_290n, { thresholdSol: 2_000n })]
  const picked = selectAboutToGraduate(rows, now)
  assert.equal(picked.length, ABOUT_TO_GRADUATE_LIMIT)
  assert.deepEqual(picked.map(m => m.mint), ['g', 'f', 'big', 'e', 'd', 'c'])
})

test('skips stale, unverified, graduated and migrating rows', () => {
  const rows = [row('stale', 80n, { age: 301_000 }), row('future', 80n, { age: -60_000 }), row('unverified', 80n, { rowStatus: 'REVIEW' }),
    { ...row('broken', 80n), observation: null }, row('migrating', 100n), row('graduated', 100n, { phase: 'GRADUATED', status: 'graduated' }),
    row('fresh', 80n)]
  assert.deepEqual(selectAboutToGraduate(rows, now).map(m => m.mint), ['fresh'])
})

test('formats remaining SOL from lamports, including amounts above 1,000 SOL', () => {
  const [market] = selectAboutToGraduate([row('whale', 2_766n, { thresholdSol: 4_000n })], now)
  assert.equal(graduationSummary(market), '69% · 1,234 SOL to go')
  assert.equal(graduationSummary({ progressPercent: 99.99, remainingLamports: '1234567890123' }), '99% · 1,234.57 SOL to go')
})
