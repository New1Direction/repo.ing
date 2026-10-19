// Bundle 3 on a disposable solana-test-validator running the e357fdf native ELFs at the mainnet program IDs: the owner
// driver's stages, #326's bundle-3 script and production collector, the trade runtime booted as the production bootstrap
// boots it, a customer coin prepared and launched native through the website collectors, and native trades through the
// real resolver, signing lifecycle (PostgreSQL 127.0.0.1:55432) and settlement with exact chain deltas. Synthetic roles.
// The production checks read mainnet only, so the website stack sees the validator under two .invalid HTTPS origins and
// the mainnet genesis (as #326's local test does), and governance holds the mainnet genesis as the real accounts do.
// Every account, slot, simulation and receipt is the validator's; a fetch guard refuses anything else.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { Connection, Keypair, PublicKey, SystemProgram, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { main } from '../../src/hooklab-owner-driver/cli.mjs'
import { ELF_DIR, VALIDATOR, syntheticRoles, writeKeyFiles, startValidator, bootstrapConfigs, finalizeProgram, genesisAccount, localConfig, sendLocal, cleanup } from './hooklab-owner-local.mjs'
import { MAINNET_GENESIS, productionArtifacts, productionProfileJson } from '../../src/hooklab-production-operator-bundle.mjs'
import { collectNativeProductionBundle, nativeProductionArtifacts } from '../../src/hooklab-production-native-bundle.mjs'
import { NATIVE_ELF, NATIVE_IDL_SHA256 } from '../../src/hooklab-native-pins.mjs'
import { sharedTradeAddresses, launchTableInventory, launchTableInstructions } from '../../src/hooklab-owner-launch-tables.mjs'
import { catchUpConnection, productionSettings } from '../../src/hooklab-production-bootstrap.mjs'
import { createInclusiveTradeRuntime } from '../../app/lib/hooklab-inclusive-trade-runtime.mjs'
import { pinsNativeBuilds } from '../../src/hooklab-native-swap.mjs'
import { collectInclusiveMaxWalletPreparationReview } from '../../src/hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { collectCustomPreparationEvidence } from '../../src/hooklab-custom-preparation-receipts.mjs'
import { collectMaxWalletLaunchReview } from '../../src/hooklab-max-wallet-launch-collector.mjs'
import { collectMaxWalletLaunchSettlement } from '../../src/hooklab-max-wallet-launch-settlement.mjs'
import { hookCoinAddresses } from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import { launchIsNative, poolIsNative } from '../../src/hooklab-native-launch.mjs'
import { estimateTrade } from '../../app/lib/hooklab-trade-math.mjs'
import { holdingAddress } from '../../src/hooklab-owner-driver/pins.mjs'
import { productionSchema, migrationSchema } from '../../scripts/hooklab-production-schema.mjs'
import { dropTestDatabase } from './drop-test-database.mjs'

export const NATIVE_ELF_DIR = process.env.HOOKLAB_NATIVE_ELF_DIR ?? path.join(homedir(), 'Documents/ChatGPT/hooks-local-state/native-e357fdf')
const available = existsSync(VALIDATOR) && existsSync(path.join(ELF_DIR, 'bordrless_launch.so')) && existsSync(path.join(NATIVE_ELF_DIR, 'bordrless_launch.so'))
export const BUNDLE3_LOCAL_SKIP = !available && process.env.HOOKLAB_OWNER_LOCAL_REQUIRED !== 'true' && 'local validator, bundle-2 ELFs or native e357fdf ELFs (HOOKLAB_NATIVE_ELF_DIR) unavailable'
export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const ORIGIN = 'https://repo.ing'
const SCRIPT = path.join(ROOT, 'scripts/hooklab-production-bundle-3.mjs'), ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111'
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// The approved economics bundle 3 requires (fee ceilings 200, 25% launch share), as #326's local test sets them.
const APPROVED = { launch: { max_creator_fee_bps: 200, rule_bounds: { max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: 200, min_max_wallet_bps: 1,
  max_max_wallet_bps: 1, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 } }, swap: { launch_protocol_share_bps: 2500 } }
// Two labelled HTTPS origins for the one validator; .invalid never resolves, so nothing can leave this machine.
export const TRUST = Object.freeze([{ provider: 'helius', trustDomain: 'local-validator-a', origin: 'https://helius.bundle3-local.invalid' },
  { provider: 'publicnode', trustDomain: 'local-validator-b', origin: 'https://publicnode.bundle3-local.invalid' }])

