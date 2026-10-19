// Bundle 3 on a disposable solana-test-validator with the programs at their mainnet IDs, before the upgrade (the bundle-2
// ELFs) and after it (the e357fdf native ELFs): the dry-run generator script, and the production collector, binding
// check and live evidence check. Synthetic roles only; the gate is finalized, both configs carry the approved
// economics and the shared trade table is frozen in genesis. Nothing reaches mainnet.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { ELF_DIR, VALIDATOR, syntheticRoles, startValidator, bootstrapConfigs, finalizeProgram, genesisAccount, cleanup } from './fixtures/hooklab-owner-local.mjs'
import { MAINNET_GENESIS, collectProductionOperatorBundle, productionArtifacts, productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'
import { collectNativeProductionBundle, nativeProductionArtifacts } from '../src/hooklab-production-native-bundle.mjs'
import { NATIVE_ELF, NATIVE_IDL_SHA256 } from '../src/hooklab-native-pins.mjs'
import { sharedTradeAddresses } from '../src/hooklab-owner-launch-tables.mjs'
import { validateMaxWalletOperatorBindings } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { inspectProductionEvidence, parseExecutionDossier } from '../src/hooklab-production-observer.mjs'
import { readProductionEvidence } from '../src/hooklab-production-rpc.mjs'

const NATIVE_ELF_DIR = process.env.HOOKLAB_NATIVE_ELF_DIR ?? path.join(homedir(), 'Documents/ChatGPT/hooks-local-state/native-e357fdf')
const available = existsSync(VALIDATOR) && existsSync(path.join(ELF_DIR, 'bordrless_launch.so')) && existsSync(path.join(NATIVE_ELF_DIR, 'bordrless_launch.so'))
const skip = !available && process.env.HOOKLAB_OWNER_LOCAL_REQUIRED !== 'true' && 'local validator, bundle-2 ELFs or native e357fdf ELFs (HOOKLAB_NATIVE_ELF_DIR) unavailable'
const ROOT = fileURLToPath(new URL('..', import.meta.url)), SCRIPT = path.join(ROOT, 'scripts/hooklab-production-bundle-3.mjs')
const ROLES = ['launch', 'swap'], ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111', LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const flip = hex => `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`
// The approved economics the collector requires (fee ceilings 200, 25% launch share); everything else as mainnet starts.
const APPROVED = { launch: { max_creator_fee_bps: 200, rule_bounds: { max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: 200, min_max_wallet_bps: 1,
  max_max_wallet_bps: 1, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 } }, swap: { launch_protocol_share_bps: 2500 } }
const TRUST_DOMAINS = [{ provider: 'helius', trustDomain: 'helius', origin: 'https://mainnet.helius-rpc.com' },
  { provider: 'solana-labs', trustDomain: 'solana-foundation', origin: 'https://api.mainnet-beta.solana.com' }]

// The shared trade table, frozen (no authority, never deactivated), holding exactly the addresses every trade shares.
function frozenTradeTable() {
  const address = Keypair.generate().publicKey.toBase58(), shared = sharedTradeAddresses(JSON.parse(productionProfileJson(productionArtifacts().base)))
  const header = Buffer.alloc(56); header.writeUInt32LE(1, 0); header.writeBigUInt64LE(0xffffffffffffffffn, 4)
  return { address, shared, row: genesisAccount(address, { lamports: 1000000000, owner: ALT_PROGRAM, data: Buffer.concat([header, ...shared.map(a => new PublicKey(a).toBuffer())]) }) }
}
async function chain(t, { native }) {
  const root = mkdtempSync(path.join(process.env.HOOKLAB_OWNER_SCRATCH ?? tmpdir(), 'hooklab-bundle-3-'))
  const roles = syntheticRoles(), table = frozenTradeTable()
  const builds = native ? { elfDir: NATIVE_ELF_DIR, elfSha256: { launch: NATIVE_ELF.launch.sha256, swap: NATIVE_ELF.swap.sha256 } } : {}
  const validator = await startValidator(root, roles, { ...builds, accounts: [table.row] })
  // Two labelled endpoints of the one validator; their websockets close before it stops so the process can exit.
  const connections = [validator.connection, new Connection(validator.url2, { commitment: 'finalized' })]
  t.after(async () => { for (const c of connections) { try { c._rpcWebSocket?.close() } catch { /* already closed */ } } await validator.stop(); cleanup(root) })
  await bootstrapConfigs(validator.connection, roles, validator.genesisHash, APPROVED)
  await finalizeProgram(validator.connection, roles, 'gate')
  return { root, validator, connections, table, reviewer: roles.admin.publicKey.toBase58(), treasury: roles.treasury.publicKey.toBase58(), upgrade: roles.upgrade.publicKey.toBase58() }
}
// Test-only: the production collector and checks read mainnet only, so present the validator under the reviewed mainnet
// origins and genesis. Every account byte and slot still comes from the validator.
function asMainnet({ connections }) {
  const relabel = (connection, origin) => ({ rpcEndpoint: `${origin}/?api-key=local-validator`, getGenesisHash: async () => MAINNET_GENESIS,
    getSlot: (...args) => connection.getSlot(...args), getMultipleAccountsInfoAndContext: (...args) => connection.getMultipleAccountsInfoAndContext(...args) })
  return connections.map((c, i) => ({ provider: TRUST_DOMAINS[i].provider, connection: relabel(c, TRUST_DOMAINS[i].origin) }))
}
const inputs = (c, connections) => ({ connections, trustDomains: TRUST_DOMAINS, lookupTable: c.table.address, reviewer: c.reviewer, treasury: c.treasury, approvalReference: 'LOCAL-VALIDATOR-TEST' })
async function dryRun(c, out) {
  const args = [SCRIPT, '--local', '--rpc', c.validator.url, '--rpc2', c.validator.url2, '--trade-table', c.table.address, '--reviewer', c.reviewer, '--treasury', c.treasury, ...(out ? ['--out', out] : [])]
  try { const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { cwd: ROOT, timeout: 120000 }); return { code: 0, stdout, stderr } }
  catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr } }
}
// What the server checks at start and on every read: config, profile and dossier bindings, then live account evidence.
async function verifies(bundle, connections) {
  validateMaxWalletOperatorBindings({ config: bundle.config, profile: bundle.profile, dossierJson: bundle.dossierJson, connections })
  const evidence = await readProductionEvidence({ dossierJson: bundle.dossierJson, expectedSha256: bundle.config.dossierSha256, providers: connections, timeoutMs: 10000 })
  assert.equal(evidence.status, 'account-bindings-matched', evidence.reason)
  return evidence
}
async function underLocalAcceptance(genesisHash, run) {
  const env = { NODE_ENV: 'development', HOOK_LOCAL_ACCEPTANCE: 'true', HOOK_LOCAL_ACCEPTANCE_GENESIS: genesisHash, HOOK_WALLET_IDENTITY_ORIGIN: 'https://127.0.0.1:19443',
    HOOK_WALLET_IDENTITY_DATABASE_URL: 'postgresql://localhost/hooks_local_bundle3', HOOK_LOCAL_ACCEPTANCE_RPC_PRIMARY: 'https://127.0.0.1:19444', HOOK_LOCAL_ACCEPTANCE_RPC_SECONDARY: 'https://127.0.0.1:19445' }
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  try { return await run() } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value }
}

