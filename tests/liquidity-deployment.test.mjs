import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, createSyncNativeInstruction, getAccount } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode as DbcSwapMode, deriveDbcPoolAuthority, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createPlatformFees } from '../src/platform-fees.mjs'
import { createPlatformRevenue, platformRevenueSummary } from '../src/platform-revenue.mjs'
import { createLiquidityDeployment, liquidityConfig, liquidityReserveSummary, reconcileLiquidity, createLiquidityRecovery, settleLiquidityIntent } from '../src/liquidity-deployment.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const repoId = '996001'
process.env.REPO_LIQUIDITY_EXECUTION_ENABLED = 'true'
process.env.REPO_LIQUIDITY_MIN_VOLUME_LAMPORTS = '100000000'
process.env.REPO_LIQUIDITY_TARGET_SOL_LAMPORTS = '1000000000000'
process.env.REPO_LIQUIDITY_RULES_VERSION = '1'
process.env.REPO_LIQUIDITY_MAX_SLIPPAGE_BPS = '1000'
process.env.REPO_LIQUIDITY_MAX_PRICE_IMPACT_BPS = '2000'
process.env.REPO_LIQUIDITY_MIN_DEPLOY_LAMPORTS = '100000'
process.env.REPO_LIQUIDITY_MAX_DEPLOY_LAMPORTS = '100000000000'
process.env.REPO_LIQUIDITY_MAX_NETWORK_COST_LAMPORTS = '20000000'

