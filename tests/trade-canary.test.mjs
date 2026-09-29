import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { LIGHTHOUSE_PROGRAM } from '../src/launch-wallet-assertions.mjs'
import { canaryAlerts, CANARY_FAILURE_THRESHOLD, createTradeCanary, lighthouseAssertion, probeMarket, TRADE_CANARY_FAILING } from '../src/trade-canary.mjs'
import { preparedFromRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'

const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const payer = Keypair.generate().publicKey

test('alert rule: a market alerts on its 2nd consecutive failure; every market failing alerts at once', () => {
  assert.equal(CANARY_FAILURE_THRESHOLD, 2)
  const ok = { repoId: '1', symbol: 'A', ok: true, consecutiveFailures: 0, error: null }
  const once = { repoId: '2', symbol: 'B', ok: false, consecutiveFailures: 1, error: 'boom' }
  assert.deepEqual(canaryAlerts([ok, once]), [])
  assert.deepEqual(canaryAlerts([ok, { ...once, consecutiveFailures: 2 }]).map(a => a.scope), ['2'])
  assert.deepEqual(canaryAlerts([{ ...ok, ok: false, consecutiveFailures: 1, error: 'x' }, once]).map(a => a.scope), ['all'])
  assert.deepEqual(canaryAlerts([]), [])
})

// Canary state and alerts in memory, mirroring the upsert and on-conflict rules (real SQL: trade-sessions-db.test.mjs).
function fakeDb() {
  const status = new Map(), alerts = new Map()
  return { status, alerts, async query(sql, params) {
    if (sql.startsWith('insert into trade_canary_status')) {
      const [repoId, , , ok, error, , at] = params, previous = status.get(repoId)
      const consecutiveFailures = ok ? 0 : !previous || previous.lastRunAt < at - 30 * 60 * 1000 ? 1 : previous.consecutiveFailures + 1
      status.set(repoId, { ok, error, lastRunAt: at.getTime(), consecutiveFailures })
      return { rows: [{ consecutiveFailures }] }
    }
    if (sql.startsWith('insert into graduation_alerts')) {
      if (alerts.has(params[0])) return { rowCount: 0 }
      alerts.set(params[0], { kind: params[2], detail: JSON.parse(params[3]) })
      return { rowCount: 1 }
    }
    throw Error(`unexpected SQL ${sql}`)
  } }
}

test('canary records each market, alerts after 2 consecutive failures, dedups per hour, and re-alerts next hour', async () => {
  const db = fakeDb(), failing = new Set(['9'])
  let at = new Date('2026-09-29T10:50:00Z')
  const canary = createTradeCanary({ db, connection: null, router: null, now: () => at,
    selectMarkets: async () => [{ repoId: '1', symbol: 'REPOING', expectPhase: 'graduated' }, { repoId: '9', symbol: 'CURVE', expectPhase: 'curve' }],
    probe: async market => { if (failing.has(market.repoId)) throw Error('simulation failed via https://rpc.example/?api-key=secret'); return { phase: market.expectPhase, unitsWithAssertion: 90_000, computeUnitLimit: 120_000 } } })
  let run = await canary.runOnce()
  assert.deepEqual(run.alerted, [])
  assert.equal(run.markets.find(m => m.repoId === '9').consecutiveFailures, 1)
  assert.match(run.markets.find(m => m.repoId === '9').error, /<url>/)
  assert.doesNotMatch(JSON.stringify(run), /secret/)
  at = new Date(at.getTime() + 5 * 60_000)
  run = await canary.runOnce()
  assert.deepEqual(run.alerted, ['9'])
  const alert = [...db.alerts.values()][0]
  assert.equal(alert.kind, TRADE_CANARY_FAILING)
  assert.deepEqual([alert.detail.market, alert.detail.symbol, alert.detail.consecutiveFailures], ['9', 'CURVE', 2])
  at = new Date(at.getTime() + 3 * 60_000)
  assert.deepEqual((await canary.runOnce()).alerted, [], 'one alert per market per hour')
  at = new Date('2026-09-29T11:02:00Z')
  assert.deepEqual((await canary.runOnce()).alerted, ['9'])
  failing.clear()
  at = new Date(at.getTime() + 5 * 60_000)
  run = await canary.runOnce()
  assert.ok(run.markets.every(m => m.ok && m.consecutiveFailures === 0))
  // Everything failing at once alerts immediately, even on a first failure.
  failing.add('1'); failing.add('9')
  at = new Date('2026-09-29T12:00:00Z')
  assert.deepEqual((await canary.runOnce()).alerted, ['all'])
})

// A prepared curve-shaped buy whose single "swap" instruction runs under the DBC program id in the fake simulator.
function preparedBuy({ limit = 120_000 } = {}) {
  const blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  return preparedFromRecord({ v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: payer.toBase58(), marketId: 1, githubRepoId: '5',
    mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(), referral: null, wsolRent: null,
    amountIn: '10000000', minimumAmountOut: '1', message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx),
    blockhash, lastValidBlockHeight: 10, slippageBps: 100, priorityFee: { computeUnitLimit: limit, microLamports: 200_000, lamports: '24000' } })
}

