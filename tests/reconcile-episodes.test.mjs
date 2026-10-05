import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconcileEpisodes, reconcileLagging, GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH,
  POOL_IDENTITY_MISMATCH, RECONCILE_HOLD_MS, RECONCILE_REPEAT_MS, RECONCILE_STALE_MS } from '../src/reconcile.mjs'

const MATCH = { status: 'MATCH', difference: 0n }
// The chain ahead of the ledger: fees from a trade the worker has not recorded yet.
const behind = (difference = 5000n) => ({ status: 'MISMATCH', difference })
// The ledger ahead of the chain: never a moment's lag.
const ahead = (difference = -5000n) => ({ status: 'MISMATCH', difference })
const partner = (earned, onchainEarned, claimed = 0n) => ({ status: 'MISMATCH', reason: PARTNER_CAPTURE_MISMATCH, onchainCreatorFee: 10n, expectedRemaining: 10n,
  platform: { earned, claimed, onchainEarned, onchainClaimed: 0n } })
const withdrawal = { status: 'MISMATCH', reason: GRADUATED_WITHDRAWAL_MISMATCH }
const unread = { status: 'UNAVAILABLE', reason: 'RPC_UNAVAILABLE' }
const PASS_MS = 80_000
// One ledger settled every pass, as the monitor does, from `from` to `until`. Returns every alert raised, by key.
function observe(episodes, clock, state, until, key = '7') {
  const raised = new Map()
  for (let pass = 0; clock.at < until; pass++) {
    clock.at = Math.min(until, clock.at + PASS_MS)
    const alert = episodes.settle(key, state(pass, clock.at))
    if (alert) raised.set(alert.key, alert)
  }
  return [...raised.values()]
}
const start = () => { const clock = { at: 1_000_000 }; return { clock, began: clock.at, episodes: createReconcileEpisodes({ now: () => clock.at }) } }

test('a ledger behind the chain, a claim in flight and a failed read normally clear by themselves; anything else does not', () => {
  assert.equal(reconcileLagging(behind()), true)
  assert.equal(reconcileLagging(partner(5n, 9n)), true, 'partner fees earned on-chain and not captured yet')
  assert.equal(reconcileLagging({ status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }), true)
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: 'Meteora pool read failed: timeout' }), true)
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: 'Canonical Meteora pool state is missing' }), true)
  assert.equal(reconcileLagging(unread), true)
  assert.equal(reconcileLagging(ahead()), false)
  assert.equal(reconcileLagging(partner(9n, 5n)), false, 'more captured than the chain shows')
  assert.equal(reconcileLagging(withdrawal), false)
  // A pool that is there and is not this market's is no failed read.
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH }), false)
  assert.equal(reconcileLagging({ status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }), false)
  assert.equal(reconcileLagging(MATCH), false)
})

test('a ledger alerts once it has stayed unmatched for the hold, whatever kept it from matching', () => {
  for (const state of [behind, ahead, () => withdrawal, () => unread, () => ({ status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }), () => ({ status: 'PENDING_REVIEW' })]) {
    const { clock, began, episodes } = start()
    assert.equal(episodes.settle('7', state()), null, 'never on the first pass')
    assert.deepEqual(observe(episodes, clock, state, began + RECONCILE_HOLD_MS - 1), [], 'nor inside the hold')
    clock.at = began + RECONCILE_HOLD_MS
    const alert = episodes.settle('7', state())
    assert.equal(alert.since, new Date(began).toISOString())
    assert.equal(alert.lagging, reconcileLagging(state()))
    clock.at += PASS_MS
    assert.deepEqual(episodes.settle('7', state()), alert, 'the same alert on the next pass')
  }
})

test('a ledger that matches again inside the hold never alerts, however often that happens', () => {
  const { clock, began, episodes } = start()
  // Wrong for several passes, right for one, all day: lag after trades, a lagging RPC node, a read that fails now and then.
  const day = observe(episodes, clock, pass => pass % 8 === 7 ? MATCH : [behind(), ahead(), unread, withdrawal][pass % 4], began + 24 * 3_600_000)
  assert.deepEqual(day, [])
})

test('one alert per episode, however its state changes between passes', () => {
  const states = [withdrawal, partner(5n, 9n), behind(3n), ahead(-5n), unread, partner(9n, 5n, 3n), { status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }, behind(900n)]
  const { clock, began, episodes } = start()
  const raised = observe(episodes, clock, pass => states[pass % states.length], began + 3 * 3_600_000)
  assert.equal(raised.length, 1)
  assert.equal(raised[0].since, new Date(began + PASS_MS).toISOString())
})

