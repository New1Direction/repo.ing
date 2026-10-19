// Native-SOL launches end to end on the reviewed hook-lab feat/native-sol e357fdf ELFs, in one isolated in-memory bank
// (LiteSVM via solders, synthetic throwaway keys, no RPC): the owner-driver stage turns the switch on, the website compiles
// create_launch_custom_v4, the owner agent co-signs it only with the switch on, the launch settles from its exact receipt,
// swap_v2 buys pay the creator fee into the launch account, and only the creator claims it, settled from exact lamport
// deltas and read back from jsonb after a restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import BN from 'bn.js'
import bs58 from 'bs58'
import { AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { compileMaxWalletLaunchReview } from '../src/hooklab-max-wallet-launch.mjs'
import { collectMaxWalletLaunchSettlement } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { validateMaxWalletOperatorBindings } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { NATIVE_ELF, loadNativeArtifacts } from '../src/hooklab-native-pins.mjs'
import { claimCreatorFeesSol, launchIsNative, poolIsNative } from '../src/hooklab-native-launch.mjs'
import { readNativeClaimStatus } from '../src/hooklab-native-claim.mjs'
import { nativeClaimResolver } from '../src/hooklab-native-claim-resolver.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { jsonbRoundTrip } from './fixtures/jsonb-round-trip.mjs'
import { STAGES } from '../src/hooklab-owner-driver/context.mjs'
import { decodeLookupTable, verifyLaunchSignRequest } from '../src/hooklab-owner-agent.mjs'
import { readLiveNativeLaunches } from '../src/hooklab-launch-bounds.mjs'
import { PROGRAMS, QUOTE_MINT } from '../src/hooklab-owner-driver/pins.mjs'
import { makeCanaryState, canaryCollectorBindings, localTestEnvironment, isolatedSvm, syntheticGenesis, pk, pda } from './fixtures/hooklab-canary.mjs'
import { missingArtifactEnv } from './fixtures/hooklab-generated-artifact.mjs'

const sha = x => createHash('sha256').update(x).digest('hex')
const elfDirectory = process.env.HOOKLAB_NATIVE_ELF_DIR
const skip = process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native-SOL ELFs (hook-lab e357fdf); HOOKLAB_CANARY_PYTHONPATH must hold solders 0.29.0')
const rentFor = bytes => (bytes + 128) * 6960
// Boot clocks of two server processes (limits.nowMs); reviews use the injected clock.
const BOOT = 1800000000000, RESTARTED = BOOT + 3600000
const names = { launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet', token: 'bordrless_token' }
// The gate and token are unchanged by the native port: their reviewed pins are the inclusive profile's.
const reviewed = JSON.parse(readFileSync(new URL('../vendor/hooklab-event-abi/inclusive-max-wallet-candidate/offline-builder-profile.json', import.meta.url)))

// One bank, its synthetic state and a two-provider transport over it (fee and simulation answers fixed; every byte real).
async function bank(t) {
  assert.ok(elfDirectory, 'HOOKLAB_NATIVE_ELF_DIR is required for the native release check; skipping is not a release gate')
  const saved = Object.fromEntries(Object.keys(localTestEnvironment()).map(k => [k, process.env[k]]))
  Object.assign(process.env, localTestEnvironment())
  const svm = isolatedSvm(), dir = mkdtempSync(path.join(tmpdir(), 'hooklab-native-svm-'))
  t.after(() => { svm.close(); rmSync(dir, { recursive: true, force: true }); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } })
  const pin = role => NATIVE_ELF[role]?.sha256 ?? (role === 'token' ? reviewed.dependencyObservation.tokenElfSha256 : reviewed.elfSha256[role])
  const init = await svm.call('init', { scope: 'isolated-canary-svm/1', programs: Object.entries(names).map(([role, name]) => ({ address: PROGRAMS[role], path: `${elfDirectory}/${name}.so`, sha256: pin(role) })) })
  const state = makeCanaryState({ elfDirectory, roles: init.roles, blockhash: init.blockhash, native: true }), roles = init.roles
  await svm.call('set', { accounts: [...state.accounts].map(([address, account]) => ({ address, account })).sort((x, y) => Number(x.account.executable) - Number(y.account.executable)) })
  const executed = new Map()
  const send = async (messageBase64, options = {}) => { const r = await svm.call('send', { messageBase64, ...options }); if (r.historyPresent) executed.set(r.signature, r); return r }
  // Everything the bank holds at the launch inventory too (the system program is a builtin account there, as on mainnet).
  const inventory = state.launchInput.observations[0].accounts.map(x => x.address)
  async function sync() { const r = await svm.call('get', { addresses: [...new Set([...state.accounts.keys(), ...Object.values(state.addresses), ...inventory, roles.mint, roles.outsider])] }); for (const row of r.accounts) if (row.account) state.accounts.set(row.address, row.account); return r }
  const account = async address => (await svm.call('get', { addresses: [address] })).accounts[0].account
  const connection = i => ({ rpcEndpoint: [localTestEnvironment().HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY, localTestEnvironment().HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY][i],
    getGenesisHash: async () => syntheticGenesis, getSlot: async () => 100, getBlockHeight: async () => 100,
    getMinimumBalanceForRentExemption: async bytes => rentFor(bytes),
    getAccountInfo: async key => { const a = await account(key.toBase58()); return a ? { owner: pk(a.owner), executable: a.executable, lamports: Number(a.lamports), data: Buffer.from(a.dataBase64, 'base64') } : null },
    getMultipleAccountsInfoAndContext: async keys => { const s = await svm.call('get', { addresses: keys.map(k => k.toBase58()) })
      return { context: { slot: s.slot }, value: s.accounts.map(({ account: v }) => v ? { owner: pk(v.owner), executable: v.executable, lamports: Number(v.lamports), data: Buffer.from(v.dataBase64, 'base64') } : null) } },
    getLatestBlockhashAndContext: async () => ({ context: { slot: 100 }, value: { blockhash: (await svm.call('get', { addresses: [] })).blockhash, lastValidBlockHeight: 250 } }),
    isBlockhashValid: async () => ({ context: { slot: 100 }, value: true }), getFeeForMessage: async m => ({ context: { slot: 100 }, value: 5000 * m.header.numRequiredSignatures }),
    simulateTransaction: async () => ({ context: { slot: 100 }, value: { err: null, logs: [], unitsConsumed: 1 } }),
    getTransaction: async signature => { const r = executed.get(signature); if (!r) return null; const signed = VersionedTransaction.deserialize(Buffer.from(r.wireBase64, 'base64'))
      return { slot: r.slot, transaction: { message: signed.message, signatures: signed.signatures.map(s => bs58.encode(s)) }, meta: { err: r.error, fee: r.fee, preBalances: [...r.preBalances], postBalances: [...r.postBalances],
        loadedAddresses: Object.fromEntries(Object.entries(r.loadedAddresses).map(([k, v]) => [k, v.map(pk)])), logMessages: [...r.logs],
        innerInstructions: r.innerInstructions.map(g => ({ index: g.index, instructions: g.instructions.map(({ dataBase64, ...ix }) => ({ ...ix, accounts: [...ix.accounts], data: bs58.encode(Buffer.from(dataBase64, 'base64')) })) })) } } },
    getBlockSignatures: async () => ({ blockhash: roles.table, previousBlockhash: roles.config, parentSlot: 99, blockHeight: 100, signatures: [...executed.keys()] }) })
  const connections = state.profile.providers.map((provider, i) => ({ provider, connection: connection(i) }))
  const readers = [0, 1].map(i => ({ provider: i ? 'secondary' : 'primary', url: connections[i].connection.rpcEndpoint, connection: connections[i].connection }))
  const driver = to => ({ config: { decisions: { computeUnitPriceMicroLamports: { value: '0', approved: true } } }, readers, genesis: syntheticGenesis, network: 'local-test',
    roles: { admin: roles.admin, payer: roles.guardian }, programs: PROGRAMS, quoteMint: QUOTE_MINT, envelope: { expectedSha256: state.profile.expectedSha256 }, journal: { dir }, options: { to } })
  const lookup = new AddressLookupTableAccount({ key: pk(state.lookupTable.address), state: AddressLookupTableAccount.deserialize(Buffer.from(state.lookupTable.dataBase64, 'base64')) })
  return { svm, state, roles, send, sync, account, connections, driver, executed, lookup }
}
const bytesOf = a => Buffer.from(a.dataBase64, 'base64')
const logs = r => `${r.error}\n${r.logs.join('\n')}`

test('native launches end to end on the reviewed ELFs: switch, v4 launch and its receipt', { skip, timeout: 180000 }, async t => {
  const b = await bank(t), { state, roles, send, sync } = b, a = state.addresses
  // Before the switch the website compiles v3 exactly as today, flag or no flag.
  const before = compileMaxWalletLaunchReview(state.launchInputNow())
  assert.equal(before.quoteForm, undefined)
  assert.deepEqual(compileMaxWalletLaunchReview({ ...state.launchInputNow(), nativeLaunches: true }).review, before.review, 'switch off: the flag changes nothing')

  // The owner-driver stage reads byte 186, compiles the governed switch and the bank executes it.
  const stage = STAGES['native-launches'], built = await stage.build(b.driver('on'), null)
  assert.equal(built.blocked, undefined, built.blocked)
  const flip = await send(built.review.messageBase64); assert.equal(flip.error, null, logs(flip))
  assert.equal(bytesOf(await b.account(a.launchConfig))[186], 1)
  assert.deepEqual(await stage.verify(b.driver('on'), built.expect), ['native launches ON (launch Config byte 186 = 1)', `launch governance commitment ${built.expect.commitment}`])
  assert.match((await stage.build(b.driver('on'), null)).blocked, /already ON .* would still bump the launch governance revision/, 'a no-op flip is refused')
  await sync()

  // The v3 review made before the flip is stale: the program refuses a bridged launch while the switch is on.
  const stale = await send(before.review.messageBase64); assert.notEqual(stale.error, null); assert.match(logs(stale), /BridgedCustomLaunchClosed/)
  // A server without HOOK_NATIVE_LAUNCHES_ENABLED compiles nothing now; with it, create_launch_custom_v4.
  assert.throws(() => compileMaxWalletLaunchReview(state.launchInputNow()), /Native launches are on chain; this server is not enabled for them/)
  const input = { ...state.launchInputNow(), nativeLaunches: true }, plan = compileMaxWalletLaunchReview(input)
  assert.equal(plan.quoteForm, 1)
  const { coders } = loadNativeArtifacts(), decoded = coders.launch.instruction.decode(Buffer.from(plan.canonicalInstruction.dataHex, 'hex'))
  assert.equal(decoded.name, 'create_launch_custom_v4'); assert.equal(decoded.data.quote_form, 1); assert.equal(decoded.data.args.virtual_quote.toString(), '53251917070')
  assert.deepEqual(plan.canonicalInstruction.accounts, before.canonicalInstruction.accounts, 'v4 has exactly v3\'s accounts, so the per-launch lookup table is unchanged')

  // The owner agent, from its own reads only (the switch from both providers, the table, the mint policy), co-signs this
  // v4 message, and would refuse it with the switch read off.
  const nativeLaunches = await readLiveNativeLaunches(b.connections.map(c => c.connection))
  assert.equal(nativeLaunches, true)
  const policyAccount = await b.account(a.policy), r = state.request
  const agent = switchOn => verifyLaunchSignRequest({ signRequest: { messageBase64: plan.review.messageBase64, messageSha256: plan.review.messageSha256, signer: roles.admin,
    validUntilSlot: String(plan.review.validUntilSlot), lastValidBlockHeight: String(plan.review.lastValidBlockHeight) },
    invited: { creator: r.creator, name: r.name, symbol: r.symbol, uri: r.uri, creatorFeeBps: r.creatorFeeBps, capBps: r.capBps, virtualQuote: r.virtualQuote },
    approved: { launchProgram: PROGRAMS.launch, gateProgram: PROGRAMS.gate, swapProgram: PROGRAMS.swap, quoteMint: QUOTE_MINT, admin: roles.admin, creatorFeeChoices: [100], capChoices: [200], feeModel: 2 },
    lookupTables: plan.review.lookupTables.map(t => decodeLookupTable(t.address, Buffer.from(t.dataBase64, 'base64'))),
    policy: { address: a.policy, owner: policyAccount.owner, data: bytesOf(policyAccount) }, live: { slot: 100, blockHeight: 100 }, nativeLaunches: switchOn })
  assert.equal(agent(nativeLaunches).quoteForm, 1)
  assert.throws(() => agent(false), /native launches are off on chain: refusing create_launch_custom_v4/)

  // The operator dossier is collected over the state the review read (after the switch, as production re-collects it).
  const bindings = canaryCollectorBindings(state)
  const launched = await send(plan.review.messageBase64); assert.equal(launched.error, null, logs(launched))
  await sync()
  const pool = bytesOf(state.accounts.get(a.pool)), launch = bytesOf(state.accounts.get(a.launch))
  assert.equal(pool[351], 1); assert.equal(launch[560], 1); assert.ok(poolIsNative(pool) && launchIsNative(launch))
  assert.equal(Number(state.accounts.get(a.launch).lamports), rentFor(565), 'the launch account starts at rent')

  // Settlement from the exact receipt: the v3 checks plus the flags and NativeLaunchCreated.
  const { config } = validateMaxWalletOperatorBindings({ ...bindings, connections: b.connections })
  const settle = (alter = x => x) => collectMaxWalletLaunchSettlement({ ...bindings, connections: b.connections, review: plan.review, signedTransactionBase64: launched.wireBase64, signature: launched.signature,
    settlementContext: alter({ schema: 'repoing/max-wallet-launch-settlement-context/1', configurationSha256: sha(JSON.stringify(config)), compilationInput: input }) })
  const settled = await settle()
  assert.equal(settled.status, 'finalized-success', JSON.stringify(settled))
  const v3Context = ctx => ({ ...ctx, compilationInput: { ...ctx.compilationInput, nativeLaunches: undefined } })
  assert.equal((await settle(v3Context)).status, 'unresolved', 'the same receipt never settles as a bridged launch')
  // E2-1: NativeLaunchCreated is part of the receipt; a changed or missing one does not settle.
  const disc = Buffer.from(loadNativeArtifacts().idls.launch.events.find(e => e.name === 'NativeLaunchCreated').discriminator), receipt = b.executed.get(launched.signature)
  const nativeEvent = ix => Buffer.from(ix.dataBase64, 'base64').subarray(8, 16).equals(disc)
  const changed = structuredClone(receipt), dropped = structuredClone(receipt)
  for (const g of changed.innerInstructions) for (const ix of g.instructions) if (nativeEvent(ix)) { const d = Buffer.from(ix.dataBase64, 'base64'); d[d.length - 1] ^= 1; ix.dataBase64 = d.toString('base64') }
  for (const g of dropped.innerInstructions) g.instructions = g.instructions.filter(ix => !nativeEvent(ix))
  assert.ok(receipt.innerInstructions.some(g => g.instructions.some(nativeEvent)), 'the launch emitted NativeLaunchCreated')
  for (const [evidence, label] of [[changed, 'changed virtual quote'], [dropped, 'no NativeLaunchCreated']]) {
    b.executed.set(launched.signature, evidence); assert.equal((await settle()).status, 'unresolved', label)
  }
  b.executed.set(launched.signature, receipt); assert.equal((await settle()).status, 'finalized-success')
  t.diagnostic(`v4 launch ${launched.signature}: ${launched.units} CU, ${launched.wireBytes} wire bytes; pool byte 351 = 1, launch byte 560 = 1`)
  b.state.native = { plan, launched }
})

// swap_v2 buy of a native coin, built here from the reviewed IDL (the website's trade builder is separate work): the trader
// pays lamports from its own wallet; the gate's slice, the launch hook's extras and the inclusive policy follow.
function swapV2Buy(state, { trader, lamports }) {
  const p = JSON.parse(state.profile.json), a = hookCoinAddresses(p, state.request.mint), { swap: S, launch: L, gate: G, token: T } = p.programs
  const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey: pk(pubkey), isWritable, isSigner })
  const keys = [meta(trader, true, true), meta(a.swapConfig), meta(a.pool, true), meta(state.request.mint), meta(p.quoteMint), meta(a.baseVault, true),
    meta(pda(T, 'holding', pk(state.request.mint).toBuffer(), pk(trader).toBuffer()), true), meta(trader, true), meta(L), meta(a.swapHookSigner), meta(T), meta(a.tokenEventAuthority),
    meta('11111111111111111111111111111111'), meta(a.swapEventAuthority), meta(S),
    meta(G), meta(a.gateHookSigner), meta(a.policy), meta(a.launch), meta(a.launch, true), meta(a.launchQuote, true), meta(a.holderVault, true), meta(a.kitConfig), meta(a.inclusiveFeePolicy)]
  const data = loadNativeArtifacts().coders.swap.instruction.encode('swap_v2', { args: { direction: 1, amount_in: new BN(lamports), min_amount_out: new BN(1), in_hook_accounts: 0, out_hook_accounts: 4, hook_data: Buffer.alloc(0) } })
  return new TransactionInstruction({ programId: pk(S), keys, data })
}