function frozenTradeTable() {
  const address = Keypair.generate().publicKey.toBase58(), shared = sharedTradeAddresses(JSON.parse(productionProfileJson(productionArtifacts().base)))
  const header = Buffer.alloc(56); header.writeUInt32LE(1, 0); header.writeBigUInt64LE(0xffffffffffffffffn, 4)
  return { address, row: genesisAccount(address, { lamports: 1000000000, owner: ALT_PROGRAM, data: Buffer.concat([header, ...shared.map(a => new PublicKey(a).toBuffer())]) }) }
}

// The validator, the owner driver over it, and the website stack's view of it. Cleans up after the test t.
export async function bundle3Chain(t) {
  const root = mkdtempSync(path.join(process.env.HOOKLAB_OWNER_SCRATCH ?? tmpdir(), 'hooklab-bundle3-'))
  const roles = syntheticRoles(), keys = writeKeyFiles(path.join(root, 'keys'), roles), table = frozenTradeTable()
  const key = Object.fromEntries(Object.values(roles).map(k => [k.publicKey.toBase58(), k]))
  const a = role => roles[role].publicKey.toBase58()
  const validator = await startValidator(root, roles, { elfDir: NATIVE_ELF_DIR, elfSha256: { launch: NATIVE_ELF.launch.sha256, swap: NATIVE_ELF.swap.sha256 }, accounts: [table.row] })
  const conn = validator.connection, sockets = [conn], blocked = []
  // Fetch guard: the two labelled origins go to the validator; the validator itself passes; anything else is refused.
  const realFetch = globalThis.fetch, routed = new Set(TRUST.map(x => new URL(x.origin).origin)), local = new Set([validator.url, validator.url2].map(u => new URL(u).origin))
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (routed.has(url.origin)) return realFetch(validator.url, init)
    if (local.has(url.origin)) return realFetch(input, init)
    blocked.push(url.origin); throw Error(`refused: ${url.origin} is not the local validator`)
  }
  t.after(async () => {
    globalThis.fetch = realFetch
    for (const c of sockets) { try { c._rpcWebSocket?.close() } catch { /* closed */ } }
    await validator.stop(); cleanup(root)
  })
  // The validator under a labelled HTTPS origin and the mainnet genesis; every call is the validator's.
  const relabel = label => {
    const target = new Connection(validator.url, { commitment: 'finalized' }); sockets.push(target)
    return new Proxy(target, { get(o, p) {
      if (p === 'rpcEndpoint') return label
      if (p === 'getGenesisHash') return async () => MAINNET_GENESIS
      const v = Reflect.get(o, p, o); return typeof v === 'function' ? v.bind(o) : v
    } })
  }
  const asMainnet = () => TRUST.map(x => ({ provider: x.provider, connection: relabel(`${x.origin}/`) }))
  const configPath = path.join(root, 'config.json'); writeFileSync(configPath, JSON.stringify(localConfig(roles), null, 2))
  const common = ['--local-test', '--rpc', validator.url, '--rpc2', validator.url2, '--config', configPath, '--runs', path.join(root, 'runs'), '--journal', path.join(root, 'journal')]
  // One owner-driver stage, planned, then executed with the given role keys. Its --local-test mode puts the local
  // acceptance boundary into process.env; the website runtime must run as production does, so the environment is restored.
  async function owner(stage, signers, { approve = false, more = [] } = {}) {
    const saved = { ...process.env }
    try {
      const quiet = { log: () => {} }, planned = await main(['plan', stage, ...common, ...more], quiet)
      assert.ok(planned.built.review, `${stage} plan blocked: ${planned.built.blocked}`)
      assert.equal(planned.preview.simulation.err, null, `${stage} simulation: ${JSON.stringify(planned.preview.simulation)}`)
      const messageSha256 = planned.built.review.messageSha256
      const result = await main(['execute', stage, ...common, ...more, '--message-sha256', messageSha256, ...signers.flatMap(r => ['--key', `${r}=${keys[r]}`]),
        ...(approve ? ['--approved', `${stage}:${messageSha256}`] : [])], quiet)
      assert.equal(result.receipt.status, 'finalized-success', stage)
      return result
    } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved) }
  }
  const transfer = (to, lamports) => SystemProgram.transfer({ fromPubkey: roles.payer.publicKey, toPubkey: new PublicKey(to), lamports })
  const fund = targets => sendLocal(conn, targets.map(([to, lamports]) => transfer(to, lamports)), [roles.payer])
  const remember = (...pairs) => { for (const k of pairs) key[k.publicKey.toBase58()] = k }
  return { root, roles, keys, key, a, table, validator, conn, relabel, asMainnet, owner, fund, remember, blocked }
}

