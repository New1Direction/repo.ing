import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconcileEpisodes, reconcileKind, reconcileLagging, GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH,
  POOL_IDENTITY_MISMATCH, POOL_STATE_MISSING, RECONCILE_BEHIND_HOLD_MS, RECONCILE_BEHIND_MAX_MS, RECONCILE_HOLD_MS, RECONCILE_REPEAT_MS, RECONCILE_STALE_MS } from '../src/reconcile.mjs'

const MATCH = { status: 'MATCH', difference: 0n }
// The chain ahead of the ledger: fees from a trade the worker has not recorded yet. recordedEarned: what the ledger holds.
const behind = (difference = 5000n, recordedEarned = 100n) => ({ status: 'MISMATCH', difference, recordedEarned })
// The same while the worker keeps recording: the ledger holds more on every pass.
const trading = pass => behind(5000n, 100n + BigInt(pass))
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
  // A pool the chain does not have at all is no failed read either.
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: POOL_STATE_MISSING }), false)
  assert.equal(POOL_STATE_MISSING, 'Canonical Meteora pool state is missing')
  assert.equal(reconcileLagging(unread), true)
  assert.equal(reconcileLagging(ahead()), false)
  assert.equal(reconcileLagging(partner(9n, 5n)), false, 'more captured than the chain shows')
  assert.equal(reconcileLagging(withdrawal), false)
  // A pool that is there and is not this market's is no failed read.
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH }), false)
  assert.equal(reconcileLagging({ status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }), false)
  assert.equal(reconcileLagging(MATCH), false)
})

