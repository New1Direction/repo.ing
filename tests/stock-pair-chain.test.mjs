import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, createTransferInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchSessionStore, launchSessionKey } from '../src/launch-sessions.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createMarketConfigResolver } from '../src/market-config.mjs'
import { assertStockConfig, buildStockQuoteConfigTransaction, reviewStockQuoteConfig, verifyCreatedStockQuoteConfig } from '../src/stock-quote-config.mjs'
import { SOL_QUOTE, resolveQuoteAsset } from '../src/quote-assets.mjs'
import { stockMintCheck, stockPairGuard } from '../app/lib/stock-launch.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createDammTrader, createTradeRouter } from '../src/canonical-damm-trade.mjs'
import { prepareCheckedTrade } from '../src/trade-prepare.mjs'
import { createStockFeeAccrual } from '../src/stock-fee-accrual.mjs'
import { createStockFeeIndexer } from '../src/stock-fee-indexer.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { splitCurveFee } from '../src/stock-fee-policy.mjs'
import { settleConfirmedTrade } from '../app/lib/trade-settlement.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// A METAx-paired market launched end to end on the programs mainnet runs (scripts/ci/start-stock-validator.sh): the DBC,
// DAMM v2, Token-2022 and Metaplex programs as deployed, Meteora's real badges for METAx, and the real METAx mint with only its
// mint authority replaced. Nothing here touches mainnet beyond reading those accounts once.
const URL_ = 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_stock_pair_chain_test'
// The validator's RPC port as scripts/ci/start-stock-validator.sh reads it (STOCK_VALIDATOR_RPC_PORT, default 8919).
const RPC = process.env.STOCK_CHAIN_RPC ?? `http://127.0.0.1:${process.env.STOCK_VALIDATOR_RPC_PORT ?? 8919}`
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const METAX = new PublicKey(META.mint)
const DOCUSAURUS = { id: 94911145, name: 'docusaurus', full_name: 'facebook/docusaurus', owner: { login: 'facebook', id: 69631, type: 'Organization',
  avatar_url: null }, description: 'Easy to maintain open source documentation websites.', stargazers_count: 60000, forks_count: 9000,
  archived: false, private: false, visibility: 'public', updated_at: '2026-10-01T00:00:00Z' }
const HELLO = { id: 1296269, name: 'Hello-World', full_name: 'octocat/Hello-World', owner: { login: 'octocat', id: 583231, type: 'User',
  avatar_url: null }, description: null, stargazers_count: 1, forks_count: 1, archived: false, private: false, visibility: 'public',
  updated_at: '2026-01-01T00:00:00Z' }
const github = repo => async () => ({ ok: true, status: 200, json: async () => repo })
// Every Connection the test opens, so their websockets can be closed (code 1000, which stops rpc-websockets reconnecting)
// before a validator this test started is stopped; otherwise the reconnect loop keeps the test process alive.
const connections = []
const local = () => { const connection = new Connection(RPC, 'confirmed'); connections.push(connection); return connection }
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
async function until(read, attempts = 160) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)) }
  return null
}