// Mainnet's state at the native upgrade: approved economics (governance bound to the mainnet genesis: no program can read
// a genesis on chain, the owner driver does not use it, and every website compiler checks it against the profile), an
// immutable gate, launches and trading open, native launches on. grant: the canary creator's one-launch grant. Funds the
// creator, the admin (launch co-signer, launch-table payer) and the treasury, which the launch compiler requires to exist.
export async function openNativeChain(c, { grant = true } = {}) {
  await bootstrapConfigs(c.conn, c.roles, MAINNET_GENESIS, APPROVED)
  await finalizeProgram(c.conn, c.roles, 'gate')
  if (grant) await c.owner('grant', ['payer', 'admin'])
  await c.owner('open-launches', ['payer', 'admin'], { approve: true })
  await c.owner('open-trading', ['payer', 'admin'], { approve: true })
  await c.owner('native-launches', ['payer', 'admin'], { approve: true, more: ['--to', 'on'] })
  await c.fund([[c.a('creator'), 3000000000], [c.a('admin'), 1000000000], [c.a('treasury'), 1000000000]])
}

// Bundle 3 two ways from the same chain: #326's script (--local dry run) and the production collector it runs on mainnet.
// They pin the same programs, IDLs, ELFs and accounts; the production-schema one is written for the bootstrap.
export async function buildBundle3(c) {
  const out = path.join(c.root, `bundle-3.local.${randomUUID()}.json`), a = c.a
  const args = [SCRIPT, '--local', '--rpc', c.validator.url, '--rpc2', c.validator.url2, '--trade-table', c.table.address, '--reviewer', a('admin'), '--treasury', a('treasury'), '--out', out]
  const { stdout } = await promisify(execFile)(process.execPath, args, { cwd: ROOT, timeout: 120000 })
  const summary = JSON.parse(stdout), local = JSON.parse(readFileSync(out))
  assert.equal(summary.mode, 'local-dry-run'); assert.equal(summary.bundleSha256, sha(readFileSync(out)))
  for (const role of ['launch', 'swap']) assert.deepEqual(summary.programs.find(p => p.role === role), { role, elfSha256: NATIVE_ELF[role].trimmedSha256, elfLength: NATIVE_ELF[role].trimmedLength, upgradeAuthority: a('upgrade') })
  const { bundle } = await collectNativeProductionBundle({ connections: c.asMainnet(), trustDomains: TRUST, lookupTable: c.table.address, reviewer: a('admin'), treasury: a('treasury'),
    approvalReference: 'LOCAL-VALIDATOR-NOT-PRODUCTION' })
  assert.equal(bundle.schema, 'repoing/production-operator-bundle/1')
  const pp = JSON.parse(bundle.profile.json), lp = JSON.parse(local.profile.json)
  assert.deepEqual({ ...lp, schema: pp.schema, genesisHash: pp.genesisHash }, pp, 'the profiles differ only by the local schema and genesis')
  assert.equal(bundle.profile.expectedSha256, sha(productionProfileJson(nativeProductionArtifacts().base)), 'bundle 3’s reviewed profile')
  assert.deepEqual(bundle.profile.idls, local.profile.idls); assert.deepEqual(bundle.profile.elfLengths, local.profile.elfLengths)
  const pd = JSON.parse(bundle.dossierJson), ld = JSON.parse(local.dossierJson)
  assert.deepEqual(pd.programs, ld.programs); assert.deepEqual(pd.accounts, ld.accounts)
  for (const role of ['launch', 'swap']) { assert.equal(pp.elfSha256[role], NATIVE_ELF[role].trimmedSha256); assert.equal(pp.idlSha256[role], NATIVE_IDL_SHA256[role]) }
  assert.equal(pinsNativeBuilds(bundle.profile), true)
  const bytes = Buffer.from(JSON.stringify(bundle)), file = path.join(c.root, `bundle-3.${randomUUID()}.json`); writeFileSync(file, bytes)
  return { bundle, file, bytes, local: { file: out, bytes: readFileSync(out) }, summary }
}

