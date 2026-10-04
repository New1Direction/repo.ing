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
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { buildStockQuoteConfigTransaction } from '../src/stock-quote-config.mjs'
import { resolveQuoteAsset } from '../src/quote-assets.mjs'
import { createStockFeeIndexer } from '../src/stock-fee-indexer.mjs'
import { splitCurveFee } from '../src/stock-fee-policy.mjs'
import { listStockMarkets } from '../src/stock-collections.mjs'
import { stockAccumulator } from '../src/stock-accumulator.mjs'
import { launcherEarnings, readMarketLauncherLedger } from '../src/stock-launcher-earnings.mjs'
import { createStockCollectionExecutor } from '../src/stock-collection-execution.mjs'
import { createStockLauncherPayouts } from '../src/stock-launcher-payouts.mjs'
import { runStockExecution } from '../src/stock-execution-job.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Stock fees collected into custody and a launcher paid, for real, on the programs mainnet runs (scripts/ci/start-stock-validator.sh:
// DBC and Token-2022 as deployed, Meteora's badges and the real METAx mint with a test mint authority). DOCUSAURUS / METAx is
// launched and traded; the stock fee indexer records the fees; then the execution pass (src/stock-execution-job.mjs) collects the
// curve's creator fee (signed by the platform creator key) and partner fee (signed by the partner key) into custody, and pays the
// launcher their 0.30% from custody, each settled from its finalized receipt. Keys are the test's own, handed to the executors as
// scripts/stock-execute.mjs hands over its Keychain keys. Nothing here touches mainnet beyond the validator script's one read of
// those accounts.
const DB = 'repoing_stock_execution_chain_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const RPC = process.env.STOCK_CHAIN_RPC ?? `http://127.0.0.1:${process.env.STOCK_VALIDATOR_RPC_PORT ?? 8919}`
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const METAX = new PublicKey(META.mint)
const DOCS = '94911145'
const connections = []
const local = commitment => { const connection = new Connection(RPC, commitment); connections.push(connection); return connection }
const closeConnections = () => { for (const connection of connections) { try { connection._rpcWebSocket?.close() } catch {} } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function healthy() {
  try { return (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })).json()).result === 'ok' } catch { return false }
}
async function stopValidator(work) {
  let pid
  try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
  if (pid) {
    try { process.kill(pid) } catch {}
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await sleep(250) }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('stock fees are collected into custody and the launcher is paid, settled from finalized receipts on mainnet\'s programs', { timeout: 900_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.STOCK_CHAIN_WORK_DIR, started = false
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let pool, created = false
  const savedConfigs = process.env.STOCK_QUOTE_CONFIGS
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-stock-execution-'))
      started = true
      assert.equal(spawnSync('scripts/ci/start-stock-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 }).status, 0, 'stock-pair validator started')
    }
    assert.ok(work && existsSync(join(work, 'metax-authority.json')), 'the validator work dir with the METAx test authority')
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'metax-authority.json'), 'utf8'))))
    const connection = local('confirmed'), finalizedConnection = local('finalized')
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 6 })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })

    const funded = async (lamports = 5_000_000_000) => {
      const keypair = Keypair.generate()
      const signature = await connection.requestAirdrop(keypair.publicKey, lamports)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
      return keypair
    }
    const finalized = async signature => {
      for (let i = 0; i < 240; i++) {
        if ((await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized') return signature
        await sleep(250)
      }
      throw Error(`${signature} did not finalize`)
    }
    const send = async (instructions, signers) => {
      const tx = new Transaction().add(...instructions)
      tx.feePayer = signers[0].publicKey
      return finalized(await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' }))
    }
    const balance = async owner => {
      const info = await finalizedConnection.getAccountInfo(getAssociatedTokenAddressSync(METAX, new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID))
      return info ? BigInt((await finalizedConnection.getTokenAccountBalance(getAssociatedTokenAddressSync(METAX, new PublicKey(owner), true, TOKEN_2022_PROGRAM_ID))).value.amount) : null
    }
    const buy = async raw => {
      const trader = await funded()
      const account = getAssociatedTokenAddressSync(METAX, trader.publicKey, false, TOKEN_2022_PROGRAM_ID)
      await send([createAssociatedTokenAccountIdempotentInstruction(trader.publicKey, account, trader.publicKey, METAX, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(METAX, account, authority.publicKey, raw, [], TOKEN_2022_PROGRAM_ID)], [trader, authority])
      const swap = await dbc.pool.swap({ owner: trader.publicKey, pool: new PublicKey(market.pool), amountIn: new BN(String(raw)),
        minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null })
      swap.feePayer = trader.publicKey
      return finalized(await sendAndConfirmTransaction(connection, swap, [trader], { commitment: 'confirmed' }))
    }
    const curveFees = async () => {
      const s = (await new DynamicBondingCurveClient(finalizedConnection, 'finalized').state.getPool(new PublicKey(market.pool))).poolState
      return { creator: BigInt(s.creatorQuoteFee.toString()), partner: BigInt(s.partnerQuoteFee.toString()) }
    }

    // The SOL launch-fee config, and the METAx config built from it with the same partner (fee claimer), as on mainnet.
    const { config: solConfig, partner } = await createFixedConfig(connection, 'launch-fee')
    const stockConfig = Keypair.generate()
    const built = await buildStockQuoteConfigTransaction({ connection, config: stockConfig.publicKey.toBase58(), asset: META, graduation: 14,
      partner: partner.publicKey.toBase58(), leftoverReceiver: partner.publicKey.toBase58() })
    built.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    await sendAndConfirmTransaction(connection, built.tx, [partner, stockConfig], { commitment: 'confirmed' })
    const stockConfigs = new Map([['meta-xstock', stockConfig.publicKey]])
    process.env.STOCK_QUOTE_CONFIGS = JSON.stringify({ 'meta-xstock': stockConfig.publicKey.toBase58() })

    // DOCUSAURUS / METAx, recorded as the launch indexer leaves a finalized market.
    const creator = await funded(), launcherWallet = await funded()
    const prepared = await createMeteoraLauncher({ connection, config: stockConfig.publicKey, creator, quote: META })
      .prepare({ launcherWallet: launcherWallet.publicKey.toBase58(), tokenName: 'Docusaurus', tokenSymbol: 'DOCUSAURUS' })
    const launch = await prepared.sign(async tx => { tx.partialSign(launcherWallet); return tx })
    await connection.sendRawTransaction(launch.raw)
    await finalized(launch.signature)
    const market = { pool: prepared.pool, mint: prepared.mint }
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values (${DOCS},'facebook','docusaurus','facebook/docusaurus',60000,9000,false,now())`)
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
        last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version)
      values ($1,'confirmed',$2,$3,$4,$5,'Docusaurus','DOCUSAURUS',$6,$7,$8,1,'finalized',now(),now(),'meta-xstock',$9,1)`,
    [DOCS, prepared.mint, prepared.pool, launcherWallet.publicKey.toBase58(), creator.publicKey.toBase58(), launch.signature, prepared.blockhash,
      String(prepared.lastValidBlockHeight), META.mint])

    // A 10 METAx buy, recorded in the stock ledgers by the worker's own stock fee indexer.
    await buy(1_000_000_000n)
    const indexer = createStockFeeIndexer({ pool, connection, config: solConfig.toBase58(), stockConfigs })
    const [indexed] = await indexer.runOnce()
    assert.deepEqual([indexed.status, indexed.quarantined], ['OK', []], indexed.error)
    const fees = await curveFees()
    assert.ok(fees.creator > 0n && fees.partner > 0n)
    const split = splitCurveFee({ creatorAmount: fees.creator, partnerAmount: fees.partner })
    assert.ok(split.launcherAmount >= 1_000_000n, 'the launcher share reaches the payout minimum')

    // The executors as scripts/stock-execute.mjs --execute builds them: the two flags are all their environment holds.
    const custody = partner.publicKey.toBase58(), launcher = launcherWallet.publicKey.toBase58()
    const env = { STOCK_COLLECTIONS_EXECUTION_ENABLED: 'true', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'true' }
    // The operator script's signers (src/stock-keychain.mjs reads them from the Keychain): here, this test's keys.
    const loadSigner = role => (role === 'creator' ? creator : partner)
    const state = { crash: false }
    const collections = createStockCollectionExecutor({ pool, connection, config: solConfig.toBase58(), env, custody, partner: custody, stockConfigs,
      legacyConfigs: '', loadSigner, hooks: { afterIntent: async () => { if (state.crash) { state.crash = false; throw Error('crash after the intent was stored') } } } })
    const payouts = createStockLauncherPayouts({ pool, connection, env, custody, loadSigner })
    const pass = execute => runStockExecution({ collections, payouts, listMarkets: filter => listStockMarkets(pool, filter), execute })
    const ledger = async () => launcherEarnings(await readMarketLauncherLedger(pool, DOCS))

    await t.test('a dry run plans both curve collections and loads, signs and sends nothing', async () => {
      const plan = await pass(false)
      assert.deepEqual(plan.collections.map(i => [i.source, i.status, i.amount, i.signer]), [
        ['dbc_creator', 'WOULD_COLLECT', String(fees.creator), creator.publicKey.toBase58()],
        ['dbc_partner', 'WOULD_COLLECT', String(fees.partner), custody]])
      assert.deepEqual(plan.payouts, [], 'nothing is in custody yet, so nothing is payable')
      assert.equal(await balance(custody), null, 'custody has no METAx account yet')
      assert.equal((await pool.query('select count(*)::int as n from stock_fee_collections')).rows[0].n, 0)
    })

    await t.test('one pass collects both fees into custody and pays the launcher their share, each from a finalized receipt', async () => {
      const done = await pass(true)
      assert.deepEqual(done.collections.map(i => [i.source, i.status, i.amount, i.launcherAmount]), [
        ['dbc_creator', 'SETTLED', String(fees.creator), String(split.launcherAmount)], ['dbc_partner', 'SETTLED', String(fees.partner), '0']])
      assert.deepEqual(done.payouts.map(i => [i.status, i.amount, i.wallet, i.accountCreated]), [['SETTLED', String(split.launcherAmount), launcher, true]])
      // On chain: the curve's fees are claimed; custody holds them less the launcher's share, which the launcher holds.
      assert.deepEqual(await curveFees(), { creator: 0n, partner: 0n })
      assert.equal(await balance(custody), fees.creator + fees.partner - split.launcherAmount)
      assert.equal(await balance(launcher), split.launcherAmount)
      // In the ledgers: settled rows with their receipts, the launcher paid exactly what was collected for them.
      const { rows } = await pool.query(`select source, status, reviewed_amount::text, actual_amount::text, launcher_amount::text,
        accumulator_amount::text, receipt->>'state' as state, receipt->>'receiverTokenAccount' as account from stock_fee_collections order by source`)
      assert.deepEqual(rows.map(r => [r.source, r.status, r.actual_amount, r.launcher_amount, r.accumulator_amount, r.state]), [
        ['dbc_creator', 'settled', String(fees.creator), String(split.launcherAmount), String(fees.creator - split.launcherAmount), 'settled'],
        ['dbc_partner', 'settled', String(fees.partner), '0', String(fees.partner), 'settled']])
      assert.ok(rows.every(r => r.account === getAssociatedTokenAddressSync(METAX, partner.publicKey, true, TOKEN_2022_PROGRAM_ID).toBase58()))
      const earnings = await ledger()
      assert.deepEqual([earnings.collected, earnings.paid, earnings.pending, earnings.payable], [split.launcherAmount, split.launcherAmount, 0n, 0n])
      const summary = await stockAccumulator(pool, 'meta-xstock', { onchain: new Map([[DOCS, { uncollected: '0' }]]) })
      assert.equal(summary.status, 'MATCH', summary.problems.join('; '))
      assert.equal(BigInt(summary.totals.custodyExpected), await balance(custody), 'custody holds exactly what the ledgers say')
      // The claims in the curve's history are known non-swaps to the stock indexer: nothing is quarantined or credited.
      const [after] = await indexer.runOnce()
      assert.deepEqual([after.status, after.quarantined, after.creditedBaseUnits], ['OK', [], 0n])
    })

    await t.test('a second pass changes nothing: nothing is collected or paid twice', async () => {
      const before = [await balance(custody), await balance(launcher)]
      assert.deepEqual(await pass(true), { collections: [], payouts: [] })
      assert.deepEqual([await balance(custody), await balance(launcher)], before)
      const { rows: [counts] } = await pool.query(`select (select count(*) from stock_fee_collections)::int as collections,
        (select count(*) from stock_launcher_payouts)::int as payouts`)
      assert.deepEqual(counts, { collections: 2, payouts: 1 })
    })

    await t.test('a collection that crashed after its signed bytes were stored is rebroadcast by recovery and settled, then paid out', async () => {
      await buy(500_000_000n)
      const [more] = await indexer.runOnce()
      assert.equal(more.status, 'OK')
      const fresh = await curveFees()
      const plan = await collections.plan((await listStockMarkets(pool, { repoId: DOCS }))[0])
      const creatorPlan = plan.find(item => item.source === 'dbc_creator')
      assert.equal(creatorPlan.status, 'MATCH')
      state.crash = true
      await assert.rejects(collections.collect({ repoId: DOCS, source: 'dbc_creator', termsHash: creatorPlan.termsHash }), /crash after the intent was stored/)
      const { rows: [row] } = await pool.query(`select signature, status from stock_fee_collections where status = 'pending'`)
      assert.equal(row.status, 'pending')
      assert.equal((await connection.getSignatureStatuses([row.signature], { searchTransactionHistory: true })).value[0], null, 'never sent')
      assert.deepEqual((await collections.recover()).map(r => [r.source, r.status]), [['dbc_creator', 'REBROADCAST']])
      await finalized(row.signature)
      assert.deepEqual((await collections.recover()).map(r => [r.source, r.status, r.signature]), [['dbc_creator', 'SETTLED', row.signature]])
      // The next pass collects the partner fee and pays the launcher the new share.
      const done = await pass(true)
      assert.deepEqual(done.collections.map(i => [i.source, i.status, i.amount]), [['dbc_partner', 'SETTLED', String(fresh.partner)]])
      const share = splitCurveFee({ creatorAmount: fresh.creator, partnerAmount: 0n }).launcherAmount
      assert.deepEqual(done.payouts.map(i => [i.status, i.amount, i.accountCreated]), [['SETTLED', String(share), false]])
      assert.equal(await balance(launcher), split.launcherAmount + share)
      const summary = await stockAccumulator(pool, 'meta-xstock', { onchain: new Map([[DOCS, { uncollected: '0' }]]) })
      assert.equal(summary.status, 'MATCH', summary.problems.join('; '))
      assert.equal(BigInt(summary.totals.custodyExpected), await balance(custody))
      console.log(JSON.stringify({ stockExecution: { pool: market.pool, custody, launcher, collections: done.collections.length,
        custodyBalance: String(await balance(custody)), launcherBalance: String(await balance(launcher)) } }))
    })
  } finally {
    if (savedConfigs === undefined) delete process.env.STOCK_QUOTE_CONFIGS
    else process.env.STOCK_QUOTE_CONFIGS = savedConfigs
    await pool?.end()
    if (created) await dropTestDatabase(admin, DB)
    await admin.end()
    closeConnections()
    if (started) await stopValidator(work)
  }
})
