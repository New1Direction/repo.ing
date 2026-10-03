import test from 'node:test'
import assert from 'node:assert/strict'
import { chainAheadOfLedger, GRADUATED_WITHDRAWAL_MISMATCH, PARTNER_CAPTURE_MISMATCH } from '../src/reconcile.mjs'

const platform = (earned, onchainEarned, claimed = 5n, onchainClaimed = claimed) => ({ earned, claimed, onchainEarned, onchainClaimed })

test('creator fees on chain above what the ledger expects are indexing lag; below it they are not', () => {
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: 12n, platform: null }), true)
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: '12', platform: null }), true, 'string amounts too')
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: -12n, platform: null }), false)
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: 9n, platform: platform(100n, 100n) }), true)
})

test('partner fees earned on chain above those captured are lag, only with equal claims and the creator side not behind', () => {
  const partner = (p, onchainCreatorFee = 20n, expectedRemaining = 20n) =>
    chainAheadOfLedger({ status: 'MISMATCH', reason: PARTNER_CAPTURE_MISMATCH, difference: null, onchainCreatorFee, expectedRemaining, platform: p })
  assert.equal(partner(platform(100n, 130n)), true)
  assert.equal(partner(platform(100n, 130n), 25n, 20n), true, 'creator fees ahead as well')
  assert.equal(partner(platform(100n, 130n), 15n, 20n), false, 'creator side behind the ledger')
  assert.equal(partner(platform(130n, 100n)), false, 'ledger ahead of the chain')
  assert.equal(partner(platform(100n, 130n, 5n, 9n)), false, 'claims differ')
  assert.equal(partner(platform(100n, 100n)), false, 'nothing ahead')
  assert.equal(partner(null), false)
})

test('a withdrawal difference, other statuses and malformed results are never lag', () => {
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', reason: GRADUATED_WITHDRAWAL_MISMATCH, difference: null, platform: platform(100n, 100n) }), false)
  for (const status of ['MATCH', 'UNAVAILABLE', 'PENDING_REVIEW']) assert.equal(chainAheadOfLedger({ status, difference: 12n }), false, status)
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: 'n/a' }), false)
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: 3n, platform: platform(100n, 'n/a') }), false)
  assert.equal(chainAheadOfLedger(null), false)
})
