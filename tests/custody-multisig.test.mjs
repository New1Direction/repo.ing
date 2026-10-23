import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import * as custody from '../src/custody-multisig.mjs'
import { governanceFixture } from './custody-evidence-fixture.mjs'

test('offline Squads preparation binds exact message, index, distinct approved members and vault zero', () => {
  assert.equal(typeof custody.prepareCustodyMultisig, 'function')
  const vault = new PublicKey('3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs')
  const plan = custody.prepareCustodyMultisig({ instructions: [SystemProgram.transfer({ fromPubkey: vault,
    toPubkey: new PublicKey(Buffer.alloc(32, 8)), lamports: 1 })], transactionIndex: 1n,
    creator: custody.CUSTODY_MEMBERS[0], rentPayer: custody.CUSTODY_MEMBERS[0],
    approvers: custody.CUSTODY_MEMBERS.slice(0, 2), executor: custody.CUSTODY_MEMBERS[1] })
  assert.equal(plan.approveInstructions.length, 2)
  assert.equal(plan.vaultIndex, 0)
  assert.equal(plan.executeInstruction.programId.toBase58(), custody.SQUADS_PROGRAM)
  assert.equal(plan.messageBytes[0], 1)
  assert.throws(() => custody.prepareCustodyMultisig({ ...plan, approvers: [custody.CUSTODY_MEMBERS[0], custody.CUSTODY_MEMBERS[0]] }))
  const proof = governanceFixture(plan)
  assert.equal(custody.validateCustodyGovernance({ plan, proof, slot: 50 }).vaultControlVerified, true)
  for (const mutate of [
    p => { p.multisig.data.writeUInt16LE(1, 72) },
    p => { p.multisig.data[40] = 1 },
    p => { p.multisig.data[164] = 3 },
    p => { p.transaction.data[81] = 1 },
    p => { p.transaction.data[p.transaction.data.length - 5] ^= 1 },
    p => { p.proposal.data.copy(p.proposal.data, 94, 62, 94) },
    p => { p.proposal.data[48] = 3 },
    p => { p.proposal.address = custody.CUSTODY_MULTISIG },
    p => { p.spendingLimits.push({}) },
    p => { p.spendingLimitsComplete = false },
    p => { p.slot++ },
  ]) {
    const bad = governanceFixture(plan); mutate(bad)
    assert.throws(() => custody.validateCustodyGovernance({ plan, proof: bad, slot: 50 }))
  }
})
