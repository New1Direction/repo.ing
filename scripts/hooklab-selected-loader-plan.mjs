// Pure unsigned release planning. No RPC, signing, keys, sending or authority changes.
import { createHash } from 'node:crypto'
import { ComputeBudgetProgram, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction } from '@solana/web3.js'

const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const sha = b => createHash('sha256').update(b).digest('hex')
const check = (ok, why) => { if (!ok) throw Error(why) }
const amount = n => { check(typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n), 'decimal lamports required'); return BigInt(n) }
const u32 = n => { check(Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff, 'u32 required'); const b = Buffer.alloc(4); b.writeUInt32LE(n); return b }
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner })

export function unsignedReleaseStep({ name, instructions, payer, blockhash, units = 60000, microLamports = 10000, ...effects }) {
  check(Number.isSafeInteger(units) && units > 0 && units <= 1400000, 'invalid CU limit')
  check(Number.isSafeInteger(microLamports) && microLamports >= 0 && microLamports <= 10000, 'release priority-price ceiling exceeded')
  const tx = new Transaction({ feePayer: new PublicKey(payer), recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions)
  const message = tx.compileMessage(), raw = message.serialize()
  const wire = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  check(wire.length <= 1232, 'release packet exceeds 1232 bytes')
  const requiredSigners = message.accountKeys.slice(0, message.header.numRequiredSignatures).map(k => k.toBase58())
  const priorityFee = (BigInt(units) * BigInt(microLamports) + 999999n) / 1000000n
  return { name, ...effects, signingGate: 'NOT SIGNABLE', canSign: false, canSubmit: false,
    messageBase64: raw.toString('base64'), messageSha256: sha(raw), unsignedTransactionBase64: wire.toString('base64'), wireBytes: wire.length,
    requiredSigners, computeUnitLimit: units, microLamportsPerUnit: microLamports,
    expectedFeeLamports: String(requiredSigners.length * 5000 + Number(priorityFee)),
    instructions: tx.instructions.map(ix => ({ program: ix.programId.toBase58(), dataBase64: ix.data.toString('base64'),
      accounts: ix.keys.map(k => ({ address: k.pubkey.toBase58(), writable: k.isWritable, signer: k.isSigner })) })) }
}

export async function selectedLoaderPlan({ program, payer, authority, seed, elf, capacity, bufferRent, extensionRent, blockhash }) {
  const P = new PublicKey(program), F = new PublicKey(payer), A = new PublicKey(authority)
  check(!P.equals(F) && !P.equals(A) && !F.equals(A), 'release roles must be distinct')
  check(Buffer.isBuffer(elf) && elf.length >= 4 && elf.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'ELF required')
  check(Number.isSafeInteger(capacity) && capacity >= 0 && Math.max(capacity, elf.length) + 45 <= 10485760, 'invalid ProgramData capacity')
  check(typeof seed === 'string' && Buffer.byteLength(seed) > 0 && Buffer.byteLength(seed) <= 32, 'invalid public buffer seed')
  check(amount(bufferRent) > 0n, 'funded buffer required')
  amount(extensionRent)
  const B = await PublicKey.createWithSeed(F, seed, LOADER)
  const [D] = PublicKey.findProgramAddressSync([P.toBuffer()], LOADER)
  const steps = [], step = (name, instructions, effects = {}, units = 20000) => steps.push(unsignedReleaseStep({ name, instructions,
    payer, blockhash, units, ...effects }))
  const loader = (tag, keys, rest = Buffer.alloc(0)) => new TransactionInstruction({ programId: LOADER, keys, data: Buffer.concat([u32(tag), rest]) })
  if (elf.length > capacity) {
    check(amount(extensionRent) > 0n, 'extension rent quote required')
    // The active loader rejects increments below 10 KiB unless reaching its maximum.
    // Rent must be quoted for this allocation, not just the ELF's exact byte length.
    const expectedCapacity = Math.min(10485760 - 45, capacity + Math.max(10240, elf.length - capacity))
    step('extend-program', [loader(6, [meta(D, true), meta(P, true), meta(SystemProgram.programId), meta(F, true, true)], u32(expectedCapacity - capacity))],
      { kind: 'extend', expectedDebitLamports: extensionRent, expectedCapacity }, 1400000)
  } else check(extensionRent === '0', 'unnecessary extension debit prohibited')
  step('create-buffer', [SystemProgram.createAccountWithSeed({ fromPubkey: F, basePubkey: F, newAccountPubkey: B, seed,
    lamports: Number(amount(bufferRent)), space: elf.length + 37, programId: LOADER }), loader(0, [meta(B, true), meta(A)])],
  { kind: 'create-buffer', expectedDebitLamports: bufferRent })
  for (let offset = 0; offset < elf.length; offset += 800) {
    const chunk = elf.subarray(offset, offset + 800), length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(chunk.length))
    step(`write-buffer-${offset}`, [loader(1, [meta(B, true), meta(A, false, true)], Buffer.concat([u32(offset), length, chunk]))],
      { kind: 'write-buffer', offset, bytes: chunk.length, chunkSha256: sha(chunk), expectedDebitLamports: '0' })
  }
  step('upgrade-program', [loader(3, [meta(D, true), meta(P, true), meta(B, true), meta(F, true), meta(SYSVAR_RENT_PUBKEY), meta(SYSVAR_CLOCK_PUBKEY), meta(A, false, true)])],
    { kind: 'upgrade', expectedDebitLamports: '0', expectedRefundLamports: bufferRent, refundRecipient: payer,
      expectedElfSha256: sha(elf), expectedElfLength: elf.length, preserveAuthority: authority }, 1400000)
  return { signingGate: 'NOT SIGNABLE', canSign: false, canSubmit: false, program, programData: D.toBase58(), buffer: B.toBase58(), seed,
    authority, payer, refundRecipient: payer, elfLength: elf.length, elfSha256: sha(elf), steps }
}