// Stops a validator this test started: SIGTERM, wait for it to exit, then remove its work dir.
async function stopValidator(work) {
  let pid
  try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
  if (pid) {
    try { process.kill(pid) } catch {}
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('a METAx-paired market launches, verifies and trades on mainnet\'s programs; SOL launches are unchanged', { timeout: 600_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  // The validator: reuse a running one (STOCK_CHAIN_RPC / STOCK_CHAIN_WORK_DIR), else start one and remove it afterwards.
  let work = process.env.STOCK_CHAIN_WORK_DIR, started = false
  const admin = new pg.Pool({ connectionString: URL_.replace(/repoing_stock_pair_chain_test$/, 'postgres') })
  let pool, created = false
  const savedConfigs = process.env.STOCK_QUOTE_CONFIGS
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-stock-chain-'))
      started = true
      const run = spawnSync('scripts/ci/start-stock-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'stock-pair validator started')
    }
    assert.ok(work && existsSync(join(work, 'metax-authority.json')), 'the validator work dir with the METAx test authority')
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'metax-authority.json'), 'utf8'))))
    const connection = local()
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    await admin.query('drop database if exists repoing_stock_pair_chain_test')
    await admin.query('create database repoing_stock_pair_chain_test'); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })

    // The SOL launch-fee config, then the METAx config built and reviewed exactly as scripts/create-stock-quote-config.mjs does on
    // mainnet: the same partner and terms, quoted in METAx with Meteora's badge, graduating at 14 METAx; the unsigned simulation
    // must prove it equals the SOL config in every must-match term before it is sent.
    const { config: solConfig, partner } = await createFixedConfig(connection, 'launch-fee')
    const stockConfig = Keypair.generate()
    const built = await buildStockQuoteConfigTransaction({ connection, config: stockConfig.publicKey.toBase58(), asset: META, graduation: 14,
      partner: partner.publicKey.toBase58(), leftoverReceiver: partner.publicKey.toBase58() })
    const review = await reviewStockQuoteConfig({ connection, tx: built.tx, config: stockConfig.publicKey.toBase58(), payer: partner.publicKey.toBase58(),
      reference: solConfig.toBase58(), asset: META, graduation: 14, curve: built.curve })
    built.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    await sendAndConfirmTransaction(connection, built.tx, [partner, stockConfig], { commitment: 'confirmed' })
    assert.ok(await verifyCreatedStockQuoteConfig({ connection, config: stockConfig.publicKey.toBase58(), accountDataSha256: review.accountDataSha256, commitment: 'confirmed' }))
    // The review also holds the account to the curve it was built from.
    const coder = dbc.state.getProgram().coder.accounts
    const referenceDecoded = coder.decode('poolConfig', (await connection.getAccountInfo(solConfig)).data)
    assert.throws(() => assertStockConfig(review.decoded, referenceDecoded, { asset: META, graduation: 14,
      curve: { ...built.curve, sqrtStartPrice: built.curve.sqrtStartPrice.addn(1) } }), /differs from the curve it was built from in: sqrtStartPrice/)
    // A review against a config with different terms refuses before anything is signed.
    const { config: flatConfig } = await createFixedConfig(connection, 'balanced')
    const other = Keypair.generate().publicKey.toBase58()
    await assert.rejects(reviewStockQuoteConfig({ connection, tx: (await buildStockQuoteConfigTransaction({ connection, config: other,
      asset: META, graduation: 14, partner: partner.publicKey.toBase58(), leftoverReceiver: partner.publicKey.toBase58() })).tx,
      config: other, payer: partner.publicKey.toBase58(), reference: flatConfig.toBase58(), asset: META, graduation: 14 }),
      /differs from the SOL launch-fee config in: .*poolFees.*enableFirstSwapWithMinFee/)
    process.env.STOCK_QUOTE_CONFIGS = JSON.stringify({ 'meta-xstock': stockConfig.publicKey.toBase58() })
    const fixed = await dbc.state.getPoolConfig(stockConfig.publicKey)
    assert.ok(fixed.quoteMint.equals(METAX))
    assert.equal(fixed.quoteTokenFlag, 1, 'quoted through Token-2022')

    let stockMarket, siteBuy
    // Every swap on DOCUSAURUS / METAx, oldest first: what the stock ledgers must hold.
    const swaps = []
    await t.test('prepared on one replica, signed by the wallet, submitted from another: DOCUSAURUS / METAx', async () => {
      const creatorSecret = Keypair.generate().secretKey, launcherWallet = await funded(connection)
      const replica = () => {
        const creator = Keypair.fromSecretKey(creatorSecret)
        const launcher = createMeteoraLauncher({ connection: local(), config: stockConfig.publicKey, creator, quote: META })
        const store = createLaunchSessionStore({ pool, key: launchSessionKey(creator.secretKey) })
        return { launcher, store, coordinator: createLaunchCoordinator({ pool, launcher, fetchImpl: github(DOCUSAURUS), quote: META,
          discoveryEnabled: true, builderAllocationEnabled: true, verificationBonusLamports: 250_000_000n, pendingReview: m => store.pending(m.id) }) }
      }
      const guard = stockPairGuard(META, stockConfig.publicKey.toBase58(), { enabled: () => true,
        owner: async () => ({ ownerId: '69631', ownerType: 'Organization' }), mintUsable: stockMintCheck(connection) })
      const a = replica(), b = replica(), id = crypto.randomUUID()
      let transaction
      await a.coordinator.prepareLaunch({ repositoryUrl: 'https://github.com/facebook/docusaurus', tokenName: 'Docusaurus', tokenSymbol: 'DOCUSAURUS',
        launcherWallet: launcherWallet.publicKey.toBase58(), launchGuard: guard, onPrepared: async ({ market, prepared, repo }) => {
          transaction = prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
          await a.store.create({ id, market, repoFullName: repo.fullName, config: stockConfig.publicKey.toBase58(), transaction,
            mintSecretKey: prepared.mintSecretKey, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight })
        } })
      const signed = Transaction.from(Buffer.from(transaction, 'base64'))
      signed.partialSign(launcherWallet)
      const posted = signed.serialize({ requireAllSignatures: false }).toString('base64')
      const session = await b.store.consume(id)
      stockMarket = await b.coordinator.submitPrepared({ marketId: session.marketId, githubRepoId: session.githubRepoId, mint: session.mint,
        repo: { githubRepoId: BigInt(session.githubRepoId), fullName: session.repoFullName }, prepared: b.launcher.restore(session), launchGuard: guard,
        signTransaction: async () => Transaction.from(Buffer.from(posted, 'base64')) })
      assert.equal(stockMarket.status, 'confirmed')
      assert.deepEqual([stockMarket.quoteAssetId, stockMarket.quoteMint, stockMarket.quoteRegistryVersion], ['meta-xstock', META.mint, 1])
      assert.deepEqual([stockMarket.discoveryVersion, stockMarket.builderAllocationVersion, stockMarket.verificationBonusLamports], [null, null, null],
        'no SOL-denominated rewards on a stock pair')
      const state = await dbc.state.getPool(new PublicKey(stockMarket.pool))
      assert.ok(state.poolState.config.equals(stockConfig.publicKey))
      const vault = await connection.getAccountInfo(state.poolState.quoteVault)
      assert.ok(vault.owner.equals(TOKEN_2022_PROGRAM_ID), 'the pool holds METAx in a Token-2022 vault')
    })

    await t.test('launch evidence and the indexer accept it; the SOL-only resolver refuses it', async () => {
      const verify = createLaunchEvidenceVerifier({ connection, config: solConfig.toBase58() })
      const result = await until(async () => { const r = await verify(stockMarket); return r.state === 'match' ? r : null })
      assert.ok(result, 'finalized evidence matches')
      const indexed = await createLaunchIndexer({ pool, verify }).processMarket(stockMarket.githubRepoId)
      assert.equal(indexed.state, 'indexed')
      assert.throws(() => createMarketConfigResolver(solConfig.toBase58(), [])(stockMarket), /quote-aware/)
      const { rows: [row] } = await pool.query('select quote_asset_id, quote_mint, indexed_at is not null as indexed from markets where id = $1', [stockMarket.id])
      assert.deepEqual(row, { quote_asset_id: 'meta-xstock', quote_mint: META.mint, indexed: true })
    })

    await t.test('a trader buys DOCUSAURUS with METAx; fees accrue in METAx', async () => {
      const trader = await funded(connection)
      const account = getAssociatedTokenAddressSync(METAX, trader.publicKey, false, TOKEN_2022_PROGRAM_ID)
      await sendAndConfirmTransaction(connection, new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, account, trader.publicKey, METAX, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(METAX, account, authority.publicKey, 200_000_000n, [], TOKEN_2022_PROGRAM_ID)), [trader, authority], { commitment: 'confirmed' })
      const swap = await dbc.pool.swap({ owner: trader.publicKey, pool: new PublicKey(stockMarket.pool), amountIn: new BN(100_000_000),
        minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null })
      swap.feePayer = trader.publicKey
      swaps.push({ signature: await sendAndConfirmTransaction(connection, swap, [trader], { commitment: 'confirmed' }), direction: 'buy',
        trader: trader.publicKey.toBase58(), amountIn: 100_000_000n })
      const after = (await dbc.state.getPool(new PublicKey(stockMarket.pool))).poolState
      assert.ok(BigInt(after.creatorQuoteFee.toString()) > 0n && BigInt(after.partnerQuoteFee.toString()) > 0n, 'creator and partner fees in METAx')
      const balance = await connection.getTokenAccountBalance(account)
      assert.equal(balance.value.amount, '100000000', 'exactly 1 METAx spent')
    })

    await t.test('the site\'s trade path buys and sells DOCUSAURUS for METAx, settled to the raw unit', async () => {
      const trader = await funded(connection)
      const account = getAssociatedTokenAddressSync(METAX, trader.publicKey, false, TOKEN_2022_PROGRAM_ID)
      await sendAndConfirmTransaction(connection, new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, account, trader.publicKey, METAX, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(METAX, account, authority.publicKey, 100_000_000n, [], TOKEN_2022_PROGRAM_ID)), [trader, authority], { commitment: 'confirmed' })
      // Routed exactly as /api/trade routes it: the router reads the stock-paired curve and picks the curve trader.
      const curve = createCanonicalTrader({ pool, connection, config: solConfig.toBase58() })
      const router = createTradeRouter({ curve, graduated: createDammTrader({ pool, connection, config: solConfig.toBase58() }) })
      const githubRepoId = String(stockMarket.githubRepoId), wallet = trader.publicKey.toBase58()
      const engine = await router(githubRepoId)
      assert.equal(engine, curve)
      const sign = async tx => { tx.partialSign(trader); return tx }
      const quote = await engine.quoteBuy({ githubRepoId, amountLamports: '50000000', slippageBps: 500 })
      assert.ok(BigInt(quote.outputAmount) > 0n && quote.priceImpactPercent >= 0)
      const buy = await prepareCheckedTrade({ engine, connection, direction: 'buy', githubRepoId, wallet, amountBaseUnits: '50000000', slippageBps: 500 })
      assert.equal(buy.prepared.quoteMint, META.mint)
      assert.deepEqual([buy.costs.quoteBalance, buy.costs.quoteShortfall, buy.costs.refundableDeposit], ['100000000', '0', '0'])
      assert.ok(BigInt(buy.costs.accountDeposits) > 0n, 'rent for the new DOCUSAURUS account, in SOL')
      const bought = await engine.submitTrade(buy.prepared, sign)
      siteBuy = { prepared: buy.prepared, signature: bought.signature }
      swaps.push({ signature: bought.signature, direction: 'buy', trader: wallet, amountIn: 50_000_000n, tokenDelta: bought.tokenDelta })
      assert.equal(bought.quoteDelta, -50_000_000n, 'exactly 0.5 METAx spent')
      assert.ok(bought.tokenDelta >= buy.prepared.minimumAmountOut)
      assert.equal(bought.quoteMint, META.mint)
      // More METAx than the wallet holds is refused before anything is signed.
      await assert.rejects(prepareCheckedTrade({ engine, connection, direction: 'buy', githubRepoId, wallet, amountBaseUnits: '60000000', slippageBps: 500 }),
        /You need approximately 0\.1[0-9]* more METAx/)
      const sell = await prepareCheckedTrade({ engine, connection, direction: 'sell', githubRepoId, wallet,
        amountBaseUnits: bought.tokenDelta.toString(), slippageBps: 500 })
      const sold = await engine.submitTrade(sell.prepared, sign)
      swaps.push({ signature: sold.signature, direction: 'sell', trader: wallet, tokenDelta: sold.tokenDelta, quoteDelta: sold.quoteDelta })
      assert.equal(sold.tokenDelta, -bought.tokenDelta, 'every DOCUSAURUS token sold')
      assert.ok(sold.quoteDelta >= sell.prepared.minimumAmountOut && sold.quoteDelta > 0n, 'METAx back to the wallet')
      assert.equal((await connection.getTokenAccountBalance(account)).value.amount, String(50_000_000n + sold.quoteDelta))

      // A wallet holding DOCUSAURUS but no METAx account sells: the estimated deposit is exactly the rent of the account
      // Token-2022 creates for it (179 bytes for METAx), and that is the account created.
      const again = await engine.submitTrade((await prepareCheckedTrade({ engine, connection, direction: 'buy', githubRepoId, wallet,
        amountBaseUnits: '20000000', slippageBps: 500 })).prepared, sign)
      swaps.push({ signature: again.signature, direction: 'buy', trader: wallet, amountIn: 20_000_000n, tokenDelta: again.tokenDelta })
      const fresh = await funded(connection)
      const freshToken = getAssociatedTokenAddressSync(new PublicKey(stockMarket.mint), fresh.publicKey)
      await sendAndConfirmTransaction(connection, new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, freshToken, fresh.publicKey, new PublicKey(stockMarket.mint)),
        createTransferInstruction(getAssociatedTokenAddressSync(new PublicKey(stockMarket.mint), trader.publicKey), freshToken, trader.publicKey, again.tokenDelta)),
        [trader], { commitment: 'confirmed' })
      const freshSell = await prepareCheckedTrade({ engine, connection, direction: 'sell', githubRepoId, wallet: fresh.publicKey.toBase58(),
        amountBaseUnits: again.tokenDelta.toString(), slippageBps: 500 })
      assert.equal(freshSell.costs.accountDeposits, String(await connection.getMinimumBalanceForRentExemption(179)))
      const freshSold = await engine.submitTrade(freshSell.prepared, async tx => { tx.partialSign(fresh); return tx })
      swaps.push({ signature: freshSold.signature, direction: 'sell', trader: fresh.publicKey.toBase58(), tokenDelta: freshSold.tokenDelta,
        quoteDelta: freshSold.quoteDelta })
      assert.ok(freshSold.quoteDelta > 0n)
      const freshStock = await connection.getAccountInfo(getAssociatedTokenAddressSync(METAX, fresh.publicKey, false, TOKEN_2022_PROGRAM_ID))
      assert.equal(freshStock.data.length, 179)
    })

    await t.test('every METAx trade reaches the stock ledgers: fees equal the pool\'s counters to the raw unit, SOL ledgers untouched', async () => {
      const finalized = async signature => (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
        .value[0]?.confirmationStatus === 'finalized'
      assert.ok(await until(() => finalized(swaps.at(-1).signature), 400), 'the last trade is finalized')
      const config = solConfig.toBase58(), githubRepoId = String(stockMarket.githubRepoId)
      // A confirmed stock trade on the site, settled as /api/trade settles it: its fees go through the stock accrual.
      const accrual = createStockFeeAccrual({ pool, connection, config })
      const settled = await settleConfirmedTrade({ connection, db: pool, engine: null, prepared: siteBuy.prepared, signature: siteBuy.signature,
        recordFees: args => accrual.recordTradeFees({ ...args, quoteMint: siteBuy.prepared.quoteMint }) })
      assert.equal(settled.feeIndexing, 'recorded')
      assert.ok(BigInt(settled.creatorFee) > 0n, 'the creator fee credited, in raw METAx')
      // The worker's two jobs on the same database: the SOL job leaves the stock market out, the stock job indexes it.
      assert.deepEqual(await createExternalFeeIndexer({ pool, connection, config }).runOnce(), [])
      const indexer = createStockFeeIndexer({ pool, connection, config })
      const [first] = await indexer.runOnce()
      assert.deepEqual([first.githubRepoId, first.status, first.discovered, first.quarantined], [githubRepoId, 'OK', swaps.length, []])
      assert.equal(first.cursorAfter.signature, swaps.at(-1).signature)

      const ledger = async () => {
        const { rows: fees } = await pool.query(`select signature, event_index, creator_amount::text, partner_amount::text, launcher_amount::text,
          accumulator_amount::text, policy_version, asset_id, quote_mint, pool from stock_fee_events order by slot, event_index`)
        const { rows: trades } = await pool.query(`select signature, event_index, venue, direction, quote_amount::text, base_amount::text, trader,
          asset_id, quote_mint, pool from stock_trade_events order by slot, event_index`)
        return { fees, trades }
      }
      const { fees, trades } = await ledger()
      assert.deepEqual(fees.map(row => [row.signature, row.event_index]), trades.map(row => [row.signature, row.event_index]), 'one fee row per trade row')
      assert.deepEqual(trades.map(row => [row.signature, row.direction, row.trader]), swaps.map(swap => [swap.signature, swap.direction, swap.trader]))
      for (const row of [...fees, ...trades]) assert.deepEqual([row.asset_id, row.quote_mint, row.pool], [META.assetId, META.mint, stockMarket.pool])
      assert.ok(trades.every(row => row.venue === 'dbc'))
      for (const [row, swap, fee] of trades.map((row, i) => [row, swaps[i], fees[i]])) {
        if (swap.direction === 'sell') {
          // Raw units in and out of the pool: the tokens sold and the METAx the wallet received.
          assert.deepEqual([BigInt(row.base_amount), BigInt(row.quote_amount)], [-swap.tokenDelta, swap.quoteDelta])
        } else {
          // The fee-excluded METAx that bought the tokens: the trading fee (creator + partner) and Meteora's fee make up the rest.
          const tradingFee = BigInt(fee.creator_amount) + BigInt(fee.partner_amount)
          assert.ok(BigInt(row.quote_amount) > 0n && BigInt(row.quote_amount) + tradingFee < swap.amountIn)
          if (swap.tokenDelta !== undefined) assert.equal(BigInt(row.base_amount), swap.tokenDelta)
        }
      }
      for (const row of fees) {
        const split = splitCurveFee({ creatorAmount: BigInt(row.creator_amount), partnerAmount: BigInt(row.partner_amount) })
        assert.deepEqual([BigInt(row.launcher_amount), BigInt(row.accumulator_amount), row.policy_version], [split.launcherAmount, split.accumulatorAmount, 1])
        assert.ok(BigInt(row.creator_amount) > 0n && BigInt(row.partner_amount) > 0n)
      }
      // The pool's own fee counters (finalized), to the raw unit.
      const state = (await new DynamicBondingCurveClient(connection, 'finalized').state.getPool(new PublicKey(stockMarket.pool))).poolState
      const sum = field => fees.reduce((total, row) => total + BigInt(row[field]), 0n)
      assert.equal(sum('creator_amount'), BigInt(state.creatorQuoteFee.toString()), 'creator fees = pool creatorQuoteFee')
      assert.equal(sum('partner_amount'), BigInt(state.partnerQuoteFee.toString()), 'partner fees = pool partnerQuoteFee')
      assert.equal(first.creditedBaseUnits + BigInt(settled.creatorFee), sum('creator_amount'), 'nothing credited twice')

      // Idempotent: another run finds nothing; a replay of the whole history from the launch credits nothing new.
      const [again] = await indexer.runOnce()
      assert.deepEqual([again.status, again.discovered, again.creditedBaseUnits], ['OK', 0, 0n])
      await pool.query('delete from stock_pool_cursors where pool = $1', [stockMarket.pool])
      const [replay] = await indexer.runOnce()
      assert.deepEqual([replay.status, replay.discovered, replay.creditedBaseUnits, replay.creditedPartnerUnits], ['OK', swaps.length, 0n, 0n])
      assert.deepEqual(await ledger(), { fees, trades })

      // The SOL ledgers and the operator feed are untouched.
      for (const table of ['fee_events', 'trade_events', 'discovery_fee_events', 'pool_fee_cursors', 'damm_trade_events', 'damm_fee_events', 'platform_fee_events']) {
        assert.equal((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, 0, `${table} untouched`)
      }
      assert.equal((await pool.query('select count(*)::int as n from graduation_alerts')).rows[0].n, 0, 'no alert or quarantine')
      console.log(JSON.stringify({ stockLedgers: { pool: stockMarket.pool, mint: stockMarket.mint, config: stockConfig.publicKey.toBase58(),
        launch: stockMarket.launchSignature, swaps: swaps.map(swap => [swap.signature, swap.direction]),
        creatorQuoteFee: state.creatorQuoteFee.toString(), partnerQuoteFee: state.partnerQuoteFee.toString() } }))
    })

    await t.test('a launcher built for one pair refuses the other pair\'s config', async () => {
      const creator = Keypair.generate(), wallet = Keypair.generate().publicKey.toBase58()
      await assert.rejects(createMeteoraLauncher({ connection, config: stockConfig.publicKey, creator })
        .prepare({ launcherWallet: wallet, tokenName: 'X', tokenSymbol: 'X' }), /does not match the tested fixed launch configuration/)
      await assert.rejects(createMeteoraLauncher({ connection, config: solConfig, creator, quote: META })
        .prepare({ launcherWallet: wallet, tokenName: 'X', tokenSymbol: 'X' }), /does not match the stock pair/)
      await assert.rejects(createMeteoraLauncher({ connection, config: stockConfig.publicKey, creator, quote: META })
        .prepare({ launcherWallet: wallet, tokenName: 'X', tokenSymbol: 'X', initialBuyLamports: '1000' }), /no initial buy/)
    })

    await t.test('a SOL launch on the same programs is unchanged: no stamp, its rewards, its evidence', async () => {
      const creator = Keypair.generate(), launcherWallet = await funded(connection)
      const launcher = createMeteoraLauncher({ connection, config: solConfig, creator })
      const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl: github(HELLO), discoveryEnabled: true, builderAllocationEnabled: true,
        verificationBonusLamports: 250_000_000n })
      const market = await coordinator.launch({ repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'Hello', tokenSymbol: 'HELLO',
        launcherWallet: launcherWallet.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(launcherWallet); return tx } })
      assert.equal(market.status, 'confirmed')
      assert.deepEqual([market.quoteAssetId, market.quoteMint, market.quoteRegistryVersion], [null, null, null])
      assert.deepEqual([market.discoveryVersion, market.builderAllocationVersion, market.verificationBonusLamports], [2, 1, 250_000_000n])
      const verify = createLaunchEvidenceVerifier({ connection, config: solConfig.toBase58() })
      assert.ok(await until(async () => (await verify(market)).state === 'match'))
      assert.equal(SOL_QUOTE.symbol, 'SOL')
    })
  } finally {
    if (savedConfigs === undefined) delete process.env.STOCK_QUOTE_CONFIGS
    else process.env.STOCK_QUOTE_CONFIGS = savedConfigs
    await pool?.end()
    if (created) await dropTestDatabase(admin, 'repoing_stock_pair_chain_test')
    await admin.end()
    closeConnections()
    if (started) await stopValidator(work)
  }
})
