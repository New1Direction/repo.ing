// Open (self-serve) launches: create_launch_open_v1 as fixed by the hook-lab feat/open-creation ABI. The compiler takes
// v4's 32 named accounts and exactly 8 remaining ones (no creator authorization, no reviewer), so the creator and the
// server-sealed mint key are the only signers. It sends through one shared, frozen launch lookup table of constant
// addresses, and offers only the fee and cap the chain's menus hold. Synthetic native canary state over the reviewed native
// ELFs (HOOKLAB_NATIVE_ELF_DIR); no RPC, no bank.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, VersionedMessage } from '@solana/web3.js'
import bs58 from 'bs58'
import { compileOpenLaunchReview, compileMaxWalletLaunchReview, openLaunchInventory, openLaunchTableAddresses, OPEN_LAUNCH_DISCRIMINATOR } from '../src/hooklab-max-wallet-launch.mjs'
import { encodeOpenCreationReserved } from '../src/hooklab-launch-config-reserved.mjs'
import { makeCanaryState, localTestEnvironment } from './fixtures/hooklab-canary.mjs'
import { missingArtifactEnv } from './fixtures/hooklab-generated-artifact.mjs'

const skip = missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native ELFs')
const ROLES = ['creator', 'admin', 'upgrade', 'guardian', 'treasury', 'outsider', 'buyer', 'mint', 'config', 'table']
const OWNER_MENUS = { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }
const sha = bytes => createHash('sha256').update(bytes).digest()
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58()
function withLocalAcceptance(run) {
  const env = localTestEnvironment(), saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { return run() } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
}
// A prepared mint (policy, registry, the creator's own launch config) on a native launch Config with open creation on.
function openState({ reserved = { native: true, open: true, ...OWNER_MENUS }, capBps = 200 } = {}) {
  const roles = Object.fromEntries(ROLES.map(r => [r, Keypair.generate().publicKey.toBase58()]))
  const state = makeCanaryState({ elfDirectory: process.env.HOOKLAB_NATIVE_ELF_DIR, roles, blockhash: bs58.encode(Keypair.generate().publicKey.toBuffer()), native: true, capBps })
  const programs = JSON.parse(state.profile.json).programs, configAddress = pda(programs.launch, Buffer.from('config'))
  const config = state.accounts.get(configAddress), bytes = Buffer.from(config.dataBase64, 'base64')
  encodeOpenCreationReserved(reserved).copy(bytes, 186); config.dataBase64 = bytes.toString('base64')
  return { state, roles, programs, configAddress, configBytes: () => Buffer.from(state.accounts.get(configAddress).dataBase64, 'base64') }
}
// The shared launch table as the owner's launch-table stage leaves it: the constant addresses, frozen, active.
function sharedTable(addresses, { frozen = true, extra = [] } = {}) {
  const all = [...addresses, ...extra], data = Buffer.alloc(56 + 32 * all.length)
  data.writeUInt32LE(1); data.writeBigUInt64LE(0xffffffffffffffffn, 4); data.writeBigUInt64LE(50n, 12)
  if (!frozen) { data[21] = 1; Keypair.generate().publicKey.toBuffer().copy(data, 22) }
  all.forEach((address, i) => new PublicKey(address).toBuffer().copy(data, 56 + i * 32))
  return { address: Keypair.generate().publicKey.toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: data.toString('base64'), sha256: sha(data).toString('hex') }
}
// The open launch input over the state: the creator's own request (no reviewer), its exact inventory, two signatures.
function openInput(world, { request = {}, table, uri } = {}) {
  const { state } = world, base = state.launchInputNow(), { reviewer, schema, ...rest } = state.request
  const r = { ...rest, schema: 'repoing/open-launch-request/1', ...(uri === undefined ? {} : { uri }), ...request }
  const { inventory } = openLaunchInventory(state.profile, r, world.configBytes())
  const { authorization, ...reviewedStateHashes } = base.reviewedStateHashes
  return { ...base, request: r, reviewedStateHashes, nativeLaunches: true,
    observations: base.observations.map(o => ({ ...o, accounts: inventory.map(address => ({ address, account: state.accounts.get(address) ?? null })) })),
    recentBlockhash: { ...base.recentBlockhash, networkFeeLamports: '10000' },
    lookupTable: table ?? sharedTable(openLaunchTableAddresses(state.profile, world.configBytes())) }
}

