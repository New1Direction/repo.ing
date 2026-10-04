import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { POLICY_VERSION, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { createStockCollections } from '../src/stock-collections.mjs'
import { launcherEarnings, readMarketLauncherLedger } from '../src/stock-launcher-earnings.mjs'
import { STOCK_EXECUTION_ERRORS as E } from '../src/stock-execution.mjs'
import { createStockExecutionStore } from '../src/stock-execution-store.mjs'
import { createStockCollectionExecutor } from '../src/stock-collection-execution.mjs'
import { createStockLauncherPayouts } from '../src/stock-launcher-payouts.mjs'
import { runStockExecution } from '../src/stock-execution-job.mjs'
import { listStockMarkets } from '../src/stock-collections.mjs'
import { META, address, curveReceipt, fakeChain, finalizedTransaction, loadFrom, payoutTransaction } from './fixtures/stock-execution-fakes.mjs'

// Stock fee collections and launcher payouts on PostgreSQL (migration 0054's tables, indexes and triggers), with PR-E's real
// collection previews (src/stock-collections.mjs) over the real stock ledgers and PR-D's real launcher ledger
// (src/stock-launcher-earnings.mjs). Only the chain is in-process (tests/fixtures/stock-execution-fakes.mjs): the reader reports
// what the curve holds, and sent transactions land as finalized receipts.
const DB = 'repoing_stock_execution_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const ON = { STOCK_COLLECTIONS_EXECUTION_ENABLED: 'true', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'true' }
const DOCS = '94911145', HELLO = '1296269'
const CREATOR_FEE = 10_000_000n, PARTNER_FEE = 4_084_507n
const SPLIT = splitCurveFee({ creatorAmount: CREATOR_FEE, partnerAmount: PARTNER_FEE })

test('stock collections and launcher payouts on PostgreSQL: one pending per market, the launcher wallet only, exact ledgers', { timeout: 120_000 }, async t => {
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let pool, created = false
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 6 })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    const creator = Keypair.generate(), partner = Keypair.generate(), launcher = Keypair.generate(), custody = partner.publicKey.toBase58()
    const market = { mint: address(), pool: address(), launcherWallet: launcher.publicKey.toBase58(), creatorWallet: creator.publicKey.toBase58() }
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values
      (${DOCS},'facebook','docusaurus','facebook/docusaurus',60000,9000,false,now()), (${HELLO},'octocat','Hello-World','octocat/Hello-World',1,1,false,now())`)
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
        last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
      ($1,'confirmed',$2,$3,$4,$5,'Docusaurus','DOCUSAURUS','LaunchDocs','Hash',100,12,'finalized',now(),now(),'meta-xstock',$6,1),
      ($7,'confirmed',$8,$9,$10,$11,'Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now(),null,null,null)`,
    [DOCS, market.mint, market.pool, market.launcherWallet, market.creatorWallet, META.mint, HELLO, address(), address(), address(), address()])
    await pool.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,
      launcher_amount,accumulator_amount,policy_version) values ($1,'meta-xstock',$2,$3,'SwapDocs',0,20,$4,$5,$6,$7,$8)`,
    [DOCS, META.mint, market.pool, CREATOR_FEE, PARTNER_FEE, SPLIT.launcherAmount, SPLIT.accumulatorAmount, POLICY_VERSION])

    // The curve as the reader sees it; a landed collection empties its side, as the program's claim does.
    const curve = { dbc_creator: CREATOR_FEE, dbc_partner: PARTNER_FEE }
    const dbc = { pool: market.pool, config: address(), baseVault: address(), quoteVault: address() }
    const reader = { local: true, programs: { dbc: new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1', 'finalized'), 'finalized').state.getProgram() },
      readMarket: async () => ({ asset: META, slot: 4242, verified: false, damm: null,
        dbc: { ...dbc, creator: market.creatorWallet, feeClaimer: custody, isMigrated: false, creatorFee: curve.dbc_creator, partnerFee: curve.dbc_partner } }) }
    const previews = createStockCollections({ pool, reader, custody })
    const intents = new Map()
    const chain = fakeChain({ finalized: (raw, signature) => {
      const intent = intents.get(signature)
      if (intent?.kind === 'payout') return payoutTransaction(raw, intent.terms)
      if (intent?.kind === 'collection') curve[intent.terms.source] = 0n
      return finalizedTransaction(raw)
    } })
    const state = { crash: false }
    const hooks = { afterIntent: async row => {
      intents.set(row.signature, row.receipt)
      if (state.crash) { state.crash = false; throw Error('crash after the intent was stored') }
    } }
    const loads = []
    const loadSigner = role => { loads.push(role); return role === 'creator' ? creator : partner }
    const collections = createStockCollectionExecutor({ pool, connection: chain.connection, config: null, env: ON, custody, partner: custody,
      previewMarket: m => previews.previewMarket(m), checkReceipt: ({ terms, signature }) => curveReceipt(terms, signature), loadTransaction: loadFrom,
      loadSigner, mintCheck: async () => ({ ok: true }), follow: chain.follow, hooks })
    const payouts = createStockLauncherPayouts({ pool, connection: chain.connection, env: ON, custody, loadTransaction: loadFrom, loadSigner,
      mintCheck: async () => ({ ok: true }), custodyBalance: async () => chain.custodyBalance, follow: chain.follow, hooks })
    const store = createStockExecutionStore(pool)
    const listMarkets = filter => listStockMarkets(pool, filter)
    const ledger = async () => launcherEarnings(await readMarketLauncherLedger(pool, DOCS))
    const count = async (table, where = 'true') => (await pool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n

    await t.test('the stock market is listed and planned; the SOL market never is', async () => {
      assert.deepEqual((await listMarkets({})).map(m => m.repoId), [DOCS])
      const plan = await runStockExecution({ collections, payouts, listMarkets, execute: false })
      assert.deepEqual(plan.collections.map(i => [i.source, i.status, i.amount]), [['dbc_creator', 'WOULD_COLLECT', String(CREATOR_FEE)],
        ['dbc_partner', 'WOULD_COLLECT', String(PARTNER_FEE)]])
      assert.deepEqual(plan.payouts, [], 'nothing is collected yet, so nothing is payable')
      assert.deepEqual([loads, chain.sends, await count('stock_fee_collections'), await count('stock_launcher_payouts')], [[], [], 0, 0])
    })

    await t.test('a collection crashing after its signed bytes are stored is finished by recovery, once', async () => {
      const [plan] = await collections.plan((await listMarkets({ repoId: DOCS }))[0])
      state.crash = true
      await assert.rejects(collections.collect({ repoId: DOCS, source: 'dbc_creator', termsHash: plan.termsHash }), /crash/)
      const { rows: [row] } = await pool.query(`select status, signature, signed_transaction is not null as signed, settled_at, receipt->>'state' as state,
        (receipt->>'lastValidBlockHeight')::bigint > 0 as expiry, reviewed_amount::text, launcher_amount::text, terms_hash from stock_fee_collections`)
      assert.deepEqual([row.status, row.signed, row.settled_at, row.state, row.expiry, row.reviewed_amount, row.launcher_amount, row.terms_hash],
        ['pending', true, null, 'pending', true, String(CREATOR_FEE), String(SPLIT.launcherAmount), plan.termsHash])
      // PR-E's preview sees the pending row; a direct attempt is refused before anything is signed.
      assert.deepEqual((await collections.plan((await listMarkets({ repoId: DOCS }))[0])).map(s => [s.source, s.status]), [['dbc_creator', 'PENDING'], ['dbc_partner', 'MATCH']])
      assert.equal((await collections.collect({ repoId: DOCS, source: 'dbc_creator', termsHash: plan.termsHash })).status, 'NOT_COLLECTABLE')
      // The database itself refuses a second pending row for this market and source.
      await assert.rejects(store.insertCollection(pool, { repoId: DOCS, assetId: META.assetId, quoteMint: META.mint, source: 'dbc_creator',
        reviewedAmount: '1', launcherAmount: '0', accumulatorAmount: '1', termsHash: 'b'.repeat(64), signature: 'x', signedTransaction: 'x', receipt: {} }), { code: E.IN_FLIGHT })
      assert.deepEqual((await collections.recover()).map(r => r.status), ['REBROADCAST'])
      assert.deepEqual((await collections.recover()).map(r => [r.source, r.status]), [['dbc_creator', 'SETTLED']])
      assert.deepEqual(await collections.recover(), [])
      assert.equal(chain.sends.length, 1)
    })

    await t.test('the partner collection runs from the pass; the ledgers then read exactly what custody received', async () => {
      const pass = await runStockExecution({ collections, listMarkets, execute: true })
      assert.deepEqual(pass.collections.map(i => [i.source, i.status]), [['dbc_partner', 'SETTLED']])
      const { rows } = await pool.query(`select source, status, reviewed_amount::text, actual_amount::text, launcher_amount::text, accumulator_amount::text,
        settled_at is not null as settled, receipt->>'state' as state, receipt->>'amount' as amount from stock_fee_collections order by source`)
      assert.deepEqual(rows.map(r => [r.source, r.status, r.actual_amount, r.launcher_amount, r.accumulator_amount, r.settled, r.state, r.amount]), [
        ['dbc_creator', 'settled', String(CREATOR_FEE), String(SPLIT.launcherAmount), String(CREATOR_FEE - SPLIT.launcherAmount), true, 'settled', String(CREATOR_FEE)],
        ['dbc_partner', 'settled', String(PARTNER_FEE), '0', String(PARTNER_FEE), true, 'settled', String(PARTNER_FEE)]])
      assert.deepEqual((await collections.plan((await listMarkets({ repoId: DOCS }))[0])).map(s => s.status), ['EMPTY', 'EMPTY'])
      const earnings = await ledger()
      assert.deepEqual([earnings.collected, earnings.paid, earnings.pending, earnings.payable], [SPLIT.launcherAmount, 0n, 0n, SPLIT.launcherAmount])
      assert.deepEqual(loads, ['creator', 'partner'])
    })

    await t.test('custody below what the ledgers say it holds blocks payouts before anything is signed; a surplus does not', async () => {
      const holds = CREATOR_FEE + PARTNER_FEE
      chain.custodyBalance = holds - 1n
      await assert.rejects(payouts.pay({ repoId: DOCS }), { code: E.CUSTODY_SHORTFALL })
      assert.deepEqual((await runStockExecution({ payouts, listMarkets, execute: true })).payouts.map(i => [i.status, i.code]), [['ERROR', E.CUSTODY_SHORTFALL]])
      // The owner's recorded settlement spends lower what custody must hold.
      await pool.query(`insert into stock_settlement_receipts(asset_id,quote_mint,kind,signature,quote_spent,repoing_spent,repoing_received,evidence)
        values ('meta-xstock',$1,'swap','SettleDocs',1,0,0,'{}')`, [META.mint])
      assert.deepEqual(await store.custodyLedger(pool, META.assetId), { collected: holds, paid: 0n, pending: 0n, spent: 1n })
      assert.equal((await payouts.plan((await listMarkets({ repoId: DOCS }))[0])).status, 'PAYABLE')
      assert.equal(await count('stock_launcher_payouts'), 0)
      assert.deepEqual(loads, ['creator', 'partner'], 'no key was loaded for a blocked payout')
      chain.custodyBalance = 50_000_000n
    })

    await t.test('a payout goes only to the launcher wallet, is never paid twice, and survives a crash', async () => {
      await assert.rejects(store.insertPayout(pool, { repoId: DOCS, assetId: META.assetId, quoteMint: META.mint, wallet: address(), amount: '1',
        signature: 'x', signedTransaction: 'x', receipt: {} }), /launcher wallet/)
      state.crash = true
      await assert.rejects(payouts.pay({ repoId: DOCS }), /crash/)
      assert.deepEqual([(await ledger()).pending, (await ledger()).payable], [SPLIT.launcherAmount, 0n])
      // Another process holding the market (the worker or the operator script) makes this one wait its turn.
      const holder = await pool.connect()
      try {
        await holder.query("select pg_advisory_lock(hashtextextended('stock-execution:' || $1, 0))", [DOCS])
        assert.deepEqual(await payouts.pay({ repoId: DOCS }), { repoId: DOCS, status: 'BUSY' })
        await holder.query("select pg_advisory_unlock(hashtextextended('stock-execution:' || $1, 0))", [DOCS])
      } finally { holder.release() }
      assert.equal((await payouts.pay({ repoId: DOCS })).status, 'IN_FLIGHT')
      await assert.rejects(store.insertPayout(pool, { repoId: DOCS, assetId: META.assetId, quoteMint: META.mint, wallet: market.launcherWallet, amount: '1',
        signature: 'y', signedTransaction: 'y', receipt: {} }), { code: E.IN_FLIGHT })
      const sends = chain.sends.length
      assert.deepEqual((await payouts.recover()).map(r => r.status), ['REBROADCAST'])
      assert.deepEqual((await payouts.recover()).map(r => [r.status, r.wallet]), [['SETTLED', market.launcherWallet]])
      const { rows: [row] } = await pool.query(`select wallet, amount::text, status, settled_at is not null as settled, receipt->>'state' as state,
        receipt->>'walletTokenAccount' as account, (receipt->>'accountCreated')::boolean as created from stock_launcher_payouts`)
      assert.deepEqual([row.wallet, row.amount, row.status, row.settled, row.state, row.created], [market.launcherWallet, String(SPLIT.launcherAmount), 'settled', true, 'settled', true])
      assert.equal(chain.sends.length, sends + 1)
      const earnings = await ledger()
      assert.deepEqual([earnings.paid, earnings.pending, earnings.payable], [SPLIT.launcherAmount, 0n, 0n])
      const again = await runStockExecution({ collections, payouts, listMarkets, execute: true })
      assert.deepEqual(again, { collections: [], payouts: [] }, 'a second pass does nothing')
      assert.equal(chain.sends.length, sends + 1)
    })

    await t.test('an expired payout that never landed aborts; a receipt that does not match stays pending with one alert', async () => {
      // More fees, collected, so the launcher is owed again.
      const more = splitCurveFee({ creatorAmount: CREATOR_FEE, partnerAmount: 0n })
      await pool.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,
        launcher_amount,accumulator_amount,policy_version) values ($1,'meta-xstock',$2,$3,'SwapDocs2',0,21,$4,0,$5,$6,$7)`,
      [DOCS, META.mint, market.pool, CREATOR_FEE, more.launcherAmount, more.accumulatorAmount, POLICY_VERSION])
      curve.dbc_creator = CREATOR_FEE
      assert.deepEqual((await runStockExecution({ collections, listMarkets, execute: true })).collections.map(i => i.status), ['SETTLED'])
      state.crash = true
      await assert.rejects(payouts.pay({ repoId: DOCS }), /crash/)
      const { rows: [pending] } = await pool.query(`select id::text, receipt->>'lastValidBlockHeight' as expiry from stock_launcher_payouts where status = 'pending'`)
      chain.finalizedHeight = Number(pending.expiry) + 1
      assert.deepEqual((await payouts.recover({ dryRun: true })).map(r => r.status), ['WOULD_ABORT'])
      assert.deepEqual((await payouts.recover()).map(r => r.status), ['ABORTED'])
      const { rows: [aborted] } = await pool.query(`select status, settled_at, receipt->>'state' as state, receipt->>'reason' as reason from stock_launcher_payouts where id = $1`, [pending.id])
      assert.deepEqual([aborted.status, aborted.settled_at, aborted.state], ['aborted', null, 'aborted'])
      assert.match(aborted.reason, /expired at finalized/)
      chain.finalizedHeight = chain.height
      assert.equal((await ledger()).payable, more.launcherAmount, 'an aborted payout is payable again')
      // A landed payout whose receipt pays another amount: never aborted, one operator alert however often it is seen.
      chain.finalized = (raw, signature) => payoutTransaction(raw, { ...intents.get(signature).terms, amount: '1' })
      const review = await payouts.pay({ repoId: DOCS })
      assert.equal(review.status, 'REVIEW')
      assert.deepEqual((await payouts.recover()).map(r => r.status), ['REVIEW'])
      assert.equal(await count('stock_launcher_payouts', "status = 'pending'"), 1)
      const { rows: alerts } = await pool.query(`select kind, github_repo_id::text as repo, detail::jsonb->>'table' as tbl from graduation_alerts`)
      assert.deepEqual(alerts, [{ kind: 'STOCK_EXECUTION_REVIEW', repo: DOCS, tbl: 'stock_launcher_payouts' }])
    })

    await t.test('the SOL ledgers are untouched', async () => {
      for (const table of ['platform_fee_claims', 'repo_claims', 'fee_events', 'discovery_claims', 'builder_fee_credits']) {
        assert.equal(await count(table), 0, `${table} untouched`)
      }
    })
  } finally {
    await pool?.end()
    if (created) await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.end()
  }
})
