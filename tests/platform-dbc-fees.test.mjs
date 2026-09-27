import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { discoverySummary } from '../src/discovery-rewards.mjs'
import { createDiscoveryClaims } from '../src/discovery-claims.mjs'
import { createDbcPlatformFees, dbcPlatformEntitlement, settleDbcPlatformClaim } from '../src/platform-dbc-fees.mjs'
import { createPlatformFeeRecovery } from '../src/platform-fees.mjs'
import { createPlatformRevenue, platformRevenueSummary, reconcilePlatformRevenue, assertPlatformReserveCustody } from '../src/platform-revenue.mjs'

const databaseUrl = process.env.DATABASE_URL
assert.equal(databaseUrl, 'postgres://dbc_test@127.0.0.1:55459/repoing_dbc_collection_test', 'Disposable test database required')
assert.equal(process.env.SOLANA_RPC_URL, 'http://127.0.0.1:8909', 'Disposable local validator required')
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed')
const pool = new pg.Pool({ connectionString: databaseUrl })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'finalized' })
const wrap = changes => new Proxy(connection, { get(target, key) {
  if (changes[key]) return changes[key]
  const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
} })
async function finalized(signature) {
  for (let n = 0; n < 180; n++) {
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (tx) return tx
    await pause(250)
  }
  throw Error('Local finality timed out')
}

