import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { POLICY_VERSION, dammCheckpoint, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { stockAccumulator } from '../src/stock-accumulator.mjs'
import { createStockCollections } from '../src/stock-collections.mjs'
import { launcherEarnings, readMarketLauncherLedger } from '../src/stock-launcher-earnings.mjs'
import { STOCK_EXECUTION_ERRORS as E, STOCK_ABORT_MARGIN_BLOCKS } from '../src/stock-execution.mjs'
import { STOCK_COLLECTION_SOURCES } from '../src/stock-collections.mjs'
import { createStockFeeAccrual } from '../src/stock-fee-accrual.mjs'
import { createStockExecutionStore } from '../src/stock-execution-store.mjs'
import { createStockCollectionExecutor } from '../src/stock-collection-execution.mjs'
import { createStockLauncherPayouts } from '../src/stock-launcher-payouts.mjs'
import { runStockExecution } from '../src/stock-execution-job.mjs'
import { listStockMarkets } from '../src/stock-collections.mjs'
import { META, address, collectionTransaction, curveReceipt, fakeChain, finalizedTransaction, loadFrom, offlinePrograms,
  payoutTransaction, usableMint } from './fixtures/stock-execution-fakes.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Stock fee collections and launcher payouts on PostgreSQL (migration 0054's tables, indexes and triggers), with PR-E's real