// A new production hook, not an upgrade to the immutable gate or a test-hook deployment.
// Freezing is a separately reviewed, irreversible final step; this only prepares unsigned bytes.
export async function selectedHookDeploymentPlan({programSeed,programRent,programDataRent,...input}){
  check(typeof programSeed==='string'&&Buffer.byteLength(programSeed)>0&&Buffer.byteLength(programSeed)<=32,'invalid public program seed')
  const F=new PublicKey(input.payer),A=new PublicKey(input.authority),P=await PublicKey.createWithSeed(F,programSeed,LOADER)
  check(P.toBase58()===input.program,'new hook identity differs from reviewed payer seed')
  check(amount(programRent)>0n&&amount(programDataRent)>0n,'new program rent quotes required')
  const plan=await selectedLoaderPlan({...input,capacity:input.elf.length,extensionRent:'0'})
  const D=new PublicKey(plan.programData),B=new PublicKey(plan.buffer)
  const loader=(tag,keys,rest=Buffer.alloc(0))=>new TransactionInstruction({programId:LOADER,keys,data:Buffer.concat([u32(tag),rest])})
  const size=Buffer.alloc(8);size.writeBigUInt64LE(BigInt(input.elf.length))
  const deploy=unsignedReleaseStep({name:'deploy-new-hook',payer:input.payer,blockhash:input.blockhash,units:1400000,
    instructions:[SystemProgram.createAccountWithSeed({fromPubkey:F,basePubkey:F,newAccountPubkey:P,seed:programSeed,
      lamports:Number(amount(programRent)),space:36,programId:LOADER}),
      loader(2,[meta(F,true,true),meta(D,true),meta(P,true),meta(B,true),meta(SYSVAR_RENT_PUBKEY),meta(SYSVAR_CLOCK_PUBKEY),meta(SystemProgram.programId),meta(A,false,true)],size)],
    kind:'deploy-new-program',classification:'DEPLOYMENT',expectedDebitLamports:String(amount(programRent)+amount(programDataRent)),
    expectedRefundLamports:input.bufferRent,refundRecipient:input.payer,expectedElfSha256:plan.elfSha256,preserveAuthority:input.authority})
  const freeze=unsignedReleaseStep({name:'freeze-new-hook',payer:input.payer,blockhash:input.blockhash,units:20000,
    instructions:[loader(4,[meta(D,true),meta(A,false,true)])],kind:'freeze-new-program',classification:'IRREVERSIBLE_HOOK_FREEZE',
    expectedDebitLamports:'0',permanentRentLamports:String(amount(programRent)+amount(programDataRent)),
    warning:'Permanently removes new hook upgrade authority; neither code nor locked rent can be recovered through an upgrade or program close'})
  return {...plan,programSeed,steps:[...plan.steps.slice(0,-1),deploy,freeze]}
}
