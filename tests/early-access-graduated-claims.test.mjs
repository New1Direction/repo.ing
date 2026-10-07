import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { assertGraduatedClaimInstructions, graduatedClaimInstructions } from '../src/claim.mjs'
import { claimAmounts, earlyAccessClaimAmounts } from '../src/claim-amounts.mjs'

// Step 7c (docs/EARLY_ACCESS.md): a graduated early access market's builder claim. The DAMM v2 claim with token A on Token-2022 is
// checked exactly before it is signed; a payout claims either the curve part or the DAMM v2 part, never both. On chain:
// tests/early-access-launch-chain.test.mjs.
const key = () => Keypair.generate().publicKey
const amm = new CpAmm(new Connection('http://127.0.0.1:1'))
const mint = key(), owner = key(), receiver = key(), temporary = key()
const graduated = { amm, pool: key(), position: key(), nftAccount: key(), poolState: { tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: key(), tokenBVault: key() } }
const spec = { owner, receiver, temporary, graduated, tokenAProgram: TOKEN_2022_PROGRAM_ID }
const build = () => graduatedClaimInstructions(graduated, spec)
const changed = (instructions, at, change) => instructions.map((ix, i) => i !== at ? ix
  : new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map(change) }))

test('the DAMM v2 claim of a graduated early access market passes only exactly as built', async () => {
  const instructions = await build()
  assertGraduatedClaimInstructions(instructions, spec)
  const refused = (candidate, label) => assert.throws(() => assertGraduatedClaimInstructions(candidate, spec), /does not match the expected claim/, label)
  let cases = 0
  for (const [at, ix] of instructions.entries()) {
    for (const index of ix.keys.keys()) {
      refused(changed(instructions, at, (meta, i) => i === index ? { ...meta, pubkey: key() } : meta), `instruction ${at} account ${index}`)
      refused(changed(instructions, at, (meta, i) => i === index ? { ...meta, isSigner: !meta.isSigner } : meta), `instruction ${at} signer ${index}`)
      refused(changed(instructions, at, (meta, i) => i === index ? { ...meta, isWritable: !meta.isWritable } : meta), `instruction ${at} writable ${index}`)
      cases += 3
    }
    refused(instructions.map((other, i) => i !== at ? other : new TransactionInstruction({ programId: key(), data: other.data, keys: other.keys })), `program ${at}`)
    refused(instructions.map((other, i) => i !== at ? other : new TransactionInstruction({ programId: other.programId, data: Buffer.concat([other.data, Buffer.from([0])]),
      keys: other.keys })), `data ${at}`)
    refused(instructions.map((other, i) => i !== at ? other : new TransactionInstruction({ programId: other.programId, data: other.data,
      keys: [...other.keys, { pubkey: key(), isSigner: false, isWritable: false }] })), `extra account ${at}`)
    cases += 3
  }
  refused(instructions.slice(0, 3), 'without the close')
  refused([...instructions, instructions[3]], 'a fifth instruction')
  refused([instructions[1], instructions[0], instructions[2], instructions[3]], 'out of order')
  // The SPL shape (a SOL market's claim) is not an early access market's.
  refused(await graduatedClaimInstructions(graduated, { ...spec, tokenAProgram: TOKEN_PROGRAM_ID }), 'token A on SPL Token')
  assert.throws(() => assertGraduatedClaimInstructions(instructions, { ...spec, graduated: { ...graduated, poolState: { ...graduated.poolState, tokenBMint: key() } } }))
  assert.ok(cases > 60, `${cases} changed claims refused`)
})

test('an early access payout claims the curve part alone when both are owed; the DAMM v2 part follows in the next claim', () => {
  // Both owed: the curve part (outstanding minus the DAMM v2 fee) alone; the DAMM v2 fee stays outstanding.
  const both = claimAmounts({ dbcFee: 700n, dammFee: 300n, outstanding: 1000n })
  assert.deepEqual(both, { payoutAmount: 1000n, dbcPayout: 700n, dammFee: 300n, surplus: 0n })
  assert.deepEqual(earlyAccessClaimAmounts(both), { payoutAmount: 700n, dbcPayout: 700n, dammFee: 0n, surplus: 0n })
  // The next claim: the curve fee is gone, so the DAMM v2 fee alone.
  const next = claimAmounts({ dbcFee: 0n, dammFee: 300n, outstanding: 300n })
  assert.deepEqual(earlyAccessClaimAmounts(next), next)
  assert.deepEqual(earlyAccessClaimAmounts(next), { payoutAmount: 300n, dbcPayout: 0n, dammFee: 300n, surplus: 0n })
  // Only the curve part owed (before graduation): unchanged.
  const curve = claimAmounts({ dbcFee: 500n, dammFee: 0n, outstanding: 500n })
  assert.deepEqual(earlyAccessClaimAmounts(curve), curve)
})
