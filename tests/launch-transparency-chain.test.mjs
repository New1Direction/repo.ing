import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, MigrationFeeOption, SwapMode, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { buildLaunchFeeConfigTransaction } from '../src/launch-fee-config.mjs'
import { launchFeeTerms, launchFeeWindow, readFeeSchedule } from '../src/launch-fee.mjs'
import { readChainPoint } from '../src/chain-clock.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { createLaunchSchedules, SCHEDULE_CODES } from '../src/launch-schedules.mjs'
import { buildMarketReport, createMarketTransparency, latestLiquiditySample, sampleLpPositions, sampleMarketLiquidity } from '../src/market-transparency.mjs'
import { curveSnapshot, dammSnapshot } from '../src/market-liquidity.mjs'
import { quoteDisplay } from '../src/trade-quote-display.mjs'
import { produceFeedEvents, readFeedEvents } from '../src/launch-feed.mjs'
import { loadHolderSnapshot } from '../app/lib/trust-panel.mjs'

// Launch transparency on a local validator and a disposable database: a scheduled launch through the production coordinator
// and launcher, published depth checked by executing swaps of exactly the published size, trading integrity from indexed
// finalized swaps (a round trip and a two-wallet transaction), the stored report, and after a real migration the DAMM pool's
// depth and LP positions with their owners.
const rpc = process.env.SOLANA_RPC_URL
assert.match(rpc ?? '', /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Disposable local validator required')
const database = new URL(process.env.DATABASE_URL ?? 'postgres://invalid')
assert.equal(database.hostname, '127.0.0.1', 'Disposable local database required')
assert.equal(decodeURIComponent(database.pathname.slice(1)), 'repoing_launch_transparency_chain_test', 'Disposable launch transparency chain database required')

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const connection = new Connection(rpc, 'confirmed')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
const amm = new CpAmm(connection)
const send = (tx, signers, commitment = 'confirmed') => sendAndConfirmTransaction(connection, tx, signers, { commitment, preflightCommitment: 'confirmed' })
async function fund(key, sol) {
  const signature = await connection.requestAirdrop(key, sol * 1e9)
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
}
async function finalized(signatures) {
  for (const signature of signatures) {
    for (let attempt = 0; ; attempt++) {
      if (await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })) break
      if (attempt > 200) throw Error(`${signature} did not finalize`)
      await pause(250)
    }
  }
}
const tokenBalance = async (owner, mint) => BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), owner), 'confirmed')
  .catch(() => ({ value: { amount: '0' } }))).value.amount)
const curveSwap = (owner, poolKey, direction, amount, minimumOut = 1n) => dbc.pool.swap({ owner, payer: owner, pool: new PublicKey(poolKey), amountIn: new BN(String(amount)),
  minimumAmountOut: new BN(String(minimumOut)), swapBaseForQuote: direction === 'sell', referralTokenAccount: null })

