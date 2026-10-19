// Production's open funding work across the native upgrade, through the real signing lifecycle and PostgreSQL
// (127.0.0.1:55432, a scratch database). Production holds one open operation: a bridged Add SOL ('wallet-fund') in
// outcome-unknown, reviewed under bundle 2 (profile dd8606aa…). When the server moves to the native bundle (native
// trading still off), that operation must still settle, and new bridged funding work must still review and settle.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import pg from 'pg'
import { nativeSigningLifecycle } from '../src/hooklab-native-signing.mjs'
import { tradeLifecycleSettings } from '../app/lib/hooklab-inclusive-trade-runtime.mjs'
import { REVIEWED_PROFILE_SHA256 } from '../src/hooklab-reviewed-profiles.mjs'
import { QUOTE_MINT, MAINNET_GENESIS } from '../src/hooklab-owner-driver/pins.mjs'
import { productionSchema, migrationSchema } from '../scripts/hooklab-production-schema.mjs'
import { COIN, HOLDING_RENT, OWNER, bundle, d, exactFund, holdingBytes, owner, receiptFor, resolverFor, state } from './fixtures/hooklab-wallet-funding-chain.mjs'
import { nativePinned } from './fixtures/hooklab-native-bundle.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

const ORIGIN = 'https://repo.ing', token = Buffer.alloc(32, 44).toString('base64url'), BUNDLE_2 = 'dd8606aa4c8107d4ae4883a5a1c182b4968a38ddf48905e19c635d31bcd24772'
const FEE = 7000, FUNDED = 1_000_000, WITHDRAWN = 400_000

// Finalized transactions on both providers, by signature (the fixture chain otherwise has none).
function ledger(connections) {
  const landed = new Map()
  for (const { connection } of connections) Object.assign(connection, {
    getTransaction: async signature => landed.get(signature) ?? null,
    getBlockSignatures: async () => ({ blockhash: '11111111111111111111111111111112', previousBlockhash: '11111111111111111111111111111113', blockHeight: 1100, signatures: [...landed.keys()] }),
  })
  return { land: receipt => landed.set(receipt.signature, receipt) }
}
// The bridged trade runtime's lifecycle settings with native trading off (the switch stays off after the upgrade).
const settingsFor = funding => tradeLifecycleSettings({ trade: {}, funding, native: {}, nativeOpen: false })