test('a real mismatch followed by lag that never clears still alerts: nothing about an episode silences its later states', () => {
  const { clock, began, episodes } = start()
  // Ledger ahead for five minutes, then plain lag for good (the indexer stopped crediting, or a claim is stuck).
  const raised = observe(episodes, clock, (_pass, at) => at - began < 5 * 60_000 ? ahead() : behind(), began + 36 * 3_600_000)
  assert.equal(raised.length, 6, 'at the hold, then once per repeat period')
  assert.equal(raised[0].lagging, true)
  assert.ok(raised.every(alert => alert.since === raised[0].since))
})

test('a new episode is a new alert, even right after an earlier one of the same kind', () => {
  const { clock, began, episodes } = start()
  const first = observe(episodes, clock, ahead, began + RECONCILE_HOLD_MS + PASS_MS)
  assert.equal(first.length, 1)
  assert.equal(episodes.settle('7', MATCH), null)
  const resumed = clock.at
  assert.deepEqual(observe(episodes, clock, ahead, resumed + RECONCILE_HOLD_MS - 1), [], 'its own hold')
  const second = observe(episodes, clock, ahead, resumed + RECONCILE_HOLD_MS + 2 * PASS_MS)
  assert.equal(second.length, 1)
  assert.notEqual(second[0].key, first[0].key)
  assert.equal(second[0].since, new Date(resumed + PASS_MS).toISOString())
})

test('an episode that lasts is announced again once per repeat period, with its first time', () => {
  const { clock, began, episodes } = start()
  const raised = observe(episodes, clock, () => withdrawal, began + 2 * RECONCILE_REPEAT_MS + RECONCILE_HOLD_MS)
  assert.equal(raised.length, 3)
  assert.equal(new Set(raised.map(alert => alert.since)).size, 1)
  assert.equal(new Set(raised.map(alert => alert.key)).size, 3)
})

test('ledgers are held apart, and a restarted worker starts its hold again instead of alerting at once', () => {
  const { clock, began, episodes } = start()
  observe(episodes, clock, () => withdrawal, began + RECONCILE_HOLD_MS + PASS_MS)
  assert.equal(episodes.settle('8', withdrawal), null, "another ledger's clock is its own")
  assert.notEqual(episodes.settle('7', withdrawal), null)
  const restarted = createReconcileEpisodes({ now: () => clock.at })
  assert.equal(restarted.settle('7', withdrawal), null)
  const again = clock.at
  assert.equal(observe(restarted, clock, () => withdrawal, again + RECONCILE_HOLD_MS + PASS_MS).length, 1)
})

test('an episode nobody has settled for a while is over: what happened before an outage does not alert the moment passes resume', () => {
  const { clock, began, episodes } = start()
  assert.equal(episodes.settle('7', behind()), null)
  // No pass reaches the ledger for longer than the hold.
  clock.at = began + RECONCILE_HOLD_MS + RECONCILE_STALE_MS + 1
  const resumed = clock.at
  assert.equal(episodes.settle('7', behind()), null, 'a new hold starts')
  assert.deepEqual(observe(episodes, clock, behind, resumed + RECONCILE_HOLD_MS - 1), [])
  clock.at = resumed + RECONCILE_HOLD_MS
  assert.equal(episodes.settle('7', behind()).since, new Date(resumed).toISOString())
  // A gap of exactly the stale limit keeps the episode.
  const kept = start()
  kept.episodes.settle('7', behind())
  kept.clock.at = kept.began + RECONCILE_STALE_MS
  kept.episodes.settle('7', behind())
  kept.clock.at = kept.began + RECONCILE_HOLD_MS
  assert.equal(kept.episodes.settle('7', behind()).since, new Date(kept.began).toISOString())
})

test('the hold is longer than the slowest fee indexing seen, and a pass must reach a ledger more often than the stale limit', () => {
  assert.ok(RECONCILE_HOLD_MS >= 15 * 60_000)
  assert.ok(RECONCILE_STALE_MS >= 5 * PASS_MS && RECONCILE_STALE_MS < RECONCILE_HOLD_MS)
  assert.ok(RECONCILE_REPEAT_MS >= 4 * RECONCILE_HOLD_MS)
})
