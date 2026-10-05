import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconcileEpisodes, reconcileLagging, reconcileMismatchKind, GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH,
  POOL_IDENTITY_MISMATCH, RECONCILE_LAG_MS, RECONCILE_REPEAT_MS, RECONCILE_STALE_MS } from '../src/reconcile.mjs'

const MATCH = { status: 'MATCH', difference: 0n }
// The chain ahead of the ledger: fees from a trade the worker has not recorded yet.
const behind = (difference = 5000n) => ({ status: 'MISMATCH', difference })
// The ledger ahead of the chain: never a moment's lag.
const ahead = (difference = -5000n) => ({ status: 'MISMATCH', difference })
const partner = (earned, onchainEarned, claimed = 0n) => ({ status: 'MISMATCH', reason: PARTNER_CAPTURE_MISMATCH, onchainCreatorFee: 10n, expectedRemaining: 10n,
  platform: { earned, claimed, onchainEarned, onchainClaimed: 0n } })
const withdrawal = { status: 'MISMATCH', reason: GRADUATED_WITHDRAWAL_MISMATCH }
const PASS_MS = 80_000
// One market observed every pass, as the monitor does, until the clock reaches `until`. Returns the last answer.
function observe(episodes, clock, state, until) {
  let last = null
  while (clock.at < until) { clock.at = Math.min(until, clock.at + PASS_MS); last = episodes.settle('7', state()) }
  return last
}
// The distinct alerts a market raises over consecutive passes.
function alertsOver(states, { passes = 90 } = {}) {
  const clock = { at: 0 }, episodes = createReconcileEpisodes({ now: () => clock.at }), keys = new Set()
  for (let pass = 0; pass < passes; pass++, clock.at += PASS_MS) {
    const alert = episodes.settle('7', states(pass))
    if (alert) keys.add(alert.key)
  }
  return keys.size
}

test('a ledger behind the chain, a claim in flight and a failed read may be lag; anything else is a real mismatch', () => {
  assert.equal(reconcileLagging(behind()), true)
  assert.equal(reconcileLagging(partner(5n, 9n)), true, 'partner fees earned on-chain and not captured yet')
  assert.equal(reconcileLagging({ status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }), true)
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: 'Meteora pool read failed: timeout' }), true)
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: 'Canonical Meteora pool state is missing' }), true)
  assert.equal(reconcileLagging(ahead()), false)
  assert.equal(reconcileLagging(partner(9n, 5n)), false, 'more captured than the chain shows')
  assert.equal(reconcileLagging(withdrawal), false)
  // A pool that is there and is not this market's is no failed read.
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH }), false)
  assert.equal(reconcileLagging({ status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }), false)
  assert.equal(reconcileLagging(MATCH), false)
})

test('lag alerts once, and only after it has lasted; a match ends the episode', () => {
  const clock = { at: 1_000_000 }, start = clock.at, episodes = createReconcileEpisodes({ now: () => clock.at })
  assert.equal(episodes.settle('7', behind(1n)), null)
  // Inside the hold, whatever the amount; a failed read in the same stretch does not restart the clock.
  let pass = 0
  assert.equal(observe(episodes, clock, () => pass++ % 2 ? { status: 'UNAVAILABLE' } : behind(BigInt(pass)), start + RECONCILE_LAG_MS - 1), null)
  clock.at = start + RECONCILE_LAG_MS
  const first = episodes.settle('7', behind(3n))
  assert.equal(first.lagging, true)
  assert.equal(first.since, new Date(start).toISOString())
  clock.at += PASS_MS
  assert.deepEqual(episodes.settle('7', behind(9n)), first, 'the same alert while it lasts')
  assert.equal(episodes.settle('7', MATCH), null)
  assert.equal(episodes.settle('7', behind(1n)), null, 'a new episode starts its own hold')
  assert.equal(episodes.settle('8', behind(1n)), null, "another market's clock is its own")
})

test('a real mismatch alerts at once; another kind alerts once more; lag turning real does not wait', () => {
  const clock = { at: 5_000 }, episodes = createReconcileEpisodes({ now: () => clock.at })
  const first = episodes.settle('7', ahead(-10n))
  assert.equal(first.lagging, false)
  assert.equal(first.since, new Date(5_000).toISOString())
  clock.at += PASS_MS
  assert.deepEqual(episodes.settle('7', ahead(-25n)), first, 'trades moving the amounts do not repeat it')
  const other = episodes.settle('7', partner(9n, 5n))
  assert.equal(other.lagging, false)
  assert.notEqual(other.key, first.key)
  assert.equal(episodes.settle('9', behind()), null)
  assert.equal(episodes.settle('9', ahead()).lagging, false)
})

