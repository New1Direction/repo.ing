import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { preparedFromRecord } from './trade-record.mjs'
import { readTradeComputeBudget, tradePriorityFee } from './trade-landing.mjs'
import { SUBMIT_WINDOW_MS } from './trade-sessions.mjs'

const markets = [
  { githubRepoId: '1250482335', phase: 'curve', mint: 'FhMEdpvV6Ui6UTcarknzEWbhV5T5Gxip2DkKFCX7pAKX', pool: '6zFBUcHCK59fcJQGLEXrQss6PxQmwtaXmeoA8MozxKdk' },
  { githubRepoId: '1388219884', phase: 'graduated', mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', pool: 'FHw49kTEEjzBhRuMff9F1Xw1bLcBpwvsaSboaAWpAcaT', curve: 'Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7' },
  { githubRepoId: '1391948723', phase: 'graduated', mint: 'HbtGZge2NcfrrmBGx2Pqf9qgrNvMa63hQHVqcWSPuNub', pool: 'q15tXnaoDGRKph9LYMuFzDeyveGseTgoa1TKgoS8TfT', curve: '4b1hdxNQaqaktZX462dofh8WtZy2uUKivMid92Nv58it' },
]
export const TEST_PLAN = Object.freeze({ id: 'existing-markets-six-swaps-v1',
  wallet: 'DrAhCGXsHLNdJ9ihhRBkyKZSzY446qKg1Dcx6zEm9dmi', ceiling: '21225960',
  steps: Object.freeze(markets.flatMap(market => ['buy', 'sell'].map(direction => Object.freeze({ ...market, direction })))) })

const amount = (value, label = 'cost') => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw Error(`Test ${label} invalid`)
  return BigInt(value)
}
function checkRequest(state, body) {
  if (!['ready', 'prepared'].includes(state.phase)) throw Error(`Test ${state.phase === 'submitted' ? 'settlement pending' : state.phase}`)
  const step = TEST_PLAN.steps[state.step]
  const input = step.direction === 'buy' ? '1000000' : state.acquired
  if (body.wallet !== TEST_PLAN.wallet || String(body.githubRepoId) !== step.githubRepoId || body.direction !== step.direction ||
    body.slippageBps !== 100 || body.amountBaseUnits !== input || body.referrer != null || !input || input === '0') throw Error('Test request outside approved plan')
  return { ...step, amountIn: input }
}

