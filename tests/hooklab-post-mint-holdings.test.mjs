import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey, Keypair, VersionedMessage, VersionedTransaction, AddressLookupTableProgram } from '@solana/web3.js'
import bs58 from 'bs58'
import { selectedLaunchFixture, selectedLaunchCollectorFixture } from './fixtures/selected-hook-launch.mjs'
import { taxHookSetupManifest, hookSetupManifestSchema } from '../src/hooklab-hook-catalog.mjs'
import { compileSelectedHookLaunchReview, selectedHookLaunchInventory } from '../src/hooklab-max-wallet-launch.mjs'
import * as launchCompiler from '../src/hooklab-max-wallet-launch.mjs'
import { sharedTable } from './fixtures/hooklab-open-launch.mjs'
import { deriveOpenLaunchPostconditions, collectOpenLaunchSettlement } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { collectOpenLaunchReview } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { collectSelectedHookLaunchSimulation } from '../src/hooklab-selected-hook-launch-simulation.mjs'

function supplementalTable(f) {
  const i = f.input, r = f.request ?? i.request
  const addresses = launchCompiler.selectedHookLaunchTableAddresses(i.profile, r, f.configBytes, { accounts: f.accounts, hookPin: i.hookPin })
  const [, address] = AddressLookupTableProgram.createLookupTable({ authority: new PublicKey(r.creator), payer: new PublicKey(r.creator), recentSlot: 40 })
  const table = sharedTable(addresses, { address: address.toBase58() })
  const { sha256, ...snapshot } = { ...table, executable: false, lamports: '100' }
  return { plan: { address: table.address, recentSlot: 40, addresses, rentLamports: '100' }, snapshot }
}

test('supplemental table preserves atomic launch at maximum UTF-8 metadata bounds and refuses table substitution', t => {
 for (const feeModel of [1, 2]) for (const count of [0, 1, 2]) for (const extraCount of [1, 32]) {
  const f = selectedLaunchFixture({ feeModel, hookState: true }), i = f.input, r = i.request
  r.name = 'é'.repeat(16); r.symbol = 'ABCDE12345'; r.uri = 'u'.repeat(200)
  if (count) {
   r.postMintSetup = { digest: 'a'.repeat(64), manifest: taxHookSetupManifest(r.selectedHook), configuration: { feeBps: '2000', maxWalletBps: '0', collector: Keypair.fromSeed(Buffer.alloc(32, 99)).publicKey.toBase58() } }
   r.postMintSetup.manifest.postMintHoldings = r.postMintSetup.manifest.postMintHoldings.slice(0, count)
  }
  i.postMintHoldingRentLamports = '100'
  const accounts = new Map(i.observations[0].accounts.map(x => [x.address, x.account]))
  if (extraCount === 32) {
   const registry = PublicKey.findProgramAddressSync([Buffer.from('bordrless-hook-accounts'), new PublicKey(r.mint).toBuffer()], new PublicKey(r.selectedHook.program))[0].toBase58()
   const head = Buffer.from('02daf6662c38c0cd0120000000', 'hex')
   const extras = Array.from({ length: 32 }, (_, index) => Keypair.fromSeed(Buffer.alloc(32, 120 + index)).publicKey)
   const data = Buffer.concat([head, ...extras.map(address => Buffer.concat([Buffer.from([0, 0]), address.toBuffer()]))])
   accounts.set(registry, { ...accounts.get(registry), dataBase64: data.toString('base64') })
   i.preparationEvidence.preparedAccountHashes.registry = createHash('sha256').update(data).digest('hex')
   for (const address of extras) accounts.set(address.toBase58(), { address: address.toBase58(), owner: r.selectedHook.program, executable: false, lamports: '100', dataBase64: 'AA==' })
  }
  const options = { accounts, hookPin: i.hookPin }
  const { inventory } = selectedHookLaunchInventory(i.profile, r, f.configBytes, options)
  i.observations = i.observations.map(o => ({ ...o, accounts: inventory.map(address => ({ address, account: accounts.get(address) ?? null })) }))
  const addresses = launchCompiler.selectedHookLaunchTableAddresses(i.profile, r, f.configBytes, options)
  const [, tableAddress] = AddressLookupTableProgram.createLookupTable({ authority: new PublicKey(r.creator), payer: new PublicKey(r.creator), recentSlot: 40 })
  const table = sharedTable(addresses, { address: tableAddress.toBase58() }), plan = { address: table.address, recentSlot: 40, addresses, rentLamports: '100' }
  i.supplementalTable = { plan, snapshot: { address: table.address, owner: table.owner, dataBase64: table.dataBase64, executable: false, lamports: '100' } }
  const compiled = compileSelectedHookLaunchReview(i), message = VersionedMessage.deserialize(Buffer.from(compiled.review.messageBase64, 'base64'))
  const packet = 1 + 64 * message.header.numRequiredSignatures + message.serialize().length
  assert.ok(packet <= 1232, `maximum metadata packet ${packet}`)
  assert.equal(launchCompiler.selectedHookLaunchPacketSize(i.profile,r,f.configBytes,options,table.address),packet,'pre-spend sizing equals full compiled transaction')
  t.diagnostic(`model ${feeModel}, ${count} atomic holdings, ${extraCount} hook extras: ${packet}/1232 bytes`)
  assert.equal(compiled.instructions.length, 3 + count)
  assert.equal(compiled.review.lookupTables.length, 2)
  assert.equal(compiled.postMintHoldings?.length ?? 0, count)
  for (const mutate of [v => v.plan.addresses.reverse(), v => v.snapshot.owner = r.selectedHook.program,
    v => { v.plan.address = Keypair.generate().publicKey.toBase58(); v.snapshot.address = v.plan.address },
    v => { const b = Buffer.from(v.snapshot.dataBase64, 'base64'); b[21] = 1; b[22] = 1; v.snapshot.dataBase64 = b.toString('base64') },
    v => { const b = Buffer.from(v.snapshot.dataBase64, 'base64'); b.writeBigUInt64LE(100n, 12); v.snapshot.dataBase64 = b.toString('base64') }]) {
    const changed = structuredClone(i); mutate(changed.supplementalTable); assert.throws(() => compileSelectedHookLaunchReview(changed))
  }
 }
})