// A bank with the switch on and one native coin launched through the real route (owner-driver stage, then v4).
async function nativeCoin(t) {
  const b = await bank(t), { state, send, sync } = b
  const flip = await send((await STAGES['native-launches'].build(b.driver('on'), null)).review.messageBase64); assert.equal(flip.error, null, logs(flip))
  await sync()
  const plan = compileMaxWalletLaunchReview({ ...state.launchInputNow(), nativeLaunches: true }), launched = await send(plan.review.messageBase64)
  assert.equal(launched.error, null, logs(launched)); await sync()
  return b
}

test('creator fees: swap_v2 buys pay the launch account, only the creator claims exactly what it holds above rent', { skip, timeout: 180000 }, async t => {
  const b = await nativeCoin(t), { state, roles, send, sync } = b, a = state.addresses, mint = roles.mint
  const lamportsOf = async address => BigInt((await b.account(address)).lamports), rent = BigInt(rentFor(565))
  const programs = JSON.parse(state.profile.json).programs, status = () => readNativeClaimStatus({ connection: b.connections[0].connection, mint, programs })
  assert.deepEqual(await status(), { mint, native: true, creator: roles.creator, claimableLamports: '0' })

  // Two buys by another wallet under the cap: the creator's share of each fee lands on the launch account as lamports.
  await b.svm.call('set', { accounts: [state.holding(mint, roles.outsider, 0)].map(address => ({ address, account: state.accounts.get(address) })) })
  for (const lamports of [500_000_000, 250_000_000]) {
    const message = new TransactionMessage({ payerKey: pk(roles.outsider), recentBlockhash: (await b.svm.call('get', { addresses: [] })).blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), swapV2Buy(state, { trader: roles.outsider, lamports })] }).compileToV0Message([b.lookup])
    const bought = await send(Buffer.from(message.serialize()).toString('base64')); assert.equal(bought.error, null, logs(bought))
  }
  await sync()
  const launch = loadNativeArtifacts().coders.launch.accounts.decode('Launch', bytesOf(state.accounts.get(a.launch)))
  const due = await lamportsOf(a.launch) - rent
  assert.ok(due > 0n); assert.equal(due, BigInt(launch.creator_fees_accrued.toString()), 'everything above rent is the creator fees the buys paid')
  assert.equal((await status()).claimableLamports, String(due))

  // Only the creator: the website refuses anyone else, and so does the program.
  const bindings = canaryCollectorBindings(state)
  const resolverAt = nowMs => nativeClaimResolver({ ...bindings, connections: b.connections, clock: () => 1000,
    limits: { nowMs, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 0, reviewExpiresAtMs: 0, maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '10000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' } })
  await assert.rejects(resolverAt(BOOT).prepare({ owner: roles.outsider, stage: 'native-claim', intent: { mint } }), error => error.code === 'HOOKLAB_USER_REFUSAL' && /Only the wallet that launched this coin/.test(error.message))
  const direct = new TransactionMessage({ payerKey: pk(roles.outsider), recentBlockhash: (await b.svm.call('get', { addresses: [] })).blockhash,
    instructions: [claimCreatorFeesSol({ launchProgram: programs.launch, creator: roles.outsider, mint })] }).compileToV0Message()
  const stranger = await send(Buffer.from(direct.serialize()).toString('base64')); assert.notEqual(stranger.error, null); assert.match(logs(stranger), /NotCreator/)
  assert.equal(await lamportsOf(a.launch), rent + due, 'a refused claim moves nothing')

  // The creator's claim: reviewed, stored as jsonb, revalidated after a restart, signed, sent once, settled.
  const prepared = await resolverAt(BOOT).prepare({ owner: roles.creator, stage: 'native-claim', intent: { mint } })
  assert.equal(prepared.review.operation, 'hooklab-native-claim'); assert.deepEqual(prepared.review.requiredSigners, [roles.creator])
  const stored = jsonbRoundTrip({ review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext })
  assert.notEqual(JSON.stringify(stored.settlementContext), JSON.stringify(prepared.settlementContext), 'jsonb reorders keys')
  assert.equal((await resolverAt(RESTARTED).revalidate({ owner: roles.creator, stage: 'native-claim', ...stored })).messageSha256, prepared.messageSha256)
  const creatorBefore = await lamportsOf(roles.creator)
  const claimed = await send(prepared.review.messageBase64); assert.equal(claimed.error, null, logs(claimed))
  const reconcile = (nowMs, over = {}) => resolverAt(nowMs).reconcile({ ...stored, ...over, signedTransactionBase64: claimed.wireBase64, signature: claimed.signature })
  for (const nowMs of [BOOT, RESTARTED]) {
    const settled = await reconcile(nowMs)
    assert.equal(settled.status, 'finalized-success', JSON.stringify(settled)); assert.equal(settled.claimedLamports, String(due)); assert.deepEqual(settled.quote, { delivered: String(due) })
  }
  assert.equal(await lamportsOf(a.launch), rent, 'the launch account is back at its rent')
  assert.equal(await lamportsOf(roles.creator) - creatorBefore, due - BigInt(claimed.fee), 'the creator gained exactly the claim less the network fee')
  assert.equal((await status()).claimableLamports, '0')

  // The receipt is checked, not trusted: altered deltas or a missing event do not settle; a changed context does not compile.
  const receipt = b.executed.get(claimed.signature), launchIndex = receipt.keys.indexOf(a.launch)
  const shifted = structuredClone(receipt); shifted.postBalances[launchIndex] += 1
  const silent = structuredClone(receipt); for (const g of silent.innerInstructions) g.instructions = []
  for (const [evidence, label] of [[shifted, 'launch left above rent'], [silent, 'no CreatorFeesClaimedSol']]) {
    b.executed.set(claimed.signature, evidence); assert.equal((await reconcile(RESTARTED)).status, 'unresolved', label)
  }
  b.executed.set(claimed.signature, receipt)
  const other = jsonbRoundTrip(stored.settlementContext); other.compilationInput.request.mint = roles.config
  assert.equal((await reconcile(RESTARTED, { settlementContext: other })).status, 'unresolved', 'another coin')
  await assert.rejects(resolverAt(RESTARTED).prepare({ owner: roles.creator, stage: 'native-claim', intent: { mint } }), /Nothing to claim yet/)
  t.diagnostic(`buys paid the creator ${due} lamports; claim ${claimed.signature}: ${claimed.units} CU, fee ${claimed.fee}`)
})