const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'finalized')
const amm = new CpAmm(connection)
assert.equal(process.env.DATABASE_URL, 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_liquidity_test', 'Use the isolated disposable test database')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'finalized', preflightCommitment: 'confirmed' })

test('liquidity gate fails closed on missing or malformed configuration', () => {
  assert.equal(liquidityConfig({}), null)
  assert.throws(() => liquidityConfig({ ...process.env, REPO_LIQUIDITY_TARGET_SOL_LAMPORTS: '' }), /incomplete: REPO_LIQUIDITY_TARGET_SOL_LAMPORTS/)
  assert.throws(() => liquidityConfig({ ...process.env, REPO_LIQUIDITY_MAX_SLIPPAGE_BPS: '20000' }), /Invalid liquidity bounds/)
  assert.equal(liquidityConfig({ ...process.env }).rulesVersion, 1)
})

test('protocol liquidity: reserve, qualification, reviewed intent, swap and LP verification, reconciliation', { timeout: 420_000 }, async t => {
  t.after(() => pool.end())
  await pool.query('truncate repositories, platform_revenue_policies, platform_revenue_allocations, buyback_intents, liquidity_intents restart identity cascade')
  const creator = Keypair.generate(), trader = Keypair.generate(), buyer = Keypair.generate()
  for (const [key, sol] of [[creator, 5], [trader, 400], [buyer, 5]]) {
    const signature = await connection.requestAirdrop(key.publicKey, sol * 1e9)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
  }
  const { config, partner } = await createFixedConfig(connection, 'builders', { leftoverReceiver: creator.publicKey })
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: Number(repoId), name: 'protocol-lp',
    full_name: 'local/protocol-lp', owner: { login: 'local' }, private: false, archived: false, stargazers_count: 1,
    forks_count: 0, updated_at: '2026-01-01T00:00:00Z' }) })
  const market = await createLaunchCoordinator({ pool, fetchImpl, discoveryEnabled: true,
    launcher: createMeteoraLauncher({ connection, config, creator }) })
    .launch({ repositoryUrl: 'https://github.com/local/protocol-lp', tokenName: 'Protocol LP', tokenSymbol: 'PLIQ',
      launcherWallet: trader.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(trader); return tx } })
  await connection.confirmTransaction(market.launchSignature, 'finalized')
  assert.equal((await createLaunchIndexer({ pool, verify: createLaunchEvidenceVerifier({ connection, config }) })
    .processMarket(BigInt(repoId))).state, 'indexed')

  // Reserve starts at zero: no claim, no allocation, nothing deployable.
  const rules = liquidityConfig()
  assert.ok(rules)
  const liquidity = createLiquidityDeployment({ pool, connection, config, partner })
  assert.equal((await liquidityReserveSummary(pool)).remaining, '0')
  const notGraduated = await liquidity.qualification(pool, repoId, rules)
  assert.equal(notGraduated.eligible, false, 'market has not graduated yet')

  // Graduate and generate volume on both sides, then claim platform fees and allocate under policy v1.
  const poolKey = new PublicKey(market.pool), mintKey = new PublicKey(market.mint)
  const fees = createExternalFeeIndexer({ pool, connection, config })
  const platformFees = createPlatformFees({ pool, connection, config, partner })
  const revenue = createPlatformRevenue({ pool, partnerWallet: partner.publicKey })
  await send(await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey, pool: poolKey,
    amountIn: new BN(170e9), minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: DbcSwapMode.PartialFill, referralTokenAccount: null }), [trader])
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })), [trader])
  const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100], payer: trader.publicKey })
  await send(migration.transaction, [trader, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
  const fixed = await dbc.state.getPoolConfig(config)
  const { deriveDammV2PoolAddress } = await import('@meteora-ag/dynamic-bonding-curve-sdk')
  const damm = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption], mintKey, NATIVE_MINT)
  const dammState = await amm.fetchPoolState(damm)
  await send(await amm.swap2({ payer: buyer.publicKey, pool: damm, inputTokenMint: NATIVE_MINT, outputTokenMint: mintKey,
    tokenAMint: dammState.tokenAMint, tokenBMint: dammState.tokenBMint, tokenAVault: dammState.tokenAVault, tokenBVault: dammState.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    swapMode: AmmSwapMode.ExactIn, amountIn: new BN(1e9), minimumAmountOut: new BN(1) }), [buyer])
  await (await fees.runOnce())
  const status = await platformFees.status(repoId)
  assert.ok(BigInt(status.available) > 0n)
  await platformFees.claim({ review: { purpose: 'platform-fee-review', repoId, amount: status.available,
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60000 } })
  await revenue.activatePolicy({ version: (await revenue.createPolicy({ buybackPermille: 500, liquidityPermille: 300, createdBy: 'op' })).version, createdBy: 'op' })
  await revenue.allocate({ review: { purpose: 'platform-revenue-allocate', policyVersion: 1, expiresAt: Date.now() + 60000 }, createdBy: 'op' })
  const summary = await platformRevenueSummary(pool)
  const reserve = BigInt(summary.allocated.liquidity)
  assert.ok(reserve > 0n, 'liquidity reserve funded')
  assert.equal((await liquidityReserveSummary(pool)).remaining, reserve.toString())

  // Qualification now passes; the operator picks the market.
  const eligible = await liquidity.qualification(pool, repoId, rules)
  assert.equal(eligible.eligible, true, eligible.reason)

  // Failure matrix before any happy path.
  await assert.rejects(() => liquidity.createIntent({ repoId, sourceAmount: (reserve * 2n).toString(),
    idempotencyKey: 'overspend-key', createdBy: 'op' }), /exceeds the remaining liquidity reserve/)
  await assert.rejects(() => liquidity.createIntent({ repoId: '999999999', sourceAmount: '1000000',
    idempotencyKey: 'wrong-market', createdBy: 'op' }), /not indexed|not eligible/)

  const amount = reserve
  const intent = await liquidity.createIntent({ repoId, sourceAmount: amount.toString(),
    idempotencyKey: 'protocol-lp-1', createdBy: 'op' })
  assert.equal(intent.status, 'prepared')
  await assert.rejects(() => liquidity.createIntent({ repoId, sourceAmount: amount.toString(),
    idempotencyKey: 'protocol-lp-1', createdBy: 'op' }), /idempotency key already exists/)
  await assert.rejects(() => liquidity.createIntent({ repoId, sourceAmount: amount.toString(),
    idempotencyKey: 'protocol-lp-2', createdBy: 'op' }), /open liquidity intent already exists/)
  await assert.rejects(() => liquidity.simulateIntent({ id: intent.id }), /Only reviewed intents/)

  const goodReview = { purpose: 'liquidity-intent-review', id:intent.id, termsHash:intent.termsHash, amount: amount.toString(), policyVersion: 1,
    rulesVersion: 1, quoteIdentifier: 'damm-self-v1', expiresAt: Date.now() + 600000 }
  await assert.rejects(() => liquidity.reviewIntent({ id: intent.id, review: { ...goodReview, amount: (amount + 1n).toString() } }), /differs/)
  await assert.rejects(() => liquidity.reviewIntent({ id: intent.id, review: { ...goodReview, policyVersion: 2 } }), /Policy version mismatch/)
  await assert.rejects(() => liquidity.reviewIntent({ id: intent.id, review: { ...goodReview, rulesVersion: 2 } }), /rules version mismatch/)
  await assert.rejects(() => liquidity.reviewIntent({ id: intent.id, review: { ...goodReview, expiresAt: Date.now() - 1 } }), /expired/)
  await liquidity.reviewIntent({ id: intent.id, review: goodReview, reviewedBy: 'op' })

  // Reserve is committed by the open intent; a second intent cannot spend it.
  const committed = await liquidityReserveSummary(pool)
  assert.equal(BigInt(committed.committed), amount)

  // Full reserve stays usable by its own intent; disabling or changing rules blocks it.
  process.env.REPO_LIQUIDITY_EXECUTION_ENABLED='false'
  await assert.rejects(liquidity.simulateIntent({id:intent.id}),/disabled/)
  process.env.REPO_LIQUIDITY_EXECUTION_ENABLED='true'
  process.env.REPO_LIQUIDITY_MAX_PRICE_IMPACT_BPS='1999'
  await assert.rejects(liquidity.simulateIntent({id:intent.id}),/rules drift/)
  process.env.REPO_LIQUIDITY_MAX_PRICE_IMPACT_BPS='2000'
  // Existing treasury holdings must survive the action unchanged, apart from the reviewed draw.
  const baseAta=getAssociatedTokenAddressSync(mintKey,partner.publicKey),wsolAta=getAssociatedTokenAddressSync(NATIVE_MINT,partner.publicKey)
  await send(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey,baseAta,partner.publicKey,mintKey),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mintKey,trader.publicKey),mintKey,baseAta,trader.publicKey,1000000n,6),
    createAssociatedTokenAccountIdempotentInstruction(trader.publicKey,wsolAta,partner.publicKey,NATIVE_MINT),
    SystemProgram.transfer({fromPubkey:trader.publicKey,toPubkey:wsolAta,lamports:50000000}),createSyncNativeInstruction(wsolAta)),[trader])
  const preexistingBase=(await getAccount(connection,baseAta,'finalized')).amount
  const simulation = await liquidity.simulateIntent({ id: intent.id })
  assert.equal(simulation.status, 'simulated')
  assert.ok(BigInt(simulation.expectedLiquidity) > 0n)

  // Execution: the reviewed action runs on-chain — balancing swap plus LP deposit.
  const concurrent=await Promise.allSettled([liquidity.executeIntent({id:intent.id}),liquidity.executeIntent({id:intent.id})])
  assert.equal(concurrent.filter(x=>x.status==='fulfilled').length,1)
  const receipt=concurrent.find(x=>x.status==='fulfilled').value
  assert.equal(receipt.status,'settled')
  assert.ok((await getAccount(connection,baseAta,'finalized')).amount>=preexistingBase)
  const { rows: [settled] } = await pool.query(`select position, settled_liquidity::text, settled_debit::text,
    position_nft_mint from liquidity_intents where id=$1`, [intent.id])
  assert.ok(settled.position && settled.position_nft_mint, 'position evidence recorded')
  assert.ok(BigInt(settled.settled_liquidity) > 0n)
  assert.ok(BigInt(settled.settled_debit) <= amount, 'economic debit stays within its allocation')

  // Replay and post-settlement rejections.
  await assert.rejects(() => liquidity.executeIntent({ id: intent.id }), /Only simulated intents|already settled/)
  const settledSummary = await liquidityReserveSummary(pool)
  assert.equal(settledSummary.settled, settled.settled_debit)
  assert.equal(BigInt(settledSummary.remaining), reserve - BigInt(settled.settled_debit))

  // Second deployment is independently possible after a fresh accrual and claim.
  await send(await amm.swap2({ payer: buyer.publicKey, pool: damm, inputTokenMint: NATIVE_MINT, outputTokenMint: mintKey,
    tokenAMint: dammState.tokenAMint, tokenBMint: dammState.tokenBMint, tokenAVault: dammState.tokenAVault, tokenBVault: dammState.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    swapMode: AmmSwapMode.ExactIn, amountIn: new BN(1e9), minimumAmountOut: new BN(1) }), [buyer])
  await (await fees.runOnce())
  const status2 = await platformFees.status(repoId)
  const second = await platformFees.claim({ review: { purpose: 'platform-fee-review', repoId, amount: status2.available,
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60000 } })
  await revenue.allocate({ review: { purpose: 'platform-revenue-allocate', policyVersion: 1, expiresAt: Date.now() + 60000 }, createdBy: 'op' })
  const afterSecond = await liquidityReserveSummary(pool)
  assert.ok(BigInt(afterSecond.remaining) > 0n, 'reserve refilled after the second claim and allocation')

  // Fresh intent, lost response, expired-looking RPC with known signature, then recovery without a signer.
  const amount2=BigInt(afterSecond.remaining)
  const intent2=await liquidity.createIntent({repoId,sourceAmount:String(amount2),idempotencyKey:'protocol-lp-recovery',createdBy:'op'})
  await liquidity.reviewIntent({id:intent2.id,review:{...goodReview,id:intent2.id,termsHash:intent2.termsHash,amount:String(amount2)},reviewedBy:'op'})
  await liquidity.simulateIntent({id:intent2.id})
  const lost=new Proxy(connection,{get(target,key){if(key==='sendRawTransaction')return async(...args)=>{await target.sendRawTransaction(...args);throw Error('Lost broadcast response')};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
  await assert.rejects(createLiquidityDeployment({pool,connection:lost,config,partner}).executeIntent({id:intent2.id}),/Lost broadcast response/)
  const {rows:[durable]}=await pool.query('select * from liquidity_intents where id=$1',[intent2.id])
  assert.equal(durable.status,'submitted')
  const unavailable=new Proxy(connection,{get(target,key){if(key==='getTransaction')return async()=>null;if(key==='getBlockHeight')return async()=>Number(durable.last_valid_block_height)+100;if(key==='getSignatureStatuses')return async()=>({value:[{confirmationStatus:'confirmed'}]});const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v}})
  assert.equal((await createLiquidityRecovery({pool,connection:unavailable}).runOnce())[0].status,'submitted')
  await assert.rejects(liquidity.cancelIntent({id:intent2.id}),/cannot be cancelled/)
  await connection.confirmTransaction(durable.signature,'finalized')
  await assert.rejects(settleLiquidityIntent(pool,connection,{...durable,source_wallet:buyer.publicKey.toBase58()}),/authority or assets/)
  assert.equal((await createLiquidityRecovery({pool,connection}).runOnce())[0].status,'settled')
  const {rows:[afterRecovery]}=await pool.query('select settled_debit::text from liquidity_intents where id=$1',[intent2.id])
  const totalSpent=BigInt(settled.settled_debit)+BigInt(afterRecovery.settled_debit)
  // Reconciliation: reserve math and position evidence all trace.
  const reconciliation = await reconcileLiquidity(pool)
  assert.equal(reconciliation.status, 'MATCH', JSON.stringify(reconciliation.problems))
  assert.equal(BigInt(reconciliation.summary.settled), totalSpent)

  // Recovery: nothing pending, and it produces no second economic action.
  assert.deepEqual(await createLiquidityRecovery({ pool, connection, partner }).runOnce(), [])
  console.log(JSON.stringify({ reserve: reserve.toString(), deployed: amount.toString(),
    settledLiquidity: settled.settled_liquidity, position: settled.position }))
})
