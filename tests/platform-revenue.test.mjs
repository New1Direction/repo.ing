import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode as DbcSwapMode, deriveDbcPoolAuthority, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createPlatformFees } from '../src/platform-fees.mjs'
import { createPlatformRevenue, platformRevenueSummary, reconcilePlatformRevenue, buybackExecutionConfig, activePolicy } from '../src/platform-revenue.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'finalized')
const amm = new CpAmm(connection)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch' })
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'finalized', preflightCommitment: 'confirmed' })
const repoId = '994001'

test('buyback execution gate fails closed on incomplete configuration', () => {
  assert.equal(buybackExecutionConfig({}), null, 'disabled by default')
  const partial = { REPO_BUYBACK_EXECUTION_ENABLED: 'true', REPO_TOKEN_MINT: '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M' }
  assert.throws(() => buybackExecutionConfig(partial), /incomplete: REPO_TREASURY_TOKEN_ACCOUNT/)
  const badBounds = { ...partial, REPO_TREASURY_TOKEN_ACCOUNT: '9nJmEkCePKHgZTPwFTQGGCND2GsA5hQ4a55ftPMbHsWM',
    REPO_BUYBACK_VENUE: 'unverified', REPO_BUYBACK_MAX_SLIPPAGE_BPS: '50000', REPO_BUYBACK_MAX_PRICE_IMPACT_BPS: '500',
    REPO_BUYBACK_MIN_SIZE_LAMPORTS: '1000000', REPO_BUYBACK_MAX_SIZE_LAMPORTS: '1000000000' }
  assert.throws(() => buybackExecutionConfig(badBounds), /Invalid buyback bounds/)
  const valid = { ...badBounds, REPO_BUYBACK_MAX_SLIPPAGE_BPS: '300' }
  const config = buybackExecutionConfig(valid)
  assert.equal(config.mint, partial.REPO_TOKEN_MINT)
  assert.equal(config.maxSlippageBps, 300)
})