test('publisher collector holding is created in exact launch wire and expected token state', () => {
  const f = selectedLaunchFixture({ feeModel: 1 }), i = f.input, r = i.request
  const collector = Keypair.fromSeed(Buffer.alloc(32, 99)).publicKey.toBase58()
  r.postMintSetup = { digest: 'a'.repeat(64), manifest: taxHookSetupManifest(r.selectedHook), configuration: { feeBps: '100', maxWalletBps: '0', collector } }
  i.postMintHoldingRentLamports = '100'
  const p = JSON.parse(i.profile.json), holding = PublicKey.findProgramAddressSync([Buffer.from('holding'), new PublicKey(r.mint).toBuffer(), new PublicKey(collector).toBuffer()], new PublicKey(p.programs.token))[0].toBase58()
  const accounts = new Map(i.observations[0].accounts.map(x => [x.address, x.account]))
  const { inventory } = selectedHookLaunchInventory(i.profile, r, f.configBytes, { accounts, hookPin: i.hookPin })
  i.observations = i.observations.map(o => ({ ...o, accounts: inventory.map(address => ({ address, account: accounts.get(address) ?? null })) }))
  i.supplementalTable = supplementalTable(f)
  const plan = compileSelectedHookLaunchReview(i)
  assert.equal(plan.instructions.length, 5)
  assert.equal(plan.instructions[3].program, p.programs.token)
  assert.equal(plan.instructions[3].dataHex, createHash('sha256').update('global:create_holding').digest().subarray(0, 8).toString('hex'))
  const eventAuthority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(p.programs.token))[0].toBase58()
  assert.deepEqual(plan.instructions[3].accounts.map(a => a.address), [r.creator, r.mint, collector, holding, '11111111111111111111111111111111', eventAuthority, p.programs.token])
  assert.deepEqual([...plan.review.requiredSigners].sort(), [r.creator, r.mint].sort(), 'collector creation adds no signer or separate transaction')
  assert(i.observations.every(o => o.accounts.find(a => a.address === holding)?.account === null), 'holding is absent before launch, not manually initialized')
  assert.equal(plan.postMintHoldings[0].address, holding)
  const post = deriveOpenLaunchPostconditions({ schema: 'repoing/open-launch-settlement-context/1', compilationInput: i }, { slot: 120, timestamp: 1000 })
  assert(post.created.includes(holding))
  const bytes = Buffer.from(post.accounts.find(x => x.address === holding).dataBase64, 'base64')
  const v = f.coders.token.accounts.decode('Holding', bytes)
  assert.equal(v.owner.toBase58(), collector)
  assert.equal(v.mint.toBase58(), r.mint)
  assert.equal(v.amount.toString(), '0')
  assert.equal(post.events.filter(e => e.name === 'HoldingCreated').length, 2)
  assert.equal(plan.postMintHoldings[1].owner, 'FhEwQ6ZdWJvD3t1phu1vqMsTZeEUgtQ89eU8zGzPsW3i')
  const legacy = structuredClone(r.postMintSetup.manifest); delete legacy.postMintHoldings
  assert(hookSetupManifestSchema.safeParse(legacy).success)
  for (const owner of [{ kind: 'field', name: 'feeBps' }, { kind: 'pda', program: r.selectedHook.program, seeds: [] }])
    assert(!hookSetupManifestSchema.safeParse({ ...legacy, postMintHoldings: [{ owner }] }).success)
  assert.throws(() => compileSelectedHookLaunchReview({ ...i, postMintHoldingRentLamports: undefined }))
  assert.throws(() => compileSelectedHookLaunchReview({ ...i, postMintHoldingRentLamports: i.limits.maxRentLamports }))
})

