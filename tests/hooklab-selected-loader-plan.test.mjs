import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey, Transaction, SystemInstruction } from '@solana/web3.js'
import * as plans from '../scripts/hooklab-selected-loader-plan.mjs'
const {selectedLoaderPlan}=plans

const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const input = { program: key(1), payer: key(2), authority: key(3), seed: 'public-review-buffer', elf: Buffer.from([127, 69, 76, 70, ...Array(1605).fill(9)]),
  capacity: 1200, bufferRent: '9900000', extensionRent: '2100000', blockhash: key(4) }

test('loader plan preserves every upload byte and refunds only to the payer without private buffer keys', async () => {
  const p = await selectedLoaderPlan(input)
  assert.equal(p.signingGate, 'NOT SIGNABLE')
  assert.equal(p.canSign, false)
  assert.equal(p.canSubmit, false)
  assert.deepEqual(p.steps.map(s => s.kind), ['extend', 'create-buffer', 'write-buffer', 'write-buffer', 'write-buffer', 'upgrade'])
  const decoded = p.steps.map(s => Transaction.from(Buffer.from(s.unsignedTransactionBase64, 'base64')))
  assert.ok(decoded.every(t => t.serialize({ requireAllSignatures: false }).length <= 1232))
  const ext = decoded[0].instructions.at(-1)
  assert.equal(ext.data.readUInt32LE(0), 6)
  assert.equal(ext.data.readUInt32LE(4), 10240)
  assert.equal(p.steps[0].expectedCapacity, 11440)
  assert.equal(ext.keys[3].pubkey.toBase58(), input.payer)
  const create = SystemInstruction.decodeCreateWithSeed(decoded[1].instructions[2])
  assert.equal(create.basePubkey.toBase58(), input.payer)
  assert.equal(create.seed, input.seed)
  assert.equal(create.space, input.elf.length + 37)
  assert.equal(create.lamports, 9900000)
  const writes = decoded.slice(2, 5).map(t => t.instructions.at(-1).data)
  assert.deepEqual(writes.map(b => b.readUInt32LE(4)), [0, 800, 1600])
  assert.ok(writes.every(b => b.readUInt32LE(0) === 1 && Number(b.readBigUInt64LE(8)) === b.length - 16))
  assert.deepEqual(Buffer.concat(writes.map(b => b.subarray(16))), input.elf)
  const upgrade = decoded.at(-1).instructions.at(-1)
  assert.equal(upgrade.data.toString('hex'), '03000000')
  assert.equal(upgrade.keys[3].pubkey.toBase58(), input.payer)
  assert.equal(upgrade.keys[6].pubkey.toBase58(), input.authority)
  assert.equal(p.steps.at(-1).expectedRefundLamports, '9900000')
  assert.deepEqual(p.steps.at(-1).requiredSigners, [input.payer, input.authority])
  assert.deepEqual(p.steps[1].requiredSigners, [input.payer])
})

test('no extension when capacity fits; invalid sizes and ELF are refused', async () => {
  const p = await selectedLoaderPlan({ ...input, capacity: input.elf.length, extensionRent: '0' })
  assert.equal(p.steps[0].kind, 'create-buffer')
  for (const patch of [{ elf: Buffer.alloc(4) }, { capacity: -1 }, { bufferRent: '-1' }, { seed: 'x'.repeat(33) }]) {
    await assert.rejects(selectedLoaderPlan({ ...input, ...patch }))
  }
})

test('loader extension rounds only increments below the 10 KiB minimum', async () => {
  for (const [required, expected] of [[10239, 10240], [10240, 10240], [10241, 10241]]) {
    const elf = Buffer.concat([Buffer.from([127, 69, 76, 70]), Buffer.alloc(1200 + required - 4)])
    const p = await selectedLoaderPlan({ ...input, elf })
    assert.equal(p.steps[0].expectedCapacity, 1200 + expected)
    assert.equal(Transaction.from(Buffer.from(p.steps[0].unsignedTransactionBase64, 'base64')).instructions.at(-1).data.readUInt32LE(4), expected)
  }
})

test('new hook deployment uses the reviewed payer-seeded identity and separates its permanent freeze',async()=>{
 const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),programSeed='production-hook-v1'
 const program=(await PublicKey.createWithSeed(new PublicKey(input.payer),programSeed,loader)).toBase58()
 assert.equal(typeof plans.selectedHookDeploymentPlan,'function')
 const args={...input,program,programSeed,programRent:'833120',programDataRent:'10000000'}
 const p=await plans.selectedHookDeploymentPlan(args),deploy=p.steps.at(-2),freeze=p.steps.at(-1)
 assert.equal(p.steps[0].kind,'create-buffer')
 assert.equal(deploy.kind,'deploy-new-program');assert.equal(deploy.expectedDebitLamports,'10833120')
 assert.equal(deploy.expectedRefundLamports,input.bufferRent)
 const tx=Transaction.from(Buffer.from(deploy.unsignedTransactionBase64,'base64'))
 const creation=SystemInstruction.decodeCreateWithSeed(tx.instructions[2]),ix=tx.instructions[3]
 assert.equal(creation.newAccountPubkey.toBase58(),program);assert.equal(creation.seed,programSeed);assert.equal(creation.space,36)
 assert.equal(ix.data.readUInt32LE(),2);assert.equal(ix.data.readBigUInt64LE(4),BigInt(input.elf.length))
 assert.deepEqual(deploy.requiredSigners,[input.payer,input.authority])
 assert.equal(freeze.classification,'IRREVERSIBLE_HOOK_FREEZE');assert.equal(freeze.permanentRentLamports,'10833120')
 const f=Transaction.from(Buffer.from(freeze.unsignedTransactionBase64,'base64')).instructions.at(-1)
 assert.equal(f.data.readUInt32LE(),4);assert.equal(f.keys.length,2)
 assert.equal(f.keys[0].pubkey.toBase58(),p.programData);assert.equal(f.keys[1].pubkey.toBase58(),input.authority)
 assert.ok(p.steps.every(s=>s.canSign===false&&s.canSubmit===false))
 for(const change of [{program:key(7)},{programRent:'-1'},{programDataRent:'0'},{programSeed:'x'.repeat(33)}]){
  await assert.rejects(plans.selectedHookDeploymentPlan({...args,...change}))
 }
})
