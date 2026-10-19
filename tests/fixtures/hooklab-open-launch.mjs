// Synthetic open (self-serve) launch state: a prepared mint on a native launch Config with open creation on and the
// owner's menus, the owner's shared launch table, operator bindings that pin it, and two read-only RPC fakes over the
// same accounts. Built on the native canary state (tests/fixtures/hooklab-canary.mjs); no keys are used for signing.
import { createHash } from 'node:crypto'
import { Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { openLaunchInventory, openLaunchTableAddresses } from '../../src/hooklab-max-wallet-launch.mjs'
import { encodeOpenCreationReserved } from '../../src/hooklab-launch-config-reserved.mjs'
import { homedir } from 'node:os'
import path from 'node:path'
import { makeCanaryState, canaryCollectorBindings, localTestEnvironment } from './hooklab-canary.mjs'
import { missingArtifactEnv } from './hooklab-generated-artifact.mjs'

// The open-creation build's launch ELF (hook-lab 36dd07e) beside the native ELFs (swap, gate and token are unchanged).
export const OPEN_ELF_DIR = process.env.HOOKLAB_OPEN_ELF_DIR ?? path.join(homedir(), 'Documents/ChatGPT/hooks-local-state/native-open-36dd07e/elf')
export const OPEN_SKIP = missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native ELFs') || false

export const OWNER_MENUS = Object.freeze({ creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
const ROLES = ['creator', 'admin', 'upgrade', 'guardian', 'treasury', 'outsider', 'buyer', 'mint', 'config', 'table']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58()

export function withLocalAcceptance(run) {
  const env = localTestEnvironment(), saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  const restore = () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v }
  let result
  try { result = run() } catch (error) { restore(); throw error }
  if (result && typeof result.then === 'function') return result.finally(restore)
  restore(); return result
}
// The shared launch table as the owner's launch-table stage leaves it: the constant addresses, frozen, active.
export function sharedTable(addresses, { frozen = true, extra = [], address = Keypair.generate().publicKey.toBase58() } = {}) {
  const all = [...addresses, ...extra], data = Buffer.alloc(56 + 32 * all.length)
  data.writeUInt32LE(1); data.writeBigUInt64LE(0xffffffffffffffffn, 4); data.writeBigUInt64LE(50n, 12)
  if (!frozen) { data[21] = 1; Keypair.generate().publicKey.toBuffer().copy(data, 22) }
  all.forEach((a, i) => new PublicKey(a).toBuffer().copy(data, 56 + i * 32))
  return { address, owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: data.toString('base64'), sha256: sha(data) }
}
// reserved: the launch Config's open-creation state; ceiling: its max_creator_fee_bps (the canary state's 100 otherwise).
// The shared table is added to the accounts.
export function openState({ reserved = { native: true, open: true, ...OWNER_MENUS }, capBps = 200, ceiling = null } = {}) {
  const roles = Object.fromEntries(ROLES.map(r => [r, Keypair.generate().publicKey.toBase58()]))
  const blockhash = bs58.encode(Keypair.generate().publicKey.toBuffer())
  const state = makeCanaryState({ elfDirectory: process.env.HOOKLAB_NATIVE_ELF_DIR, openElfDirectory: OPEN_ELF_DIR, roles, blockhash, native: true, capBps })
  const programs = JSON.parse(state.profile.json).programs, configAddress = pda(programs.launch, Buffer.from('config'))
  const config = state.accounts.get(configAddress), bytes = Buffer.from(config.dataBase64, 'base64')
  encodeOpenCreationReserved(reserved).copy(bytes, 186)
  if (ceiling !== null) { const coder = state.bindings.launch.coder, value = coder.accounts.decode('Config', bytes)
    coder.types.encode('Config', { ...value, max_creator_fee_bps: ceiling }).copy(bytes, 8) }
  config.dataBase64 = bytes.toString('base64')
  const configBytes = () => Buffer.from(state.accounts.get(configAddress).dataBase64, 'base64')
  const table = sharedTable(openLaunchTableAddresses(state.profile, configBytes()))
  state.accounts.set(table.address, { address: table.address, owner: table.owner, dataBase64: table.dataBase64, lamports: '10000000', executable: false })
  return { state, roles, programs, configAddress, configBytes, blockhash, table }
}
// The open launch request for the state's prepared mint: the creator's own coin, no reviewer.
export function openRequest(world, overrides = {}) {
  const { reviewer, schema, ...rest } = world.state.request
  return { ...rest, schema: 'repoing/open-launch-request/1', ...overrides }
}
// The compiler's input over the state as it is now (two signatures: creator and mint).
export function openInput(world, { request = {}, table, uri } = {}) {
  const { state } = world, base = state.launchInputNow(), r = openRequest(world, { ...(uri === undefined ? {} : { uri }), ...request })
  const { inventory } = openLaunchInventory(state.profile, r, world.configBytes())
  const { authorization, ...reviewedStateHashes } = base.reviewedStateHashes
  return { ...base, request: r, reviewedStateHashes, nativeLaunches: true,
    observations: base.observations.map(o => ({ ...o, accounts: inventory.map(address => ({ address, account: state.accounts.get(address) ?? null })) })),
    recentBlockhash: { ...base.recentBlockhash, networkFeeLamports: '10000' }, lookupTable: table ?? world.table }
}
// Operator bindings that pin both governances (as production does) and the shared launch table.
export function openBindings(world) {
  const bindings = canaryCollectorBindings(world.state, { governance: true })
  return { ...bindings, config: { ...bindings.config, launchLookupTable: { address: world.table.address, sha256: world.table.sha256 } } }
}
// Two read-only providers over the state's accounts, at slot and height 100, with the state's blockhash valid to 250.
export function openConnections(world) {
  const { state } = world, e = localTestEnvironment(), genesisHash = JSON.parse(state.profile.json).genesisHash
  const transport = () => ({ getGenesisHash: async () => genesisHash, getSlot: async () => 100, getBlockHeight: async () => 100,
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: 100 }, value: keys.map(k => { const v = state.accounts.get(k.toBase58())
      return v ? { owner: new PublicKey(v.owner), executable: v.executable, lamports: Number(v.lamports), data: Buffer.from(v.dataBase64, 'base64') } : null }) }),
    getLatestBlockhashAndContext: async () => ({ context: { slot: 100 }, value: { blockhash: world.blockhash, lastValidBlockHeight: 250 } }),
    isBlockhashValid: async () => ({ context: { slot: 100 }, value: true }), getMinimumBalanceForRentExemption: async size => (128 + size) * 6960,
    getFeeForMessage: async m => ({ context: { slot: 100 }, value: 5000 * m.header.numRequiredSignatures }) })
  return state.profile.providers.map((provider, i) => ({ provider, connection: { rpcEndpoint: [e.HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY, e.HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY][i], ...transport() } }))
}
// The durable preparation the launch builds on, as the preparation journal holds it for this wallet.
export function openPreparation(world) {
  const base = world.state.launchInputNow().preparationEvidence
  return { wallet: world.roles.creator, profileSha256: base.profileSha256, preparationIntentSha256: base.preparationIntentSha256,
    preparedRequest: world.state.preparationRequest, executionSlot: base.executionSlot, preparedAccountHashes: base.preparedAccountHashes }
}
export const OPEN_LIMITS = Object.freeze({ maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 196, reviewExpiresAtMs: 6000, maxLaunchFeeLamports: '0', maxPoolCreationFeeLamports: '0',
  maxRentLamports: '200000000', maxInstructionDebitLamports: '200000000', maxNetworkFeeLamports: '15000', maxTotalDebitLamports: '200015000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' })
