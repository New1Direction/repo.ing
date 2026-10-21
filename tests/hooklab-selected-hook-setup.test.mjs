import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey, VersionedMessage, VersionedTransaction, AddressLookupTableProgram, AddressLookupTableInstruction, TransactionMessage } from '@solana/web3.js'
import { planSelectedHookSetup, collectSelectedHookSetup, revalidateSelectedHookSetup, taxHookPrepareIntent } from '../src/hooklab-selected-hook-setup.mjs'
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const sha = b => createHash('sha256').update(b).digest('hex')
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const system = '11111111111111111111111111111111'
function fixture() {
  const creator = key(1), mint = key(2), program = key(3), collector = key(4)
  const request = structuredClone(taxHookPrepareIntent({ creator, mint, program, collector, feeBps: 100, maxWalletBps: 5000 }))
  const pd = PublicKey.findProgramAddressSync([new PublicKey(program).toBuffer()], new PublicKey(loader))[0].toBase58()
  const pb = Buffer.alloc(36); pb.writeUInt32LE(2); new PublicKey(pd).toBuffer().copy(pb, 4)
  const db = Buffer.alloc(49); db.writeUInt32LE(3); Buffer.from([127,69,76,70]).copy(db,45)
  const account = (address, owner, data, executable = false) => ({ address, owner, dataBase64: data.toString('base64'), executable, lamports: '100000' })
  const addresses = [...new Set([creator, program, pd, ...request.instructions.flatMap(i => i.accounts.map(a => a.address)), 'ComputeBudget111111111111111111111111111111'])]
  const snapshots = addresses.map(address => ({ address, account: address === program ? account(address, loader, pb, true) : address === pd ? account(address, loader, db) : address === creator ? account(address, system, Buffer.alloc(0)) : null }))
  const input = { request, programs: { token: key(5), swap: key(6), launch: key(7), gate: key(8) }, hookPin: { program, elfSha256: sha(db.subarray(45)) },
    snapshots, context: { genesisHash: key(9), profileSha256: 'a'.repeat(64), recentBlockhash: key(10), observedSlot: 40, validUntilSlot: 90, observedAtMs: 1000, reviewExpiresAtMs: 2000, lastValidBlockHeight: 150, baseFeeLamports: '5000' },
    limits: { computeUnits: 200000, maxRentLamports: '10000', maxNetworkFeeLamports: '5000', maxTotalDebitLamports: '15000' } }
  const plan = () => planSelectedHookSetup(input)
  // Synthetic empty mint-stable registry; NOT an SBF execution of tax_hook.
  const registry = request.instructions[0].accounts[4].address
  const registryData = Buffer.from('02daf6662c38c0cd0100000000', 'hex')
  let change = () => {}
  const connections = ['one','two'].map((provider, index) => ({ provider, connection: {
    async getGenesisHash() { return input.context.genesisHash },
    async getMultipleAccountsInfoAndContext(keys) { return { context: { slot: 42 }, value: keys.map(k => { const a = snapshots.find(a => a.address === k.toBase58())?.account; return a ? { ...a, owner: new PublicKey(a.owner), data: Buffer.from(a.dataBase64,'base64'), lamports: Number(a.lamports) } : null }) } },
    async isBlockhashValid() { return { context: { slot: 42 }, value: true } }, async getBlockHeight() { return 100 }, async getFeeForMessage() { return { context: { slot: 42 }, value: 5000 } },
    async simulateTransaction(tx, options) {
      assert.equal(Buffer.from(tx.message.serialize()).toString('base64'), plan().review.messageBase64)
      const accounts = options.accounts.addresses.map(address => { const a = snapshots.find(a => a.address === address)?.account
        if (address === registry) return { owner: program, executable: false, lamports: 1000, data: [registryData.toString('base64'),'base64'] }
        return a ? { owner: a.owner, executable: a.executable, lamports: Number(a.lamports) - (address === creator ? 6000 : 0), data: [a.dataBase64,'base64'] } : null })
      change({ accounts, addresses: options.accounts.addresses, index })
      return { context: { slot: 42 }, value: { err: null, unitsConsumed: 10000, accounts } }
    },
  } }))
  return { input, plan, registry, connections, mutate: fn => { change = fn }, clock: () => 1200 }
}
test('synthetic compilation only: immutable creator-only exact setup, tax prepare ABI', async () => {
  const f = fixture(), p = f.plan()
  assert.equal(p.request.instructions[0].dataBase64, Buffer.concat([createHash('sha256').update('global:prepare').digest().subarray(0,8), Buffer.from([100,0,136,19])]).toString('base64'))
  assert.equal(Object.isFrozen(p.request.instructions[0]), true)
  const evidence = await collectSelectedHookSetup({ plan: p, connections: f.connections, clock: f.clock })
  assert.equal(evidence.canSubmit, false)
  assert.deepEqual(await revalidateSelectedHookSetup({ plan: p, connections: f.connections, clock: f.clock, expected: evidence }), evidence)
})
test('setup binds creator-funded create/extend/permanent freeze and exact rent disclosure to the reviewed wire', () => {
  const f = fixture(), creator = new PublicKey(f.input.request.creator)
  const [, address] = AddressLookupTableProgram.createLookupTable({ authority: creator, payer: creator, recentSlot: 40 })
  f.input.supplementalTable = { address: address.toBase58(), recentSlot: 40, addresses: [key(24), key(25)], rentLamports: '1000' }
  f.input.snapshots.push({ address: address.toBase58(), account: null }, { address: AddressLookupTableProgram.programId.toBase58(), account: null })
  const p = f.plan()
  assert.deepEqual(p.review.supplementalTableCost, { address: address.toBase58(), rentLamports: '1000', permanentFreeze: true })
  const message = VersionedMessage.deserialize(Buffer.from(p.review.messageBase64, 'base64'))
  const instructions = TransactionMessage.decompile(message).instructions.slice(-3)
  assert.deepEqual(instructions.map(ix => AddressLookupTableInstruction.decodeInstructionType(ix)), ['CreateLookupTable', 'ExtendLookupTable', 'FreezeLookupTable'])
  assert.deepEqual(AddressLookupTableInstruction.decodeExtendLookupTable(instructions[1]).addresses.map(k => k.toBase58()), [key(24), key(25)])
  assert.deepEqual(p.review.requiredSigners, [f.input.request.creator])
  assert.equal(p.review.maxNativeDebitLamports, '15000')
  assert.ok(1 + 64 + message.serialize().length <= 1232)
  for (const mutate of [i => i.supplementalTable.address = key(26), i => i.supplementalTable.recentSlot++, i => i.supplementalTable.addresses.push(key(24)),
    i => i.supplementalTable.rentLamports = '10001', i => i.snapshots.find(a => a.address === address.toBase58()).account = { address: address.toBase58(), owner: system, executable: false, lamports: '1', dataBase64: '' }]) {
    const changed = structuredClone(f.input); mutate(changed); assert.throws(() => planSelectedHookSetup(changed))
  }
})
test('setup measures all readonly pins within the RPC return-account limit and refuses cross-bank or execution drift', async () => {
  for (const drift of [null, 'bank', 'execution']) {
    const f = fixture(), plan = f.plan()
    assert.ok(plan.snapshots.length > plan.review.accounts.length, 'ProgramData is outside the message keys')
    for (const { connection } of f.connections) {
      const simulate = connection.simulateTransaction
      let calls = 0
      connection.simulateTransaction = async (tx, options) => {
        assert.ok(options.accounts.addresses.length <= plan.review.accounts.length, 'Agave caps account returns at message-key count')
        const result = await simulate(tx, options)
        // Agave materializes nonexistent readonly message accounts as empty system accounts.
        result.value.accounts = result.value.accounts.map((a, i) => a === null && !plan.review.accounts.find(k => k.address === options.accounts.addresses[i])?.writable
          ? { owner: system, executable: false, lamports: 0, data: ['', 'base64'] } : a)
        if (++calls % 2 === 0 && drift === 'bank') result.context.slot++
        if (calls % 2 === 0 && drift === 'execution') result.value.unitsConsumed++
        return result
      }
    }
    const collect = () => collectSelectedHookSetup({ plan, connections: f.connections, clock: f.clock })
    if (drift) await assert.rejects(collect(), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' })
    else assert.equal((await collect()).canSign, false)
  }
})
test('compound setup simulation requires exact frozen table bytes and disclosed rent on both readers', async () => {
 for (const bad of [null, 'authority', 'addresses', 'rent', 'slot']) {
  const f=fixture(),creator=new PublicKey(f.input.request.creator)
  const [,table]=AddressLookupTableProgram.createLookupTable({authority:creator,payer:creator,recentSlot:40})
  f.input.supplementalTable={address:table.toBase58(),recentSlot:40,addresses:[key(24),key(25)],rentLamports:'1000'}
  f.input.snapshots.push({address:table.toBase58(),account:null},{address:AddressLookupTableProgram.programId.toBase58(),account:null})
  f.mutate(({accounts,addresses})=>{
   const payer=addresses.indexOf(f.input.request.creator);if(payer>=0)accounts[payer].lamports-=1000
   const index=addresses.indexOf(table.toBase58());if(index<0)return
   const b=Buffer.alloc(120);b.writeUInt32LE(1);b.writeBigUInt64LE(0xffffffffffffffffn,4);b.writeBigUInt64LE(42n,12)
   new PublicKey(key(24)).toBuffer().copy(b,56);new PublicKey(key(25)).toBuffer().copy(b,88)
   if(bad==='authority'){b[21]=1;creator.toBuffer().copy(b,22)}
   if(bad==='addresses')b[56]^=1
   if(bad==='slot')b.writeBigUInt64LE(43n,12)
   accounts[index]={owner:AddressLookupTableProgram.programId.toBase58(),executable:false,lamports:bad==='rent'?1001:1000,data:[b.toString('base64'),'base64']}
  })
  const collect=()=>collectSelectedHookSetup({plan:f.plan(),connections:f.connections,clock:f.clock})
  if(bad)await assert.rejects(collect());else assert.equal((await collect()).canSign,false)
 }
})
test('reject blank, alias, signer expansion and unreviewed instruction substitution', () => {
  for (const mutate of [i => i.request.instructions = [], i => i.request.instructions[0].accounts.push(i.request.instructions[0].accounts[0]), i => i.request.instructions[0].accounts[1].signer = true, i => i.request.mint = i.request.creator]) {
    const f = fixture(); mutate(f.input); assert.throws(() => f.plan())
  }
})
test('collector refuses wire substitution, missing/wrong registry, readonly/executable mutation, debit and disagreement', async () => {
  for (const [address, mutate] of [
    [f => f.registry, (a, i) => a[i] = null],
    [f => f.registry, (a, i) => a[i].owner = key(20)],
    [f => f.registry, (a, i) => a[i].data = ['AQ==','base64']],
    [f => f.input.request.selectedHook.program, (a, i) => a[i].executable = false],
    [f => f.plan().programData, (a, i) => a[i].data = ['AQ==','base64']],
    [f => f.input.request.mint, (a, i) => a[i] = { owner: system, executable: false, lamports: 1, data: ['', 'base64'] }],
    [f => f.input.request.creator, (a, i) => a[i].lamports = 0],
    [f => f.registry, (a, i, provider) => { if (provider) a[i].lamports++ }],
  ]) {
    const f = fixture(); let altered = false
    f.mutate(({ accounts, addresses, index }) => {
      const i = addresses.indexOf(address(f))
      if (i >= 0) { mutate(accounts, i, index); altered = true }
    })
    await assert.rejects(collectSelectedHookSetup({ plan: f.plan(), connections: f.connections, clock: f.clock }))
    assert.equal(altered, true, 'mutation must reach its simulation return slice')
  }
  const f = fixture(), p = JSON.parse(JSON.stringify(f.plan())); p.request.instructions[0].dataBase64 = 'AQ=='
  await assert.rejects(collectSelectedHookSetup({ plan: p, connections: f.connections, clock: f.clock }))
  const p2 = f.plan(), tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(p2.review.messageBase64,'base64'))); tx.message.recentBlockhash = key(21)
  await assert.rejects(revalidateSelectedHookSetup({ plan: p2, connections: f.connections, clock: f.clock, expected: {}, signedBase64: Buffer.from(tx.serialize()).toString('base64') }))
  await assert.rejects(collectSelectedHookSetup({ plan: p2, connections: [f.connections[0],f.connections[0]], clock: f.clock }))
})
test('instruction bounds and cross-instruction privilege aliases fail closed', () => {
  for (const mutate of [i => i.request.instructions = Array(9).fill(i.request.instructions[0]),
    i => i.request.instructions[0].dataBase64 = Buffer.alloc(769).toString('base64'),
    i => i.request.instructions[0].program = key(22),
    i => i.request.instructions[0].accounts[4].writable = false,
    i => { const ix = structuredClone(i.request.instructions[0]); ix.accounts[0].signer = false; i.request.instructions.push(ix) },
    i => i.limits.maxNetworkFeeLamports = '4999',
  ]) { const f = fixture(); mutate(f.input); assert.throws(() => f.plan()) }
})
test('generic non-tax bytes/flags compile; live genesis and pinned prestate disagreement refuse', async () => {
  const f = fixture(); f.input.request.selectedHook.flags = 255; f.input.request.instructions[0].dataBase64 = 'Bw=='
  assert.equal(f.plan().request.selectedHook.flags, 255)
  f.connections[1].connection.getGenesisHash = async () => key(23)
  await assert.rejects(collectSelectedHookSetup({ plan: f.plan(), connections: f.connections, clock: f.clock }))
  const g = fixture(), p = g.plan()
  g.input.snapshots.find(a => a.address === p.programData).account.owner = system
  await assert.rejects(collectSelectedHookSetup({ plan: p, connections: g.connections, clock: g.clock }))
})

