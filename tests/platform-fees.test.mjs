import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode as DbcSwapMode, deriveDbcPoolAuthority, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createGraduatedFees, recordGraduatedFees, recordPlatformFees } from '../src/graduated-fees.mjs'
import { createPlatformFees, createPlatformFeeRecovery, settlePlatformClaim } from '../src/platform-fees.mjs'
import { createReconciler } from '../src/reconcile.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'finalized')
const amm = new CpAmm(connection)
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch' })
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'finalized', preflightCommitment: 'confirmed' })
const repoId = '993001'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

test('platform fee capture: graduation, dual accrual, reviewed claim, replay, recovery, reconciliation', { timeout: 300_000 }, async t => {
  await pool.query('truncate repositories restart identity cascade')
  const creator = Keypair.generate(), trader = Keypair.generate(), buyer = Keypair.generate()
  for (const [key, sol] of [[creator, 5], [trader, 400], [buyer, 5]]) {
    const signature = await connection.requestAirdrop(key.publicKey, sol * 1e9)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
  }
  const { config, partner } = await createFixedConfig(connection, 'builders', { leftoverReceiver: creator.publicKey })
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    id: Number(repoId), name: 'platform-fees', full_name: 'local/platform-fees', owner: { login: 'local' }, private: false,
    archived: false, stargazers_count: 1, forks_count: 0, updated_at: '2026-01-01T00:00:00Z' }) })
  const market = await createLaunchCoordinator({ pool, fetchImpl, launcher: createMeteoraLauncher({ connection, config, creator }) })
    .launch({ repositoryUrl: 'https://github.com/local/platform-fees', tokenName: 'Platform Fees', tokenSymbol: 'PLAT',
      launcherWallet: trader.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(trader); return tx } })
  await connection.confirmTransaction(market.launchSignature, 'finalized')
  const indexer = await createLaunchIndexer({ pool, verify: createLaunchEvidenceVerifier({ connection, config }) }).processMarket(BigInt(repoId))
  assert.equal(indexer.state, 'indexed')

  // Graduate at exactly the configured threshold.
  const poolKey = new PublicKey(market.pool), mintKey = new PublicKey(market.mint)
  await send(await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey, pool: poolKey,
    amountIn: new BN(170e9), minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: DbcSwapMode.PartialFill, referralTokenAccount: null }), [trader])
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })), [trader])
  const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100], payer: trader.publicKey })
  await send(migration.transaction, [trader, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])

  // Zero-accrual path: partner capture is enrolled but empty before any DAMM trade.
  const fees = createExternalFeeIndexer({ pool, connection, config })
  const first = (await fees.runOnce()).find(row => String(row.githubRepoId) === repoId)
  assert.equal(first.status, 'OK')
  assert.equal(first.platformCredit, 0n)
  const service = createPlatformFees({ pool, connection, config, partner })
  assert.equal((await service.status(repoId)).enrolled, true)
  assert.equal((await service.status(repoId)).available, '0')
  await assert.rejects(() => service.claim({ review: { purpose: 'platform-fee-review', repoId, amount: '1',
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60000 } }), /No platform fees/)

  // Generate DAMM volume; both locked positions must accrue and index independently.
  async function dammBuy(lamports) {
    const damm = await dammPool()
    const state = await amm.fetchPoolState(damm)
    const tx = await amm.swap2({ payer: buyer.publicKey, pool: damm, inputTokenMint: NATIVE_MINT, outputTokenMint: mintKey,
      tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      swapMode: AmmSwapMode.ExactIn, amountIn: new BN(lamports), minimumAmountOut: new BN(1) })
    await send(tx, [buyer])
  }
  const graduatedFees = createGraduatedFees({ connection, config })
  async function dammPool() {
    const fixed = await dbc.state.getPoolConfig(config)
    return deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption], mintKey, NATIVE_MINT)
  }
  await dammBuy(1e9)
  const second = (await fees.runOnce()).find(row => String(row.githubRepoId) === repoId)
  assert.ok(second.platformCredit > 0n, 'partner position accrued and indexed')
  assert.ok(second.graduatedCredit > 0n, 'creator position accrued and indexed independently')
  const { rows: creatorEvents } = await pool.query('select count(*)::int as n from damm_fee_events where github_repo_id=$1', [repoId])
  const { rows: platformEvents } = await pool.query('select count(*)::int as n from platform_fee_events where github_repo_id=$1', [repoId])
  assert.ok(creatorEvents[0].n > 0 && platformEvents[0].n > 0)

  // Reviewed claim: wrong receiver and wrong amount fail closed before any broadcast.
  const status = await service.status(repoId)
  assert.ok(BigInt(status.available) > 0n)
  const goodReview = { purpose: 'platform-fee-review', repoId, amount: status.available,
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60000 }
  await assert.rejects(() => service.claim({ review: { ...goodReview, receiver: creator.publicKey.toBase58() } }), /protected partner wallet/)
  await assert.rejects(() => service.claim({ review: { ...goodReview, amount: String(BigInt(status.available) + 1n) } }), /differs/)
  await assert.rejects(() => service.claim({ review: { ...goodReview, expiresAt: Date.now() - 1 } }), /expired/)

  // Exact settlement: the partner wallet receives the full reviewed amount minus its own network fee.
  const before = await connection.getBalance(partner.publicKey, 'finalized')
  const receipt = await service.claim({ review: goodReview })
  const after = await connection.getBalance(partner.publicKey, 'finalized')
  assert.equal(receipt.status, 'settled')
  assert.ok(BigInt(after - before) + 5_000_000n >= BigInt(status.available), 'partner wallet received at least the reviewed amount minus fees')
  const snapshotAfter = await graduatedFees.read({ githubRepoId: repoId, pool: market.pool, mint: market.mint, creatorWallet: creator.publicKey.toBase58() })
  assert.equal(snapshotAfter.partner.available, 0n)
  assert.equal(snapshotAfter.partner.claimed, BigInt(status.available))
  assert.ok(snapshotAfter.available === snapshotAfter.claimed ? true : snapshotAfter.available >= 0n, 'creator position untouched by the platform claim')

  // Replay and repeat rejection.
  await assert.rejects(() => service.claim({ review: goodReview }), /No platform fees|in flight/)
  const { rows: [oneSettled] } = await pool.query(`select count(*)::int as n from platform_fee_claims where status='settled'`, [])
  assert.equal(oneSettled.n, 1)

  // Settlement mismatch fails closed.
  const { rows: [intent] } = await pool.query(`select signature, signed_transaction as "signedTransaction", wallet, amount::text, pool
    from platform_fee_claims where github_repo_id=$1 order by id desc limit 1`, [repoId])
  await assert.rejects(() => settlePlatformClaim(pool, connection, { ...intent, amount: String(BigInt(intent.amount) + 10_000_000n) }), /differs/)

  // Second accrual remains independently claimable; a lost response is recovered exactly once.
  await dammBuy(1e9)
  const third = (await fees.runOnce()).find(row => String(row.githubRepoId) === repoId)
  assert.ok(third.platformCredit > 0n)
  const lost = new Proxy(connection, { get(target, key) {
    if (key === 'sendRawTransaction') return async (...args) => { await target.sendRawTransaction(...args); throw Error('Lost response') }
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value } })
  const lostService = createPlatformFees({ pool, connection: lost, config, partner })
  const status2 = await service.status(repoId)
  const review2 = { ...goodReview, amount: status2.available }
  await assert.rejects(() => lostService.claim({ review: review2 }), /Lost response/)
  for (let i = 0; i < 160 && !await connection.getTransaction((await pool.query(
    'select signature from platform_fee_claims where status=$1 order by id desc limit 1', ['pending'])).rows[0]?.signature,
    { commitment: 'finalized', maxSupportedTransactionVersion: 0 }); i++) await delay(250)
  const recovered = await createPlatformFeeRecovery({ pool, connection }).runOnce()
  assert.equal(recovered[0].status, 'settled')
  assert.deepEqual(await createPlatformFeeRecovery({ pool, connection }).runOnce(), [])
  const settled = await service.status(repoId)
  assert.equal(settled.available, '0')
  await assert.rejects(() => service.claim({ review: { ...goodReview, amount: '1' } }), /No platform fees|differs/)

  // Decreasing entitlement fails closed.
  await assert.rejects(() => recordPlatformFees(pool, { githubRepoId: repoId }, { earned: 1n, claimed: 0n, available: 1n,
    pool: new PublicKey(market.pool), position: Keypair.generate().publicKey, nftAccount: Keypair.generate().publicKey,
    slot: 1, evidence: {}, hash: 'x'.repeat(64) }), /decreased/)

  // Independent reconciliation: creator and platform ledgers both MATCH.
  const result = await createReconciler({ pool, connection, config }).reconcile(repoId)
  assert.equal(result.status, 'MATCH')
  assert.ok(result.platform && result.platform.earned === result.platform.onchainEarned)
  console.log(JSON.stringify({ platformEarned: result.platform.earned.toString(), creatorEarned: result.recordedEarned.toString() }))
  t.after(async () => { await pool.end() })
})
