import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createDbcPlatformFees } from '../src/platform-dbc-fees.mjs'
import { listPlatformFees } from '../src/platform-fee-operations.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK } from '../src/early-access-hook.mjs'

// Step 6f (docs/EARLY_ACCESS.md) without a chain: which markets the platform's DBC partner fee collection reads, and how it reads
// an early access market's transfer-hook pool and config (account bytes encoded with the program's own layouts). The collection
// itself runs on mainnet's programs in tests/early-access-launch-chain.test.mjs.
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const root = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed').state.getProgram().coder, coder = root.accounts
// An account of the program's type `name`, its fields zero except what edit() sets.
function account(name, edit) {
  const { discriminator, layout } = coder.accountLayouts.get(name), size = coder.size(name)
  const value = coder.decode(name, Buffer.concat([Buffer.from(discriminator), Buffer.alloc(size - discriminator.length)]))
  edit(value)
  const bytes = Buffer.alloc(size * 2), length = layout.encode(value, bytes)
  return { owner: DBC, data: Buffer.concat([Buffer.from(discriminator), bytes.subarray(0, length)]), lamports: 1, executable: false }
}
const key = () => Keypair.generate().publicKey
const partner = Keypair.generate(), creator = key(), solConfig = key(), eaConfig = key()
const GROSS = 9_000_000n, DISCOVERY_PAID = 4_000_000n
const poolState = (config, mint) => state => Object.assign(state, { config, baseMint: mint, creator, quoteVault: key(),
  partnerQuoteFee: new BN(String(GROSS - DISCOVERY_PAID)), partnerBaseFee: new BN(0) })
const configState = tokenType => config => Object.assign(config, { feeClaimer: partner.publicKey, quoteMint: NATIVE_MINT, collectFeeMode: 0, tokenType })

// The market (stamped or not), its two accounts, and a database answering the queries inspect makes.
function setup({ stamped = true, pool: poolAccount = null, config: configAccount = null } = {}) {
  const mint = key(), configKey = stamped ? eaConfig : solConfig, pool = deriveDbcPoolAddress(NATIVE_MINT, mint, configKey)
  const market = { repoId: '7', mint: mint.toBase58(), pool: pool.toBase58(), creatorWallet: creator.toBase58(), version: 2,
    earlyAccessEnd: stamped ? new Date() : null, transferHookProgram: stamped ? HOOK.toBase58() : null }
  const accounts = [poolAccount ?? (stamped ? account('transferHookPool', s => poolState(configKey, mint)(s.poolState))
    : account('virtualPool', s => poolState(configKey, mint)(s.poolState ?? s))),
  configAccount ?? (stamped ? account('configWithTransferHook', c => { configState(1)(c.config); c.transferHookProgram = HOOK })
    : account('poolConfig', configState(0)))]
  const params = []
  const client = { release() {}, query: async (sql, values) => {
    if (/advisory/.test(sql)) return { rows: [{ locked: true }] }
    if (/from markets/.test(sql)) { params.push(values); return { rows: !market.earlyAccessEnd || values[1] === true ? [market] : [] } }
    return { rows: [{ gross: String(GROSS), eligible: String(GROSS), discoveryPaid: String(DISCOVERY_PAID), platformPaid: '0', discoveryPending: 0, platformPending: 0 }] }
  } }
  const connection = { rpcEndpoint: 'http://127.0.0.1:8899', getMultipleAccountsInfoAndContext: async () => ({ context: { slot: 1 }, value: accounts }) }
  return { market, params, pool: { connect: async () => client }, connection }
}
const fees = (run, earlyAccess) => createDbcPlatformFees({ pool: run.pool, connection: run.connection, config: solConfig.toBase58(), partner, earlyAccess,
  env: { PLATFORM_FEE_TREASURY_WALLET: key().toBase58() } })

test('an early access market is read only with the setting, from its transfer-hook pool and config', async () => {
  const run = setup()
  await assert.rejects(fees(run, null).status('7'), /not finalized and indexed/)
  assert.equal(run.params.at(-1)[1], false)
  const status = await fees(run, eaConfig).status('7')
  assert.equal(run.params.at(-1)[1], true)
  assert.deepEqual([status.hook, status.config, status.available], [true, eaConfig.toBase58(), String((GROSS - DISCOVERY_PAID) - (GROSS / 2n - DISCOVERY_PAID))])
})

test('a hook pool must be read as one: another hook program, an SPL base, or the plain account kinds are refused', async () => {
  const otherHook = setup({ config: account('configWithTransferHook', c => { configState(1)(c.config); c.transferHookProgram = key() }) })
  await assert.rejects(fees(otherHook, eaConfig).status('7'), /Canonical partner config/)
  const splBase = setup({ config: account('configWithTransferHook', c => { configState(0)(c.config); c.transferHookProgram = HOOK }) })
  await assert.rejects(fees(splBase, eaConfig).status('7'), /Canonical partner config/)
  const plainPool = setup({ pool: account('virtualPool', s => Object.assign(s.poolState ?? s, { partnerBaseFee: new BN(0) })) })
  await assert.rejects(fees(plainPool, eaConfig).status('7'))
  const plainConfig = setup({ config: account('poolConfig', configState(1)) })
  await assert.rejects(fees(plainConfig, eaConfig).status('7'), /Not a DBC config with a transfer hook/)
})

test('a SOL market is read as before, whatever the setting', async () => {
  for (const earlyAccess of [null, eaConfig]) {
    const status = await fees(setup({ stamped: false }), earlyAccess).status('7')
    assert.deepEqual([status.hook, status.config], [false, solConfig.toBase58()])
  }
  const hookPoolForSol = setup({ stamped: false, pool: account('transferHookPool', s => poolState(solConfig, key())(s.poolState)) })
  await assert.rejects(fees(hookPoolForSol, eaConfig).status('7'))
})

test('the platform fee list includes early access markets only with the setting', async () => {
  const seen = []
  const db = { release() {}, query: async (sql, values) => { seen.push(values); return { rows: [] } } }
  await listPlatformFees({ pool: { connect: async () => db }, feeService: () => null, earlyAccess: false })
  await listPlatformFees({ pool: { connect: async () => db }, feeService: () => null, earlyAccess: true })
  await listPlatformFees({ pool: { connect: async () => db }, feeService: () => null })
  assert.deepEqual(seen, [[false], [true], [false]], 'unset in this process: left out')
})