// Exactly one operator-created run. The runtime may update state, never insert a
// run or change enabled. No memory fallback, TTL cleanup, reset or rearm endpoint.
export function createTestRun({ db, now = Date.now }) {
  async function locked(fn) {
    const client = await db.connect()
    try {
      await client.query('begin')
      const { rows: [row] } = await client.query('select enabled, state from existing_market_test_runs where id=$1 for update', [TEST_PLAN.id])
      if (!row) throw Error('Test run missing')
      const state = row.state
      // Expiry must commit the stop even when the requested operation is refused.
      if (state.phase === 'prepared' && now() - state.pending.createdAt > SUBMIT_WINDOW_MS) {
        state.phase = 'stopped'; state.reason = 'prepared transaction expired; no replacements'
      }
      let value, failure
      try { value = await fn(state, row.enabled, client) } catch (error) { failure = error }
      if (failure && state.reason !== 'prepared transaction expired; no replacements') throw failure
      await client.query('update existing_market_test_runs set state=$2::jsonb where id=$1', [TEST_PLAN.id, JSON.stringify(state)])
      await client.query('commit')
      if (failure) throw failure
      return value
    } catch (error) { await client.query('rollback'); throw error } finally { client.release() }
  }
  const active = enabled => { if (!enabled) throw Error('Test run disabled') }
  const inspect = () => locked((state, enabled) => ({ state, enabled }))
  const load = id => locked(state => {
    const completed = state.history.find(item => item.id === id)
    if (completed) return { state, completed }
    if (state.pending?.id !== id) throw Error('Test session not found')
    return { state, pending: state.pending }
  })
  return {
    inspect, load,
    request: body => locked((state, enabled) => { active(enabled); checkRequest(state, body); return state }),
    reserve: (body, { record, costs, before = null }) => locked((state, enabled) => {
      active(enabled)
      const step = checkRequest(state, body)
      if (state.pending) return state // concurrent prepare returns the original, never a replacement
      const prepared = preparedFromRecord(record), tx = prepared.transaction
      for (const key of ['githubRepoId', 'direction', 'phase', 'mint', 'pool', 'amountIn']) {
        if (record[key] !== step[key]) throw Error('Test prepared record outside approved plan')
      }
      if (record.wallet !== TEST_PLAN.wallet || record.slippageBps !== 100 || record.referral || record.quoteMint ||
        record.signedMessage || tx.signatures.some(item => item.signature !== null) ||
        tx.feePayer?.toBase58() !== TEST_PLAN.wallet || tx.compileMessage().header.numRequiredSignatures !== 1 ||
        (step.curve && record.curve !== step.curve) || (step.phase === 'graduated' && !before)) throw Error('Test prepared record outside approved plan')
      const budget = readTradeComputeBudget(tx.instructions)
      const fee = amount(costs.networkFee), deposit = amount(costs.accountDeposits), temporary = amount(costs.refundableDeposit)
      if (budget.count !== 2 || fee < 5000n + tradePriorityFee(tx.instructions) || fee > 805000n ||
        deposit > (step.direction === 'buy' ? 1488440n : 0n) || temporary > 1488440n) throw Error('Test cost ceiling exceeded')
      if (amount(costs.shortfall, 'balance') !== 0n) throw Error('Test balance insufficient')
      const gross = (step.direction === 'buy' ? 1000000n : 0n) + fee + deposit + temporary
      if (amount(state.spent) + gross > BigInt(TEST_PLAN.ceiling)) throw Error('Test cumulative cost ceiling exceeded')
      state.pending = { id: randomUUID(), step: state.step, createdAt: now(), record, costs, gross: String(gross), before }
      state.phase = 'prepared'
      return state
    }),
    // Called only after cryptographic verification against this durable record.
    // Commit first-use before RPC. Even an uncertain send never receives a retry.
    claimVerifiedSignature: (id, { signature, signedMessage }) => locked((state, enabled) => {
      active(enabled)
      const pending = state.pending
      if (!pending || pending.id !== id) throw Error('Test session not found')
      if (pending.signature) {
        if (pending.signature !== signature || pending.signedMessage !== signedMessage) throw Error('Test replacement signature forbidden')
        return { send: false, pending }
      }
      if (state.phase !== 'prepared') throw Error(`Test ${state.reason ?? state.phase}`)
      // This test permits the exact message only, not wallet-added instructions.
      if (signedMessage !== pending.record.message) throw Error('Test signed message changed')
      pending.signature = signature; pending.signedMessage = signedMessage
      state.spent = String(BigInt(state.spent) + BigInt(pending.gross))
      state.phase = 'submitted'
      return { send: true, pending }
    }),
    stop: (id, reason) => locked(state => {
      if (state.pending?.id !== id) throw Error('Test session not found')
      state.phase = 'stopped'; state.reason = reason
    }),
    settle: (id, evidence, account) => locked(async (state, _enabled, client) => {
      const completed = state.history.find(item => item.id === id)
      if (completed) {
        if (!isDeepStrictEqual(completed.evidence, evidence)) throw Error('Test contradictory settlement')
        return completed.result
      }
      const pending = state.pending
      if (!pending?.signature || pending.id !== id || pending.signature !== evidence.signature ||
        !Number.isSafeInteger(evidence.slot) || evidence.slot < 1) throw Error('Test settlement evidence mismatch')
      const delta = BigInt(evidence.tokenDelta), buy = pending.record.direction === 'buy'
      if ((buy && delta < BigInt(pending.record.minimumAmountOut)) || (buy && delta <= 0n) ||
        (!buy && delta !== -BigInt(pending.record.amountIn))) throw Error('Test acquired token amount mismatch')
      const accounting = await account(client, pending)
      if (accounting?.status !== 'recorded') throw Error('Test accounting pending')
      const stopped = state.phase === 'stopped'
      const result = { state: 'finalized', step: state.step + 1, ...evidence, accounting, stopped }
      state.history.push({ ...pending, evidence, result })
      state.acquired = buy ? String(delta) : null
      state.step++
      state.pending = null
      state.phase = stopped ? 'stopped' : state.step === 6 ? 'completed' : 'ready'
      return result
    }),
  }
}
