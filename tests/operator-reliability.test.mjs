import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkerReliability, deploymentVersion } from '../src/worker-reliability.mjs'
import { loadOperatorReliability, reliabilityThresholds, workerObservation, RELIABILITY_SQL } from '../src/operator-reliability.mjs'
import { GET } from '../app/api/operations/reliability/route.js'
import { encryptGithubSession, newGithubSession } from '../app/lib/auth.mjs'

test('worker observations preserve results and failures, distinguish partial work, and never store payloads', async () => {
  let at = 0, stored
  const recorder = createWorkerReliability({ now: () => at, version: 'abc1234', write: async value => { stored = JSON.parse(value) } })
  const result = { done: 3, wallet: 'sensitive-wallet' }
  assert.equal(await recorder.track('transparency', async () => { at = 75; return result }), result)
  const failure = new Error('sensitive-url-token')
  await assert.rejects(recorder.track('transparency', async () => { at = 100; throw failure }), e => e === failure)
  await recorder.flush()
  assert.deepEqual(stored.stages[0], { name: 'transparency', state: 'failed', lastStartedAt: new Date(75).toISOString(),
    lastFinishedAt: new Date(100).toISOString(), lastSuccessAt: new Date(75).toISOString(), durationMs: 25 })
  await recorder.track('fees', async () => [{ status: 'ERROR', reason: 'sensitive-detail' }])
  await recorder.track('launches', async () => ({ reports: { done: 1, deferred: 2 } }))
  await recorder.track('graduatedTrades', async () => [{ status: 'SKIPPED', code: 'VERIFICATION_RPC_REQUIRED' }])
  let finish
  const running = recorder.track('claims', () => new Promise(resolve => { finish = resolve }))
  await recorder.flush()
  assert.deepEqual(stored.stages.map(s => s.state), ['failed', 'degraded', 'incomplete', 'incomplete', 'running'])
  assert.equal(stored.stages.find(s => s.name === 'graduatedTrades').lastSuccessAt, null)
  assert.doesNotMatch(JSON.stringify(stored), /sensitive/)
  finish([]); await running
})

test('telemetry writes coalesce and a failed write cannot fail or delay a worker job', async () => {
  let reject, writes = 0
  const recorder = createWorkerReliability({ write: () => { writes++; return new Promise((_, no) => { reject = no }) }, log() {} })
  const a = recorder.flush(), b = recorder.flush()
  assert.equal(a, b)
  assert.equal(await recorder.track('claims', async () => 'done'), 'done')
  reject(new Error('private connection error')); await a
  assert.equal(writes, 1)
})

test('worker freshness and running time honor strict boundaries, including clock skew and unknown evidence', () => {
  const thresholds = reliabilityThresholds({}), at = 1_000_000
  const snapshot = { capturedAt: new Date(at - 180_000), stages: [{ name: 'fees', state: 'running', lastStartedAt: new Date(at - 300_000) }] }
  assert.equal(workerObservation(snapshot, at, thresholds).status, 'ok')
  assert.equal(workerObservation(snapshot, at + 1, thresholds).status, 'degraded')
  assert.equal(workerObservation({ ...snapshot, capturedAt: new Date(at + 1) }, at, thresholds).status, 'degraded')
  assert.equal(workerObservation(null, at, thresholds).status, 'unknown')
  assert.equal(reliabilityThresholds({ OPS_WORKER_STALE_MS: '250000', OPS_STAGE_SLOW_MS: '-1' }).workerStaleMs, 250000)
  assert.equal(reliabilityThresholds({ OPS_WORKER_STALE_MS: 'Infinity' }).workerStaleMs, 180000)
  assert.equal(deploymentVersion({ REPOING_COMMIT_SHA: 'https://secret.example/key' }), null)
})

test('dashboard distinguishes stale/missing, bounded coverage, retry backoff and partial unavailability', async () => {
  const at = Date.parse('2026-10-14T12:00:00Z'), ago = ms => new Date(at - ms)
  const values = new Map([
    [RELIABILITY_SQL.worker, [{ snapshot: { capturedAt: ago(0), stages: [] } }]],
    [RELIABILITY_SQL.markets, [
      { indexedAt: ago(9_000_000), assessedAt: ago(7_200_000), sampledAt: ago(7_200_001) },
      { indexedAt: ago(9_000_000), assessedAt: ago(7_200_001), sampledAt: ago(0) },
      { indexedAt: ago(10), assessedAt: ago(10), sampledAt: null },
      { indexedAt: ago(10), assessedAt: null, sampledAt: ago(0) },
    ]],
    [RELIABILITY_SQL.pending, [{ createdAt: ago(900_001) }, { createdAt: ago(900_000) }]],
    [RELIABILITY_SQL.webhooks, [{ status: 'pending', attempts: 1, nextAttemptAt: ago(-60_000) }, { status: 'sending', attempts: 1, nextAttemptAt: ago(900_001) }]],
    [RELIABILITY_SQL.failures, []],
  ])
  const query = async sql => ({ rows: values.get(sql) ?? [] })
  const data = await loadOperatorReliability({ query, probeRpc: async () => { throw new Error('private rpc URL') }, now: () => at, env: {} })
  assert.deepEqual([data.markets.reportsStale, data.markets.reportsMissing, data.markets.samplesStale, data.markets.samplesMissing], [2, 1, 1, 1])
  assert.equal(data.pending.overdue, 1)
  assert.deepEqual([data.webhooks.overdue, data.webhooks.retrying], [1, 1])
  assert.equal(data.rpc.status, 'unknown'); assert.equal(data.database.status, 'ok'); assert.equal(data.status, 'degraded')
  assert.doesNotMatch(JSON.stringify(data), /private rpc/)
  values.set(RELIABILITY_SQL.markets, Array.from({ length: 1001 }, () => ({ indexedAt: ago(10), assessedAt: ago(0), sampledAt: ago(0) })))
  const capped = await loadOperatorReliability({ query, now: () => at, env: {} })
  assert.equal(capped.markets.status, 'unknown'); assert.equal(capped.markets.sampled, 1000); assert.equal(capped.markets.truncated, true)
  const unavailable = await loadOperatorReliability({ env: {} })
  assert.equal(unavailable.status, 'unknown'); assert.equal(unavailable.pending.count, undefined)
})

test('read-only API rejects anonymous, expired and nonoperator sessions before any observations', async () => {
  const original = { secret: process.env.GITHUB_APP_CLIENT_SECRET, ids: process.env.PLATFORM_OPERATOR_GITHUB_IDS }
  process.env.GITHUB_APP_CLIENT_SECRET = 'local-test-fixture-only'
  process.env.PLATFORM_OPERATOR_GITHUB_IDS = '42'
  const session = newGithubSession({ scope: 'builders', githubRepoId: null, githubUserId: '43', githubLogin: 'test',
    permission: 'identity', accessToken: 'ghu_fixture', accessTokenExpiresAt: Date.now() + 100_000 })
  try {
    for (const [cookie, expected] of [[null, 401], [encryptGithubSession(session), 403],
      [encryptGithubSession({ ...session, githubUserId: '42', expiresAt: Date.now() - 1 }), 401]]) {
      const response = await GET({ cookies: { get: () => ({ value: cookie }) } })
      assert.equal(response.status, expected)
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('vary'), 'Cookie')
      assert.deepEqual(Object.keys(await response.json()), ['error'])
    }
  } finally {
    for (const [key, value] of [['GITHUB_APP_CLIENT_SECRET', original.secret], ['PLATFORM_OPERATOR_GITHUB_IDS', original.ids]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  }
})
