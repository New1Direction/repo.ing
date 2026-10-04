import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, SwapMode as DbcSwapMode, deriveDammV2PoolAddress,
  deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { buildStockQuoteConfigTransaction, reviewStockQuoteConfig } from '../src/stock-quote-config.mjs'
import { resolveQuoteAsset } from '../src/quote-assets.mjs'
import { stockMintCheck, stockPairGuard } from '../app/lib/stock-launch.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../src/canonical-damm-trade.mjs'
import { prepareCheckedTrade } from '../src/trade-prepare.mjs'
import { createStockGraduation } from '../src/stock-graduation.mjs'
import { createStockGraduationMonitor, stockGraduationPass } from '../src/stock-graduation-monitor.mjs'
import { createStockFeeIndexer } from '../src/stock-fee-indexer.mjs'
import { stockDammSwapEvents } from '../src/stock-damm-trades.mjs'
import { stockDbcSwapEvents } from '../src/stock-trade-evidence.mjs'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { LAUNCHER_DEN, LAUNCHER_NUM } from '../src/stock-fee-policy.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// A METAx-paired market graduates on the programs mainnet runs (scripts/ci/start-stock-validator.sh): DOCUSAURUS / METAx is
// bought past its 14 METAx threshold, migrated into its DAMM v2 pool as Meteora's migrator does on mainnet, and from then on
// the worker proves the migration, indexes every swap in METAx and checkpoints both locked positions' fees, while the site
// trades it in the graduated pool. Nothing here touches mainnet beyond the validator script reading its accounts once.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_stock_graduation_chain_test'
const RPC = process.env.STOCK_CHAIN_RPC ?? `http://127.0.0.1:${process.env.STOCK_VALIDATOR_RPC_PORT ?? 8919}`
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const METAX = new PublicKey(META.mint)
const DOCUSAURUS = { id: 94911145, name: 'docusaurus', full_name: 'facebook/docusaurus', owner: { login: 'facebook', id: 69631, type: 'Organization',
  avatar_url: null }, description: 'Easy to maintain open source documentation websites.', stargazers_count: 60000, forks_count: 9000,
  archived: false, private: false, visibility: 'public', updated_at: '2026-10-01T00:00:00Z' }
const github = repo => async () => ({ ok: true, status: 200, json: async () => repo })
const connections = []
const local = (commitment = 'confirmed') => { const connection = new Connection(RPC, commitment); connections.push(connection); return connection }
const closeConnections = () => { for (const connection of connections) { try { connection._rpcWebSocket?.close() } catch {} } }