// A scratch database with the production schema and the wallet-funding and native-stages migrations.
export async function scratchDatabase(t) {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }, admin = new pg.Pool(config)
  const database = `bundle3_${randomUUID().replaceAll('-', '')}`
  await admin.query(`create database ${database}`)
  const pool = new pg.Pool({ ...config, database })
  t.after(async () => { await pool.end().catch(() => {}); await dropTestDatabase(admin, database).catch(() => {}); await admin.end() })
  await pool.query(productionSchema().sql); await pool.query(migrationSchema('wallet-funding').sql); await pool.query(migrationSchema('native-stages').sql)
  return pool
}
// A wallet session, as the identity route records it after sign-in.
export async function signIn(pool, token, wallet) {
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,$3,'general-launcher',$4,clock_timestamp()+interval '30 minutes')",
    [sha(token), wallet, ORIGIN, MAINNET_GENESIS])
}

// The production bootstrap's settings (src/hooklab-production-bootstrap.mjs productionSettings) and its trade runtime call.
export function bootEnv(file, bytes, reviewer, origins, more = {}) {
  return { HOOK_OWNER_APPROVED_LAUNCHES: 'true', HOOK_NATIVE_LAUNCH_ENABLED: 'true', HOOK_WALLET_IDENTITY_ENABLED: 'true', HOOK_INCLUSIVE_TRADING_ENABLED: 'true',
    HOOK_NATIVE_TRADING_ENABLED: 'true', HOOKLAB_PRODUCTION_BUNDLE_FILE: file, HOOKLAB_PRODUCTION_BUNDLE_SHA256: sha(bytes), HOOK_LAUNCH_ADMIN_ADDRESS: reviewer,
    HOOKLAB_PRODUCTION_RPC_PRIMARY_URL: origins[0], HOOKLAB_PRODUCTION_RPC_SECONDARY_URL: origins[1],
    HOOK_NATIVE_KEYRING_JSON: JSON.stringify({ 'local-1': Buffer.alloc(32, 7).toString('base64') }), HOOK_NATIVE_ACTIVE_KEY_ID: 'local-1', ...more }
}
export const bundle3Origins = () => TRUST.map(x => `${x.origin}/`)
export async function bootRuntime(c, pool, env) {
  const s = await productionSettings({ env, connectionFor: url => catchUpConnection(c.relabel(url)) })
  const base = { enabled: true, origin: ORIGIN, ownerCustodyApproved: true, operatorDeploymentApproved: true, economicsApproved: true,
    config: s.bundle.config, profile: s.bundle.profile, dossierJson: s.bundle.dossierJson, connections: s.connections, keyRing: s.keyRing, activeKeyId: s.activeKeyId, expiryObserver: s.observers.bothPast }
  const runtime = createInclusiveTradeRuntime(pool, { ...base, ownerTradingApproved: true, limits: s.tradeLimits, walletFundingEnabled: env.HOOK_WALLET_FUNDING_ENABLED === 'true',
    nativeTradingEnabled: env.HOOK_NATIVE_TRADING_ENABLED === 'true' })
  return { s, runtime }
}