test('collector observes rent; settlement refuses missing holding, wrong token state, rent and event', async () => {
  const f = selectedLaunchCollectorFixture({ feeModel: 1 }), collector = Keypair.fromSeed(Buffer.alloc(32, 99)).publicKey.toBase58()
  f.request.postMintSetup = { digest: 'a'.repeat(64), manifest: taxHookSetupManifest(f.request.selectedHook), configuration: { feeBps: '100', maxWalletBps: '0', collector } }
  const table = supplementalTable(f); f.supplementalTable = table.plan; f.accounts.set(table.plan.address, table.snapshot)
  for (const { connection } of f.connections) connection.getMinimumBalanceForRentExemption = async size => { assert.equal(size, 204); return 100 }
  const { plan, settlementContext } = await collectOpenLaunchReview(f), review = plan.review
  assert.equal(settlementContext.compilationInput.postMintHoldingRentLamports, '100')
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64, 'base64')))
  tx.sign([31, 32].map(n => Keypair.fromSeed(Buffer.alloc(32, n))))
  const signedTransactionBase64 = Buffer.from(tx.serialize()).toString('base64'), signature = bs58.encode(tx.signatures[0])
  const expected = deriveOpenLaunchPostconditions(settlementContext, { slot: 110, timestamp: 1000 }), post = new Map(f.accounts)
  for (const a of expected.accounts) post.set(a.address, { ...a, lamports: expected.created.includes(a.address) ? '100' : f.accounts.get(a.address).lamports })
  const keys = review.accounts.map(a => a.address), idx = k => keys.indexOf(k), preBalances = keys.map(k => Number(f.accounts.get(k)?.lamports ?? 0)), postBalances = [...preBalances]
  let rent = 0; for (const a of expected.created) { postBalances[idx(a)] = 100; rent += 100 - preBalances[idx(a)] }
  postBalances[idx(f.request.creator)] -= rent + 10000
  const event = e => ({ programIdIndex: idx(e.program), accounts: [idx(e.program === f.p.programs.swap ? f.addresses.swapEventAuthority : e.program === f.p.programs.token ? f.addresses.tokenEventAuthority : f.addresses.eventAuthority)], data: bs58.encode(Buffer.from(e.dataBase64, 'base64')), stackHeight: e.program === f.p.programs.swap ? 3 : 2 })
  const events = expected.events, innerInstructions = [{ index: 2, instructions: [event(events.find(e => e.name === 'OpenLaunchCreated')), { programIdIndex: idx(f.p.programs.swap), accounts: [], data: bs58.encode(Buffer.from([1])), stackHeight: 2 }, event(events.find(e => e.name === 'PoolCreated')), event(events.find(e => e.name === 'LaunchCreated')), event(events.find(e => e.name === 'NativeLaunchCreated'))] }, ...events.filter(e => e.name === 'HoldingCreated').map((e, i) => ({ index: 3 + i, instructions: [event(e)] }))]
  const loaded = review.accounts.slice(tx.message.staticAccountKeys.length), transaction = { slot: 110, transaction: { message: tx.message, signatures: tx.signatures.map(s => bs58.encode(s)) }, meta: { err: null, fee: 10000, preBalances, postBalances, innerInstructions, loadedAddresses: { writable: loaded.filter(x => x.writable).map(x => new PublicKey(x.address)), readonly: loaded.filter(x => !x.writable).map(x => new PublicKey(x.address)) } } }
  for (const { connection } of f.connections) {
    connection.getTransaction = async () => transaction
    connection.getBlockSignatures = async () => ({ parentSlot: 109, blockHeight: 110, blockhash: Keypair.fromSeed(Buffer.alloc(32, 61)).publicKey.toBase58(), previousBlockhash: Keypair.fromSeed(Buffer.alloc(32, 62)).publicKey.toBase58(), signatures: [signature] })
    connection.getMultipleAccountsInfoAndContext = async keys => ({ context: { slot: 111 }, value: keys.map(k => { const a = post.get(k.toBase58()); return a ? { owner: new PublicKey(a.owner), executable: a.executable, lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } : null }) })
  }
  const settle = () => collectOpenLaunchSettlement({ ...f, settlementContext, review, signedTransactionBase64, signature })
  assert.equal((await settle()).status, 'finalized-success')
  for (const { address: h } of plan.postMintHoldings) {
    const original = post.get(h)
    post.delete(h); assert.equal((await settle()).status, 'unresolved'); post.set(h, original)
    post.set(h, { ...original, owner: f.p.programs.launch }); assert.equal((await settle()).status, 'unresolved'); post.set(h, original)
    postBalances[idx(h)]++; assert.equal((await settle()).status, 'unresolved'); postBalances[idx(h)]--
  }
  innerInstructions.pop(); assert.equal((await settle()).status, 'unresolved')
})