test('before the upgrade: the bundle-3 dry run refuses with "programs not upgraded yet" and bundle 2 still verifies', { skip, timeout: 600000 }, async t => {
  const c = await chain(t, { native: false })
  const result = await dryRun(c)
  assert.equal(result.code, 2, result.stdout)
  assert.match(result.stderr, /programs not upgraded yet: launch and swap still run the bundle-2 build/)
  const connections = asMainnet(c)
  await assert.rejects(collectNativeProductionBundle(inputs(c, connections)), /programs not upgraded yet/)
  // Bundle 3's pins on their own are refused by the collector's program check too (the bundle-2 ProgramData is shorter).
  await assert.rejects(collectProductionOperatorBundle({ ...inputs(c, connections), artifacts: nativeProductionArtifacts() }), /launch program data is not an upgradeable-loader program/)
  const bundle2 = await collectProductionOperatorBundle(inputs(c, connections))
  const dossier = JSON.parse(bundle2.dossierJson)
  for (const role of ROLES) assert.equal(dossier.programs.find(p => p.role === role).elfSha256, productionArtifacts().base.elfSha256[role])
  await verifies(bundle2, connections)
})

test('after the upgrade: the dry run builds bundle 3, which verifies only against the native programs', { skip, timeout: 600000 }, async t => {
  const c = await chain(t, { native: true })
  const out = path.join(c.root, 'bundle-3.local.json'), result = await dryRun(c, out)
  assert.equal(result.code, 0, result.stderr)
  const summary = JSON.parse(result.stdout)
  assert.equal(summary.mode, 'local-dry-run'); assert.equal(summary.schema, 'repoing/local-operator-bundle/1'); assert.equal(summary.genesisHash, c.validator.genesisHash)
  assert.equal(summary.sourceCommit, 'e357fdf4a5be0d8baa360ec82028441d298b925b'); assert.equal(sha(readFileSync(out)), summary.bundleSha256)
  for (const role of ROLES) {
    assert.deepEqual(summary.preview.find(p => p.role === role), { role, programData: PublicKey.findProgramAddressSync([new PublicKey(productionArtifacts().base.programs[role]).toBuffer()], new PublicKey(LOADER))[0].toBase58(),
      build: 'native', deploySlot: 0, upgradeAuthority: c.upgrade, trimmedSha256: NATIVE_ELF[role].trimmedSha256, expectedTrimmedSha256: NATIVE_ELF[role].trimmedSha256 })
    assert.deepEqual(summary.programs.find(p => p.role === role), { role, elfSha256: NATIVE_ELF[role].trimmedSha256, elfLength: NATIVE_ELF[role].trimmedLength, upgradeAuthority: c.upgrade })
    assert.equal(summary.idlSha256[role], NATIVE_IDL_SHA256[role])
  }
  // The local bundle is never production evidence; under the local acceptance boundary it verifies against the validator.
  const local = JSON.parse(readFileSync(out))
  assert.throws(() => parseExecutionDossier(JSON.parse(local.dossierJson)), /isolated acceptance configuration/)
  const localProviders = c.connections.map((connection, i) => ({ provider: local.profile.providers[i], connection }))
  const localEvidence = await underLocalAcceptance(c.validator.genesisHash, () => readProductionEvidence({ dossierJson: local.dossierJson, expectedSha256: local.config.dossierSha256, providers: localProviders, timeoutMs: 10000 }))
  assert.equal(localEvidence.status, 'account-bindings-matched', localEvidence.reason)

  // The production path: bundle 3 passes the start-up binding check and the live evidence check.
  const connections = asMainnet(c), { preview, bundle } = await collectNativeProductionBundle(inputs(c, connections))
  assert.equal(bundle.schema, 'repoing/production-operator-bundle/1'); assert.deepEqual(preview.programs.map(p => p.build), ['native', 'native'])
  const profile = JSON.parse(bundle.profile.json), dossier = JSON.parse(bundle.dossierJson)
  for (const role of ROLES) {
    assert.equal(profile.idlSha256[role], NATIVE_IDL_SHA256[role]); assert.equal(profile.elfSha256[role], NATIVE_ELF[role].trimmedSha256)
    assert.equal(dossier.accounts.find(a => a.role === `${role}-config`).idlSha256, NATIVE_IDL_SHA256[role])
  }
  const evidence = await verifies(bundle, connections)
  // Bundle 2 no longer verifies once the programs are upgraded.
  await assert.rejects(collectProductionOperatorBundle(inputs(c, connections)), /launch deployed code differs from its reviewed pin/)
  // A tampered native IDL hash on a config pin is refused by the live check.
  const tamperedJson = JSON.stringify({ ...dossier, accounts: dossier.accounts.map(a => a.role === 'launch-config' ? { ...a, idlSha256: flip(a.idlSha256) } : a) })
  const tampered = await readProductionEvidence({ dossierJson: tamperedJson, expectedSha256: sha(tamperedJson), providers: connections, timeoutMs: 10000 })
  assert.equal(tampered.status, 'mismatch'); assert.equal(tampered.reason, 'Config/control/quote account drift')
  // The same observations with bundle-2 launch code in the launch ProgramData (same header and allocation): refused.
  const launchData = dossier.programs.find(p => p.role === 'launch').programData, oldElf = readFileSync(path.join(ELF_DIR, 'bordrless_launch.so'))
  const withOldElf = dataBase64 => { const b = Buffer.from(dataBase64, 'base64'), next = Buffer.alloc(b.length); b.copy(next, 0, 0, 45); oldElf.copy(next, 45); return next.toString('base64') }
  const observations = evidence.observations.map(o => ({ ...o, accounts: o.accounts.map(a => a.address === launchData ? { ...a, dataBase64: withOldElf(a.dataBase64) } : a) }))
  const oldCode = inspectProductionEvidence({ dossierJson: bundle.dossierJson, expectedSha256: bundle.config.dossierSha256, observations, nowMs: Date.now() })
  assert.equal(oldCode.status, 'mismatch'); assert.equal(oldCode.reason, 'ELF bytes or trailing allocation differ')
})
