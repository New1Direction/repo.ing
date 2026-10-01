import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, MigrationFeeOption, SwapMode, deriveDbcPoolAuthority,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { buildLaunchFeeConfigTransaction, reviewLaunchFeeConfig, verifyCreatedLaunchFeeConfig } from '../src/launch-fee-config.mjs'
import { feeNumeratorAt, launchFeeWindow, readFeeSchedule, STANDARD_FEE_NUMERATOR } from '../src/launch-fee.mjs'
import { readChainPoint } from '../src/chain-clock.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { canonicalDbcSwapEvents } from '../src/trade-evidence.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { createClaim } from '../src/claim.mjs'
import { discoverySummary } from '../src/discovery-rewards.mjs'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, createDbcPlatformFees } from '../src/platform-dbc-fees.mjs'
import { readBondingStatus } from '../app/lib/bonding-status.mjs'

// End-to-end launch-fee proof on a local validator and a disposable database: the config builder creates the new
// config, the production launcher launches on it, and every fee is checked against the program's exact charge.
const rpc = process.env.SOLANA_RPC_URL
assert.match(rpc ?? '', /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Disposable local validator required')
const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid')
assert.equal(database.hostname, '127.0.0.1', 'Disposable local database required')
assert.equal(decodeURIComponent(database.pathname.slice(1)), 'repoing_launch_fee_test', 'Disposable launch-fee test database required')
assert.notEqual(database.port, '55439', 'Never the production tunnel port')

const DENOMINATOR = 1_000_000_000n
const ceilDiv = (a, b) => (a + b - 1n) / b
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
const send = (tx, signers, commitment = 'confirmed') => sendAndConfirmTransaction(connection, tx, signers, { commitment, preflightCommitment: 'confirmed' })

async function fund(key, sol) {
  const signature = await connection.requestAirdrop(key, sol * 1e9)
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
}
async function transaction(signature, commitment = 'confirmed') {
  for (let attempt = 0; attempt < 200; attempt++) {
    const tx = await connection.getTransaction(signature, { commitment, maxSupportedTransactionVersion: 0 })
    if (tx) return tx
    await pause(250)
  }
  throw Error(`${signature} did not reach ${commitment}`)
}
const finalized = signatures => Promise.all(signatures.map(signature => transaction(signature, 'finalized')))

// What the program charged in one canonical swap, and what the schedule says it must charge at that second.
async function charged(signature, market, configKey) {
  const { events } = canonicalDbcSwapEvents(await transaction(signature), market, configKey, dbc)
  assert.equal(events.length, 1, 'one canonical swap')
  const { swapResult, currentTimestamp, tradeDirection, amountIn } = events[0].data
  const fee = BigInt(swapResult.tradingFee.toString()) + BigInt(swapResult.protocolFee.toString()) + BigInt(swapResult.referralFee.toString())
  const buy = tradeDirection === 1
  // Quote-token fees: taken from a buy's input, and from a sell's gross output.
  const base = buy ? BigInt(amountIn.toString()) : BigInt(swapResult.outputAmount.toString()) + fee
  const [state, fixed] = await Promise.all([dbc.state.getPool(market.pool), dbc.state.getPoolConfig(configKey)])
  const elapsed = BigInt(currentTimestamp.toString()) - BigInt(state.poolState.activationPoint.toString())
  const numerator = feeNumeratorAt(readFeeSchedule(fixed), state.poolState.activationPoint, currentTimestamp)
  return { fee, base, elapsed, numerator, rateBps: Number(fee * 1_000_000n / base) / 100, direction: buy ? 'buy' : 'sell',
    creatorFee: BigInt(swapResult.tradingFee.toString()) * 71n / 100n }
}

test('launch-fee config: launcher pays 1.75%, early trades pay the launch fee, accounting and graduation unchanged', { timeout: 1_200_000 }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const previousLegacy = process.env.DBC_LEGACY_CONFIGS
  t.after(async () => {
    if (previousLegacy === undefined) delete process.env.DBC_LEGACY_CONFIGS
    else process.env.DBC_LEGACY_CONFIGS = previousLegacy
    await pool.end()
  })
  await pool.query('truncate repositories restart identity cascade')
  const partner = Keypair.generate(), creator = Keypair.generate(), launcher = Keypair.generate()
  const sniper = Keypair.generate(), trader = Keypair.generate(), treasury = Keypair.generate(), receiver = Keypair.generate()
  for (const [signer, sol] of [[partner, 5], [creator, 5], [launcher, 20], [sniper, 5], [trader, 250], [treasury, 1]]) await fund(signer.publicKey, sol)
  const evidence = { configs: {}, markets: {}, fees: [] }

  // The flat builders config production uses today, and the new config built and reviewed against it.
  const oldConfig = Keypair.generate()
  const oldTx = await dbc.partner.createConfig({ config: oldConfig.publicKey, feeClaimer: partner.publicKey,
    leftoverReceiver: creator.publicKey, payer: partner.publicKey, quoteMint: NATIVE_MINT, ...buildLaunchCurve('builders') })
  oldTx.feePayer = partner.publicKey
  await send(oldTx, [partner, oldConfig])
  const newConfig = Keypair.generate()
  await t.test('config builder creates exactly the reviewed launch-fee config', async () => {
    const built = await buildLaunchFeeConfigTransaction({ connection, config: newConfig.publicKey, partner: partner.publicKey,
      leftoverReceiver: creator.publicKey })
    const review = await reviewLaunchFeeConfig({ connection, tx: built.tx, config: newConfig.publicKey, payer: partner.publicKey,
      reference: oldConfig.publicKey })
    assert.deepEqual(review.differences.sort(), ['enableFirstSwapWithMinFee', 'poolFees.baseFee.baseFeeMode', 'poolFees.baseFee.cliffFeeNumerator',
      'poolFees.baseFee.firstFactor', 'poolFees.baseFee.secondFactor', 'poolFees.baseFee.thirdFactor'])
    const before = await connection.getBalance(partner.publicKey, 'confirmed')
    const signature = await send(built.tx, [partner, newConfig], 'finalized')
    assert.equal(before - await connection.getBalance(partner.publicKey, 'confirmed'), review.totalDebitLamports, 'partner pays exactly the reviewed rent + fee')
    const created = await verifyCreatedLaunchFeeConfig({ connection, config: newConfig.publicKey, accountDataSha256: review.accountDataSha256 })
    assert.equal(created.feeClaimer.toBase58(), partner.publicKey.toBase58())
    assert.equal(created.leftoverReceiver.toBase58(), creator.publicKey.toBase58())
    evidence.configs = { old: oldConfig.publicKey.toBase58(), new: newConfig.publicKey.toBase58(), creation: signature,
      rentLamports: review.rentLamports, debitLamports: review.totalDebitLamports }
  })
  process.env.DBC_LEGACY_CONFIGS = oldConfig.publicKey.toBase58()
  const config = newConfig.publicKey.toBase58()

  await t.test('the program refuses rate-limiter configs and the launch guard refuses unapproved schedules', async () => {
    const curve = buildLaunchCurve('builders'), rejected = Keypair.generate()
    const rateLimiter = await dbc.partner.program.methods.createConfig({ ...curve, poolFees: { baseFee: { cliffFeeNumerator: new BN(17_500_000),
      firstFactor: 100, secondFactor: new BN(120), thirdFactor: new BN(100_000_000), baseFeeMode: 2 }, dynamicFee: null } })
      .accountsPartial({ config: rejected.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: creator.publicKey,
        quoteMint: NATIVE_MINT, payer: partner.publicKey }).transaction()
    rateLimiter.feePayer = partner.publicKey
    await assert.rejects(send(rateLimiter, [partner, rejected]), error => /DeprecatedBaseFeeMode|0x17be/.test(`${error.message} ${(error.logs ?? []).join(' ')}`))
    // Same schedule, but the launcher's first buy would pay the launch fee: never approved for launches.
    const unsafe = Keypair.generate()
    const unsafeTx = await dbc.partner.createConfig({ config: unsafe.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: creator.publicKey,
      payer: partner.publicKey, quoteMint: NATIVE_MINT, ...buildLaunchCurve('launch-fee'), enableFirstSwapWithMinFee: false })
    unsafeTx.feePayer = partner.publicKey
    await send(unsafeTx, [partner, unsafe])
    await assert.rejects(createMeteoraLauncher({ connection, config: unsafe.publicKey.toBase58(), creator }).prepare({
      launcherWallet: launcher.publicKey.toBase58(), tokenName: 'Unsafe', tokenSymbol: 'UNSAFE', initialBuyLamports: '0' }),
    /does not match the tested fixed launch configuration/)
  })

  await t.test('a launch transaction whose first buy is not eligible for the minimum fee fails as a whole', async () => {
    const prepared = await createMeteoraLauncher({ connection, config, creator }).prepare({ launcherWallet: launcher.publicKey.toBase58(),
      tokenName: 'No sysvar', tokenSymbol: 'NOSYS', initialBuyLamports: '100000000' })
    const stripped = new Transaction({ feePayer: launcher.publicKey, recentBlockhash: prepared.blockhash })
    for (const ix of prepared.transaction.instructions) stripped.add({ ...ix, keys: ix.keys.filter(key => !key.pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY)) })
    stripped.sign(launcher, creator, Keypair.fromSecretKey(prepared.mintSecretKey))
    const signature = await connection.sendRawTransaction(stripped.serialize(), { skipPreflight: true })
    const result = await connection.confirmTransaction({ signature, blockhash: prepared.blockhash,
      lastValidBlockHeight: Number(prepared.lastValidBlockHeight) }, 'confirmed')
    assert.deepEqual(result.value.err, { InstructionError: [7, { Custom: 6002 }] }, 'ExceededSlippage: the exact minimum output refuses the launch fee')
    assert.equal(await connection.getAccountInfo(new PublicKey(prepared.pool), 'confirmed'), null, 'no pool was created')
  })

  // Real launches through the coordinator and production launcher; repository metadata is local.
  const launch = async (repoId, key, discoveryEnabled) => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: repoId, name: `fee-${repoId}`, full_name: `local/fee-${repoId}`,
      owner: { login: 'local' }, private: false, archived: false, stargazers_count: 1, forks_count: 0, updated_at: '2026-01-01T00:00:00Z' }) })
    return createLaunchCoordinator({ pool, fetchImpl, discoveryEnabled, launcher: createMeteoraLauncher({ connection, config: key, creator }) }).launch({
      repositoryUrl: `https://github.com/local/fee-${repoId}`, tokenName: `Fee ${repoId}`, tokenSymbol: 'FEE',
      launcherWallet: launcher.publicKey.toBase58(), initialBuyLamports: '100000000', signTransaction: async tx => { tx.partialSign(launcher); return tx } })
  }
  const sniperBuy = async market => send(await dbc.pool.swap({ owner: sniper.publicKey, payer: sniper.publicKey, pool: new PublicKey(market.pool),
    amountIn: new BN(100_000_000), minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null }), [sniper])

  const fresh = await launch(9_910_001, config, true)
  const sniped = await sniperBuy(fresh)
  const legacy = await launch(9_910_002, oldConfig.publicKey.toBase58(), true)
  const legacySniped = await sniperBuy(legacy)
  const signatures = { fresh: [fresh.launchSignature, sniped], legacy: [legacy.launchSignature, legacySniped] }

  await t.test('the launcher initial buy pays exactly 1.75% at activation; a buy seconds later pays the launch fee', async () => {
    const launchBuy = await charged(fresh.launchSignature, fresh, newConfig.publicKey)
    assert.equal(launchBuy.elapsed, 0n)
    assert.ok(launchBuy.numerator > 400_000_000n, 'the scheduled fee at activation is the launch fee')
    assert.equal(launchBuy.fee, ceilDiv(100_000_000n * STANDARD_FEE_NUMERATOR, DENOMINATOR))
    assert.equal(launchBuy.fee, 1_750_000n)
    const snipe = await charged(sniped, fresh, newConfig.publicKey)
    assert.ok(snipe.elapsed <= 30n, `sniper bought ${snipe.elapsed} s after activation`)
    assert.equal(snipe.fee, ceilDiv(snipe.base * snipe.numerator, DENOMINATOR), 'exact scheduled fee')
    assert.ok(snipe.rateBps > 2_500, `launch-window fee ${snipe.rateBps} bps`)
    const old = [await charged(legacy.launchSignature, legacy, oldConfig.publicKey), await charged(legacySniped, legacy, oldConfig.publicKey)]
    for (const trade of old) assert.equal(trade.fee, ceilDiv(trade.base * STANDARD_FEE_NUMERATOR, DENOMINATOR), 'old config: flat 1.75%')
    evidence.fees.push({ market: 'new', trade: 'launcher initial buy', ...printable(launchBuy) }, { market: 'new', trade: 'sniper buy', ...printable(snipe) },
      { market: 'old', trade: 'launcher initial buy', ...printable(old[0]) }, { market: 'old', trade: 'immediate buy', ...printable(old[1]) })
  })

  await finalized([...signatures.fresh, ...signatures.legacy])
  const verify = createLaunchEvidenceVerifier({ connection, config })
  assert.ok((await createLaunchIndexer({ pool, verify }).runOnce()).every(item => item.state === 'indexed'))
  const repo = { fresh: String(fresh.githubRepoId), legacy: String(legacy.githubRepoId) }
  const traderApi = createCanonicalTrader({ pool, connection, config })
  const submit = async prepared => traderApi.submitTrade(prepared, async tx => { tx.partialSign(trader); return tx })

  await t.test('in-window app trades quote the live launch fee, keep the 1% minimum safe, and pay the exact fee', async () => {
    const quote = await traderApi.quoteBuy({ githubRepoId: repo.fresh, amountLamports: 200_000_000n })
    assert.equal(quote.launchFee.active, true)
    assert.ok(BigInt(quote.feeNumerator) > STANDARD_FEE_NUMERATOR)
    assert.equal(quote.feeNumerator, quote.launchFee.feeNumerator)
    const prepared = await traderApi.prepareBuy({ githubRepoId: repo.fresh, wallet: trader.publicKey.toBase58(), amountLamports: 200_000_000n })
    assert.equal(prepared.launchFee.active, true)
    const bought = await submit(prepared)
    assert.ok(bought.tokenDelta >= prepared.minimumAmountOut)
    const buy = await charged(bought.signature, fresh, newConfig.publicKey)
    assert.equal(buy.fee, ceilDiv(buy.base * buy.numerator, DENOMINATOR))
    assert.ok(buy.numerator <= BigInt(quote.feeNumerator), 'executed fee never exceeds the quoted fee')
    assert.ok(buy.numerator > STANDARD_FEE_NUMERATOR, 'still inside the window')
    const sell = await submit(await traderApi.prepareSell({ githubRepoId: repo.fresh, wallet: trader.publicKey.toBase58(), amountBaseUnits: bought.tokenDelta / 2n }))
    const sold = await charged(sell.signature, fresh, newConfig.publicKey)
    assert.equal(sold.fee, ceilDiv(sold.base * sold.numerator, DENOMINATOR))
    assert.ok(sold.numerator > STANDARD_FEE_NUMERATOR)
    signatures.fresh.push(bought.signature, sell.signature)
    evidence.fees.push({ market: 'new', trade: 'app buy in window', ...printable(buy) }, { market: 'new', trade: 'app sell in window', ...printable(sold) })
    const old = await traderApi.quoteBuy({ githubRepoId: repo.legacy, amountLamports: 200_000_000n })
    assert.equal(old.launchFee, null)
    assert.equal(old.feeNumerator, '17500000')
    const legacyBuy = await submit(await traderApi.prepareBuy({ githubRepoId: repo.legacy, wallet: trader.publicKey.toBase58(), amountLamports: 200_000_000n }))
    const flat = await charged(legacyBuy.signature, legacy, oldConfig.publicKey)
    assert.equal(flat.fee, ceilDiv(flat.base * STANDARD_FEE_NUMERATOR, DENOMINATOR))
    signatures.legacy.push(legacyBuy.signature)
  })

  await t.test('after the window every trade pays exactly 1.75%', async () => {
    const state = await dbc.state.getPool(fresh.pool)
    const window = launchFeeWindow(readFeeSchedule(await dbc.state.getPoolConfig(newConfig.publicKey)), state.poolState.activationPoint, 0n)
    while ((await readChainPoint(connection, 1)).lt(new BN(window.endsAt.toString()))) await pause(2_000)
    const quote = await traderApi.quoteBuy({ githubRepoId: repo.fresh, amountLamports: 300_000_000n })
    assert.equal(quote.launchFee.active, false)
    assert.equal(quote.feeNumerator, '17500000')
    const bought = await submit(await traderApi.prepareBuy({ githubRepoId: repo.fresh, wallet: trader.publicKey.toBase58(), amountLamports: 300_000_000n }))
    const sold = await submit(await traderApi.prepareSell({ githubRepoId: repo.fresh, wallet: trader.publicKey.toBase58(), amountBaseUnits: bought.tokenDelta }))
    for (const signature of [bought.signature, sold.signature]) {
      const trade = await charged(signature, fresh, newConfig.publicKey)
      assert.ok(trade.elapsed >= 180n)
      assert.equal(trade.numerator, STANDARD_FEE_NUMERATOR)
      assert.equal(trade.fee, ceilDiv(trade.base * STANDARD_FEE_NUMERATOR, DENOMINATOR))
      evidence.fees.push({ market: 'new', trade: `app ${trade.direction} after window`, ...printable(trade) })
    }
    signatures.fresh.push(bought.signature, sold.signature)
  })

  await t.test('builder, partner and discovery accounting reconcile on both configs; builder and platform claims settle', async () => {
    await finalized([...signatures.fresh, ...signatures.legacy])
    const indexed = await createExternalFeeIndexer({ pool, connection, config }).runOnce()
    assert.equal(indexed.length, 2)
    assert.ok(indexed.every(item => item.status === 'OK' && item.quarantined.length === 0), JSON.stringify(indexed, (_, v) => typeof v === 'bigint' ? String(v) : v))
    for (const [key, market, configKey] of [['fresh', fresh, newConfig.publicKey], ['legacy', legacy, oldConfig.publicKey]]) {
      const expected = (await Promise.all(signatures[key].map(signature => charged(signature, market, configKey)))).reduce((sum, trade) => sum + trade.creatorFee, 0n)
      const { rows: [credited] } = await pool.query('select coalesce(sum(amount_base_units),0)::text as total, count(*)::int as events from fee_events where github_repo_id=$1', [repo[key]])
      assert.equal(BigInt(credited.total), expected, `${key}: builder credits equal 71% of each charged trading fee`)
      assert.equal(credited.events, signatures[key].length)
      const onchain = BigInt((await dbc.state.getPool(market.pool)).poolState.creatorQuoteFee.toString())
      assert.equal(onchain, expected)
      assert.equal((await createReconciler({ pool, connection, config }).reconcile(repo[key])).status, 'MATCH')
    }
    const summary = await discoverySummary(pool, repo.fresh)
    const { rows: [partnerFees] } = await pool.query(`select coalesce(sum(partner_amount),0)::text as gross from discovery_fee_events
      where github_repo_id=$1 and discovery_eligible`, [repo.fresh])
    assert.equal(summary.earned, String(BigInt(partnerFees.gross) / 2n), 'discoverer earns half of every eligible partner fee, launch fee included')
    const partnerOnchain = BigInt((await dbc.state.getPool(fresh.pool)).poolState.partnerQuoteFee.toString())
    assert.equal(partnerOnchain, BigInt(partnerFees.gross))
    const platform = createDbcPlatformFees({ pool, connection: new Connection(rpc, 'finalized'), config, partner, verification: connection,
      env: { PLATFORM_DBC_COLLECTION_ENABLED: 'true', PLATFORM_FEE_TREASURY_WALLET: treasury.publicKey.toBase58() } })
    const status = await platform.status(repo.fresh)
    assert.equal(status.discoveryReserved, summary.earned)
    const treasuryBefore = await connection.getBalance(treasury.publicKey, 'finalized')
    const collected = await platform.claim({ review: { purpose: 'platform-fee-review', phase: 'DBC', repoId: status.repoId, amount: status.available,
      receiver: status.receiver, termsHash: status.termsHash, expiresAt: Date.now() + 120_000, maxNetworkFeeLamports: String(DBC_MAX_NETWORK_FEE_LAMPORTS) } })
    assert.equal(collected.reconciliation, 'MATCH')
    assert.equal(BigInt(await connection.getBalance(treasury.publicKey, 'finalized') - treasuryBefore), BigInt(status.available))
    assert.equal((await dbc.state.getPool(fresh.pool)).poolState.partnerQuoteFee.toString(), summary.earned, 'discovery reserve stays in the pool')
    const githubVerifier = { verifyCurrentAuthority: async ({ githubRepoId }) => ({ verified: true, permission: 'admin', githubRepoId,
      githubUserId: 123n, verifiedAt: new Date() }) }
    for (const key of ['fresh', 'legacy']) {
      await pool.query(`insert into repo_verifications (github_repo_id, github_user_id, github_login, permission) values ($1,123,'local-admin','admin')`, [repo[key]])
      await pool.query('insert into repo_beneficiaries (github_repo_id, github_user_id, wallet) values ($1,123,$2)', [repo[key], receiver.publicKey.toBase58()])
      const payout = await createClaim({ pool, connection, config, creator, githubVerifier }).claim({ githubRepoId: repo[key], githubAuthorization: {} })
      assert.ok(payout.amountBaseUnits > 0n)
      assert.equal((await createReconciler({ pool, connection, config }).reconcile(repo[key])).status, 'MATCH')
      evidence.markets[key] = { pool: (key === 'fresh' ? fresh : legacy).pool, builderPayout: payout.amountBaseUnits.toString(), payoutSignature: payout.signature }
    }
    evidence.markets.fresh.platformCollected = status.available
    evidence.markets.fresh.discoveryEarned = summary.earned
  })

  await t.test('the launch-fee market graduates and migrates to DAMM v2 like the flat config', async () => {
    const poolKey = new PublicKey(fresh.pool)
    const finish = await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey, pool: poolKey, amountIn: new BN(170e9),
      minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null })
    const finishSignature = await send(finish, [trader], 'finalized')
    const completing = await charged(finishSignature, fresh, newConfig.publicKey)
    assert.equal(completing.numerator, STANDARD_FEE_NUMERATOR)
    assert.equal((await readBondingStatus(connection, fresh, config)).status, 'migrating')
    const indexed = await createExternalFeeIndexer({ pool, connection, config }).runOnce()
    assert.ok(indexed.every(item => item.status === 'OK'))
    assert.equal((await createReconciler({ pool, connection, config }).reconcile(repo.fresh)).status, 'MATCH')
    await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })), [trader])
    const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, payer: trader.publicKey,
      dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100] })
    const migrated = await send(migration.transaction, [trader, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair], 'finalized')
    const bonding = await readBondingStatus(connection, fresh, config)
    assert.equal(bonding.status, 'graduated')
    assert.ok(bonding.destination?.pool, 'verified DAMM v2 destination')
    assert.equal((await createReconciler({ pool, connection, config }).reconcile(repo.fresh)).status, 'MATCH')
    evidence.markets.fresh.migration = migrated
    evidence.markets.fresh.dammPool = bonding.destination.pool
  })
  console.log(JSON.stringify(evidence, null, 1))
})

function printable(trade) {
  return { elapsedSeconds: Number(trade.elapsed), feeLamports: trade.fee.toString(), feeBaseLamports: trade.base.toString(),
    chargedRate: `${trade.rateBps / 100}%`, scheduledNumerator: trade.numerator.toString() }
}
