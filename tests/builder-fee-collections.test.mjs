import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createBuilderFeeCollections } from '../src/builder-fee-collections.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { createClaim } from '../src/claim.mjs'

const url = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_builder_collections'
assert.equal(url, 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_builder_collections', 'Disposable database required')
assert.equal(process.env.SOLANA_RPC_URL, 'http://127.0.0.1:8909', 'Local validator required')
const pool = new pg.Pool({ connectionString: url })
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed')
const pause = ms => new Promise(r => setTimeout(r, ms))
const wrap = changes => new Proxy(connection, { get(target, key) {
  if (changes[key]) return changes[key]
  const value = Reflect.get(target, key)
  return typeof value === 'function' ? value.bind(target) : value
} })
async function finalized(signature) {
  for (let n = 0; n < 180; n++) {
    const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (tx) return tx
    await pause(250)
  }
  throw Error('Finalized receipt unavailable')
}

test('manual builder collection preserves owner remainder, separates ledgers, rejects stale approvals and recovers once', { timeout: 300_000 }, async t => {
  t.after(() => pool.end())
  await pool.query('truncate repositories restart identity cascade')
  const creator = Keypair.generate(), launcher = Keypair.generate(), custody = Keypair.generate(), owner = Keypair.generate()
  for (const wallet of [creator, launcher, custody]) {
    const sig = await connection.requestAirdrop(wallet.publicKey, 20e9)
    await connection.confirmTransaction({ signature: sig, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const { config } = await createFixedConfig(connection)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const repoId = '997301'
  const coordinator = createLaunchCoordinator({ pool, discoveryEnabled: true,
    launcher: createMeteoraLauncher({ connection, config, creator }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: Number(repoId), name: 'collection',
      full_name: 'local/collection', owner: { login: 'local' }, private: false, archived: false,
      stargazers_count: 1, forks_count: 0, updated_at: '2026-01-01T00:00:00Z' }) }) })
  const market = await coordinator.launch({ repositoryUrl: 'https://github.com/local/collection', tokenName: 'Collection', tokenSymbol: 'COLL',
    launcherWallet: launcher.publicKey.toBase58(), initialBuyLamports: '10000000', signTransaction: async tx => { tx.partialSign(launcher); return tx } })
  await finalized(market.launchSignature)
  await createLaunchIndexer({ pool, verify: createLaunchEvidenceVerifier({ connection, config }) }).processMarket(BigInt(repoId))
  const accrual = createFeeAccrual({ pool, connection, config })
  await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [market.launchSignature] })
  const buy = async () => {
    const tx = await dbc.pool.swap2({ owner: launcher.publicKey, payer: launcher.publicKey, pool: new PublicKey(market.pool),
      amountIn: new BN('1000000101'), minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: SwapMode.ExactIn, referralTokenAccount: null })
    const signature = await sendAndConfirmTransaction(connection, tx, [launcher], { commitment: 'finalized' })
    await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [signature] })
  }
  await buy()
  const env = { BUILDER_FEE_COLLECTION_ENABLED: 'true' }
  const make = (changes = {}) => createBuilderFeeCollections({ pool, connection, verification: connection, config, creator, env, ...changes })
  const service = make(), approve = review => ({ reviewId: review.id, termsHash: review.termsHash })
  const review = () => service.review({ repoId, receiver: custody.publicKey.toBase58() })
  const reconcile = createReconciler({ pool, connection, config }).reconcile
  const initial = await review()
  const partnerBefore = (await dbc.state.getPool(market.pool)).poolState.partnerQuoteFee.toString()
  const ownerRequest = { githubRepoId: repoId, githubAuthorization: { session: true } }
  const ownerClaim = createClaim({ pool, connection, config, creator, githubVerifier: { verifyCurrentAuthority: async () => ({
    verified: true, permission: 'admin', githubRepoId: BigInt(repoId), githubUserId: 17n, verifiedAt: new Date() }) } })
  await pool.query(`insert into repo_verifications(github_repo_id,github_user_id,github_login,permission) values($1,17,'local-owner','admin')`, [repoId])
  await pool.query('insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values($1,17,$2)', [repoId, owner.publicKey.toBase58()])
  const { rows: [bound] } = await pool.query('select bound_at from repo_beneficiaries where github_repo_id=$1', [repoId])
  const oldOwnerReview = { purpose: 'builder-claim-review', repoId, wallet: owner.publicKey.toBase58(),
    boundAt: bound.bound_at.toISOString(), paid: '0', platformCollected: '0', amount: initial.terms.unclaimed, expiresAt: Date.now() + 600_000 }

  await t.test('exact half simulation is read-only and invalid review authority cannot pay', async () => {
    assert.equal(initial.terms.amount, String(BigInt(initial.terms.unclaimed) / 2n))
    assert.equal(BigInt(initial.terms.amount) + BigInt(initial.terms.remaining), BigInt(initial.terms.unclaimed))
    assert.equal(BigInt(initial.terms.unclaimed) % 2n, 1n, 'Odd fee balance leaves the extra lamport with the owner')
    const before = await connection.getBalance(custody.publicKey, 'finalized')
    assert.equal((await service.claim({ ...approve(initial), simulateOnly: true })).status, 'simulated')
    assert.equal(await connection.getBalance(custody.publicKey, 'finalized'), before)
    assert.equal((await service.receipt(initial.id)).status, 'reviewed')
    await assert.rejects(service.claim({ ...approve(initial), termsHash: '0'.repeat(64) }), /changed or expired/)
    const now = Date.now
    try { Date.now = () => initial.expiresAt + 1; await assert.rejects(service.claim(approve(initial)), /expired/) }
    finally { Date.now = now }
    await assert.rejects(make({ env: {} }).claim(approve(initial)), /disabled/)
  })
  await t.test('pending owner payout blocks collection; independent account disagreement blocks review', async () => {
    await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status)
      values($1,$2,1,'So11111111111111111111111111111111111111112',$3,'pending')`, [repoId, owner.publicKey.toBase58(), 'fixture-pending'])
    await assert.rejects(service.claim(approve(initial)), /conflicting payout/)
    await pool.query("delete from repo_claims where claim_signature='fixture-pending'")
    const disagree = wrap({ getMultipleAccountsInfoAndContext: async (...args) => {
      const r = await connection.getMultipleAccountsInfoAndContext(...args)
      r.value[0].data = Buffer.from(r.value[0].data); r.value[0].data[100] ^= 1
      return r
    } })
    await assert.rejects(make({ verification: disagree }).review({ repoId, receiver: custody.publicKey.toBase58() }), /RPC disagreement/)
  })
  await t.test('settled transfer pays the reviewed half and leaves partner fees and owner-paid totals untouched', async () => {
    const before = await connection.getBalance(custody.publicKey, 'finalized')
    const payer = await connection.getBalance(creator.publicKey, 'finalized')
    const receipt = await service.claim(approve(initial))
    assert.equal(receipt.reconciliation, 'MATCH')
    assert.equal(BigInt(await connection.getBalance(custody.publicKey, 'finalized') - before), BigInt(initial.terms.amount))
    assert.equal(BigInt(await connection.getBalance(creator.publicKey, 'finalized') - payer), -BigInt(receipt.networkFee))
    const state = (await dbc.state.getPool(market.pool)).poolState
    assert.equal(state.creatorQuoteFee.toString(), initial.terms.remaining)
    assert.equal(state.partnerQuoteFee.toString(), partnerBefore)
    const result = await reconcile(repoId)
    assert.equal(result.status, 'MATCH'); assert.equal(result.recordedClaimed, 0n)
    assert.equal(result.platformCollected, BigInt(initial.terms.amount))
    assert.equal((await pool.query('select count(*)::int n from repo_claims')).rows[0].n, 0)
    assert.equal((await pool.query('select count(*)::int n from platform_fee_claims')).rows[0].n, 0)
    await assert.rejects(service.claim(approve(initial)), /already consumed/)
  })
  await t.test('a settled collection invalidates a prior owner approval without paying its old amount', async () => {
    await assert.rejects(ownerClaim.claim({ ...ownerRequest, review: oldOwnerReview }), /Payout details changed/)
    assert.equal((await pool.query('select count(*)::int n from repo_claims')).rows[0].n, 0)
  })
  await t.test('new accrual invalidates a reviewed amount rather than silently changing collection', async () => {
    const stale = await review()
    await buy()
    await assert.rejects(service.claim(approve(stale)), /terms changed/)
  })
  let second
  await t.test('lost response blocks owner payout and recovery settles the same signature exactly once', async () => {
    second = await review()
    const lossy = wrap({ sendRawTransaction: async (...args) => { await connection.sendRawTransaction(...args); throw Error('Lost response') } })
    await assert.rejects(make({ connection: lossy }).claim(approve(second)), /Lost response/)
    const pending = await service.receipt(second.id)
    assert.equal(pending.status, 'pending')
    await assert.rejects(ownerClaim.claim(ownerRequest), /Pending platform collection/)
    await finalized(pending.signature)
    const badReceipt = wrap({ getTransaction: async (...args) => {
      const tx = await connection.getTransaction(...args)
      return tx ? { ...tx, meta: { ...tx.meta, postBalances: tx.meta.postBalances.map((v,i) => i === 0 ? v + 1 : v) } } : tx
    } })
    const rejected = await make({ verification: badReceipt }).recover()
    assert.equal(rejected[0].status, 'review')
    assert.equal((await service.receipt(second.id)).status, 'pending')
    const reverseKeys = value => value && typeof value === 'object'
      ? Array.isArray(value) ? value.map(reverseKeys) : Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k,reverseKeys(v)]))
      : value
    const reorderedReceipt = wrap({ getTransaction: async (...args) => {
      const tx = await connection.getTransaction(...args)
      return tx ? { ...tx, meta: reverseKeys(tx.meta) } : tx
    } })
    const recovered = await make({ verification: reorderedReceipt }).recover()
    assert.equal(recovered[0].signature, pending.signature); assert.equal(recovered[0].status, 'settled')
    assert.deepEqual(await service.recover(), [])
    assert.equal((await reconcile(repoId)).status, 'MATCH')
  })
  await t.test('an explicitly reviewed exact amount can cover the remainder without changing half defaults', async () => {
    const remaining = (await reconcile(repoId)).expectedRemaining
    const exact = await service.review({ repoId, receiver: custody.publicKey.toBase58(), amount: String(remaining) })
    assert.equal(exact.terms.selection, 'exact')
    assert.equal(exact.terms.amount, String(remaining))
    assert.equal(exact.terms.remaining, '0')
    const simulation = await service.claim({ reviewId: exact.id, termsHash: exact.termsHash, simulateOnly: true })
    assert.equal(simulation.broadcast, false)
    assert.equal(simulation.amount, String(remaining))
    assert.equal((await reconcile(repoId)).expectedRemaining, remaining)
    const half = await review()
    assert.equal(half.terms.amount, String(remaining / 2n))
    for (const amount of ['0', '-1', '1.5', String(remaining + 1n)]) {
      await assert.rejects(service.review({ repoId, receiver: custody.publicKey.toBase58(), amount }), /positive integer|exceeds/)
    }
  })
  await t.test('an operator payout recorded under another purpose is not a DBC collection; a DBC row the pool never paid still refuses', async () => {
    const remaining = (await reconcile(repoId)).expectedRemaining
    const settledRow = (purpose, signature, amount) => pool.query(`insert into builder_fee_collections(id,github_repo_id,mint,pool,wallet,amount,status,
      terms,terms_hash,expires_at,signature,signed_transaction,last_valid_block_height,receipt,settled_at)
      values(gen_random_uuid(),$1,$2,$3,$4,$5,'settled',$6,$7,now(),$8,'fixture',1,'{}',now())`,
      [repoId, initial.terms.mint, initial.terms.pool, custody.publicKey.toBase58(), amount, JSON.stringify({ purpose }), '0'.repeat(64), signature])
    try {
      // A DAMM position-fee payout in the same ledger took no DBC fees, so the DBC balance still matches the pool.
      await settledRow('operator-damm-payout-v1', 'fixture-damm-payout', '10000000000')
      const exact = await service.review({ repoId, receiver: custody.publicKey.toBase58(), amount: String(remaining) })
      assert.equal(exact.terms.unclaimed, String(remaining))
      assert.equal(exact.terms.platformCollected, String(BigInt(initial.terms.amount) + BigInt(second.terms.amount)))
      // A DBC collection the pool never paid breaks the on-chain equality, so the check still refuses.
      await settledRow('builder-fee-collection-v1', 'fixture-dbc-unpaid', '1')
      await assert.rejects(service.review({ repoId, receiver: custody.publicKey.toBase58() }), /indexing or reconciliation/)
    } finally {
      await pool.query("delete from builder_fee_collections where signature in ('fixture-damm-payout','fixture-dbc-unpaid')")
    }
  })
  await t.test('fresh ordinary owner claim receives the remaining entitlement without claiming platform withdrawals', async () => {
    const remaining = (await reconcile(repoId)).expectedRemaining
    const payout = await ownerClaim.claim(ownerRequest)
    assert.equal(payout.amountBaseUnits, remaining)
    const result = await reconcile(repoId)
    assert.equal(result.status, 'MATCH'); assert.equal(result.expectedRemaining, 0n)
    assert.equal(result.recordedClaimed, remaining)
    assert.equal(result.platformCollected, BigInt(initial.terms.amount) + BigInt(second.terms.amount))
    assert.equal((await dbc.state.getPool(market.pool)).poolState.partnerQuoteFee.toString(), second.terms.partnerUnclaimed)
  })
})