test('exact-message launch simulation includes collector among canonical token holdings', async () => {
  const f = selectedLaunchCollectorFixture({ feeModel: 1 }), collector = Keypair.fromSeed(Buffer.alloc(32, 99)).publicKey.toBase58()
  f.request.postMintSetup = { digest: 'a'.repeat(64), manifest: taxHookSetupManifest(f.request.selectedHook), configuration: { feeBps: '100', maxWalletBps: '0', collector } }
  const table = supplementalTable(f); f.supplementalTable = table.plan; f.accounts.set(table.plan.address, table.snapshot)
  for (const { connection } of f.connections) connection.getMinimumBalanceForRentExemption = async () => 100
  const collected = await collectOpenLaunchReview(f), post = new Map(f.accounts)
  for (const a of deriveOpenLaunchPostconditions(collected.settlementContext, { slot: 100, timestamp: 0 }).accounts)
    post.set(a.address, { ...a, lamports: f.accounts.get(a.address)?.lamports ?? '100' })
  const payer = post.get(collected.plan.review.payer)
  payer.lamports = String(BigInt(payer.lamports) - BigInt(collected.plan.review.maxNativeDebitLamports))
  for (const { connection } of f.connections) connection.simulateTransaction = async (tx, options) => {
    assert.equal(Buffer.from(tx.message.serialize()).toString('base64'), collected.plan.review.messageBase64)
    return { context: { slot: 100 }, value: { err: null, unitsConsumed: 100000, accounts: options.accounts.addresses.map(address => {
      const a = post.get(address)
      return a ? { owner: a.owner, executable: a.executable, lamports: Number(a.lamports), data: [a.dataBase64, 'base64'] }
        : { owner: '11111111111111111111111111111111', executable: false, lamports: 0, data: ['', 'base64'] }
    }) } }
  }
  const simulate = () => collectSelectedHookLaunchSimulation({ ...f, ...collected })
  const result = await simulate()
  assert.equal(Object.keys(result.tokenDeltas).length, 7)
  for (const { address } of collected.plan.postMintHoldings) {
    assert.equal(result.tokenDeltas[address], '0')
    const original = post.get(address)
    post.delete(address); await assert.rejects(simulate(), { code: 'SELECTED_HOOK_SIMULATION_UNAVAILABLE' }); post.set(address, original)
  }
})