test('what a pass found is one of three kinds: behind, unchecked, or a difference a completed check found', () => {
  for (const result of [behind(), behind(1n), partner(5n, 9n), trading(3)]) assert.equal(reconcileKind(result), 'behind')
  for (const result of [unread, { status: 'UNAVAILABLE', reason: 'Meteora pool read failed: timeout' }, { status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' },
    { status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }]) assert.equal(reconcileKind(result), 'unchecked')
  for (const result of [ahead(), withdrawal, partner(9n, 5n), { status: 'MISMATCH' }, { status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH },
    { status: 'UNAVAILABLE', reason: POOL_STATE_MISSING }, { status: 'SOMETHING_NEW' }, undefined]) assert.equal(reconcileKind(result), 'difference')
})

test('a difference a completed check found alerts once it is seen again the hold later, with no match in between', () => {
  for (const state of [() => ahead(), () => withdrawal, () => partner(9n, 5n), () => ({ status: 'UNAVAILABLE', reason: POOL_IDENTITY_MISMATCH })]) {
    const { clock, began, episodes } = start()
    assert.equal(episodes.settle('7', state()), null, 'never on the first pass')
    assert.deepEqual(observe(episodes, clock, state, began + RECONCILE_HOLD_MS - 1), [], 'nor inside the hold')
    clock.at = began + RECONCILE_HOLD_MS
    const alert = episodes.settle('7', state())
    assert.deepEqual([alert.lagging, alert.since], [false, new Date(began).toISOString()])
    clock.at += PASS_MS
    assert.deepEqual(episodes.settle('7', state()), alert, 'the same alert on the next pass')
  }
})

test('a ledger that could not be checked alerts after the hold without one completed check', () => {
  for (const state of [() => unread, () => ({ status: 'ERROR', reason: 'EVIDENCE_UNAVAILABLE' }), () => ({ status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' })]) {
    const { clock, began, episodes } = start()
    assert.equal(episodes.settle('7', state()), null)
    assert.deepEqual(observe(episodes, clock, state, began + RECONCILE_HOLD_MS - 1), [])
    clock.at = began + RECONCILE_HOLD_MS
    const alert = episodes.settle('7', state())
    assert.deepEqual([alert.lagging, alert.since], [reconcileLagging(state()), new Date(began).toISOString()])
  }
  // Any completed check in between starts the count again, whatever it found: the ledger is being checked.
  for (const completed of [trading, () => ahead()]) {
    const { clock, began, episodes } = start()
    const raised = observe(episodes, clock, pass => pass % 10 === 9 ? completed(pass) : unread, began + 4 * 3_600_000)
    assert.deepEqual(raised.filter(alert => alert.lagging), [], 'never as a ledger that could not be checked')
  }
})

test('a ledger behind the chain while its fees keep being recorded is trading, not a problem', () => {
  const { clock, began, episodes } = start()
  // A market traded without a pause: every pass finds the chain ahead and the ledger further on than the pass before.
  assert.deepEqual(observe(episodes, clock, trading, began + RECONCILE_BEHIND_MAX_MS - 1), [])
  // Only a ledger that has not matched once in six hours is announced whatever it recorded.
  const [alert, ...more] = observe(episodes, clock, pass => trading(pass + 10_000), began + RECONCILE_BEHIND_MAX_MS + 2 * PASS_MS)
  assert.deepEqual([alert.lagging, alert.since, more.length], [true, new Date(began + PASS_MS).toISOString(), 0])
  // The partner side moving counts the same.
  const partnerSide = start()
  assert.deepEqual(observe(partnerSide.episodes, partnerSide.clock, pass => partner(BigInt(pass), BigInt(pass) + 4n), partnerSide.began + 3 * 3_600_000), [])
})

test('a ledger behind the chain with nothing recorded for an hour alerts: the indexer stopped, or missed a trade', () => {
  for (const state of [() => behind(), () => partner(5n, 9n), () => behind(1n)]) {
    const { clock, began, episodes } = start()
    assert.equal(episodes.settle('7', state()), null)
    assert.deepEqual(observe(episodes, clock, state, began + RECONCILE_BEHIND_HOLD_MS - 1), [], 'catching up after trades can take most of an hour')
    clock.at = began + RECONCILE_BEHIND_HOLD_MS
    const alert = episodes.settle('7', state())
    assert.deepEqual([alert.lagging, alert.since], [true, new Date(began).toISOString()])
  }
  // The hour counts from the last time the ledger moved: trading for ninety minutes with one trade's fees missed, then quiet.
  const { clock, began, episodes } = start()
  const quietFrom = began + 90 * 60_000
  const raised = observe(episodes, clock, (pass, at) => at < quietFrom ? trading(pass) : behind(5000n, 99_999n), began + 4 * 3_600_000)
  assert.equal(raised.length, 1)
  const stopped = began + PASS_MS * Math.ceil(90 * 60_000 / PASS_MS)
  assert.ok(clock.at >= stopped + RECONCILE_BEHIND_HOLD_MS)
  const again = start()
  assert.deepEqual(observe(again.episodes, again.clock, (pass, at) => at < again.began + 90 * 60_000 ? trading(pass) : behind(5000n, 99_999n), again.began + 90 * 60_000 + RECONCILE_BEHIND_HOLD_MS - PASS_MS), [],
    'not before the ledger has been still for the hour')
})

test('one bad read during a long run of trading is not a problem: what it showed must be seen again, or last', () => {
  // A failed read on one pass: the next completed check ends it.
  const failed = start()
  assert.deepEqual(observe(failed.episodes, failed.clock, pass => pass === 4 ? unread : trading(pass), failed.began + 3 * 3_600_000), [])
  // A stale read on one pass shows the ledger ahead of the chain: alone it is nothing.
  const stale = start()
  assert.deepEqual(observe(stale.episodes, stale.clock, pass => pass === 4 ? ahead() : trading(pass), stale.began + 3 * 3_600_000), [])
  // Seen again the hold later, in the same unmatched stretch, it is a difference.
  const twice = start()
  const raised = observe(twice.episodes, twice.clock, pass => pass === 4 || pass === 30 ? ahead() : trading(pass), twice.began + 3 * 3_600_000)
  assert.deepEqual(raised.map(alert => alert.lagging), [false])
  // A real difference that lag hides on most passes of a trading market still alerts at the hold.
  const hidden = start()
  const found = observe(hidden.episodes, hidden.clock, pass => pass % 4 ? trading(pass) : withdrawal, hidden.began + RECONCILE_HOLD_MS + 5 * PASS_MS)
  assert.deepEqual(found.map(alert => alert.lagging), [false])
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
  // Ledger ahead for five minutes, then behind for good with nothing recorded (the indexer stopped crediting).
  const raised = observe(episodes, clock, (_pass, at) => at - began < 5 * 60_000 ? ahead() : behind(), began + 36 * 3_600_000)
  assert.equal(raised.length, 6, 'an hour after the ledger stopped moving, then once per repeat period')
  assert.equal(raised[0].lagging, true)
  assert.ok(raised.every(alert => alert.since === raised[0].since))
})

test('a new episode is a new alert, even right after an earlier one of the same kind', () => {
  const { clock, began, episodes } = start()
  const first = observe(episodes, clock, () => ahead(), began + RECONCILE_HOLD_MS + PASS_MS)
  assert.equal(first.length, 1)
  assert.equal(episodes.settle('7', MATCH), null)
  const resumed = clock.at
  assert.deepEqual(observe(episodes, clock, () => ahead(), resumed + RECONCILE_HOLD_MS - 1), [], 'its own hold')
  const second = observe(episodes, clock, () => ahead(), resumed + RECONCILE_HOLD_MS + 2 * PASS_MS)
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
  assert.equal(episodes.settle('7', unread), null)
  // No pass reaches the ledger for longer than the hold.
  clock.at = began + RECONCILE_HOLD_MS + RECONCILE_STALE_MS + 1
  const resumed = clock.at
  assert.equal(episodes.settle('7', unread), null, 'a new hold starts')
  assert.deepEqual(observe(episodes, clock, () => unread, resumed + RECONCILE_HOLD_MS - 1), [])
  clock.at = resumed + RECONCILE_HOLD_MS
  assert.equal(episodes.settle('7', unread).since, new Date(resumed).toISOString())
  // A gap of exactly the stale limit keeps the episode.
  const kept = start()
  kept.episodes.settle('7', unread)
  kept.clock.at = kept.began + RECONCILE_STALE_MS
  kept.episodes.settle('7', unread)
  kept.clock.at = kept.began + RECONCILE_HOLD_MS
  assert.equal(kept.episodes.settle('7', unread).since, new Date(kept.began).toISOString())
})

test('the holds are longer than the slowest fee indexing seen, and a pass must reach a ledger more often than the stale limit', () => {
  assert.ok(RECONCILE_HOLD_MS >= 15 * 60_000)
  // Measured on the busiest market over five days: behind without a break for at most about 30 minutes.
  assert.ok(RECONCILE_BEHIND_HOLD_MS >= 2 * 30 * 60_000)
  assert.ok(RECONCILE_STALE_MS >= 5 * PASS_MS && RECONCILE_STALE_MS < RECONCILE_HOLD_MS)
  assert.ok(RECONCILE_REPEAT_MS >= 4 * RECONCILE_BEHIND_HOLD_MS)
  // A ledger that never matches is announced by the time its first repeat would be.
  assert.ok(RECONCILE_BEHIND_MAX_MS >= RECONCILE_BEHIND_HOLD_MS && RECONCILE_BEHIND_MAX_MS <= RECONCILE_REPEAT_MS)
})

test('a problem that changes kind inside one episode is announced as the new kind, not held for the repeat', () => {
  // Reads fail for twenty minutes, then the chain answers and the ledger is ahead of it, with no match in between.
  const { clock, began, episodes } = start()
  const raised = observe(episodes, clock, (_pass, at) => at - began <= 20 * 60_000 ? unread : ahead(), began + 2 * 3_600_000)
  assert.deepEqual(raised.map(alert => [alert.kind, alert.lagging, alert.repeat]), [['unchecked', true, false], ['difference', false, false]])
  assert.equal(new Set(raised.map(alert => alert.since)).size, 1, 'one episode')
  assert.deepEqual(raised.map(alert => alert.key), [`${began + PASS_MS}:unchecked:0`, `${began + PASS_MS}:difference:0`])
  // Behind with nothing recorded, then a real difference: the same.
  const other = start()
  const later = observe(other.episodes, other.clock, (_pass, at) => at - other.began <= 90 * 60_000 ? behind() : withdrawal, other.began + 3 * 3_600_000)
  assert.deepEqual(later.map(alert => alert.kind), ['behind', 'difference'])
})

test('an alert says whether its kind was already announced in this episode', () => {
  const { clock, began, episodes } = start()
  const raised = observe(episodes, clock, () => withdrawal, began + 2 * RECONCILE_REPEAT_MS + RECONCILE_HOLD_MS)
  assert.deepEqual(raised.map(alert => [alert.kind, alert.repeat]), [['difference', false], ['difference', true], ['difference', true]])
  // A kind that first shows in a later period is new then, and a repeat only after that.
  const late = start()
  const mixed = observe(late.episodes, late.clock, (_pass, at) => at - late.began <= RECONCILE_REPEAT_MS + 3_600_000 ? unread : withdrawal, late.began + 3 * RECONCILE_REPEAT_MS)
  assert.deepEqual(mixed.map(alert => [alert.kind, alert.repeat]),
    [['unchecked', false], ['unchecked', true], ['difference', false], ['difference', true]])
  // Asked again in the same period, an alert is the same alert: storing it failed, or a second pass saw it.
  const again = start()
  observe(again.episodes, again.clock, () => withdrawal, again.began + RECONCILE_HOLD_MS + PASS_MS)
  const first = again.episodes.settle('7', withdrawal)
  again.clock.at += PASS_MS
  assert.deepEqual(again.episodes.settle('7', withdrawal), first)
  assert.equal(first.repeat, false)
})

test('the stale limit can follow the pass cadence: slow passes must not end every episode on every pass', () => {
  const SLOW_PASS_MS = 13 * 60_000
  const slow = (staleMs) => {
    const clock = { at: 1_000_000 }, episodes = createReconcileEpisodes({ now: () => clock.at, staleMs }), raised = new Map()
    for (let pass = 0; pass < 20; pass++) {
      clock.at += SLOW_PASS_MS
      const alert = episodes.settle('7', withdrawal)
      if (alert) raised.set(alert.key, alert)
    }
    return raised.size
  }
  assert.equal(slow(RECONCILE_STALE_MS), 0, 'with the fixed limit every pass starts a new episode')
  assert.ok(slow(() => 3 * SLOW_PASS_MS) >= 1, 'a limit above the cadence keeps the episode')
})