test('bridged funding across the native bundle upgrade', { timeout: 120000 }, async t => {
  const config = { host: '127.0.0.1', port: 55432, user: 'postgres', password: 'launchtest', database: 'postgres' }, admin = new pg.Pool(config)
  const database = `funding_upgrade_${randomUUID().replaceAll('-', '')}`
  let pool
  t.after(async () => { await pool?.end().catch(() => {}); await dropTestDatabase(admin, database).catch(() => {}); await admin.end() })
  await admin.query(`create database ${database}`); pool = new pg.Pool({ ...config, database })
  await pool.query(productionSchema().sql); await pool.query(migrationSchema('wallet-funding').sql); await pool.query(migrationSchema('native-stages').sql)
  await pool.query("insert into hook_lab_wallet_sessions(token_sha256,wallet,origin,audience,genesis_hash,expires_at) values($1,$2,$3,'general-launcher',$4,clock_timestamp()+interval '30 minutes')",
    [createHash('sha256').update(token).digest('hex'), OWNER, ORIGIN, MAINNET_GENESIS])
  const lifecycleWith = (funding, sender) => nativeSigningLifecycle(pool, { enabled: true, origin: ORIGIN, custodyAdapter: null, sender, ...settingsFor(funding) })
  const native = nativePinned(bundle)
  // The server after the upgrade: the native bundle, a new boot time. Same chain, same providers.
  const afterUpgrade = async (rows, simulated, reviewedProfiles) => {
    const { resolver, connections } = await resolverFor(rows, [null, null], simulated, { nowMs: Date.now() }, { from: native, clock: Date.now, reviewedProfiles })
    return { resolver, ...ledger(connections) }
  }
  async function signed(lifecycle, id) {
    const request = await lifecycle.walletRequest(token, id), tx = VersionedTransaction.deserialize(Buffer.from(request.partialTransactionBase64, 'base64')); tx.sign([owner])
    const wire = Buffer.from(tx.serialize()).toString('base64'); await lifecycle.retainWalletSignature(token, id, wire); return wire
  }

  await t.test('an Add SOL left in outcome-unknown under bundle 2 settles after the server moves to the native bundle', async () => {
    assert.equal(bundle.config.profileSha256, BUNDLE_2, 'the pinned production bundle is bundle 2'); assert.ok(REVIEWED_PROFILE_SHA256.includes(BUNDLE_2))
    assert.notEqual(native.config.profileSha256, BUNDLE_2, 'the native bundle is a new profile')
    // Under bundle 2: review, wallet signature, and a send whose result was lost (production's open operation).
    const before = await resolverFor(state(), [null, null], exactFund(FUNDED, 2), { nowMs: Date.now() }, { clock: Date.now })
    const bundle2 = lifecycleWith(before.resolver, { send: async () => { throw Error('connection reset after the send') } })
    const id = randomUUID(), intent = { action: 'fund', mint: COIN, lamports: String(FUNDED) }
    const reviewed = await bundle2.createReview(token, id, { custodyOperationId: id, stage: 'wallet-fund', intent })
    assert.equal(reviewed.profileSha256, BUNDLE_2)
    const wire = await signed(bundle2, id)
    assert.equal((await bundle2.submitOnce(token, id)).status, 'outcome-unknown')
    assert.equal((await bundle2.reconcile(token, id)).status, 'outcome-unknown', 'not finalized anywhere yet')

    // It landed. The server now runs the native bundle; the row keeps its bundle-2 review and context.
    const { review } = await bundle2.get(token, id), q = reviewed.request.quote, rent = BigInt(q.holdingRentLamports)
    assert.equal(rent, BigInt(HOLDING_RENT))
    const receipt = receiptFor(review, wire, { [OWNER]: -(FEE + 2 * HOLDING_RENT + FUNDED), [d.bridgeSolVault]: FUNDED, [q.createdHoldings[0]]: HOLDING_RENT, [q.createdHoldings[1]]: HOLDING_RENT })
    assert.equal(receipt.signature, bs58.encode(VersionedTransaction.deserialize(Buffer.from(wire, 'base64')).signatures[0]))
    const unlisted = await afterUpgrade(state(), () => null, [native.config.profileSha256]); unlisted.land(receipt)
    assert.equal((await lifecycleWith(unlisted.resolver).reconcile(token, id)).status, 'outcome-unknown', 'control: without bundle 2 in the reviewed list it never settles')
    const upgraded = await afterUpgrade(state(), () => null); upgraded.land(receipt)
    const settled = await lifecycleWith(upgraded.resolver).reconcile(token, id)
    assert.equal(settled.status, 'finalized-success'); assert.equal(settled.profileSha256, BUNDLE_2); assert.equal(settled.settlement.status, 'finalized-success')
    assert.equal((await lifecycleWith(upgraded.resolver).get(token, id)).status, 'finalized-success', 'and reads back')
  })

  await t.test('a new bridged withdrawal reviews, sends and settles under the native bundle', async () => {
    // The wallet after the Add SOL above: both holdings exist and 1,000,000 lamports are bridged.
    const walletLamports = 1_000_000_000 - FEE - 2 * HOLDING_RENT - FUNDED
    const rows = state({ walletLamports: String(walletLamports), quoteHolding: holdingBytes(QUOTE_MINT, OWNER, FUNDED), coinHolding: holdingBytes(COIN, OWNER, 0) })
    const upgraded = await afterUpgrade(rows, address => address === OWNER ? walletLamports - FEE + WITHDRAWN : null)
    let sent = null
    const lifecycle = lifecycleWith(upgraded.resolver, { send: async ({ signature }) => { sent = signature; return signature } })
    const id = randomUUID()
    const reviewed = await lifecycle.createReview(token, id, { custodyOperationId: id, stage: 'wallet-withdraw', intent: { action: 'withdraw', mint: null, lamports: String(WITHDRAWN) } })
    assert.equal(reviewed.status, 'reviewed'); assert.equal(reviewed.review.operation, 'hooklab-wallet-withdraw')
    assert.equal(reviewed.profileSha256, native.config.profileSha256, 'reviewed under the native bundle')
    const wire = await signed(lifecycle, id)
    assert.equal((await lifecycle.submitOnce(token, id)).status, 'submitted'); assert.ok(sent)
    upgraded.land(receiptFor(reviewed.review, wire, { [OWNER]: WITHDRAWN - FEE, [d.bridgeSolVault]: -WITHDRAWN }))
    assert.equal((await lifecycle.reconcile(token, id)).status, 'finalized-success')
  })
})

