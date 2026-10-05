import test from 'node:test'
import assert from 'node:assert/strict'
import { createReconcileEpisodes, reconcileLagging, reconcileMismatchKind, GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH, RECONCILE_LAG_MS } from '../src/reconcile.mjs'

const MATCH = { status: 'MATCH', difference: 0n }
// The chain ahead of the ledger: fees from a trade the worker has not recorded yet.
const behind = (difference = 5000n) => ({ status: 'MISMATCH', difference })
// The ledger ahead of the chain: never a moment's lag.
const ahead = (difference = -5000n) => ({ status: 'MISMATCH', difference })
const partner = (earned, onchainEarned) => ({ status: 'MISMATCH', reason: PARTNER_CAPTURE_MISMATCH, onchainCreatorFee: 10n, expectedRemaining: 10n,
  platform: { earned, claimed: 0n, onchainEarned, onchainClaimed: 0n } })

test('a ledger behind the chain, a claim in flight and a failed read may be lag; anything else is a real mismatch', () => {
  assert.equal(reconcileLagging(behind()), true)
  assert.equal(reconcileLagging(partner(5n, 9n)), true, 'partner fees earned on-chain and not captured yet')
  assert.equal(reconcileLagging({ status: 'PENDING_REVIEW', reason: '1 unresolved claim intent(s)' }), true)
  assert.equal(reconcileLagging({ status: 'UNAVAILABLE', reason: 'Meteora pool read failed: timeout' }), true)
  assert.equal(reconcileLagging(ahead()), false)
  assert.equal(reconcileLagging(partner(9n, 5n)), false, 'more captured than the chain shows')
  assert.equal(reconcileLagging({ status: 'MISMATCH', reason: GRADUATED_WITHDRAWAL_MISMATCH }), false)
  assert.equal(reconcileLagging(MATCH), false)
})

test('lag alerts once, and only after it has lasted; a match ends the episode', () => {
  let clock = 1_000_000
  const episodes = createReconcileEpisodes({ now: () => clock })
  assert.equal(episodes.settle('7', behind(1n)), null)
  clock += RECONCILE_LAG_MS - 1
  assert.equal(episodes.settle('7', behind(2n)), null, 'inside the hold, whatever the amount')
  // A claim in flight or a failed read in the same stretch does not restart the clock.
  assert.equal(episodes.settle('7', { status: 'UNAVAILABLE' }), null)
  clock += 1
  const first = episodes.settle('7', behind(3n))
  assert.equal(first.lagging, true)
  assert.equal(first.since, new Date(1_000_000).toISOString())
  clock += 60_000
  assert.deepEqual(episodes.settle('7', behind(9n)), first, 'the same alert key for as long as the episode lasts')
  assert.equal(episodes.settle('7', MATCH), null)
  assert.equal(episodes.settle('7', behind(1n)), null, 'a new episode starts its own hold')
  assert.equal(episodes.settle('8', behind(1n)), null, "another market's clock is its own")
})

test('a real mismatch alerts at once and once per kind; trades moving the amounts do not repeat it', () => {
  let clock = 5_000
  const episodes = createReconcileEpisodes({ now: () => clock })
  const first = episodes.settle('7', ahead(-10n))
  assert.equal(first.lagging, false)
  assert.equal(first.since, new Date(5_000).toISOString())
  clock += 30_000
  assert.deepEqual(episodes.settle('7', ahead(-25n)), first)
  // Another kind of mismatch is a new episode with its own alert.
  const other = episodes.settle('7', partner(9n, 5n))
  assert.equal(other.lagging, false)
  assert.notEqual(other.key, first.key)
  // Lag that turns into a real mismatch alerts without waiting out the hold.
  assert.equal(episodes.settle('9', behind()), null)
  assert.equal(episodes.settle('9', ahead()).lagging, false)
  // A fresh process (a deploy) starts new episodes: its keys never collide with an earlier process's.
  assert.notEqual(createReconcileEpisodes({ now: () => clock }).settle('7', ahead(-10n)).key, first.key)
})

test('the kind of a mismatch ignores amounts and keeps the direction and the reason', () => {
  assert.equal(reconcileMismatchKind(ahead(-1n)), reconcileMismatchKind(ahead(-999n)))
  assert.notEqual(reconcileMismatchKind(ahead(-1n)), reconcileMismatchKind(behind(1n)))
  assert.equal(reconcileMismatchKind(partner(9n, 5n)), reconcileMismatchKind(partner(90n, 50n)))
  assert.notEqual(reconcileMismatchKind(partner(9n, 5n)), reconcileMismatchKind({ status: 'MISMATCH', reason: GRADUATED_WITHDRAWAL_MISMATCH }))
  // Results read back from JSON (amounts as text) classify the same way.
  assert.equal(reconcileMismatchKind({ status: 'MISMATCH', difference: '-10' }), reconcileMismatchKind(ahead()))
})

test('a caller can supply its own kind, as the protocol ledgers do', () => {
  const episodes = createReconcileEpisodes({ now: () => 0 })
  const first = episodes.settle('protocol', { status: 'MISMATCH' }, () => 'revenue')
  assert.deepEqual(episodes.settle('protocol', { status: 'MISMATCH' }, () => 'revenue'), first)
  assert.notEqual(episodes.settle('protocol', { status: 'MISMATCH' }, () => 'liquidity').key, first.key)
})