test('a lasting mismatch on a trading market is one alert, however its state flickers between passes', () => {
  // Lag beside a withdrawal difference: any partner lag is reported first by the reconciler, so every trade flips the state.
  assert.equal(alertsOver(pass => pass % 3 === 2 ? partner(5n, 9n) : withdrawal), 1)
  // A ledger slightly ahead, which each trade's unrecorded fees push the other way for a pass.
  assert.equal(alertsOver(pass => pass % 2 ? behind(3n) : ahead(-5n)), 1)
  // A read that fails every other pass.
  assert.equal(alertsOver(pass => pass % 2 ? { status: 'UNAVAILABLE' } : ahead()), 1)
  // Two kinds of real mismatch taking turns are two alerts, not one per turn.
  assert.equal(alertsOver(pass => pass % 2 ? partner(9n, 5n, 3n) : partner(5n, 5n, 3n)), 2)
  // Plain lag that clears between passes, as on a busy market, is none.
  assert.equal(alertsOver(pass => pass % 4 ? MATCH : behind()), 0)
})

test('a mismatch that persists is announced again once per repeat period, with its first time', () => {
  const clock = { at: RECONCILE_REPEAT_MS * 10 + 60_000 }, episodes = createReconcileEpisodes({ now: () => clock.at })
  const first = episodes.settle('7', withdrawal)
  assert.deepEqual(observe(episodes, clock, () => withdrawal, RECONCILE_REPEAT_MS * 11 - 1), first)
  clock.at = RECONCILE_REPEAT_MS * 11
  const again = episodes.settle('7', withdrawal)
  assert.notEqual(again.key, first.key)
  assert.equal(again.since, first.since)
})

test('a restarted or second worker raises the same alert, not another', () => {
  const at = () => RECONCILE_REPEAT_MS * 3 + 1000
  assert.deepEqual(createReconcileEpisodes({ now: at }).settle('7', withdrawal), createReconcileEpisodes({ now: at }).settle('7', withdrawal))
  assert.notEqual(createReconcileEpisodes({ now: at }).settle('7', withdrawal).key, createReconcileEpisodes({ now: at }).settle('7', ahead()).key)
})

test('an episode nobody has observed for a while is over: lag from before an outage does not alert the moment passes resume', () => {
  const clock = { at: 0 }, episodes = createReconcileEpisodes({ now: () => clock.at })
  assert.equal(episodes.settle('7', behind()), null)
  // The market's passes fail before they reach its ledger, for longer than the hold.
  clock.at += RECONCILE_LAG_MS + RECONCILE_STALE_MS
  const resumed = clock.at
  assert.equal(episodes.settle('7', behind()), null, 'a new hold starts')
  assert.equal(observe(episodes, clock, behind, resumed + RECONCILE_LAG_MS - 1), null)
  clock.at = resumed + RECONCILE_LAG_MS
  assert.equal(episodes.settle('7', behind()).since, new Date(resumed).toISOString())
})

test('the kind of a mismatch ignores amounts and keeps the direction and the reason', () => {
  assert.equal(reconcileMismatchKind(ahead(-1n)), reconcileMismatchKind(ahead(-999n)))
  assert.notEqual(reconcileMismatchKind(ahead(-1n)), reconcileMismatchKind(behind(1n)))
  assert.equal(reconcileMismatchKind(partner(9n, 5n)), reconcileMismatchKind(partner(90n, 50n)))
  assert.notEqual(reconcileMismatchKind(partner(9n, 5n)), reconcileMismatchKind(withdrawal))
  // Results read back from JSON (amounts as text) classify the same way.
  assert.equal(reconcileMismatchKind({ status: 'MISMATCH', difference: '-10' }), reconcileMismatchKind(ahead()))
})

test('a caller can supply its own kind, as the platform ledgers do', () => {
  const episodes = createReconcileEpisodes({ now: () => 0 })
  const first = episodes.settle('protocol', { status: 'MISMATCH' }, () => 'revenue')
  assert.deepEqual(episodes.settle('protocol', { status: 'MISMATCH' }, () => 'revenue'), first)
  assert.notEqual(episodes.settle('protocol', { status: 'MISMATCH' }, () => 'liquidity').key, first.key)
})
