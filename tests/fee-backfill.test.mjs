import test from 'node:test'
import assert from 'node:assert/strict'
import { discoverFeeBackfill, replayFeeBackfill } from '../src/fee-backfill.mjs'

const market = { githubRepoId: '42', pool: 'So11111111111111111111111111111111111111112', launchSignature: 'launch' }
const item = (signature, slot, err = null) => ({ signature, slot, err, confirmationStatus: 'finalized' })
test('bounded discovery includes launch, excludes future and failed transactions, never uses cursor', async () => {
  const calls = []
  const connection = { getSignaturesForAddress: async (...args) => {
    calls.push(args)
    return calls.length === 1 ? [item('future', 12), item('trade', 10), item('failed', 9, {})] : [item('launch', 8)]
  } }
  const history = await discoverFeeBackfill({ connection, market, throughSlot: 10 })
  assert.deepEqual(history.signatures.map(i => i.signature), ['launch', 'trade'])
  assert.equal(calls[0][2], 'finalized')
  assert.equal(calls[1][1].before, 'failed')
})
test('missing launch, repeated pages, invalid finality and exhausted bounds fail closed', async () => {
  for (const pages of [[[]], [[item('x', 1)], []], [[item('x', 1)], [item('x', 1)]],
    [[{ ...item('launch', 1), confirmationStatus: 'confirmed' }]], [[item('launch', 11)]]]) {
    await assert.rejects(discoverFeeBackfill({ connection: { getSignaturesForAddress: async () => pages.shift() ?? [] },
      market, throughSlot: 10, maxPages: 2 }))
  }
})
test('replay delegates exact signatures to canonical writer and reports writer dedup, not gap credits', async () => {
  const seen = new Set(), calls = []
  const accrual = { recordTradeFees: async args => {
    calls.push(args)
    const signature = args.signatures[0], fresh = !seen.has(signature)
    seen.add(signature)
    return { creditedBaseUnits: fresh ? 7n : 0n, eventKeys: [`${signature}:0:dbc_creator_quote`] }
  } }
  const history = { complete: true, githubRepoId: '42', throughSlot: 10,
    signatures: [item('trade', 10), item('trade', 10)] }
  assert.equal((await replayFeeBackfill({ history, accrual })).creditedBaseUnits, 7n)
  assert.equal((await replayFeeBackfill({ history, accrual })).creditedBaseUnits, 0n)
  assert.deepEqual(calls[0], { githubRepoId: '42', signatures: ['trade'], allowNonSwap: true })
  await assert.rejects(replayFeeBackfill({ history: { ...history, complete: false }, accrual }))
  await assert.rejects(replayFeeBackfill({ history: { ...history, signatures: [item('future', 11)] }, accrual }))
  assert.equal(calls.length, 2)
})