test('DBC treasury collection preserves discovery and builder fees, refunds rent, recovers once and allocates by custody', { timeout: 300_000 }, async t => {
  t.after(() => pool.end())
  await pool.query('truncate repositories restart identity cascade')
  const creator = Keypair.generate(), launcher = Keypair.generate(), treasury = Keypair.generate()
  const sig = await connection.requestAirdrop(launcher.publicKey, 10e9)
  await connection.confirmTransaction({ signature: sig, ...await connection.getLatestBlockhash() }, 'confirmed')
  const treasuryFunding = await connection.requestAirdrop(treasury.publicKey, 1e9)
  await connection.confirmTransaction({ signature: treasuryFunding, ...await connection.getLatestBlockhash() }, 'confirmed')
  const { config, partner } = await createFixedConfig(connection)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const accrual = createFeeAccrual({ pool, connection, config })
  const env = { PLATFORM_DBC_COLLECTION_ENABLED: 'true', PLATFORM_FEE_TREASURY_WALLET: treasury.publicKey.toBase58() }
  // Finalized reads must still send with confirmed preflight: the freshly fetched
  // confirmed blockhash may not yet be visible to a finalized preflight bank.
  const service = createDbcPlatformFees({ pool, connection: new Connection(process.env.SOLANA_RPC_URL, 'finalized'), config, partner, env, verification: connection })
  async function launch(repoId, discoveryEnabled) {
    const coordinator = createLaunchCoordinator({ pool, discoveryEnabled, launcher: createMeteoraLauncher({ connection, config, creator }),
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: repoId, name: `fees-${repoId}`,
        full_name: `local/fees-${repoId}`, owner: { login: 'local' }, private: false, archived: false,
        stargazers_count: 1, forks_count: 0, updated_at: '2026-01-01T00:00:00Z' }) }) })
    const m = await coordinator.launch({ repositoryUrl: `https://github.com/local/fees-${repoId}`,
      tokenName: 'Treasury test', tokenSymbol: 'FEE', launcherWallet: launcher.publicKey.toBase58(),
      initialBuyLamports: '10000000', signTransaction: async tx => { tx.partialSign(launcher); return tx } })
    await finalized(m.launchSignature)
    assert.equal((await createLaunchIndexer({ pool, verify: createLaunchEvidenceVerifier({ connection, config }) }).processMarket(BigInt(repoId))).state, 'indexed')
    await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [m.launchSignature] })
    return m
  }
  const legacy = await launch(996001, false), enrolled = await launch(996002, true)
  const review = state => ({ purpose: 'platform-fee-review', phase: 'DBC', repoId: state.repoId,
    amount: state.available, receiver: state.receiver, termsHash: state.termsHash,
    expiresAt: Date.now() + 120_000, maxNetworkFeeLamports: '20000' })
  async function buy(m) {
    const tx = await dbc.pool.swap2({ owner: launcher.publicKey, payer: launcher.publicKey, pool: new PublicKey(m.pool),
      amountIn: new BN('10000000'), minimumAmountOut: new BN(1), swapBaseForQuote: false,
      swapMode: SwapMode.ExactIn, referralTokenAccount: null })
    const signature = await send(tx, [launcher])
    await accrual.recordTradeFees({ githubRepoId: m.githubRepoId, signatures: [signature] })
    return signature
  }
  await t.test('all partner fees indexed once; only enrolled fees accrue discovery rewards', async () => {
    const old = await service.status(legacy.githubRepoId), current = await service.status(enrolled.githubRepoId)
    assert.equal(old.discoveryReserved, '0'); assert.equal(old.available, old.gross)
    assert.equal(await discoverySummary(pool, legacy.githubRepoId), null)
    assert.equal(BigInt(current.discoveryReserved), BigInt(current.gross) / 2n)
    await accrual.recordTradeFees({ githubRepoId: legacy.githubRepoId, signatures: [legacy.launchSignature] })
    assert.equal((await service.status(legacy.githubRepoId)).gross, old.gross)
    assert.equal((await pool.query('select discovery_eligible from discovery_fee_events where github_repo_id=$1', [legacy.githubRepoId])).rows[0].discovery_eligible, false)
  })
  await t.test('disabled gate, expired/wrong review, RPC disagreement and missing evidence block before funds move', async () => {
    const state = await service.status(enrolled.githubRepoId), good = review(state)
    await assert.rejects(createDbcPlatformFees({ pool, connection, config, partner, env: {} }).claim({ review: good }), /disabled/)
    await assert.rejects(service.claim({ review: { ...good, expiresAt: 1 } }), /expired/)
    await assert.rejects(service.claim({ review: { ...good, receiver: creator.publicKey.toBase58() } }), /terms changed/)
    await assert.rejects(service.claim({ review: { ...good, amount: '1' } }), /terms changed/)
    const disagree = wrap({ getMultipleAccountsInfoAndContext: async (...args) => {
      const read = await connection.getMultipleAccountsInfoAndContext(...args)
      read.value[0].data = Buffer.from(read.value[0].data); read.value[0].data[100] ^= 1; return read
    } })
    await assert.rejects(createDbcPlatformFees({ pool, connection, config, partner, env, verification: disagree }).status(enrolled.githubRepoId), /RPC disagreement/)
    assert.throws(() => dbcPlatformEntitlement({ gross: '10', eligible: '10', discoveryPaid: '0', platformPaid: '0', version: 2, onchain: '11' }), /reconciliation/)
    assert.throws(() => dbcPlatformEntitlement({ gross: '10', eligible: '20', discoveryPaid: '0', platformPaid: '0', version: 2, onchain: '10' }), /Invalid/)
    assert.equal((await pool.query('select count(*)::int as n from platform_fee_claims')).rows[0].n, 0)
  })
  await t.test('simulation sends nothing; exact treasury receipt, no stranded rent; replay blocked', async () => {
    for (const m of [legacy, enrolled]) {
      const state = await service.status(m.githubRepoId), good = review(state)
      const sim = await service.claim({ review: good, simulateOnly: true })
      assert.equal(sim.status, 'simulated'); assert.equal(sim.broadcast, false)
      const before = await connection.getBalance(treasury.publicKey, 'finalized')
      const payerBefore = await connection.getBalance(partner.publicKey, 'finalized')
      const result = await service.claim({ review: good })
      assert.equal(result.reconciliation, 'MATCH')
      assert.equal(BigInt(await connection.getBalance(treasury.publicKey, 'finalized') - before), BigInt(state.available))
      assert.equal(BigInt(await connection.getBalance(partner.publicKey, 'finalized') - payerBefore), -BigInt(result.networkFee))
      const after = await dbc.state.getPool(m.pool)
      assert.equal(after.poolState.creatorQuoteFee.toString(), state.creatorUnclaimed)
      assert.equal(after.poolState.partnerQuoteFee.toString(), state.discoveryReserved)
      assert.equal((await service.status(m.githubRepoId)).available, '0')
      await assert.rejects(service.claim({ review: good }), /terms changed|No platform fees/)
    }
  })
  await t.test('discoverer can claim every reserved lamport after platform collection', async () => {
    const claims = createDiscoveryClaims({ pool, connection, config, partner })
    const offer = await claims.prepare({ repoId: enrolled.githubRepoId, wallet: launcher.publicKey.toBase58() })
    const tx = Transaction.from(Buffer.from(offer.transaction, 'base64')); tx.partialSign(launcher)
    const submitted = await claims.submit({ repoId: enrolled.githubRepoId, id: offer.id,
      transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') })
    await finalized(submitted.signature)
    assert.equal((await claims.recover(enrolled.githubRepoId)).status, 'settled')
    assert.equal((await discoverySummary(pool, enrolled.githubRepoId)).remaining, '0')
    assert.equal((await service.status(enrolled.githubRepoId)).available, '0')
  })
  await t.test('later accrual and lost broadcast response recover exactly once; corrupt receipt fails', async () => {
    await buy(enrolled)
    const current = await service.status(enrolled.githubRepoId)
    const lossy = wrap({ sendRawTransaction: async (...args) => { await connection.sendRawTransaction(...args); throw Error('Lost response') } })
    await assert.rejects(createDbcPlatformFees({ pool, connection: lossy, config, partner, env }).claim({ review: review(current) }), /Lost response/)
    await assert.rejects(service.status(enrolled.githubRepoId), /in flight/)
    const { rows: [intent] } = await pool.query(`select signature,signed_transaction as "signedTransaction", wallet,amount::text,pool,phase,evidence
      from platform_fee_claims where status='pending'`)
    await finalized(intent.signature)
    await assert.rejects(settleDbcPlatformClaim(pool, connection, { ...intent, amount: '1' }), /terms mismatch/)
    const chainTx = await connection.getTransaction(intent.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    await assert.rejects(settleDbcPlatformClaim(pool, wrap({ getTransaction: async () => ({ ...chainTx,
      meta: { ...chainTx.meta, innerInstructions: [] } }) }), intent), /event mismatch/)
    assert.equal((await createPlatformFeeRecovery({ pool, connection }).runOnce())[0].status, 'settled')
    assert.deepEqual(await createPlatformFeeRecovery({ pool, connection }).runOnce(), [])
    assert.equal((await service.status(enrolled.githubRepoId)).available, '0')
  })
  await t.test('same revenue ledger allocates once, phase totals agree and wrong spending custody blocks', async () => {
    const revenue = createPlatformRevenue({ pool, partnerWallet: treasury.publicKey })
    const policy = await revenue.createPolicy({ buybackPermille: 600, liquidityPermille: 200, createdBy: 'local-test' })
    await revenue.activatePolicy({ version: policy.version, createdBy: 'local-test' })
    const approval = { purpose: 'platform-revenue-allocate', policyVersion: policy.version, expiresAt: Date.now() + 60000 }
    await revenue.allocate({ review: approval, createdBy: 'local-test' })
    await assert.rejects(revenue.allocate({ review: approval, createdBy: 'local-test' }), /No claimed/)
    const summary = await platformRevenueSummary(pool)
    assert.equal(summary.claimed.damm, '0'); assert.equal(summary.claimed.total, summary.claimed.dbc)
    assert.equal(summary.allocated.total, summary.claimed.total)
    assert.equal(summary.spent, '0')
    await assert.rejects(assertPlatformReserveCustody(pool, partner.publicKey), /different treasury/)
    await assertPlatformReserveCustody(pool, treasury.publicKey)
    assert.equal((await reconcilePlatformRevenue(pool)).status, 'MATCH')
    console.log(JSON.stringify({ receipts: (await pool.query('select phase,amount::text,receipt from platform_fee_claims')).rows,
      revenue: summary, discovery: await discoverySummary(pool, enrolled.githubRepoId) }))
  })
})