function signedWire(c, messageBase64) {
  const message = VersionedMessage.deserialize(Buffer.from(messageBase64, 'base64')), tx = new VersionedTransaction(message)
  const signers = message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map(k => c.key[k.toBase58()])
  assert.ok(signers.every(Boolean), 'a required signer is not one of the synthetic keys'); tx.sign(signers)
  return Buffer.from(tx.serialize()).toString('base64')
}
async function land(conn, wire) {
  const latest = await conn.getLatestBlockhash('finalized')
  const signature = await conn.sendRawTransaction(Buffer.from(wire, 'base64'), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
  const result = await conn.confirmTransaction({ signature, ...latest }, 'finalized')
  assert.equal(result.value.err, null, `transaction ${signature} failed: ${JSON.stringify(result.value.err)}`)
  return signature
}

// A customer coin through the website's real path on this bundle: the two-provider preparation collector, its receipt
// evidence, the launch's own lookup table (as the owner agent creates it), the launch collector with native launches on
// (create_launch_custom_v4), the admin co-signature, and the launch settlement. Review timing is read per review.
export async function launchNativeCoin(c, s, bundle, { creator, mint, selectedConfig }) {
  c.remember(creator, mint, selectedConfig)
  const p = bundle.profile, profile = JSON.parse(p.json), cap = profile.capability, C = creator.publicKey.toBase58(), M = mint.publicKey.toBase58()
  const prep = { schema: 'repoing/inclusive-max-wallet-preparation-request/1', policyKind: 'max-wallet', policyVersion: 2, creator: C, feePayer: C, mint: M,
    selectedConfig: selectedConfig.publicKey.toBase58(), capBps: cap.defaultCapBps, label: 'local-native', creatorFeeBps: cap.creatorFeeBps, rules: 'none', hookFlags: 1, feeModel: 2, protocolShareBps: 2500 }
  const request = { ...prep, schema: 'repoing/inclusive-max-wallet-launch-request/1', reviewer: c.a('admin'), name: 'Local native', symbol: 'LNATIVE', uri: '', virtualQuote: '1000000000' }
  const preparationProfile = { json: p.json, expectedSha256: p.expectedSha256, providers: p.providers, idls: { launch: p.idls.launch, gate: p.idls.gate }, elfLengths: { launch: p.elfLengths.launch, gate: p.elfLengths.gate } }
  const collected = await collectInclusiveMaxWalletPreparationReview({ profile: preparationProfile, request: prep, connections: s.connections, limits: (await s.launchLimits()).preparationLimits })
  const prepWire = signedWire(c, collected.plan.review.messageBase64); await land(c.conn, prepWire)
  const receipt = await collectCustomPreparationEvidence({ preparationInput: collected.preparationInput, signedTransactionBase64: prepWire, providers: s.connections,
    expectedProfileSha256: p.expectedSha256, evidenceMode: 'configured-readonly-rpc' })
  assert.equal(receipt.result.status, 'candidate-preparation-matched', JSON.stringify(receipt.result.reasonCode))
  // Its recent slot must be in the SlotHashes of the bank that checks it (sendLocal simulates at finalized), so one before.
  const launchConfig = PublicKey.findProgramAddressSync([Buffer.from('config')], new PublicKey(profile.programs.launch))[0]
  const { inventory } = launchTableInventory(p, request, (await c.conn.getAccountInfo(launchConfig, 'finalized')).data)
  const { table, steps } = launchTableInstructions({ admin: c.a('admin'), recentSlot: await c.conn.getSlot('finalized') - 1, inventory })
  for (const step of steps) await sendLocal(c.conn, step, [c.roles.admin])
  await sleep(1000)
  const lookupTable = { address: table, sha256: sha((await c.conn.getAccountInfo(new PublicKey(table), 'finalized')).data) }
  const bindings = { config: { ...bundle.config, lookupTable }, profile: p, dossierJson: bundle.dossierJson, connections: s.connections }
  const launch = await collectMaxWalletLaunchReview({ ...bindings, request, nativeLaunches: true, limits: (await s.launchLimits()).launchLimits,
    preparation: { wallet: C, profileSha256: p.expectedSha256, preparationIntentSha256: sha(JSON.stringify(prep)), preparedRequest: prep,
      executionSlot: receipt.result.finalizedSlot, preparedAccountHashes: receipt.result.matchedAccountHashes } })
  assert.equal(launch.plan.quoteForm, 1, 'create_launch_custom_v4: a native-SOL coin')
  const launchWire = signedWire(c, launch.plan.review.messageBase64), signature = await land(c.conn, launchWire)
  const settled = await collectMaxWalletLaunchSettlement({ ...bindings, review: launch.plan.review, settlementContext: launch.settlementContext, signedTransactionBase64: launchWire, signature })
  assert.equal(settled.status, 'finalized-success', JSON.stringify(settled))
  const coin = hookCoinAddresses(profile, M)
  const [pool, launchAccount] = await c.conn.getMultipleAccountsInfo([new PublicKey(coin.pool), new PublicKey(coin.launch)], 'finalized')
  assert.equal(poolIsNative(pool.data), true); assert.equal(launchIsNative(launchAccount.data), true)
  return { ...coin, mint: M, selectedConfig: prep.selectedConfig }
}

// Exact lamport movement of each account in a finalized transaction.
async function deltas(conn, signature) {
  const tx = await conn.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
  const out = {}; for (let i = 0; i < keys.length; i++) out[keys.get(i).toBase58()] = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i])
  return { fee: BigInt(tx.meta.fee), of: address => out[address] ?? 0n }
}
export async function coinsOf(c, mint, wallet) { const h = await c.conn.getAccountInfo(new PublicKey(holdingAddress(mint, wallet)), 'finalized'); return h ? h.data.readBigUInt64LE(74) : 0n }