test('launch transparency: scheduled launch gate, executable depth, integrity, report and LP positions on chain', { timeout: 1_500_000 }, async t => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  t.after(() => pool.end())
  await pool.query('truncate repositories restart identity cascade')
  const partner = Keypair.generate(), creator = Keypair.generate(), launcher = Keypair.generate(), stranger = Keypair.generate()
  const [buyerA, flipperB, bundlerC, bundlerD, depthBuyer, whale, provider] = Array.from({ length: 7 }, () => Keypair.generate())
  for (const [signer, sol] of [[partner, 5], [creator, 5], [launcher, 10], [stranger, 5], [buyerA, 5], [flipperB, 5], [bundlerC, 5], [bundlerD, 5],
    [depthBuyer, 20], [whale, 400], [provider, 20]]) await fund(signer.publicKey, sol)

  const configKey = Keypair.generate()
  const built = await buildLaunchFeeConfigTransaction({ connection, config: configKey.publicKey, partner: partner.publicKey, leftoverReceiver: creator.publicKey })
  await send(built.tx, [partner, configKey], 'finalized')
  const config = configKey.publicKey.toBase58()
  const labels = new Map([[creator.publicKey.toBase58(), { kind: 'platform', label: 'repo.ing launch signer' }],
    [partner.publicKey.toBase58(), { kind: 'platform', label: 'repo.ing partner wallet' }]])

  // Repository metadata is local; the coordinator persists it.
  const repoRow = id => ({ id, name: `tr-${id}`, full_name: `local/tr-${id}`, owner: { login: 'local' }, private: false, archived: false, stargazers_count: 240,
    forks_count: 4, created_at: '2024-02-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' })
  const coordinator = id => createLaunchCoordinator({ pool, fetchImpl: async () => ({ ok: true, status: 200, json: async () => repoRow(id) }),
    launcher: createMeteoraLauncher({ connection, config, creator }) })
  const launch = (id, signer, initialBuyLamports) => coordinator(id).launch({ repositoryUrl: `https://github.com/local/tr-${id}`, tokenName: `Tr ${id}`, tokenSymbol: `TR${id % 100}`,
    launcherWallet: signer.publicKey.toBase58(), initialBuyLamports, signTransaction: async tx => { tx.partialSign(signer); return tx } })
  const persistRepo = id => pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
    values($1,'local',$2,$3,240,4,false,now()) on conflict do nothing`, [id, `tr-${id}`, `local/tr-${id}`])

  const SCHEDULED = 9_920_001, UPCOMING = 9_920_002
  let market
  await t.test('a scheduled launch: only the announced wallet, within the announced buy, during the window; nobody before it', async () => {
    // Announced two hours ago for thirty minutes ago, so its 120-minute window is open now.
    const schedules = createLaunchSchedules({ pool, verifyAdmin: async () => ({ githubUserId: 5n, githubLogin: 'local-admin' }), persistRepository: persistRepo })
    const announcedAt = Date.now() - 2 * 3_600_000
    await schedules.create({ repoId: String(SCHEDULED), scheduledAt: new Date(Date.now() - 30 * 60_000).toISOString(), windowMinutes: 120,
      launcherWallet: launcher.publicKey.toBase58(), maxInitialBuyLamports: '100000000' }, { now: announcedAt })
    await schedules.create({ repoId: String(UPCOMING), scheduledAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), launcherWallet: launcher.publicKey.toBase58() })
    await assert.rejects(launch(SCHEDULED, stranger, '0'), error => error.code === SCHEDULE_CODES.LAUNCHER)
    await assert.rejects(launch(SCHEDULED, launcher, '100000001'), error => error.code === SCHEDULE_CODES.BUY)
    await assert.rejects(launch(UPCOMING, launcher, '0'), error => error.code === SCHEDULE_CODES.BEFORE)
    assert.equal((await pool.query('select count(*)::int as n from markets')).rows[0].n, 0, 'a refused launch reserves nothing')
    market = await launch(SCHEDULED, launcher, '100000000')
    assert.equal(market.status, 'confirmed')
    await finalized([market.launchSignature])
    const verify = createLaunchEvidenceVerifier({ connection, config })
    assert.ok((await createLaunchIndexer({ pool, verify }).runOnce()).every(item => item.state === 'indexed'))
    const job = createMarketTransparency({ pool, connection, resolveConfig: createMarketConfigResolver(config), sampling: false })
    assert.deepEqual((await job.runOnce()).schedules, { launched: 1, lapsed: 0 })
    const kinds = (await readFeedEvents(pool, { limit: 20 })).map(event => event.kind).sort()
    assert.deepEqual(kinds, ['launch.scheduled', 'launch.scheduled', 'launch.window_open', 'market.launched'])
  })

  const signatures = []
  const expected = {}
  await t.test('trades: an organic buy, a round trip, and a transaction in which two wallets trade both sides', async () => {
    const poolKey = market.pool
    signatures.push(await send(await curveSwap(buyerA.publicKey, poolKey, 'buy', 500_000_000n), [buyerA]))
    signatures.push(await send(await curveSwap(bundlerD.publicKey, poolKey, 'buy', 300_000_000n), [bundlerD]))
    signatures.push(await send(await curveSwap(flipperB.publicKey, poolKey, 'buy', 400_000_000n), [flipperB]))
    const flipped = await tokenBalance(flipperB.publicKey, market.mint)
    signatures.push(await send(await curveSwap(flipperB.publicKey, poolKey, 'sell', flipped), [flipperB]))
    // One transaction: C buys and D sells half of what D holds. Two owners, both sides, one signer set.
    const bundled = new Transaction()
    bundled.add(...(await curveSwap(bundlerC.publicKey, poolKey, 'buy', 200_000_000n)).instructions)
    bundled.add(...(await curveSwap(bundlerD.publicKey, poolKey, 'sell', (await tokenBalance(bundlerD.publicKey, market.mint)) / 2n)).instructions)
    bundled.feePayer = bundlerC.publicKey
    expected.bundle = await send(bundled, [bundlerC, bundlerD])
    signatures.push(expected.bundle)
    await finalized(signatures)
    const indexed = await createExternalFeeIndexer({ pool, connection, config }).runOnce()
    assert.ok(indexed.every(item => item.status === 'OK'), JSON.stringify(indexed, (_, v) => typeof v === 'bigint' ? String(v) : v))
    const { rows } = await pool.query(`select signature, trader, direction, (case when direction = 'buy' then input_base_units else output_base_units end)::numeric::text as lamports
      from trade_events where pool = $1 order by slot, event_index`, [poolKey])
    assert.equal(rows.length, 7, 'launch buy, five swaps and the two in one transaction')
    const sum = list => list.reduce((total, row) => total + BigInt(row.lamports), 0n)
    const flip = rows.filter(row => row.trader === flipperB.publicKey.toBase58())
    const [flipBuy, flipSell] = [BigInt(flip.find(row => row.direction === 'buy').lamports), BigInt(flip.find(row => row.direction === 'sell').lamports)]
    expected.volume = sum(rows)
    expected.roundTrip = 2n * (flipBuy < flipSell ? flipBuy : flipSell)
    expected.sameTransaction = sum(rows.filter(row => row.signature === expected.bundle))
    assert.equal(rows.filter(row => row.signature === expected.bundle).length, 2)
  })

  let sample
  await t.test('after the launch fee window, the published 2% depth is exactly executable', async () => {
    const fixed = await dbc.state.getPoolConfig(config)
    const state = await dbc.state.getPool(market.pool)
    const window = launchFeeWindow(readFeeSchedule(fixed), state.poolState.activationPoint, 0n)
    while ((await readChainPoint(connection, 1)).lt(new BN(window.endsAt.toString()))) await pause(2_000)
    const resolveConfig = createMarketConfigResolver(config)
    const job = createMarketTransparency({ pool, connection, resolveConfig, labelsFor: () => labels,
      holderSnapshot: async m => ({ ...await loadHolderSnapshot(connection, m.mint, m.pool, { labels }), observedAt: new Date().toISOString() }),
      launchFeeFor: async () => launchFeeTerms(readFeeSchedule(fixed)) !== null })
    const result = await job.runOnce()
    assert.deepEqual(result.liquidity, { sampled: 1, failed: 0 })
    assert.deepEqual(result.reports, { stored: 1, failed: 0 })
    sample = await latestLiquiditySample(pool, String(SCHEDULED))
    assert.equal(sample.venue, 'curve')
    const band = sample.profile.depth.find(row => row.impactPercent === 2)
    const buyLamports = BigInt(band.buyLamports), buyTokens = BigInt(band.buyTokens)
    assert.ok(buyLamports > 0n && buyTokens > 0n)
    // The next lamports above the published size would cross 2% on the same state.
    const snapshot = await curveSnapshot({ connection, market: { mint: market.mint, pool: market.pool }, configKey: resolveConfig(market) })
    const over = buyLamports + buyLamports / 500n, quoted = snapshot.quote('buy', over)
    assert.ok(quoteDisplay({ direction: 'buy', input: over, output: quoted.outputAmount, sqrtPrice: snapshot.sqrtPrice, fee: quoted.fee }).priceImpactPercent > 2)
    // Executed with the published token amount as the minimum: the chain delivers exactly it.
    const before = await tokenBalance(depthBuyer.publicKey, market.mint)
    await send(await curveSwap(depthBuyer.publicKey, market.pool, 'buy', buyLamports, buyTokens), [depthBuyer])
    assert.equal(await tokenBalance(depthBuyer.publicKey, market.mint) - before, buyTokens, 'executed output equals the published depth')
    // And the sell side on a fresh snapshot: selling the published token amount returns at least the published SOL. The wallet
    // first buys enough to cover the sell band; the snapshot is taken after that buy.
    await send(await curveSwap(depthBuyer.publicKey, market.pool, 'buy', 6n * buyLamports), [depthBuyer])
    await sampleMarketLiquidity(pool, { githubRepoId: String(SCHEDULED), mint: market.mint, pool: market.pool, graduatedPool: null }, { connection, resolveConfig })
    const sellBand = (await latestLiquiditySample(pool, String(SCHEDULED))).profile.depth.find(row => row.impactPercent === 2)
    const sellTokens = BigInt(sellBand.sellTokens), sellLamports = BigInt(sellBand.sellLamports)
    assert.ok(sellTokens > 0n && sellTokens <= await tokenBalance(depthBuyer.publicKey, market.mint))
    const solBefore = BigInt(await connection.getBalance(depthBuyer.publicKey, 'confirmed'))
    const sold = await send(await curveSwap(depthBuyer.publicKey, market.pool, 'sell', sellTokens, sellLamports), [depthBuyer])
    const tx = await connection.getTransaction(sold, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    const received = BigInt(await connection.getBalance(depthBuyer.publicKey, 'confirmed')) - solBefore + BigInt(tx.meta.fee)
    // The wallet's WSOL account is created and closed in the swap: its rent is refunded too, so received ≥ the quoted SOL.
    assert.ok(received >= sellLamports, `received ${received} for a published ${sellLamports}`)
  })

  await t.test('the stored report: integrity totals from the indexed swaps, evidence and unknowns', async () => {
    const { rows: [stored] } = await pool.query('select report, score, coverage_percent from launch_quality_reports where github_repo_id = $1', [String(SCHEDULED)])
    const report = stored.report
    assert.equal(BigInt(report.integrity.totals.volume), expected.volume)
    assert.equal(BigInt(report.integrity.totals.roundTrip), expected.roundTrip)
    assert.equal(BigInt(report.integrity.totals.sameTransaction), expected.sameTransaction)
    assert.equal(BigInt(report.integrity.totals.organic), expected.volume - expected.roundTrip - expected.sameTransaction)
    assert.equal(report.integrity.traders.linkedControllers, 1, 'C and D are one controller')
    const byId = Object.fromEntries(report.criteria.map(item => [item.id, item]))
    assert.equal(byId.anti_sniper.status, 'pass')
    assert.equal(byId.mint_authorities.status, 'pass', 'fixed supply, authorities revoked, read from chain')
    assert.equal(byId.scheduled.status, 'info')
    assert.match(byId.scheduled.value, /Scheduled publicly 2 h ahead/)
    assert.match(byId.launch_buy.value, /Launcher bought/)
    assert.equal(byId.maintainer.status, 'fail')
    assert.ok(report.unknowns.includes('repo_activity'), 'no Dev Pulse reading: unknown, not zero')
    assert.equal(stored.score, report.score)
    assert.ok(report.coveragePercent >= 60 && report.score !== null)
  })

  await t.test('graduated: the DAMM pool depth is executable and LP positions are attributed to their NFT holders', async () => {
    const poolKey = new PublicKey(market.pool)
    await send(await dbc.pool.swap2({ owner: whale.publicKey, payer: whale.publicKey, pool: poolKey, amountIn: new BN(170e9), minimumAmountOut: new BN(1),
      swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null }), [whale], 'finalized')
    await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })), [whale])
    const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, payer: whale.publicKey, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100] })
    const migrated = await send(migration.transaction, [whale, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair], 'finalized')
    const tx = await connection.getTransaction(migrated, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    const dammPools = (await amm._program.account.pool.all()).filter(entry => entry.account.tokenAMint.toBase58() === market.mint)
    assert.equal(dammPools.length, 1)
    const damm = dammPools[0].publicKey.toBase58()
    await pool.query(`insert into graduation_events (github_repo_id, signature, pool, slot, evidence_hash, evidence, reconciliation)
      values ($1, $2, $3, $4, repeat('0', 64), '{}', '{}')`, [String(SCHEDULED), migrated, damm, String(tx.slot)])
    // A third party adds liquidity: two-sided by construction.
    const poolState = await amm.fetchPoolState(new PublicKey(damm))
    await send(await amm.swap2({ payer: provider.publicKey, pool: new PublicKey(damm), inputTokenMint: NATIVE_MINT, outputTokenMint: poolState.tokenAMint,
      tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(2e9),
      minimumAmountOut: new BN(1), poolState }), [provider])
    const fresh = await amm.fetchPoolState(new PublicKey(damm))
    const liquidityDelta = amm.getLiquidityDelta({ maxAmountTokenA: new BN(String(await tokenBalance(provider.publicKey, market.mint) / 2n)), maxAmountTokenB: new BN(1e9),
      sqrtPrice: fresh.sqrtPrice, sqrtMinPrice: fresh.sqrtMinPrice, sqrtMaxPrice: fresh.sqrtMaxPrice, collectFeeMode: fresh.collectFeeMode })
    const nft = Keypair.generate()
    await send(await amm.createPositionAndAddLiquidity({ owner: provider.publicKey, pool: new PublicKey(damm), positionNft: nft.publicKey, liquidityDelta,
      maxAmountTokenA: new BN(10n ** 15n), maxAmountTokenB: new BN(5e9), tokenAAmountThreshold: new BN(10n ** 15n), tokenBAmountThreshold: new BN(5e9),
      tokenAMint: fresh.tokenAMint, tokenBMint: fresh.tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID }), [provider, nft])
    const graduated = { githubRepoId: String(SCHEDULED), mint: market.mint, pool: market.pool, graduatedPool: damm }
    const lp = await sampleLpPositions(pool, graduated, { connection })
    assert.equal(lp.positions, 3, 'creator, partner and the provider')
    const { rows: owners } = await pool.query('select owner, liquidity::text, permanent_locked_liquidity::text as locked from lp_position_samples where github_repo_id = $1', [String(SCHEDULED)])
    assert.deepEqual(owners.map(row => row.owner).sort(), [creator.publicKey.toBase58(), partner.publicKey.toBase58(), provider.publicKey.toBase58()].sort())
    assert.ok(owners.filter(row => row.owner !== provider.publicKey.toBase58()).every(row => BigInt(row.locked) > 0n), 'migrated positions are permanently locked')
    // DAMM depth: buy exactly the published 2% size with its token amount as the minimum.
    await sampleMarketLiquidity(pool, graduated, { connection, resolveConfig: () => null })
    const dammSample = await latestLiquiditySample(pool, String(SCHEDULED))
    assert.equal(dammSample.venue, 'damm')
    assert.equal(dammSample.twoSided, true)
    const band = dammSample.profile.depth.find(row => row.impactPercent === 2)
    const before = await tokenBalance(depthBuyer.publicKey, market.mint)
    const state = await amm.fetchPoolState(new PublicKey(damm))
    await send(await amm.swap2({ payer: depthBuyer.publicKey, pool: new PublicKey(damm), inputTokenMint: NATIVE_MINT, outputTokenMint: state.tokenAMint,
      tokenAMint: state.tokenAMint, tokenBMint: state.tokenBMint, tokenAVault: state.tokenAVault, tokenBVault: state.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, swapMode: SwapMode.ExactIn, amountIn: new BN(band.buyLamports),
      minimumAmountOut: new BN(band.buyTokens), poolState: state }), [depthBuyer])
    assert.equal(await tokenBalance(depthBuyer.publicKey, market.mint) - before, BigInt(band.buyTokens))
    assert.ok(await dammSnapshot({ connection, market: graduated, pool: damm }))
    // The incentive preview: the provider is the only eligible owner; repo.ing's locked positions are labeled, not rewarded.
    // As the worker runs it: no signer-key labels, only the market's pool creator and the config's fee claimer from chain facts.
    const report = await buildMarketReport(pool, { ...graduated, launchSignature: market.launchSignature, launcherWallet: launcher.publicKey.toBase58(),
      creatorWallet: market.creatorWallet, launchedAt: new Date(), bundleId: null, graduationSignature: migrated },
    { labels: new Map(), feeClaimerFor: async () => (await dbc.state.getPoolConfig(config)).feeClaimer.toBase58() })
    const providers = Object.fromEntries(report.incentives.providers.map(row => [row.owner, row]))
    assert.equal(providers[provider.publicKey.toBase58()].exclusion, null)
    assert.equal(providers[provider.publicKey.toBase58()].incentiveSharePercent, 100)
    assert.equal(providers[creator.publicKey.toBase58()].exclusion, 'labeled')
    assert.equal(report.criteria.find(item => item.id === 'liquidity_lock').status, 'unknown', 'graduated without a stored lock proof: unknown, not assumed')
    assert.equal((await produceFeedEvents(pool)).added >= 1, true, 'the graduation is a feed event')
  })
})