function chain({ err = null, swap = true, units = 80_000, assertionUnits = 5_000, lighthouseFails = false } = {}) {
  const sims = []
  return { sims, getBalance: async () => 5_000_000_000, getFeeForMessage: async () => ({ value: 29_000 }),
    simulateTransaction: async (tx, options) => {
      const keys = tx.message.staticAccountKeys.map(k => k.toBase58()), asserted = keys.includes(LIGHTHOUSE_PROGRAM)
      sims.push({ asserted, options })
      const logs = swap ? [`Program ${DBC} invoke [1]`, `Program ${DBC} success`] : []
      if (asserted) logs.push(`Program ${LIGHTHOUSE_PROGRAM} invoke [1]`, `Program ${LIGHTHOUSE_PROGRAM} ${lighthouseFails ? 'failed' : 'success'}`)
      return { value: { err: asserted && lighthouseFails ? { InstructionError: [2, { Custom: 1 }] } : err, logs, unitsConsumed: units + (asserted ? assertionUnits : 0) } }
    } }
}
const engine = (prepared = preparedBuy()) => ({ prepareBuy: async request => { assert.equal(request.amountLamports, '10000000'); assert.equal(request.referrer, null); return prepared } })

test('probe: real prepare path, record round trip, plain and wallet-asserted simulations within the CU limit', async () => {
  const connection = chain()
  const result = await probeMarket({ engine: engine(), connection, repoId: '5', payer: payer.toBase58(), expectPhase: 'curve' })
  assert.deepEqual([result.phase, result.unitsConsumed, result.unitsWithAssertion, result.computeUnitLimit], ['curve', 80_000, 85_000, 120_000])
  // preflight (plain), plain canary simulation, then the wallet-asserted one; the canary sims replace the blockhash.
  assert.deepEqual(connection.sims.map(s => s.asserted), [false, false, true])
  assert.ok(connection.sims.slice(1).every(s => s.options.replaceRecentBlockhash && s.options.sigVerify === false))
  const data = lighthouseAssertion(payer).data
  assert.deepEqual([...data.subarray(0, 3)], [5, 0, 2]); assert.equal(data.length, 36)
})

test('probe fails on a failing simulation, a missing swap, a refused or failing assertion, CU overrun, or the wrong phase', async () => {
  const run = (connection, options = {}) => probeMarket({ engine: engine(options.prepared), connection, repoId: '5', payer: payer.toBase58(), expectPhase: options.expectPhase ?? 'curve' })
  await assert.rejects(run(chain({ err: { InstructionError: [1, { Custom: 6001 }] } })), /simulation did not pass|simulation failed/)
  await assert.rejects(run(chain({ swap: false })), /did not run the swap/)
  await assert.rejects(run(chain({ lighthouseFails: true })), /Wallet-asserted trade simulation failed/)
  await assert.rejects(run(chain({ units: 118_000 })), /compute units/)
  await assert.rejects(run(chain(), { expectPhase: 'graduated' }), /expected graduated/)
  // A prepared transaction that already contains the Lighthouse program cannot accept wallet assertions.
  const withLighthouse = preparedBuy(), tx = withLighthouse.transaction
  const polluted = new Transaction({ feePayer: payer, recentBlockhash: tx.recentBlockhash }).add(...tx.instructions, lighthouseAssertion(payer))
  const record = { ...withLighthouse.record, message: Buffer.from(polluted.serializeMessage()).toString('base64'), transaction: serializeUnsigned(polluted) }
  await assert.rejects(run(chain(), { prepared: preparedFromRecord(record) }), /Review check refused/)
})