// collection previews (src/stock-collections.mjs) over the real stock ledgers and PR-D's real launcher ledger
// (src/stock-launcher-earnings.mjs). Only the chain is in-process (tests/fixtures/stock-execution-fakes.mjs): the reader reports
// what the curve holds, and sent transactions land as finalized receipts.
const DB = 'repoing_stock_execution_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const ON = { STOCK_COLLECTIONS_EXECUTION_ENABLED: 'true', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'true' }
const DOCS = '94911145', HELLO = '1296269', REACT = '10270250'
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

    // The pools as the reader sees them: DOCUSAURUS's curve, and later facebook/react's graduated pool. A landed collection empties
    // its side, as the program's claim does; a position claim takes everything accrued, the review plus any excess that raced it.
    const curve = { dbc_creator: CREATOR_FEE, dbc_partner: PARTNER_FEE }
    const dbc = { pool: market.pool, config: address(), baseVault: address(), quoteVault: address() }
    const grad = { mint: address(), curve: address(), pool: address(), creatorPosition: address(), partnerPosition: address(), tokenAVault: address(),
      tokenBVault: address(), launcherWallet: Keypair.generate().publicKey.toBase58(), uncollected: 0n, claimed: 0n }
    const nft = { [grad.creatorPosition]: address(), [grad.partnerPosition]: address() }
    const position = (address_, owner, uncollected, claimed) => ({ position: address_, nftAccount: nft[address_], owner, uncollected, claimed })
    const reader = { local: true, programs: offlinePrograms(),
      readMarket: async m => (m.repoId === REACT ? { asset: META, slot: 4242, verified: false,
        dbc: { ...dbc, pool: grad.curve, creator: m.creatorWallet, feeClaimer: custody, isMigrated: true, creatorFee: 0n, partnerFee: 0n },
        damm: { pool: grad.pool, tokenAVault: grad.tokenAVault, tokenBVault: grad.tokenBVault,
          creator: position(grad.creatorPosition, m.creatorWallet, grad.uncollected, grad.claimed), partner: position(grad.partnerPosition, custody, 0n, 0n) } }
        : { asset: META, slot: 4242, verified: false, damm: null,
          dbc: { ...dbc, creator: market.creatorWallet, feeClaimer: custody, isMigrated: false, creatorFee: curve.dbc_creator, partnerFee: curve.dbc_partner } }) }
    const previews = createStockCollections({ pool, reader, custody })
    const intents = new Map()
    const state = { crash: false, excess: 0n }
    const landed = (raw, signature) => {
      const intent = intents.get(signature)
      if (intent?.kind === 'payout') return payoutTransaction(raw, intent.terms)
      if (intent?.kind !== 'collection') return finalizedTransaction(raw)
      const received = BigInt(intent.terms.amount) + (intent.terms.source.startsWith('damm_') ? state.excess : 0n)
      if (intent.terms.source === 'damm_creator') { grad.claimed += received; grad.uncollected = 0n }
      else curve[intent.terms.source] = 0n
      return collectionTransaction(raw, intent.terms, received)
    }
    const chain = fakeChain({ finalized: landed })
    const receipt = ({ terms, signature }) => (terms.source.startsWith('damm_') && state.excess
      ? { ...curveReceipt(terms, signature), amount: String(BigInt(terms.amount) + state.excess), excess: String(state.excess) } : curveReceipt(terms, signature))
    const hooks = { afterIntent: async row => {
      intents.set(row.signature, row.receipt)
      if (state.crash) { state.crash = false; throw Error('crash after the intent was stored') }
    } }
    const loads = []
    const loadSigner = role => { loads.push(role); return role === 'creator' ? creator : partner }
    // Whether any advisory lock is held in this test's database while a transaction is followed to finality, or while a key is
    // read: none may be (the lock is taken after the key is read, released after the first send, and taken again only to settle).
    const lockSeen = []
    const advisoryLocks = async () => (await pool.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted
      and database = (select oid from pg_database where datname = current_database())`)).rows[0].n
    const follow = { now: chain.follow.now, sleep: async ms => { lockSeen.push(await advisoryLocks()); await chain.follow.sleep(ms) } }
    // Graduated-pool sources opted in (the operator script's --damm), for the DAMM race below.
    const collections = createStockCollectionExecutor({ pool, connection: chain.connection, config: null, env: ON, custody, partner: custody,
      previewMarket: m => previews.previewMarket(m), checkReceipt: receipt, loadTransaction: loadFrom,
      loadSigner, mintCheck: async () => ({ ok: true }), follow, hooks, sources: STOCK_COLLECTION_SOURCES })
    const payouts = createStockLauncherPayouts({ pool, connection: chain.connection, env: ON, custody, loadTransaction: loadFrom, loadSigner,
      mintCheck: usableMint, custodyBalance: async () => chain.custodyBalance, follow, hooks })
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
      // The pass reads the key (the operator script's Keychain read) before it takes the market's lock: no lock is held then.
      const prepared = []
      const prepareSigner = async role => { prepared.push([role, await advisoryLocks()]) }
      const pass = await runStockExecution({ collections, listMarkets, execute: true, prepareSigner })
      assert.deepEqual(pass.collections.map(i => [i.source, i.status]), [['dbc_partner', 'SETTLED']])
      assert.deepEqual(prepared, [['partner', 0]], 'no advisory lock was held while the key was read')
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
      // The market's lock is the stock reconciliation's own (src/stock-reconcile.mjs: pg_advisory_lock(github_repo_id)): while
      // it holds the market, a payout waits, so the reconciliation never reads a half-settled payout.
      const holder = await pool.connect()
      let waiting
      try {
        await holder.query('select pg_advisory_lock($1::bigint)', [DOCS])
        waiting = payouts.pay({ repoId: DOCS })
        let blocked = 0
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (await pool.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted
            and classid = 0 and objid = $1 and objsubid = 1`, [Number(DOCS)])).rows[0].n
          if (!blocked) await new Promise(resolve => setTimeout(resolve, 50))
        }
        assert.equal(blocked, 1, 'the payout waits on the lock the reconciliation holds')
        await holder.query('select pg_advisory_unlock($1::bigint)', [DOCS])
      } finally { holder.release() }
      assert.equal((await waiting).status, 'IN_FLIGHT')
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
      // Expired, but the deciding RPC (here the primary: no verification RPC on a local validator) is not yet past the margin.
      chain.finalizedHeight = Number(pending.expiry) + Number(STOCK_ABORT_MARGIN_BLOCKS)
      assert.deepEqual((await payouts.recover()).map(r => r.status), ['WAITING'])
      chain.finalizedHeight += 1
      assert.deepEqual((await payouts.recover({ dryRun: true })).map(r => r.status), ['WOULD_ABORT'])
      assert.deepEqual((await payouts.recover()).map(r => r.status), ['ABORTED'])
      const { rows: [aborted] } = await pool.query(`select status, settled_at, receipt->>'state' as state, receipt->>'reason' as reason from stock_launcher_payouts where id = $1`, [pending.id])
      assert.deepEqual([aborted.status, aborted.settled_at, aborted.state], ['aborted', null, 'aborted'])
      assert.match(aborted.reason, /expired \d+ blocks ago at finalized/)
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

    await t.test('the DAMM race: a position claim that took more than its review settles by the checkpoint rule, payouts wait for the checkpoint, nothing is credited twice', async () => {
      chain.finalized = landed
      const E = 20_000_000n, x = 12_345n, y = 3_000_000n, share = value => value * 150n / 497n
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
        values (${REACT},'facebook','react','facebook/react',240000,49000,false,now())`)
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
          last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version)
        values ($1,'confirmed',$2,$3,$4,$5,'React','REACT','LaunchReact','Hash',100,12,'finalized',now(),now(),'meta-xstock',$6,1)`,
      [REACT, grad.mint, grad.curve, grad.launcherWallet, market.creatorWallet, META.mint])
      await pool.query(`insert into stock_graduation_events(github_repo_id,asset_id,quote_mint,dbc_pool,damm_pool,migration_signature,slot,creator_position,
        partner_position,evidence) values ($1,'meta-xstock',$2,$3,$4,'MigrateReact',90,$5,$6,'{}')`, [REACT, META.mint, grad.curve, grad.pool, grad.creatorPosition, grad.partnerPosition])
      // PR-B's checkpoints of the creator position (src/stock-graduation.mjs): cumulative earnings, each crediting its growth.
      let last = null
      const checkpoint = async (slot, cumulative) => {
        const c = dammCheckpoint({ side: 'creator', cumulativeEarned: cumulative, previous: last === null ? null : { cumulativeEarned: last } })
        await pool.query(`insert into stock_damm_fee_checkpoints(github_repo_id,asset_id,quote_mint,damm_pool,side,position,slot,cumulative_earned,
          cumulative_claimed,credit,launcher_cumulative,launcher_credit,accumulator_credit,policy_version) values ($1,'meta-xstock',$2,$3,'creator',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [REACT, META.mint, grad.pool, grad.creatorPosition, slot, cumulative, grad.claimed, c.credit, c.launcherCumulative, c.launcherCredit, c.accumulatorCredit, POLICY_VERSION])
        last = cumulative
      }
      const gradMarket = async () => (await listMarkets({ repoId: REACT }))[0]
      const earnings = async () => launcherEarnings(await readMarketLauncherLedger(pool, REACT))
      grad.uncollected = E
      await checkpoint(100, E)
      const planned = (await collections.plan(await gradMarket())).find(item => item.source === 'damm_creator')
      assert.deepEqual([planned.status, planned.amount, planned.launcherAmount], ['MATCH', String(E), String(share(E))])
      // Without the opt-in the same source is held back: graduated-pool collections are off by default.
      const defaults = createStockCollectionExecutor({ pool, connection: chain.connection, config: null, env: ON, custody, partner: custody,
        previewMarket: m => previews.previewMarket(m) })
      assert.equal((await defaults.plan(await gradMarket())).find(item => item.source === 'damm_creator').status, 'NOT_ENABLED')
      // Trades land between the preview and the claim: the claim takes x more than reviewed.
      state.excess = x
      const settled = await collections.collect({ repoId: REACT, source: 'damm_creator', termsHash: planned.termsHash })
      state.excess = 0n
      assert.deepEqual([settled.status, settled.amount, settled.launcherAmount], ['SETTLED', String(E + x), String(share(E + x))])
      const { rows: [row] } = await pool.query(`select reviewed_amount::text, actual_amount::text, launcher_amount::text, accumulator_amount::text
        from stock_fee_collections where github_repo_id = $1`, [REACT])
      assert.deepEqual(row, { reviewed_amount: String(E), actual_amount: String(E + x), launcher_amount: String(share(E + x)),
        accumulator_amount: String(E + x - share(E + x)) }, 'launcher + accumulator = the amount received')
      // Until PR-B's next checkpoint credits the excess, the launcher has collected more than the ledger says they earned: payouts
      // wait, quietly, without a key.
      await assert.rejects(earnings(), /collections exceed launcher earnings/)
      const before = loads.length
      assert.deepEqual([(await payouts.plan(await gradMarket())).status, (await payouts.pay({ repoId: REACT })).status], ['WAITING', 'WAITING'])
      assert.equal(loads.length, before)
      // The checkpoint after the claim records the cumulative it reached: earned catches up with collected exactly.
      await checkpoint(5000, E + x)
      assert.deepEqual([(await earnings()).earned, (await earnings()).collected], [share(E + x), share(E + x)])
      const paid = await payouts.pay({ repoId: REACT })
      assert.deepEqual([paid.status, paid.amount], ['SETTLED', String(share(E + x))])
      // More trading: the next checkpoint and collection take exactly the growth, with the launcher's part the running total's.
      grad.uncollected = y
      await checkpoint(6000, E + x + y)
      const next = (await collections.plan(await gradMarket())).find(item => item.source === 'damm_creator')
      assert.deepEqual([next.status, next.amount, next.launcherAmount], ['MATCH', String(y), String(share(E + x + y) - share(E + x))])
      assert.equal((await collections.collect({ repoId: REACT, source: 'damm_creator', termsHash: next.termsHash })).status, 'SETTLED')
      const total = await earnings()
      assert.deepEqual([total.earned, total.collected, total.paid], [share(E + x + y), share(E + x + y), share(E + x)], 'nothing credited twice')
      const summary = await stockAccumulator(pool, 'meta-xstock')
      assert.deepEqual(summary.problems.filter(problem => problem.includes(REACT)), [])
      const { rows: [sums] } = await pool.query(`select sum(actual_amount)::text as actual, sum(launcher_amount + accumulator_amount)::text as parts
        from stock_fee_collections where github_repo_id = $1 and status = 'settled'`, [REACT])
      assert.deepEqual(sums, { actual: String(E + x + y), parts: String(E + x + y) })
    })

    await t.test('no lock was held while a transaction was followed to finality', () => {
      assert.ok(lockSeen.length >= 5, `followed ${lockSeen.length} times`)
      assert.deepEqual([...new Set(lockSeen)], [0])
    })

    await t.test("a web trade-confirm's stock fee accrual waits a bounded time for the market's lock, never indefinitely", async () => {
      const accrual = createStockFeeAccrual({ pool, connection: chain.connection, config: address(), dbc: {}, lockTimeoutMs: 300 })
      const holder = await pool.connect()
      try {
        await holder.query('select pg_advisory_lock($1::bigint)', [DOCS])
        assert.equal(await advisoryLocks(), 1, "the lock probe sees a lock that is held")
        const started = Date.now()
        await assert.rejects(accrual.recordTradeFees({ githubRepoId: DOCS, signatures: ['Sig'] }), { code: 'STOCK_FEE_LOCK_BUSY' })
        assert.ok(Date.now() - started < 5_000, 'gave up after its timeout')
      } finally {
        await holder.query('select pg_advisory_unlock($1::bigint)', [DOCS]).catch(() => {})
        holder.release()
      }
      // Free, it takes the lock (then fails here, with no stock config registered) and gives it back.
      await assert.rejects(accrual.recordTradeFees({ githubRepoId: DOCS, signatures: ['Sig'] }), error => error.code !== 'STOCK_FEE_LOCK_BUSY')
      assert.equal(await advisoryLocks(), 0)
    })

    await t.test('the SOL ledgers are untouched', async () => {
      for (const table of ['platform_fee_claims', 'repo_claims', 'fee_events', 'discovery_claims', 'builder_fee_credits']) {
        assert.equal(await count(table), 0, `${table} untouched`)
      }
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, DB)
    await admin.end()
  }
})