test('setup retains verified delayed authority and rejects changed executor snapshots before consent', async () => {
  const f = fixture(), program = f.input.request.selectedHook.program
  const executor = 'BBUzaamchPWZpKENmn7bopiuQWvRGm2Vg8TqLLgzgGGZ'
  const [tl, bump] = PublicKey.findProgramAddressSync([Buffer.from('timelock'), new PublicKey(program).toBuffer()], new PublicKey(executor))
  const epd = PublicKey.findProgramAddressSync([new PublicKey(executor).toBuffer()], new PublicKey(loader))[0].toBase58()
  const programAccount = f.input.snapshots.find(a => a.address === program).account
  const programData = f.input.snapshots.find(a => a.address === f.plan().programData).account
  const pd = Buffer.from(programData.dataBase64, 'base64'); pd[12] = 1; tl.toBuffer().copy(pd, 13); programData.dataBase64 = pd.toString('base64')
  const pb = Buffer.alloc(36), db = Buffer.alloc(49), tb = Buffer.alloc(279)
  pb.writeUInt32LE(2); new PublicKey(epd).toBuffer().copy(pb, 4)
  db.writeUInt32LE(3); Buffer.from([127,69,76,70]).copy(db, 45)
  Buffer.from('bd214e4bcd1f04b1', 'hex').copy(tb); tb[8] = 1; tb[9] = bump
  new PublicKey(program).toBuffer().copy(tb, 10); new PublicKey(programData.address).toBuffer().copy(tb, 42); tb.writeUInt32LE(259200, 138)
  const account = (address, owner, data, executable = false) => ({ address, owner, executable, dataBase64: data.toString('base64') })
  const identity = ({ lamports, ...rest }) => rest
  const authority = { kind: 'timelocked', upgradeAuthority: tl.toBase58(), delaySeconds: 259200,
    timelock: account(tl.toBase58(), executor, tb), executor: account(executor, loader, pb, true), executorProgramData: account(epd, loader, db) }
  const e = { schema: 'repoing/selected-hook-authority-evidence/2', genesisHash: f.input.context.genesisHash, policySha256: 'b'.repeat(64),
    hookPin: { ...f.input.hookPin, elfLength: 4 }, programAccount: identity(programAccount), programData: identity(programData), authority,
    programSha256: sha(Buffer.from(programAccount.dataBase64, 'base64')), programDataSha256: sha(pd), executableSha256: f.input.hookPin.elfSha256, observedSlot: 40, providers: ['one','two'] }
  f.input.selectedAuthorityEvidence = e
  for (const a of [authority.timelock, authority.executor, authority.executorProgramData]) f.input.snapshots.push({ address: a.address, account: { ...a, lamports: '100000' } })
  const p = f.plan()
  assert.deepEqual(p.selectedAuthorityEvidence, e)
  assert.equal((await collectSelectedHookSetup({ plan: p, connections: f.connections, clock: f.clock })).canSign, false)
  const changed = structuredClone(f.input)
  changed.snapshots.find(a => a.address === epd).account.dataBase64 = Buffer.alloc(49).toString('base64')
  assert.throws(() => planSelectedHookSetup(changed), /authority|snapshot/i)
})
