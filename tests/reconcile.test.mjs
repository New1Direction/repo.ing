import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { drizzle } from 'drizzle-orm/node-postgres'
import { feeEvents, repoBeneficiaries, repoClaims, repoVerifications } from '../src/db/schema.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createClaim } from '../src/claim.mjs'
import { createReconciler } from '../src/reconcile.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_reconcile'
const connection = new Connection(rpc, 'confirmed')
const pool = new pg.Pool({ connectionString: databaseUrl })
const db = drizzle(pool)
const repoId = 1384142609n
let config, market, creator, traderWallet, trader, accrual, reconciler, claim, firstFee, laterFee, claimResult
const githubVerifier = { verifyCallback: async ({ githubRepoId, expectedGithubRepoId }) => {
  assert.equal(githubRepoId, repoId)
  assert.equal(expectedGithubRepoId, repoId)
  return { verified: true, permission: 'admin', githubRepoId: repoId,
    githubUserId: 285551516n, verifiedAt: new Date() }
} }
const claimRequest = () => ({ githubRepoId: repoId,
  githubAuthorization: { code: 'local-fixture', state: 'local-state', expectedState: 'local-state' } })
const finalizedTrade = async amountLamports => {
  const prepared = await trader.prepareBuy({ githubRepoId: repoId,
    wallet: traderWallet.publicKey.toBase58(), amountLamports })
  const result = await trader.submitTrade(prepared, async tx => { tx.partialSign(traderWallet); return tx })
  let finalized = null
  for (let i = 0; i < 120; i++) {
    finalized = await connection.getTransaction(result.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (finalized) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(finalized)
  return result.signature
}
const snapshot = result => ({ earned: result.recordedEarned.toString(),
  claimed: result.recordedClaimed.toString(), remaining: result.expectedRemaining.toString(),
  onchain: result.onchainCreatorFee?.toString() ?? null, status: result.status,
  difference: result.difference?.toString() ?? null })

test.before(async () => {
  await pool.query('truncate repo_claims, wallet_binding_challenges, repo_beneficiaries, repo_verifications, fee_events, markets, repositories restart identity cascade')
  ;({ config } = await createFixedConfig(connection))
  creator = Keypair.generate()
  const beneficiary = Keypair.generate()
  const launcherWallet = Keypair.generate()
  traderWallet = Keypair.generate()
  for (const wallet of [creator, launcherWallet, traderWallet]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    id: Number(repoId), name: 'Waternot', full_name: 'New1Direction/Waternot',
    owner: { login: 'New1Direction' }, description: null, stargazers_count: 1, forks_count: 1,
    archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
  }) })
  market = await createLaunchCoordinator({ pool, launcher: createMeteoraLauncher({ connection, config, creator }), fetchImpl }).launch({
    repositoryUrl: 'https://github.com/New1Direction/Waternot', tokenName: 'Reconcile Repo', tokenSymbol: 'RECON',
    launcherWallet: launcherWallet.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(launcherWallet); return tx },
  })
  const verifyLaunch = createLaunchEvidenceVerifier({ connection, config })
  let finality
  for (let i = 0; i < 120; i++) {
    finality = await verifyLaunch(market)
    if (finality.state === 'match') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(finality.state, 'match')
  assert.equal((await createLaunchIndexer({ pool, verify: verifyLaunch }).runOnce())[0].state, 'indexed')
  await db.insert(repoVerifications).values({ githubRepoId: repoId, githubUserId: 285551516n,
    githubLogin: 'local-test-admin', permission: 'admin' })
  await db.insert(repoBeneficiaries).values({ githubRepoId: repoId, githubUserId: 285551516n,
    wallet: beneficiary.publicKey.toBase58() })
  trader = createCanonicalTrader({ pool, connection, config })
  accrual = createFeeAccrual({ pool, connection, config })
  claim = createClaim({ pool, connection, config, creator, githubVerifier })
  reconciler = createReconciler({ pool, connection, config })
})
test.after(async () => { await pool.end() })