test('platform revenue to buyback readiness: ledger, policy, allocation, intent, dry run, gate, reconciliation', { timeout: 300_000 }, async t => {
  await pool.query('truncate repositories, platform_revenue_policies, platform_revenue_allocations, buyback_intents restart identity cascade')
  const creator = Keypair.generate(), trader = Keypair.generate(), buyer = Keypair.generate()
  for (const [key, sol] of [[creator, 5], [trader, 400], [buyer, 5]]) {
    const signature = await connection.requestAirdrop(key.publicKey, sol * 1e9)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
  }
  const { config, partner } = await createFixedConfig(connection, 'builders', { leftoverReceiver: creator.publicKey })
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    id: Number(repoId), name: 'platform-revenue', full_name: 'local/platform-revenue', owner: { login: 'local' }, private: false,
    archived: false, stargazers_count: 1, forks_count: 0, updated_at: '2026-01-01T00:00:00Z' }) })
  const market = await createLaunchCoordinator({ pool, fetchImpl, discoveryEnabled: true,
    launcher: createMeteoraLauncher({ connection, config, creator }) })
    .launch({ repositoryUrl: 'https://github.com/local/platform-revenue', tokenName: 'Revenue', tokenSymbol: 'REV',
      launcherWallet: trader.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(trader); return tx } })
  await connection.confirmTransaction(market.launchSignature, 'finalized')
  assert.equal((await createLaunchIndexer({ pool, verify: createLaunchEvidenceVerifier({ connection, config }) })
    .processMarket(BigInt(repoId))).state, 'indexed')

  // Accrue both revenue phases: curve buys (DBC partner fees) then graduation and DAMM volume.
  const poolKey = new PublicKey(market.pool), mintKey = new PublicKey(market.mint)
  const fees = createExternalFeeIndexer({ pool, connection, config })
  const platformFees = createPlatformFees({ pool, connection, config, partner })
  const revenue = createPlatformRevenue({ pool, partnerWallet: partner.publicKey })
  const reviewFor = extra => ({ purpose: 'platform-revenue-allocate', policyVersion: 1, expiresAt: Date.now() + 60000, ...extra })

  // Before any claim: earned evidence exists after trades, but nothing is spendable.
  await send(await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey, pool: poolKey,
    amountIn: new BN(5e9), minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: DbcSwapMode.PartialFill, referralTokenAccount: null }), [trader])
  await (await fees.runOnce())
  let summary = await platformRevenueSummary(pool)
  assert.ok(BigInt(summary.earned.dbc) > 0n, 'DBC partner fees recorded in the ledger')
  assert.equal(summary.claimed.total, '0')
  assert.equal(summary.available, '0')
  await assert.rejects(() => revenue.allocate({ review: reviewFor(), createdBy: "op" }), /No active platform revenue policy/)
  await assert.rejects(() => platformFees.claim({ review: { purpose: 'platform-fee-review', repoId, amount: '1',
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60000 } }), /No platform fees|not indexed/)

  // Policy: invalid permilles rejected; versioned create + immutable activate.
  await assert.rejects(() => revenue.createPolicy({ buybackPermille: 700, liquidityPermille: 400, createdBy: 'op' }), /at most 1000/)
  const draft = await revenue.createPolicy({ buybackPermille: 600, liquidityPermille: 200, createdBy: 'op' })
  assert.equal(draft.version, 1)
  assert.equal((await activePolicy(pool)), null, 'draft policy is not active')
  await assert.rejects(() => revenue.allocate({ review: reviewFor(), createdBy: 'op' }), /No active platform revenue policy/)
  await revenue.activatePolicy({ version: draft.version, createdBy: 'op' })
  await assert.rejects(() => revenue.activatePolicy({ version: draft.version, createdBy: 'op' }), /already immutable/)

  // Claim platform fees, then allocate exactly once under the active policy.
  await send(await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey, pool: poolKey,
    amountIn: new BN(170e9), minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: DbcSwapMode.PartialFill, referralTokenAccount: null }), [trader])
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })), [trader])
  const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100], payer: trader.publicKey })
  await send(migration.transaction, [trader, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
  const fixed = await dbc.state.getPoolConfig(config)
  const damm = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption], mintKey, NATIVE_MINT)
  const dammState = await amm.fetchPoolState(damm)
  await send(await amm.swap2({ payer: buyer.publicKey, pool: damm, inputTokenMint: NATIVE_MINT, outputTokenMint: mintKey,
    tokenAMint: dammState.tokenAMint, tokenBMint: dammState.tokenBMint, tokenAVault: dammState.tokenAVault, tokenBVault: dammState.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    swapMode: AmmSwapMode.ExactIn, amountIn: new BN(1e9), minimumAmountOut: new BN(1) }), [buyer])
  await (await fees.runOnce())
  summary = await platformRevenueSummary(pool)
  assert.ok(BigInt(summary.earned.damm) > 0n, 'DAMM partner fees recorded in the ledger')
  const status = await platformFees.status(repoId)
  assert.ok(BigInt(status.available) > 0n)
  await platformFees.claim({ review: { purpose: 'platform-fee-review', repoId, amount: status.available,
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60000 } })
  summary = await platformRevenueSummary(pool)
  assert.ok(BigInt(summary.claimed.total) > 0n)
  assert.equal(summary.available, summary.claimed.total, 'claimed revenue is available until allocated')

  // Stale policy version in the review fails closed.
  await assert.rejects(() => revenue.allocate({ review: reviewFor({ policyVersion: 99 }), createdBy: 'op' }), /different policy version/)
  await assert.rejects(() => revenue.allocate({ review: reviewFor({ expiresAt: Date.now() - 1 }), createdBy: 'op' }), /expired/)
  const allocation = await revenue.allocate({ review: reviewFor(), createdBy: 'op' })
  assert.equal(allocation.policyVersion, 1)
  assert.ok(BigInt(allocation.claimedAmount) > 0n)
  summary = await platformRevenueSummary(pool)
  assert.equal(summary.available, '0', 'all settled claims consumed')
  const claimed = BigInt(summary.claimed.total)
  assert.equal(BigInt(summary.allocated.buyback), claimed * 600n / 1000n)
  assert.equal(BigInt(summary.allocated.liquidity), claimed * 200n / 1000n)
  assert.equal(BigInt(summary.allocated.treasury), claimed - BigInt(summary.allocated.buyback) - BigInt(summary.allocated.liquidity))
  await assert.rejects(() => revenue.allocate({ review: reviewFor(), createdBy: 'op' }), /No claimed platform revenue/, 'double allocation rejected')

  // Buyback intents: overspend, duplicate idempotency, review mismatch, dry run, gate.
  const reserve = BigInt(summary.buybackReserve)
  assert.equal(reserve, BigInt(summary.allocated.buyback))
  const intentReview = { purpose: 'platform-revenue-intent.create', sessionId: 's', allocationGroup: allocation.group,
    amount: (reserve + 1n).toString(), idempotencyKey: 'overspend-key', expiresAt: Date.now() + 60000 }
  await assert.rejects(() => revenue.createIntent({ allocationGroup: allocation.group, amount: (reserve + 1n).toString(),
    idempotencyKey: 'overspend-key', createdBy: 'op' }), /exceeds the remaining reserve/, 'overspend rejected')
  const half = reserve / 2n
  const intent = await revenue.createIntent({ allocationGroup: allocation.group, amount: half.toString(),
    idempotencyKey: 'launch-buyback-1', createdBy: 'op' })
  assert.equal(intent.status, 'prepared')
  await assert.rejects(() => revenue.createIntent({ allocationGroup: allocation.group, amount: half.toString(),
    idempotencyKey: 'launch-buyback-1', createdBy: 'op' }), /idempotency key already exists/, 'duplicate intent rejected')
  await assert.rejects(() => revenue.simulateIntent({ id: intent.id }), /Only reviewed intents/, 'prepared intent cannot simulate')
  await assert.rejects(() => revenue.reviewIntent({ id: intent.id, review: { purpose: 'buyback-intent-review',
    amount: (reserve + 1n).toString(), expiresAt: Date.now() + 60000 }, reviewedBy: 'op' }), /differs from the prepared intent/)
  const reviewed = await revenue.reviewIntent({ id: intent.id, review: { purpose: 'buyback-intent-review',
    amount: half.toString(), destinationMint: null, destinationTokenAccount: null, quoteIdentifier: null,
    expectedOutput: null, minimumOutput: null, maxSlippageBps: 300, maxPriceImpactBps: 500,
    expiresAt: Date.now() + 60000 }, reviewedBy: 'op' })
  assert.equal(reviewed.amount, half.toString())
  const simulation = await revenue.simulateIntent({ id: intent.id })
  assert.equal(simulation.status, 'simulated')
  assert.equal(simulation.simulation.dryRun, true)
  assert.equal(simulation.simulation.gateConfigured, false)
  await assert.rejects(() => revenue.simulateIntent({ id: intent.id }), /Only reviewed intents/, 'already simulated rejected')
  await assert.rejects(() => revenue.executeIntent({ id: intent.id }), /execution is disabled/, 'gate blocks execution while $REPO is absent')

  // End-to-end reconciliation: earned, claimed, available, reserve all trace; nothing spent.
  const reconciliation = await reconcilePlatformRevenue(pool)
  assert.equal(reconciliation.status, 'MATCH')
  assert.equal(reconciliation.summary.spent, '0')
  assert.equal(reconciliation.summary.buybackReserve, summary.buybackReserve)
  console.log(JSON.stringify({ earned: reconciliation.summary.earned, claimed: reconciliation.summary.claimed,
    buybackReserve: reconciliation.summary.buybackReserve, policy: summary.activePolicy }))
  t.after(async () => { await pool.end() })
})
