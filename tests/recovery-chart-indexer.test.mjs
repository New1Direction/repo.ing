import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import * as charts from '../scripts/recovery-chart-indexer.mjs'
import { recoveryHistory, runRecoveryCharts } from '../scripts/recovery-chart-indexer.mjs'

const pool = '11111111111111111111111111111111'
const item = (signature, slot) => ({ signature, slot, err: null })
const rpc = (endpoint, pages) => ({ rpcEndpoint: endpoint, getSignaturesForAddress: async (_key, { before }, commitment) => {
  assert.equal(commitment, 'finalized')
  return pages[before ?? 'head'] ?? []
} })

test('chart recovery requires complete agreeing history and returns oldest first without the accounting boundary', async () => {
  const pages = { head: [item('new', 33), item('middle', 22)], middle: [item('old', 11), item('boundary', 10)] }
  assert.deepEqual(await recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, 'boundary', { pageSize: 2 }),
    [item('old', 11), item('middle', 22), item('new', 33)])
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('primary', pages), pool, 'boundary'), /INDEPENDENT_RPC_REQUIRED/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', { head: [item('different', 33), item('boundary', 10)] }), pool, 'boundary', { pageSize: 2 }), /RPC_DISAGREEMENT/)
  await assert.rejects(recoveryHistory(rpc('primary', { head: [item('new', 33)] }), rpc('verifier', pages), pool, 'boundary'), /CHART_HISTORY_INCOMPLETE/)
  await assert.rejects(recoveryHistory(rpc('primary', pages), rpc('verifier', pages), pool, 'boundary', { pageSize: 2, maxPages: 1 }), /CHART_HISTORY_LIMIT/)
})

test('a separate current-state verifier cannot conceal a non-independent archive provider', async () => {
  const manifest = readFileSync(new URL('../config/existing-market-custody.json', import.meta.url))
  await assert.rejects(runRecoveryCharts({
    TRADING_CUSTODY_RECOVERY_SHA256: createHash('sha256').update(manifest).digest('hex'),
    RECOVERY_CHART_DATABASE_URL: 'postgres://repoing_chart_recovery@127.0.0.1:1/chart?sslmode=verify-full',
    SOLANA_RPC_URL: 'https://primary.invalid/current',
    SOLANA_VERIFICATION_RPC_URL: 'https://independent.invalid',
    SOLANA_ARCHIVE_VERIFICATION_RPC_URL: 'https://primary.invalid/archive',
  }), /INDEPENDENT_RPC_REQUIRED/)
})

const pacedEnv = {
  RECOVERY_CHART_RPC_MODE: 'archival-paced',
  SOLANA_RPC_URL: 'https://primary.invalid/read',
  SOLANA_VERIFICATION_RPC_URL: 'https://pruned.invalid',
  SOLANA_ARCHIVE_VERIFICATION_RPC_URL: 'https://archive.invalid/read',
}

test('chart archival mode shares alias pacing through body completion, without changing legacy selection', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  const starts = []; let active = 0, peak = 0
  const providers = charts.createRecoveryChartProviders(pacedEnv, async (url, options) => {
    assert.equal(new URL(url).hostname, 'archive.invalid')
    const { id } = JSON.parse(options.body)
    starts.push(performance.now()); active++; peak = Math.max(peak, active)
    return new Response(new ReadableStream({ async start(controller) {
      await delay(starts.length === 1 ? 1200 : 5)
      controller.enqueue(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: 123 })))
      active--; controller.close()
    } }))
  })
  assert.deepEqual(await Promise.all([
    providers.verification.getBlockTime(1), providers.archiveVerification.getBlockTime(2),
    providers.verification.getBlockTime(3),
  ]), [123, 123, 123])
  assert.equal(peak, 1)
  assert.ok(starts[1] - starts[0] >= 1200, 'headers must not release the endpoint queue')
  assert.ok(starts[2] - starts[1] >= 1000, 'short bodies must still respect start spacing')
  const legacy = charts.createRecoveryChartProviders({ ...pacedEnv, RECOVERY_CHART_RPC_MODE: undefined })
  assert.equal(legacy.verification.rpcEndpoint, pacedEnv.SOLANA_VERIFICATION_RPC_URL)
  assert.equal(legacy.archiveVerification.rpcEndpoint, pacedEnv.SOLANA_ARCHIVE_VERIFICATION_RPC_URL)
  assert.throws(() => charts.createRecoveryChartProviders({ ...pacedEnv, RECOVERY_CHART_RPC_MODE: 'typo' }), /CHART_RPC_MODE/)
  assert.throws(() => charts.createRecoveryChartProviders({ ...pacedEnv, SOLANA_ARCHIVE_VERIFICATION_RPC_URL: undefined }), /CHART_RPC_CONFIG/)
})

test('paced chart transport fails closed on HTTP/RPC errors and cancels queued aliases without retries or secrets', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  for (const status of [429, 503, 200]) {
    let requests = 0
    const providers = charts.createRecoveryChartProviders(pacedEnv, async (_url, options) => {
      requests++
      const { id } = JSON.parse(options.body)
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message: 'SECRET_SENTINEL' } }), { status })
    })
    const results = await Promise.allSettled([providers.verification.getBlockTime(1), providers.archiveVerification.getBlockTime(2)])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.match(result.reason.message, /CHART_RPC_FAILED/)
      assert.equal(result.reason.message.includes('SECRET_SENTINEL'), false)
    }
    await assert.rejects(providers.connection.getGenesisHash(), /CHART_RPC_FAILED/)
    assert.equal(requests, 1)
    assert.throws(() => providers.assertSafe(), /CHART_RPC_FAILED/)
  }
})

test('paced chart transport cannot send transactions or fall back after a denied request', async () => {
  assert.equal(typeof charts.createRecoveryChartProviders, 'function')
  let requests = 0
  const providers = charts.createRecoveryChartProviders(pacedEnv, async () => { requests++; throw Error('must not fetch') })
  await assert.rejects(providers.connection.sendRawTransaction(Buffer.from([1])), /CHART_RPC_DENIED/)
  await assert.rejects(providers.connection.getGenesisHash(), /CHART_RPC_DENIED/)
  assert.equal(requests, 0)
})