test('accrued creator fees with no claim reconcile to MATCH', async () => {
  const signature = await finalizedTrade(10_000_000n)
  firstFee = await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [signature] })
  const result = await reconciler.reconcile(repoId)
  assert.equal(result.status, 'MATCH')
  assert.equal(result.recordedEarned, firstFee.earnedBaseUnits)
  assert.equal(result.recordedClaimed, 0n)
  assert.equal(result.expectedRemaining, firstFee.earnedBaseUnits)
  assert.equal(result.onchainCreatorFee, firstFee.earnedBaseUnits)
  console.log(JSON.stringify({ stage: 'before_claim', signature, ...snapshot(result) }))
})

test('settled creator-fee claim reconciles to MATCH', async () => {
  claimResult = await claim.claim(claimRequest())
  const result = await reconciler.reconcile(repoId)
  assert.equal(result.status, 'MATCH')
  assert.equal(result.recordedEarned, firstFee.earnedBaseUnits)
  assert.equal(result.recordedClaimed, claimResult.amountBaseUnits)
  assert.equal(result.expectedRemaining, 0n)
  assert.equal(result.onchainCreatorFee, 0n)
  console.log(JSON.stringify({ stage: 'after_claim', claimSignature: claimResult.signature, ...snapshot(result) }))
})

test('later trade accrues new fees and a new process reproduces MATCH with positive remaining', async () => {
  const signature = await finalizedTrade(5_000_000n)
  laterFee = await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [signature] })
  const result = await reconciler.reconcile(repoId)
  assert.equal(result.status, 'MATCH')
  assert.ok(result.expectedRemaining > 0n)
  assert.equal(result.recordedClaimed, claimResult.amountBaseUnits)
  assert.equal(result.expectedRemaining, result.onchainCreatorFee)
  const output = execFileSync(process.execPath, ['scripts/reconcile-repo.mjs', repoId.toString(), config.toBase58()],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc }, encoding: 'utf8' })
  const restarted = JSON.parse(output)
  assert.deepEqual(restarted, JSON.parse(JSON.stringify(result,
    (_key, value) => typeof value === 'bigint' ? value.toString() : value)))
  console.log(JSON.stringify({ stage: 'later_trade', signature, ...snapshot(result), restart: 'same_result' }))
})

test('controlled ledger disagreement returns MISMATCH and makes no repair', async () => {
  const fakeSignature = 'controlled-ledger-disagreement'
  await db.insert(feeEvents).values({ githubRepoId: repoId, mint: market.mint, pool: market.pool,
    signature: fakeSignature, eventIndex: 0, amountBaseUnits: 1n, asset: NATIVE_MINT.toBase58(),
    kind: 'dbc_creator_quote', slot: 1n })
  const result = await reconciler.reconcile(repoId)
  assert.equal(result.status, 'MISMATCH')
  assert.equal(result.expectedRemaining, laterFee.observedCreatorFee + 1n)
  assert.equal(result.onchainCreatorFee, laterFee.observedCreatorFee)
  assert.equal(result.difference, -1n)
  assert.equal((await db.select().from(feeEvents)).length, 3)
  assert.equal((await db.select().from(repoClaims)).length, 1)
  console.log(JSON.stringify({ stage: 'controlled_mismatch', ...snapshot(result), repaired: false }))
})

test('unresolved pending claim returns PENDING_REVIEW', async () => {
  await db.insert(repoClaims).values({ githubRepoId: repoId,
    beneficiaryWallet: Keypair.generate().publicKey.toBase58(), amountBaseUnits: 1n,
    asset: NATIVE_MINT.toBase58(), claimSignature: 'unresolved-local-intent', status: 'pending' })
  const result = await reconciler.reconcile(repoId)
  assert.equal(result.status, 'PENDING_REVIEW')
  assert.equal(result.onchainCreatorFee, null)
  assert.equal(result.difference, null)
  assert.equal(result.recordedClaimed, claimResult.amountBaseUnits)
  console.log(JSON.stringify({ stage: 'pending', ...snapshot(result) }))
})
