import test from 'node:test'
import assert from 'node:assert/strict'
import { builderClaimMessage, builderClaimTicket, packBuilderMessage, packBuilderTicket } from '../src/credits-tickets.mjs'
import { assertionMessage } from '../src/repo-inference-handoff.mjs'

// The same vectors as repo-inference src/builder_shares.rs: both sides sign and check the same text.
const SECRET = 'handoff-assertion-vector-secret-0123456789'
const AT = '2026-10-11T12:00:00.000Z'

test('pack and claim tickets match the ledger\'s vectors', () => {
  const pack = { idempotencyKey: 'pack-vector-key-0001', githubUserId: '583231', repoId: '1296269', shareBps: 1000, issuedAt: AT }
  assert.equal(packBuilderMessage(pack), 'repoing-pack-builder-v1\nrepo-inference\npack-vector-key-0001\n583231\n1296269\n1000\n2026-10-11T12:00:00.000Z')
  assert.deepEqual(packBuilderTicket(SECRET, pack), { repo_id: '1296269', share_bps: 1000, issued_at: AT,
    signature: '43c7e79e4dc5e91b4d969660f6553264bfbd71b44c8e972349a18f0d767b8000' })
  const claim = { idempotencyKey: 'claim-vector-key-0001', githubUserId: '583231', repoId: '1296269', issuedAt: AT }
  assert.deepEqual(builderClaimTicket(SECRET, claim), { issued_at: AT, signature: '9acccff999f19885742ce75e7b66baf85d6800734d4f99fa3805d93b9e17547b' })
  // Never the handoff assertion's text: a ticket cannot pass for an assertion.
  assert.notEqual(builderClaimMessage(claim).split('\n')[0], assertionMessage({ handoffId: 'h', githubUserId: '1', login: 'l', repoId: '1', permission: 'admin', verifiedAt: AT }).split('\n')[0])
})