// One native trade through the runtime: the panel's minimum (its estimate less 3%), review, the wallet's one approval,
// one send through the production sender, then reconcile until settled. Returns the settlement and the chain's deltas.
export async function nativeTrade(c, runtime, bundle, { token, wallet, coin, side, amount }) {
  const W = wallet.publicKey.toBase58(), view = await runtime.market(coin.mint, W)
  assert.equal(view.market.native, true)
  const estimate = estimateTrade(view.market, { side, amount, coinBalance: BigInt(view.wallet.coin ?? 0), slippageBps: 300 })
  assert.equal(estimate.error ?? null, null)
  const cap = JSON.parse(bundle.profile.json).capability, id = randomUUID()
  const intent = { side, creatorFeeBps: cap.creatorFeeBps, capBps: cap.defaultCapBps, mint: coin.mint, selectedConfig: coin.selectedConfig, amountIn: String(amount),
    minAmountOut: String(estimate.minAmountOut), maxInput: String(amount), maxPriceImpactBps: 1000, graduate: false }
  const reviewed = await runtime.lifecycle.createReview(token, id, { custodyOperationId: id, stage: `native-${side}`, intent })
  assert.equal(reviewed.status, 'reviewed'); assert.equal(reviewed.profileSha256, bundle.config.profileSha256)
  const request = await runtime.lifecycle.walletRequest(token, id), tx = VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64, 'base64')); tx.sign([wallet])
  await runtime.lifecycle.retainWalletSignature(token, id, Buffer.from(tx.serialize()).toString('base64'))
  assert.equal((await runtime.lifecycle.submitOnce(token, id)).status, 'submitted', 'one send, through the production sender')
  let op; for (let i = 0; i < 60; i++) { op = await runtime.lifecycle.reconcile(token, id); if (op.status === 'finalized-success') break; await sleep(2000) }
  assert.equal(op.status, 'finalized-success', JSON.stringify(op.settlement))
  return { op, chain: await deltas(c.conn, op.signature) }
}
// A native buy, asserted to the lamport: G = ceil(x·b/10⁴), P = floor(G/4), N = G − P; the wallet pays fee, amount and
// (first buy) its coin account deposit; the launch receives N; the pool the rest, platform share included.
export async function exactNativeBuy(c, runtime, bundle, { token, wallet, coin, amount }) {
  const W = wallet.publicKey.toBase58(), bps = BigInt(JSON.parse(bundle.profile.json).capability.creatorFeeBps), holding = holdingAddress(coin.mint, W)
  const first = (await c.conn.getAccountInfo(new PublicKey(holding), 'finalized')) === null, before = await coinsOf(c, coin.mint, W)
  const rent = first ? BigInt(await c.conn.getMinimumBalanceForRentExemption(204, 'finalized')) : 0n
  const { op, chain } = await nativeTrade(c, runtime, bundle, { token, wallet, coin, side: 'buy', amount }), q = op.settlement.quote
  const G = (amount * bps + 9999n) / 10000n, P = G / 4n, N = G - P
  assert.deepEqual([q.grossCreatorFee, q.protocolFee, q.netCreatorFee], [String(G), String(P), String(N)])
  assert.equal(op.settlement.feeLamports, String(chain.fee))
  assert.equal(chain.of(W), -(chain.fee + amount + rent)); assert.equal(chain.of(coin.launch), N); assert.equal(chain.of(coin.pool), amount - N)
  assert.equal(chain.of(holding), rent); assert.equal(await coinsOf(c, coin.mint, W), before + BigInt(q.delivered))
  return { op, chain, G, P, N, rent }
}
// A native sale, asserted to the lamport: the wallet receives the SOL less the fee, the launch N, the pool pays out the
// SOL and N (the platform share stays); G = ceil(gross out·b/10⁴).
export async function exactNativeSell(c, runtime, bundle, { token, wallet, coin, amount }) {
  const W = wallet.publicKey.toBase58(), bps = BigInt(JSON.parse(bundle.profile.json).capability.creatorFeeBps), held = await coinsOf(c, coin.mint, W)
  const { op, chain } = await nativeTrade(c, runtime, bundle, { token, wallet, coin, side: 'sell', amount }), q = op.settlement.quote
  const G = BigInt(q.grossCreatorFee), P = BigInt(q.protocolFee), N = BigInt(q.netCreatorFee), delivered = BigInt(q.delivered)
  assert.equal(G, ((delivered + G) * bps + 9999n) / 10000n); assert.equal(P, G / 4n); assert.equal(N, G - P)
  assert.equal(op.settlement.feeLamports, String(chain.fee))
  assert.equal(chain.of(W), delivered - chain.fee); assert.equal(chain.of(coin.launch), N); assert.equal(chain.of(coin.pool), -(delivered + N))
  assert.equal(await coinsOf(c, coin.mint, W), held - amount)
  return { op, chain, G, P, N, delivered }
}