async function healthy() {
  try { return (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })).json()).result === 'ok' } catch { return false }
}
async function funded(connection, lamports = 5_000_000_000) {
  const keypair = Keypair.generate()
  const signature = await connection.requestAirdrop(keypair.publicKey, lamports)
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  return keypair
}
async function until(read, attempts = 240) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)) }
  return null
}
async function stopValidator(work) {
  let pid
  try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
  if (pid) {
    try { process.kill(pid) } catch {}
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('a METAx-paired market graduates: proven, its DAMM swaps indexed in METAx, fee checkpoints equal to the positions, traded on the site', { timeout: 900_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.STOCK_CHAIN_WORK_DIR, started = false
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_stock_graduation_chain_test$/, 'postgres') })
  let pool, created = false
  const savedConfigs = process.env.STOCK_QUOTE_CONFIGS
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-stock-graduation-'))
      started = true
      const run = spawnSync('scripts/ci/start-stock-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'stock-pair validator started')
    }
    assert.ok(work && existsSync(join(work, 'metax-authority.json')), 'the validator work dir with the METAx test authority')
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'metax-authority.json'), 'utf8'))))
    const connection = local(), verification = local('finalized')
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'finalized', preflightCommitment: 'confirmed' })
    const holdMetax = async (wallet, amount) => {
      const account = getAssociatedTokenAddressSync(METAX, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID)
      await sendAndConfirmTransaction(connection, new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, account, wallet.publicKey, METAX, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(METAX, account, authority.publicKey, amount, [], TOKEN_2022_PROGRAM_ID)), [wallet, authority], { commitment: 'confirmed' })
      return account
    }
    await admin.query('drop database if exists repoing_stock_graduation_chain_test')
    await admin.query('create database repoing_stock_graduation_chain_test'); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })

    // The METAx config, built and reviewed as scripts/create-stock-quote-config.mjs does, graduating at 14 METAx.
    const { config: solConfig, partner } = await createFixedConfig(connection, 'launch-fee')
    const stockConfig = Keypair.generate()
    const built = await buildStockQuoteConfigTransaction({ connection, config: stockConfig.publicKey.toBase58(), asset: META, graduation: 14,
      partner: partner.publicKey.toBase58(), leftoverReceiver: partner.publicKey.toBase58() })
    await reviewStockQuoteConfig({ connection, tx: built.tx, config: stockConfig.publicKey.toBase58(), payer: partner.publicKey.toBase58(),
      reference: solConfig.toBase58(), asset: META, graduation: 14, curve: built.curve })
    built.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    await sendAndConfirmTransaction(connection, built.tx, [partner, stockConfig], { commitment: 'confirmed' })
    process.env.STOCK_QUOTE_CONFIGS = JSON.stringify({ 'meta-xstock': stockConfig.publicKey.toBase58() })
    const config = solConfig.toBase58()

    // DOCUSAURUS / METAx, launched and indexed.
    const creator = Keypair.generate(), launcherWallet = await funded(connection)
    const launcher = createMeteoraLauncher({ connection: local(), config: stockConfig.publicKey, creator, quote: META })
    const guard = stockPairGuard(META, stockConfig.publicKey.toBase58(), { enabled: () => true,
      owner: async () => ({ ownerId: '69631', ownerType: 'Organization' }), mintUsable: stockMintCheck(connection) })
    const launched = await createLaunchCoordinator({ pool, launcher, fetchImpl: github(DOCUSAURUS), quote: META }).launch({
      repositoryUrl: 'https://github.com/facebook/docusaurus', tokenName: 'Docusaurus', tokenSymbol: 'DOCUSAURUS',
      launcherWallet: launcherWallet.publicKey.toBase58(), launchGuard: guard, signTransaction: async tx => { tx.partialSign(launcherWallet); return tx } })
    assert.equal(launched.status, 'confirmed')
    const verify = createLaunchEvidenceVerifier({ connection, config })
    assert.ok(await until(async () => (await verify(launched)).state === 'match'), 'finalized launch evidence matches')
    assert.equal((await createLaunchIndexer({ pool, verify }).processMarket(launched.githubRepoId)).state, 'indexed')
    const { rows: [market] } = await pool.query(`select id, github_repo_id::text as "githubRepoId", mint, pool, creator_wallet as "creatorWallet",
      quote_asset_id as "quoteAssetId", quote_mint as "quoteMint" from markets where id = $1`, [launched.id])
    const githubRepoId = market.githubRepoId, curve = new PublicKey(market.pool), mint = new PublicKey(market.mint)

    const monitor = createStockGraduationMonitor({ pool, connection, verification, config, env: { ...process.env, NODE_ENV: 'test' } })
    // A later job (PR-D's reconciliation) runs in the same pass and lock, with the verified state.
    monitor.addHook({ name: 'probe', run: async ({ db, market: hooked, state }) => ({ phase: state.phase, repoId: hooked.githubRepoId,
      locked: (await db.query("select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()")).rows[0].n,
      slot: BigInt(state.slot) }) })
    const pass = async () => {
      const results = await monitor.runOnce()
      assert.equal(results.length, 1, 'stock-paired markets only')
      assert.equal(results[0].status, 'VERIFIED', JSON.stringify(results, (_, value) => typeof value === 'bigint' ? String(value) : value))
      assert.deepEqual([results[0].hooks.probe.phase, results[0].hooks.probe.repoId, results[0].hooks.probe.locked], [results[0].phase, githubRepoId, 1])
      return results[0]
    }
    const checkpointTotals = async () => Object.fromEntries((await pool.query(`select side, sum(credit)::text as credit, sum(launcher_credit)::text as launcher,
      sum(accumulator_credit)::text as accumulator, max(cumulative_earned)::text as earned, max(launcher_cumulative)::text as "launcherCumulative"
      from stock_damm_fee_checkpoints group by side`)).rows.map(row => [row.side, row]))

    // The worker's curve indexer for stock pairs (src/stock-fee-indexer.mjs): it hands the market over at graduation.
    const curveIndexer = createStockFeeIndexer({ pool, connection, config })
    const curvePass = async () => {
      const [result] = await curveIndexer.runOnce()
      assert.equal(result.githubRepoId, githubRepoId)
      return result
    }

    await t.test('on the curve: progress in METAx, no graduation yet', async () => {
      assert.deepEqual([(await curvePass()).status, (await pool.query('select count(*)::int as n from stock_fee_events')).rows[0].n], ['OK', 0], 'the launch, no swap yet')
      // The worker's own pass (scripts/run-worker.mjs) never rejects, even with a hook returning a BigInt.
      const lines = []
      assert.equal(await stockGraduationPass(monitor, line => lines.push(line)), false)
      assert.equal(typeof JSON.parse(lines[0]).stockGraduation[0].hooks.probe.slot, 'string')
      const result = await pass()
      assert.deepEqual([result.phase, result.curve, result.migration], ['CURVE', 'active', null])
      const { rows: [observation] } = await pool.query('select asset_id, quote_mint, pool, migration_threshold::text, is_migrated from stock_graduation_observations')
      assert.deepEqual(observation, { asset_id: 'meta-xstock', quote_mint: META.mint, pool: market.pool, migration_threshold: '1400000000', is_migrated: false })
    })

    let curveSwaps = 0
    await t.test('dust swaps on the curve are recorded with their zero amounts and their fees credited, never quarantined', async () => {
      const trader = await funded(connection)
      await holdMetax(trader, 10_000_000n)
      const swap = async (buy, amountIn, minimumAmountOut) => send(await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey,
        pool: curve, amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)), swapBaseForQuote: !buy,
        swapMode: DbcSwapMode.ExactIn, referralTokenAccount: null }), [trader])
      // A small buy first, so the trader holds tokens to sell.
      const signatures = [await swap(true, 1_000_000n, 1n)]
      // Dust both ways, 1 raw unit in: whatever the program accepts is a swap to record with its fee, never a quarantine that
      // would leave the fee out of the ledger.
      const dust = {}
      for (const [name, buy] of [['dustBuy', true], ['dustSell', false]]) {
        try { dust[name] = await swap(buy, 1n, 0n); signatures.push(dust[name]) }
        catch (error) { dust[name] = { refused: String(error?.message ?? error).match(/custom program error: 0x[0-9a-f]+|Error Code: \w+/)?.[0] ?? 'refused' } }
      }
      // What the program reported for each swap, read back from its finalized transaction.
      const reported = []
      for (const signature of signatures) {
        const { events } = stockDbcSwapEvents(await loadFinalizedTransaction(connection, signature), market,
          { config: stockConfig.publicKey.toBase58(), quoteMint: META.mint }, dbc)
        for (const { eventIndex, data } of events) {
          reported.push({ signature, eventIndex, direction: data.tradeDirection === 1 ? 'buy' : 'sell', ...Object.fromEntries(
            ['actualInputAmount', 'outputAmount', 'tradingFee', 'protocolFee'].map(field => [field, data.swapResult[field].toString()])) })
        }
      }
      const result = await curvePass()
      const { rows } = await pool.query(`select t.signature, t.event_index, t.direction, t.quote_amount::text, t.base_amount::text,
        (f.creator_amount + f.partner_amount)::text as fee from stock_trade_events t join stock_fee_events f using (signature, event_index)
        where t.venue = 'dbc' and t.signature = any($1) order by t.slot, t.event_index`, [signatures])
      console.log(JSON.stringify({ curveDust: dust, reported, quarantined: result.quarantined, rows }))
      assert.deepEqual([result.status, result.quarantined], ['OK', []], 'nothing quarantined')
      assert.ok(reported.some(event => event.outputAmount === '0'), `a dust swap landed and moved nothing out: ${JSON.stringify(dust)}`)
      // Each swap is one trade row with the program's own amounts (zero where it moved nothing) and one fee row with its whole
      // trading fee.
      assert.deepEqual(rows.map(row => [row.signature, row.event_index, row.direction, row.quote_amount, row.base_amount, row.fee]),
        reported.map(event => [event.signature, event.eventIndex, event.direction, ...(event.direction === 'buy'
          ? [event.actualInputAmount, event.outputAmount] : [event.outputAmount, event.actualInputAmount]), event.tradingFee]))
      // Every unit of the curve's fees so far is in the ledger, the dust swaps' included.
      const { poolState } = await new DynamicBondingCurveClient(verification, 'finalized').state.getPool(curve)
      const { rows: [fees] } = await pool.query(`select count(*)::int as n, sum(creator_amount)::text as creator, sum(partner_amount)::text as partner
        from stock_fee_events where github_repo_id = $1`, [githubRepoId])
      assert.deepEqual(fees, { n: reported.length, creator: poolState.creatorQuoteFee.toString(), partner: poolState.partnerQuoteFee.toString() })
      curveSwaps = reported.length
    })

    let dammPool, migrationSignature
    await t.test('past the threshold, migrated locally into the METAx DAMM pool and proven', async () => {
      const whale = await funded(connection, 20_000_000_000)
      await holdMetax(whale, 3_000_000_000n)
      await send(await dbc.pool.swap2({ owner: whale.publicKey, payer: whale.publicKey, pool: curve, amountIn: new BN(2_500_000_000),
        minimumAmountOut: new BN(1), swapBaseForQuote: false, swapMode: DbcSwapMode.PartialFill, referralTokenAccount: null }), [whale])
      const full = await pass()
      assert.deepEqual([full.phase, full.curve, full.progressPercent, full.migration], ['CURVE', 'migrating', 100, null])
      // Before the migration, the completed curve's surplus and leftover withdrawals: whichever the program allows now moves no
      // swap fee, and the curve indexer goes on past it (it never stops the market).
      const creatorFunds = await connection.requestAirdrop(creator.publicKey, 1_000_000_000)
      await connection.confirmTransaction({ signature: creatorFunds, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
      const withdrawals = {}
      for (const [name, build, signers] of [
        ['partnerWithdrawSurplus', () => dbc.partner.partnerWithdrawSurplus({ pool: curve, feeClaimer: partner.publicKey }), [partner]],
        ['creatorWithdrawSurplus', () => dbc.creator.creatorWithdrawSurplus({ creator: creator.publicKey, pool: curve }), [creator]],
        ['withdrawLeftover', () => dbc.migration.withdrawLeftover({ pool: curve, payer: whale.publicKey }), [whale]]]) {
        try { withdrawals[name] = { landed: await send(await build(), signers) } }
        catch (error) { withdrawals[name] = { refused: String(error?.message ?? error).match(/custom program error: 0x[0-9a-f]+|Error Code: \w+/)?.[0] ?? 'refused' } }
      }
      console.log(JSON.stringify({ beforeMigration: withdrawals }))
      assert.equal((await curvePass()).status, 'OK', `the curve indexer goes on: ${JSON.stringify(withdrawals)}`)
      // As Meteora's migrator does on mainnet: the pool authority pays the new pool's rent; anyone may send the migration.
      await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1_000_000_000 })), [whale])
      const fixed = await dbc.state.getPoolConfig(stockConfig.publicKey)
      const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
      const migration = await dbc.migration.migrateToDammV2({ pool: curve, dammConfig, payer: whale.publicKey })
      migrationSignature = await send(migration.transaction, [whale, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
      dammPool = deriveDammV2PoolAddress(dammConfig, mint, METAX)
      const graduated = await pass()
      assert.deepEqual([graduated.phase, graduated.curve, graduated.migration, graduated.dammPool], ['GRADUATED', 'graduated', migrationSignature, dammPool.toBase58()])
      const { rows: [event] } = await pool.query('select * from stock_graduation_events')
      assert.deepEqual([event.github_repo_id, event.asset_id, event.quote_mint, event.dbc_pool, event.damm_pool, event.migration_signature],
        [githubRepoId, 'meta-xstock', META.mint, market.pool, dammPool.toBase58(), migrationSignature])
      assert.ok(event.creator_position && event.partner_position && event.evidence.migration.pre && event.evidence.migration.post)
      // The SOL proof tables never see it.
      assert.equal((await pool.query('select count(*)::int as n from graduation_events')).rows[0].n, 0)
      assert.equal((await pool.query('select count(*)::int as n from graduated_migration_proofs')).rows[0].n, 0)
      // What the token page's curve and trade panel read: the newest reading is migrated, and the proof names the pool.
      const { rows: [reading] } = await pool.query(`select is_migrated, pool from stock_graduation_observations where github_repo_id = $1
        order by observed_at desc, id desc limit 1`, [githubRepoId])
      assert.deepEqual(reading, { is_migrated: true, pool: market.pool })
      // The proof replays: a second pass changes nothing.
      assert.equal((await pass()).migration, migrationSignature)
      assert.equal((await pool.query('select count(*)::int as n from stock_graduation_events')).rows[0].n, 1)
      // The hand-off: once the migration is proven the curve indexer credits what it has not yet seen up to and in the
      // migration, stops on it, and is GRADUATED from then on. Every unit of curve fee is in the ledger: the swaps before the
      // fill (dust included) and the fill.
      const finished = await curvePass()
      assert.deepEqual([finished.status, finished.migration, finished.cursorAfter.signature], ['GRADUATED', migrationSignature, migrationSignature])
      assert.equal((await curvePass()).status, 'GRADUATED')
      const curveState = (await new DynamicBondingCurveClient(verification, 'finalized').state.getPool(curve)).poolState
      const { rows: [fees] } = await pool.query(`select count(*)::int as n, sum(creator_amount)::text as creator, sum(partner_amount)::text as partner
        from stock_fee_events where github_repo_id = $1`, [githubRepoId])
      assert.deepEqual(fees, { n: curveSwaps + 1, creator: curveState.creatorQuoteFee.toString(), partner: curveState.partnerQuoteFee.toString() })
      assert.equal((await pool.query("select count(*)::int as n from stock_trade_events where venue = 'dbc'")).rows[0].n, curveSwaps + 1)
    })

    const swaps = {}
    await t.test('swaps straight on the pool are indexed in METAx; the fee checkpoints equal both positions\' fees', async () => {
      const amm = new CpAmm(connection), poolState = await amm.fetchPoolState(dammPool)
      assert.ok(poolState.tokenAMint.equals(mint) && poolState.tokenBMint.equals(METAX))
      assert.deepEqual([poolState.tokenAFlag, poolState.tokenBFlag, poolState.collectFeeMode], [0, 1, 1], 'SPL market token, Token-2022 METAx, fees in METAx')
      const trader = await funded(connection)
      await holdMetax(trader, 500_000_000n)
      const swap = async (buy, amountIn) => send(await amm.swap2({ payer: trader.publicKey, pool: dammPool, poolState, swapMode: SwapMode.ExactIn,
        inputTokenMint: buy ? METAX : mint, outputTokenMint: buy ? mint : METAX, tokenAMint: mint, tokenBMint: METAX,
        tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID,
        referralTokenAccount: null, amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(1) }), [trader])
      swaps.directBuy = await swap(true, 200_000_000n)
      const held = BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, trader.publicKey))).value.amount)
      swaps.directSell = await swap(false, held / 2n)
      const result = await pass()
      assert.equal(result.trades.inserted, 2)
      const { rows: trades } = await pool.query(`select signature, venue, direction, quote_amount::text, base_amount::text, asset_id, quote_mint, trader
        from stock_trade_events where venue = 'damm' order by slot, event_index`)
      assert.deepEqual(trades.map(row => [row.signature, row.venue, row.direction, row.asset_id, row.quote_mint, row.trader]), [
        [swaps.directBuy, 'damm', 'buy', 'meta-xstock', META.mint, trader.publicKey.toBase58()],
        [swaps.directSell, 'damm', 'sell', 'meta-xstock', META.mint, trader.publicKey.toBase58()]])
      // quote_amount as on the curve rows: a buy's stock without the pool's fee, a sell's stock received.
      const [bought] = stockDammSwapEvents(await loadFinalizedTransaction(connection, swaps.directBuy), { mint, quoteMint: METAX, pool: dammPool, coder: amm._program.coder })
      assert.deepEqual([bought.quoteAmount, trades[0].quote_amount], ['200000000', bought.quoteVolume], 'exactly 2 METAx paid; the row is without the fee')
      assert.ok(BigInt(bought.quoteVolume) < 200_000_000n)
      const [sold] = stockDammSwapEvents(await loadFinalizedTransaction(connection, swaps.directSell), { mint, quoteMint: METAX, pool: dammPool, coder: amm._program.coder })
      assert.deepEqual([trades[1].base_amount, trades[1].quote_amount], [String(held / 2n), sold.quoteAmount])
      assert.equal((await pool.query('select count(*)::int as n from damm_trade_events')).rows[0].n, 0, 'the SOL DAMM ledger never sees it')
      const graduation = createStockGraduation({ connection: verification, config, db: pool })
      const snapshot = await graduation.read(market)
      assert.ok(snapshot.earned > 0n && snapshot.partner.earned > 0n, 'both locked positions earned METAx')
      const totals = await checkpointTotals()
      assert.equal(totals.creator.credit, String(snapshot.earned), 'creator checkpoints = the creator position\'s fees')
      assert.equal(totals.partner.credit, String(snapshot.partner.earned), 'partner checkpoints = the partner position\'s fees')
      assert.equal(totals.creator.launcher, String(snapshot.earned * LAUNCHER_NUM / LAUNCHER_DEN))
      assert.equal(BigInt(totals.creator.launcher) + BigInt(totals.creator.accumulator), snapshot.earned)
      assert.deepEqual([totals.partner.launcher, totals.partner.accumulator], ['0', String(snapshot.partner.earned)])
      assert.equal((await pass()).checkpoints.length, 0, 'nothing new earned, nothing new credited')
    })

    await t.test('a v1 swap and dust swaps on the pool are indexed like any other swap, never quarantined', async () => {
      const amm = new CpAmm(connection), poolState = await amm.fetchPoolState(dammPool)
      const trader = await funded(connection)
      await holdMetax(trader, 100_000_000n)
      const accounts = { payer: trader.publicKey, pool: dammPool, tokenAMint: mint, tokenBMint: METAX, tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID, referralTokenAccount: null }
      // The v1 swap instruction, as aggregators still send it.
      const v1 = await send(await amm.swap({ ...accounts, inputTokenMint: METAX, outputTokenMint: mint, amountIn: new BN(10_000_000), minimumAmountOut: new BN(1) }), [trader])
      // Dust both ways: whatever the program accepts is a swap to record, never a reason to pin the market in REVIEW.
      const dust = {}
      for (const [name, buy] of [['dustBuy', true], ['dustSell', false]]) {
        try {
          dust[name] = await send(await amm.swap2({ ...accounts, poolState, swapMode: SwapMode.ExactIn, inputTokenMint: buy ? METAX : mint,
            outputTokenMint: buy ? mint : METAX, amountIn: new BN(1), minimumAmountOut: new BN(0) }), [trader])
        } catch (error) { dust[name] = { refused: String(error?.message ?? error).match(/custom program error: 0x[0-9a-f]+|Error Code: \w+/)?.[0] ?? 'refused' } }
      }
      const result = await pass()
      const landed = [v1, ...Object.values(dust).filter(value => typeof value === 'string')]
      const { rows } = await pool.query(`select signature, direction, quote_amount::text, base_amount::text from stock_trade_events
        where venue = 'damm' and signature = any($1) order by slot, event_index`, [landed])
      console.log(JSON.stringify({ v1Swap: v1, dust, rows }))
      assert.deepEqual([result.trades.quarantined, rows.length], [[], landed.length], 'every landed swap is a row')
      assert.equal(rows.find(row => row.signature === v1).direction, 'buy')
    })

    await t.test('the site\'s trade path buys and sells DOCUSAURUS for METAx in the graduated pool, settled to the raw unit', async () => {
      const trader = await funded(connection)
      const account = await holdMetax(trader, 100_000_000n)
      const curveTrader = createCanonicalTrader({ pool, connection, config })
      const graduated = createDammTrader({ pool, connection, config })
      const router = createTradeRouter({ curve: curveTrader, graduated })
      const engine = await router(githubRepoId)
      assert.equal(engine, graduated, 'routed as /api/trade routes it: the curve migrated')
      const wallet = trader.publicKey.toBase58(), sign = async tx => { tx.partialSign(trader); return tx }
      const quote = await engine.quoteBuy({ githubRepoId, amountLamports: '50000000', slippageBps: 500 })
      assert.equal(quote.venue, 'damm')
      assert.ok(BigInt(quote.outputAmount) > 0n && BigInt(quote.tradingFeeLamports) > 0n)
      const buy = await prepareCheckedTrade({ engine, connection, direction: 'buy', githubRepoId, wallet, amountBaseUnits: '50000000', slippageBps: 500 })
      assert.deepEqual([buy.prepared.phase, buy.prepared.quoteMint, buy.prepared.referral], ['graduated', META.mint, null])
      assert.deepEqual([buy.costs.quoteBalance, buy.costs.quoteShortfall, buy.costs.refundableDeposit], ['100000000', '0', '0'])
      const bought = await engine.submitTrade(buy.prepared, sign)
      assert.equal(bought.quoteDelta, -50_000_000n, 'exactly 0.5 METAx spent')
      assert.equal(bought.quoteMint, META.mint)
      assert.ok(bought.tokenDelta >= buy.prepared.minimumAmountOut)
      // More METAx than the wallet holds is refused before anything is signed.
      await assert.rejects(prepareCheckedTrade({ engine, connection, direction: 'buy', githubRepoId, wallet, amountBaseUnits: '60000000', slippageBps: 500 }),
        /You need approximately 0\.1[0-9]* more METAx/)
      const sell = await prepareCheckedTrade({ engine, connection, direction: 'sell', githubRepoId, wallet, amountBaseUnits: bought.tokenDelta.toString(), slippageBps: 500 })
      const sold = await engine.submitTrade(sell.prepared, sign)
      assert.equal(sold.tokenDelta, -bought.tokenDelta, 'every DOCUSAURUS token sold')
      assert.ok(sold.quoteDelta >= sell.prepared.minimumAmountOut && sold.quoteDelta > 0n, 'METAx back to the wallet')
      assert.equal((await connection.getTokenAccountBalance(account)).value.amount, String(50_000_000n + sold.quoteDelta))
      // As the trade route settles a graduated trade: re-verified once finalized; the worker indexes it and its fees.
      for (const [prepared, signature] of [[buy.prepared, bought.signature], [sell.prepared, sold.signature]]) {
        assert.ok(await until(async () => (await connection.getSignatureStatuses([signature])).value[0]?.confirmationStatus === 'finalized'))
        assert.equal((await engine.verifyTrade(prepared, signature, { commitment: 'finalized' })).quoteMint, META.mint)
      }
      swaps.siteBuy = bought.signature
      swaps.siteSell = sold.signature
      const result = await pass()
      assert.equal(result.trades.inserted, 2)
      const { rows } = await pool.query(`select signature, direction, quote_amount::text from stock_trade_events where signature = any($1) order by slot`,
        [[bought.signature, sold.signature]])
      const coder = new CpAmm(connection)._program.coder
      const [boughtEvent] = stockDammSwapEvents(await loadFinalizedTransaction(connection, bought.signature), { mint, quoteMint: METAX, pool: dammPool, coder })
      assert.equal(boughtEvent.quoteAmount, '50000000')
      assert.deepEqual(rows, [{ signature: bought.signature, direction: 'buy', quote_amount: boughtEvent.quoteVolume },
        { signature: sold.signature, direction: 'sell', quote_amount: String(sold.quoteDelta) }])
      const snapshot = await createStockGraduation({ connection: verification, config, db: pool }).read(market)
      const totals = await checkpointTotals()
      assert.deepEqual([totals.creator.credit, totals.partner.credit, totals.creator.earned, totals.partner.earned],
        [String(snapshot.earned), String(snapshot.partner.earned), String(snapshot.earned), String(snapshot.partner.earned)])
      assert.equal(totals.creator.launcherCumulative, String(snapshot.earned * LAUNCHER_NUM / LAUNCHER_DEN))
      // A SOL record never verifies against the stock pool, and a stock record carries its mint.
      await assert.rejects(engine.verifyTrade({ ...buy.prepared, record: { ...buy.prepared.record, quoteMint: null } }, bought.signature), /Canonical market changed/)
    })

    console.log(JSON.stringify({ network: 'local', market: { repoId: githubRepoId, mint: market.mint, curve: market.pool, creator: market.creatorWallet,
      config: stockConfig.publicKey.toBase58(), partner: partner.publicKey.toBase58() }, dammPool: dammPool?.toBase58(), migrationSignature, swaps }))
  } finally {
    if (savedConfigs === undefined) delete process.env.STOCK_QUOTE_CONFIGS
    else process.env.STOCK_QUOTE_CONFIGS = savedConfigs
    await pool?.end()
    if (created) await dropTestDatabase(admin, 'repoing_stock_graduation_chain_test')
    await admin.end()
    closeConnections()
    if (started) await stopValidator(work)
  }
})