test('an open launch compiles to create_launch_open_v1: 40 accounts, only the creator and the mint sign, the open control hash', { skip }, () => withLocalAcceptance(() => {
  const world = openState(), { state, roles, programs } = world, plan = compileOpenLaunchReview(openInput(world))
  const message = VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64'))
  assert.deepEqual(plan.review.requiredSigners, [roles.creator, roles.mint])
  assert.equal(plan.review.operation, 'open-launch')
  const ix = plan.canonicalInstruction, data = Buffer.from(ix.dataHex, 'hex')
  assert.deepEqual([...data.subarray(0, 8)], [51, 106, 16, 21, 31, 133, 167, 85])
  assert.deepEqual(OPEN_LAUNCH_DISCRIMINATOR, sha(Buffer.from('global:create_launch_open_v1')).subarray(0, 8))
  assert.equal(ix.accounts.length, 40)
  const a = plan.addresses
  assert.deepEqual(ix.accounts.slice(32).map(m => [m.address, m.signer, m.writable]), [[a.launchGovernance, false, false], [a.gateProgramData, false, false], [programs.gate, false, false],
    [a.gateHookSigner, false, false], [a.registry, false, false], [a.policy, false, false], [a.launch, false, false], [a.inclusiveFeePolicy, false, true]])
  assert.equal(ix.accounts[29].address, roles.config, 'the creator\'s own launch config is account 30')
  for (const absent of [a.authorization, roles.admin]) assert.ok(!plan.review.accounts.some(x => x.address === absent), `${absent} is not in an open launch`)
  // expected_control_hash = sha256("hook-lab:open-creation-controls:v1" || launch program || launch governance commitment)
  assert.equal(plan.commitments.creationControl, sha(Buffer.concat([Buffer.from('hook-lab:open-creation-controls:v1'), new PublicKey(programs.launch).toBuffer(), Buffer.from(plan.commitments.launchGovernance, 'hex')])).toString('hex'))
  assert.equal(message.addressTableLookups.length, 1); assert.equal(message.addressTableLookups[0].accountKey.toBase58(), plan.review.lookupTables[0].address)
  assert.ok(1 + 64 * 2 + message.serialize().length <= 1232, 'fits one packet')
  assert.deepEqual({ creatorFeeBps: plan.creatorFeeBps, capBps: plan.policy.capBps, quoteForm: plan.quoteForm }, { creatorFeeBps: 100, capBps: 200, quoteForm: 1 })
  // Deterministic, and the v4 custom launch over the same state still compiles (existing coins and owner-approved launches).
  assert.equal(compileOpenLaunchReview(openInput(world, { table: plan.review.lookupTables[0] })).review.messageBase64, plan.review.messageBase64)
  assert.ok(compileMaxWalletLaunchReview({ ...state.launchInputNow(), nativeLaunches: true }))
}))

test('the shared launch table holds only the addresses every open launch shares', { skip }, () => withLocalAcceptance(() => {
  const world = openState(), { state, roles, programs } = world, addresses = openLaunchTableAddresses(state.profile, world.configBytes())
  const { addresses: a } = openLaunchInventory(state.profile, openInput(world).request, world.configBytes())
  for (const own of [roles.creator, roles.mint, roles.config, a.launch, a.pool, a.lpMint, a.policy, a.registry, a.inclusiveFeePolicy, a.authorization, programs.launch]) assert.ok(!addresses.includes(own), own)
  for (const shared of [world.configAddress, roles.treasury, a.swapConfig, a.launchGovernance, a.gateProgramData, programs.gate, programs.swap, programs.token]) assert.ok(addresses.includes(shared), shared)
  assert.deepEqual(addresses, [...addresses].sort())
}))

test('refused: open creation off, a fee or cap not on the menu, another payer, a table that is not the frozen shared one, too long a URI', { skip }, () => withLocalAcceptance(() => {
  const refuses = (world, options, pattern) => assert.throws(() => compileOpenLaunchReview(openInput(world, options)), pattern)
  refuses(openState({ reserved: { native: true, open: false, ...OWNER_MENUS } }), {}, /Open creation is off/)
  refuses(openState({ reserved: { native: true, open: true, creatorFeeBps: [50, 200], capBps: [100, 200] } }), {}, /creator fee is not on the on-chain menu/)
  refuses(openState({ reserved: { native: true, open: true, creatorFeeBps: [100], capBps: [100, 500] } }), {}, /wallet cap is not on the on-chain menu/)
  refuses(openState({ reserved: { native: false, open: true, ...OWNER_MENUS } }), {}, /native launches are off/i)
  const world = openState(), addresses = openLaunchTableAddresses(world.state.profile, world.configBytes())
  refuses(world, { request: { feePayer: world.roles.outsider } }, /Preparation intent\/profile differs|creator pays/)   // the preparation binds the payer too
  refuses(world, { table: sharedTable(addresses, { frozen: false }) }, /shared launch table/)
  refuses(world, { table: sharedTable(addresses, { extra: [world.roles.outsider] }) }, /shared launch table/)
  refuses(world, { table: sharedTable(addresses.slice(1)) }, /shared launch table/)
  refuses(world, { uri: `https://repo.ing/${'x'.repeat(183)}` }, /packet/)   // 200 bytes: allowed by the program, too long for one packet here
}))
