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

function observedFixture() {
  const plan=custody.prepareCustodyMultisig({instructions:[SystemProgram.transfer({
    fromPubkey:new PublicKey(custody.MULTISIG_VAULT),toPubkey:new PublicKey(Buffer.alloc(32,8)),lamports:1})],
    transactionIndex:1n,creator:custody.CUSTODY_MEMBERS[0],rentPayer:custody.CUSTODY_MEMBERS[0],
    approvers:custody.CUSTODY_MEMBERS.slice(0,2),executor:custody.CUSTODY_MEMBERS[1]})
  const accounts=governanceFixture(plan,50)
  const entry=(signature,keys)=>({version:'legacy',transaction:{signatures:[signature],message:{accountKeys:keys}},meta:{err:null}})
  const execution=entry('execution',[plan.multisig,plan.proposal,plan.transaction])
  const unrelated=entry('unrelated',[PublicKey.default.toBase58()])
  const blocks=new Map([
    [50,{parentSlot:49,previousBlockhash:'hash49',blockhash:'hash50',transactions:[execution,unrelated]}],
    [52,{parentSlot:50,previousBlockhash:'hash50',blockhash:'hash52',transactions:[unrelated]}],
  ])
  const connection={
    getSignatureStatuses:async()=>({value:[{slot:50,err:null,confirmationStatus:'finalized'}]}),
    getMultipleAccountsInfoAndContext:async()=>({context:{slot:50},value:[accounts.multisig,accounts.transaction,accounts.proposal]}),
    getProgramAccounts:async(_program,config)=>({context:{slot:52},value:config.withContext && config.filters.length===2 &&
      config.filters[1].memcmp.offset===8 && !config.filters.some(f=>f.dataSize!==undefined)?[]:[{}]}),
    // Raw JSON-RPC: web3.js cannot parse blocks that contain version 1 transactions.
    _rpcRequest:async(method,[slot,config])=>method==='getBlock' && config.maxSupportedTransactionVersion===1 &&
      config.encoding==='json'?{result:blocks.get(slot)??null}:{error:{message:'unexpected request'}},
    // An incorrectly chosen address-history proof would miss a later config change.
    getSignaturesForAddress:async()=>[{signature:'execution',slot:50,err:null,confirmationStatus:'finalized'}],
  }
  return {plan,blocks,connection,entry}
}

test('finalized block ancestry reconstructs unchanged execution control without relabeling later account slots',async()=>{
  assert.equal(typeof custody.collectCustodyGovernance,'function')
  const f=observedFixture()
  const result=await custody.collectCustodyGovernance({...f,signature:'execution'})
  assert.equal(result.tx.slot,50)
  assert.equal(result.governanceProof.snapshot.accountsContextSlot,50)
  assert.equal(result.governanceProof.snapshot.limitsContextSlot,52)
  assert.equal(custody.validateCustodyGovernance({plan:f.plan,proof:result.governanceProof,slot:50,signature:'execution'}).vaultControlVerified,true)
  result.governanceProof.snapshot.blocks[0].block.transactions.push(f.entry('hidden-change',[f.plan.multisig]))
  assert.throws(()=>custody.validateCustodyGovernance({plan:f.plan,proof:result.governanceProof,slot:50,signature:'execution'}))
})

test('version 1 transactions are scanned like the others and may not load addresses',async()=>{
  const f=observedFixture(), unrelated=f.entry('unrelated-v1',[PublicKey.default.toBase58()])
  unrelated.version=1
  f.blocks.get(52).transactions.push(unrelated)
  assert.equal((await custody.collectCustodyGovernance({...f,signature:'execution'})).tx.slot,50)
  for(const kind of ['touches','loads']) {
    const g=observedFixture(), changed=g.entry('v1-change',kind==='touches'?[g.plan.multisig]:[PublicKey.default.toBase58()])
    changed.version=1
    if(kind==='loads') changed.meta.loadedAddresses={readonly:[PublicKey.default.toBase58()],writable:[]}
    g.blocks.get(52).transactions.push(changed)
    await assert.rejects(custody.collectCustodyGovernance({...g,signature:'execution'}),/Custody/)
  }
})

test('stale address history cannot hide later, same-slot or ALT-loaded governance activity',async()=>{
  assert.equal(typeof custody.collectCustodyGovernance,'function')
  for(const kind of ['later','same-slot','alt']) {
    const f=observedFixture(), changed=f.entry('config-change',[f.plan.multisig])
    if(kind==='alt') {
      changed.version=0
      changed.transaction.message={staticAccountKeys:[PublicKey.default.toBase58()],addressTableLookups:[{}]}
      changed.meta.loadedAddresses={readonly:[f.plan.multisig],writable:[]}
    }
    f.blocks.get(kind==='same-slot'?50:52).transactions.push(changed)
    await assert.rejects(custody.collectCustodyGovernance({...f,signature:'execution'}),/Custody/)
  }
})

test('incomplete block history, wrong linkage, missing metadata and missing spending-limit evidence fail closed',async()=>{
  assert.equal(typeof custody.collectCustodyGovernance,'function')
  for(const change of [
    f=>f.blocks.delete(50),
    f=>{f.blocks.get(52).previousBlockhash='wrong'},
    f=>{f.blocks.get(52).transactions[0].meta=null},
    f=>{f.blocks.get(50).transactions.shift()},
    f=>{f.connection.getProgramAccounts=async()=>({context:{slot:52},value:[{}]})},
    f=>{f.connection.getProgramAccounts=async()=>{throw Error('RPC incomplete')}},
    f=>{f.connection.getMultipleAccountsInfoAndContext=async()=>({context:{slot:49},value:[]})},
  ]) {
    const f=observedFixture();change(f)
    await assert.rejects(custody.collectCustodyGovernance({...f,signature:'execution'}))
  }
  await assert.rejects(custody.collectCustodyGovernance({...observedFixture(),signature:'execution',maxBlocks:1}),/Custody/)
})
