import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { POLICY_VERSION, dammCheckpoint, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { STOCK_RECONCILE_ALERT, STOCK_RECONCILE_REASONS as R, createStockChainReads, createStockReconcileRunner, createStockReconciler,
  stockChainAheadOfLedger } from '../src/stock-reconcile.mjs'
import { readMarketLauncherLedger, walletStockLauncherEarnings } from '../src/stock-launcher-earnings.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { createBuilderReminders } from '../src/builder-reminders.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { readFileSync } from 'node:fs'
import { METAX_MINT, curveConfig, curvePool, dammPool, dammPosition, fakeConnection, key, rpcAccount, startJsonRpc, stockMarket,
  token2022Account } from './fixtures/stock-chain.mjs'

// Stock-pair reconciliation and launcher earnings on real PostgreSQL with every migration (0054's stock ledgers, their checks
// and market triggers): the stock ledgers against chain state encoded with the programs' coders (no validator), operator alerts
// stored where the operations pages read them, launcher earnings, and the partition of every job's market list: SOL markets and
// stock markets together are every indexed market, with no overlap.
const DB = 'repoing_stock_reconcile_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const META = quoteAssetById('meta-xstock'), MSFT = quoteAssetById('msft-xstock')
const HELLO = '1296269', DOCS = '94911145', VSCODE = '41881900', PENDING = '10270250'
const MULTIPLIER = '1.0028515433272898'

let admin, pool
const docs = stockMarket({ repoId: DOCS }), vscode = stockMarket({ repoId: VSCODE, assetId: MSFT.assetId })
const feeClaimer = key(), custody = getAssociatedTokenAddressSync(new PublicKey(META.mint), new PublicKey(feeClaimer), true, TOKEN_2022_PROGRAM_ID).toBase58()
const graduation = { pool: key(), creatorPosition: key(), partnerPosition: key() }
// What the chain holds right now; each test sets what it needs.
const chain = { creatorQuoteFee: 0n, partnerQuoteFee: 0n, migrated: false, creator: { unclaimed: 0n, claimed: 0n }, partner: { unclaimed: 0n, claimed: 0n }, custody: 0n }
const accounts = new Map([
  [docs.pool, () => curvePool({ config: docs.config, creator: docs.creatorWallet, baseMint: docs.mint, creatorQuoteFee: chain.creatorQuoteFee,
    partnerQuoteFee: chain.partnerQuoteFee, migrated: chain.migrated })],
  [docs.config, () => curveConfig({ quoteMint: METAX_MINT, feeClaimer })],
  [graduation.pool, () => dammPool({ tokenAMint: docs.mint, tokenBMint: METAX_MINT })],
  [graduation.creatorPosition, () => dammPosition({ pool: graduation.pool, ...chain.creator })],
  [graduation.partnerPosition, () => dammPosition({ pool: graduation.pool, ...chain.partner })],
  [custody, () => token2022Account({ mint: METAX_MINT, owner: feeClaimer, amount: chain.custody })]])
// microsoft/vscode's pool and config are behind a failing RPC: its reads are unavailable, never a mismatch.
const connection = fakeConnection(accounts, { fail: address => address === vscode.pool || address === vscode.config })
const reconciler = () => createStockReconciler({ pool, config: key(), stockConfigs: new Map([['meta-xstock', new PublicKey(docs.config)], ['msft-xstock', new PublicKey(vscode.config)]]),
  reads: createStockChainReads({ connection }) })

let feeIndex = 0
async function recordCurveFee(creatorAmount, partnerAmount) {
  const split = splitCurveFee({ creatorAmount, partnerAmount })
  await pool.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,
    launcher_amount,accumulator_amount,policy_version) values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11)`, [DOCS, META.assetId, META.mint, docs.pool,
    `FeeSig${++feeIndex}`, 100 + feeIndex, String(creatorAmount), String(partnerAmount), String(split.launcherAmount), String(split.accumulatorAmount), POLICY_VERSION])
  return split
}
const settle = (table, extra) => `insert into ${table}(github_repo_id,asset_id,quote_mint,${extra.columns},status,signature,receipt,settled_at)
  values ($1,$2,$3,${extra.values},'settled',$${extra.next},'{}',now())`

test.before(async () => {
  assert.equal(process.env.DATABASE_URL, URL_, 'a dedicated disposable database')
  admin = new pg.Pool({ connectionString: URL_.replace(`/${DB}`, '/postgres') })
  await admin.query(`drop database if exists ${DB} with (force)`)
  await admin.query(`create database ${DB}`)
  pool = new pg.Pool({ connectionString: URL_ })
  await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
    (${HELLO},'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,now()),
    (${DOCS},'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,now()),
    (${VSCODE},'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,now()),
    (${PENDING},'facebook','react','facebook/react',null,null,240000,49000,false,now())`)
  const insert = `insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version)
    values ($1,'confirmed',$2,$3,$4,$5,'Token','TOKEN',$6,'Hash',100,10,'finalized',now(),now(),$7,$8,$9)`
  await pool.query(insert, [HELLO, 'MintHello', 'PoolHello', 'LauncherHello', 'CreatorHello', 'LaunchHello', null, null, null])
  for (const market of [docs, vscode]) await pool.query(insert, [market.repoId, market.mint, market.pool, market.launcherWallet, market.creatorWallet,
    `Launch${market.repoId}`, market.quoteAssetId, market.quoteMint, 1])
  // A stock launch that was sent and not indexed yet: no job reconciles it.
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,quote_asset_id,quote_mint,quote_registry_version) values ($1,'submitted','MintReact','PoolReact','LauncherReact','CreatorReact','React','REACT','LaunchReact','Hash',100,$2,$3,1)`,
  [PENDING, META.assetId, META.mint])
})
test.after(async () => {
  await globalThis.__gitfunPool?.end()
  delete globalThis.__gitfunPool
  await pool?.end()
  await admin?.query(`drop database if exists ${DB} with (force)`)
  await admin?.end()
})

test('curve fees: the ledger minus settled collections against the pool, with the indexer\'s lag tolerated and a real gap not', async () => {
  const a = await recordCurveFee(10_000_000n, 4_084_507n), b = await recordCurveFee(20_000_000n, 8_169_014n)
  await pool.query(settle('stock_fee_collections', { columns: 'source,reviewed_amount,actual_amount,launcher_amount,accumulator_amount,terms_hash',
    values: "'dbc_creator',$4,$4,$5,$6,repeat('c',64)", next: 7 }), [DOCS, META.assetId, META.mint, '10000000', String(a.launcherAmount),
    String(10_000_000n - a.launcherAmount), 'CollectSig1'])
  Object.assign(chain, { creatorQuoteFee: 20_000_000n, partnerQuoteFee: 12_253_521n })
  let result = await reconciler().reconcile(DOCS)
  assert.equal(result.status, 'MATCH')
  assert.deepEqual([result.curve.creator.ledgerEarned, result.curve.creator.ledgerCollected, result.curve.partner.expectedRemaining], [30_000_000n, 10_000_000n, 12_253_521n])
  // A trade lands; its fee is on-chain before the indexer records it.
  chain.creatorQuoteFee += 5_000_000n; chain.partnerQuoteFee += 2_042_253n
  result = await reconciler().reconcile(DOCS)
  assert.deepEqual([result.status, result.curve.creator.difference, stockChainAheadOfLedger(result)], ['MISMATCH', 5_000_000n, true])
  await recordCurveFee(5_000_000n, 2_042_253n)
  assert.equal((await reconciler().reconcile(DOCS)).status, 'MATCH')
  // A recorded fee the pool never had: no lag explains it.
  await recordCurveFee(1_000n, 0n)
  result = await reconciler().reconcile(DOCS)
  assert.deepEqual([result.status, result.curve.creator.difference, stockChainAheadOfLedger(result)], ['MISMATCH', -1_000n, false])
  await pool.query("delete from stock_fee_events where signature = $1", [`FeeSig${feeIndex}`])
  assert.ok(b.launcherAmount > 0n)
})

test('graduated positions: latest checkpoints and settled collections against the DAMM positions', async () => {
  chain.migrated = true
  assert.deepEqual([(await reconciler().reconcile(DOCS)).reason, stockChainAheadOfLedger(await reconciler().reconcile(DOCS))], [R.GRADUATION_NOT_RECORDED, true])
  await pool.query(`insert into stock_graduation_events(github_repo_id,asset_id,quote_mint,dbc_pool,damm_pool,migration_signature,slot,creator_position,partner_position,evidence)
    values ($1,$2,$3,$4,$5,'MigrateSig',500,$6,$7,'{}')`, [DOCS, META.assetId, META.mint, docs.pool, graduation.pool, graduation.creatorPosition, graduation.partnerPosition])
  const checkpoint = async (side, position, slot, cumulativeEarned, previous) => {
    const c = dammCheckpoint({ side, cumulativeEarned, previous })
    await pool.query(`insert into stock_damm_fee_checkpoints(github_repo_id,asset_id,quote_mint,damm_pool,side,position,slot,cumulative_earned,cumulative_claimed,credit,
      launcher_cumulative,launcher_credit,accumulator_credit,policy_version) values ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13)`, [DOCS, META.assetId, META.mint,
      graduation.pool, side, position, slot, String(cumulativeEarned), String(c.credit), String(c.launcherCumulative), String(c.launcherCredit), String(c.accumulatorCredit), POLICY_VERSION])
    return { cumulativeEarned, launcherCumulative: c.launcherCumulative, side, policyVersion: POLICY_VERSION }
  }
  const first = await checkpoint('creator', graduation.creatorPosition, 600, 3_000_000n, null)
  await checkpoint('creator', graduation.creatorPosition, 700, 7_000_000n, first)
  await checkpoint('partner', graduation.partnerPosition, 700, 2_000_000n, null)
  await pool.query(settle('stock_fee_collections', { columns: 'source,reviewed_amount,actual_amount,launcher_amount,accumulator_amount,terms_hash',
    values: "'damm_creator',$4,$4,$5,$6,repeat('d',64)", next: 7 }), [DOCS, META.assetId, META.mint, '1000000', '301810', '698190', 'CollectSig2'])
  Object.assign(chain, { creator: { unclaimed: 6_000_000n, claimed: 1_000_000n }, partner: { unclaimed: 2_000_000n, claimed: 0n } })
  let result = await reconciler().reconcile(DOCS)
  assert.equal(result.status, 'MATCH')
  assert.deepEqual([result.graduated.pool, result.graduated.creator.ledgerEarned, result.graduated.creator.onchainClaimed], [graduation.pool, 7_000_000n, 1_000_000n])
  chain.partner = { unclaimed: 2_500_000n, claimed: 0n }
  result = await reconciler().reconcile(DOCS)
  assert.deepEqual([result.status, stockChainAheadOfLedger(result)], ['MISMATCH', true], 'an unrecorded checkpoint is lag')
  chain.partner = { unclaimed: 0n, claimed: 2_000_000n }
  result = await reconciler().reconcile(DOCS)
  assert.deepEqual([result.status, result.graduated.partner.claimedDifference, stockChainAheadOfLedger(result)], ['MISMATCH', 2_000_000n, false],
    'partner fees claimed with no collection recorded')
  chain.partner = { unclaimed: 2_000_000n, claimed: 0n }
})

test('custody: settled collections minus settled launcher payouts minus settlement spends equal the fee claimer\'s METAx account', async () => {
  await pool.query(settle('stock_launcher_payouts', { columns: 'wallet,amount', values: '$4,$5', next: 6 }), [DOCS, META.assetId, META.mint, docs.launcherWallet, '1000000', 'PayoutSig1'])
  await assert.rejects(pool.query(settle('stock_launcher_payouts', { columns: 'wallet,amount', values: '$4,$5', next: 6 }),
    [DOCS, META.assetId, META.mint, key(), '1', 'PayoutSig2']), /launcher wallet/, 'a payout goes only to the launcher')
  await pool.query(`insert into stock_settlement_receipts(asset_id,quote_mint,kind,signature,quote_spent,repoing_spent,repoing_received,evidence)
    values ($1,$2,'swap','SettleSig1',2000000,0,123456789,'{}')`, [META.assetId, META.mint])
  // 10 000 000 + 1 000 000 collected, 1 000 000 paid to the launcher, 2 000 000 spent in settlement.
  chain.custody = 8_000_000n
  let result = await reconciler().reconcileStockCustody('meta-xstock')
  assert.deepEqual([result.status, result.wallet, result.account, result.expected], ['MATCH', feeClaimer, custody, 8_000_000n])
  chain.custody = 7_999_000n
  result = await reconciler().reconcileStockCustody('meta-xstock')
  assert.deepEqual([result.status, result.reason, result.difference], ['MISMATCH', R.CUSTODY_SHORTFALL, -1_000n])
  await pool.query(`insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status) values ($1,$2,$3,$4,500,'pending')`,
    [DOCS, META.assetId, META.mint, docs.launcherWallet])
  assert.equal((await reconciler().reconcileStockCustody('meta-xstock')).status, 'PENDING_REVIEW', 'a payout in flight')
  await pool.query("update stock_launcher_payouts set status = 'aborted' where status = 'pending'")
  chain.custody = 8_000_000n
})

test('launcher earnings from the ledgers: earned on the curve and after graduation, collected, paid, pending, payable', async () => {
  const { rows: [sums] } = await pool.query(`select (select sum(launcher_amount) from stock_fee_events where github_repo_id = $1)::text as curve,
    (select sum(launcher_credit) from stock_damm_fee_checkpoints where github_repo_id = $1)::text as graduated`, [DOCS])
  const row = await readMarketLauncherLedger(pool, DOCS)
  assert.deepEqual([row.curveEarned, row.graduatedEarned, row.collected, row.paid, row.pending], [sums.curve, sums.graduated,
    String(splitCurveFee({ creatorAmount: 10_000_000n, partnerAmount: 0n }).launcherAmount + 301_810n), '1000000', '0'])
  assert.equal(await readMarketLauncherLedger(pool, HELLO), null, 'a SOL market has no stock launcher earnings')
  assert.equal(await readMarketLauncherLedger(pool, PENDING), null, 'nor does a stock launch not indexed yet')
  const [view] = await walletStockLauncherEarnings(pool, connection, docs.launcherWallet, { read: async () => MULTIPLIER })
  const earned = BigInt(sums.curve) + BigInt(sums.graduated)
  assert.deepEqual([view.repoId, view.raw.earned, view.raw.payable, view.asset.symbol], [DOCS, String(earned), String(BigInt(row.collected) - 1_000_000n), 'METAx'])
  assert.equal(view.shown.earned, String(earned * 10028515433272898n / 10n ** 16n))
  assert.deepEqual(await walletStockLauncherEarnings(pool, connection, 'LauncherHello'), [], 'SOL launches are not stock launcher earnings')
})

test('runner: real mismatches are stored as RECONCILIATION_MISMATCH operator alerts, once; the market list is the indexed stock markets', async () => {
  const runner = createStockReconcileRunner({ pool, reconciler: reconciler() })
  let run = await runner.runOnce()
  assert.deepEqual(run.markets.map(market => market.repoId), [VSCODE, DOCS].sort(), 'indexed stock markets only: not the SOL market, not an unindexed launch')
  assert.deepEqual(run.custody.map(item => item.assetId), ['meta-xstock', 'msft-xstock'])
  const docsRun = run.markets.find(market => market.repoId === DOCS)
  assert.deepEqual([docsRun.status, docsRun.alert], ['MATCH', null])
  const vscodeRun = run.markets.find(market => market.repoId === VSCODE)
  assert.equal(vscodeRun.status, 'UNAVAILABLE', 'its pool is not on this chain: unavailable, held before it alerts')
  chain.creatorQuoteFee -= 1n
  run = await runner.runOnce()
  assert.ok(run.markets.find(market => market.repoId === DOCS).alert)
  await runner.runOnce()
  const { rows } = await pool.query(`select kind, github_repo_id::text as "repoId", detail from graduation_alerts where acknowledged_at is null order by id`)
  assert.equal(rows.length, 1, 'one alert for one mismatch')
  assert.deepEqual([rows[0].kind, rows[0].repoId, JSON.parse(rows[0].detail).ledger, JSON.parse(rows[0].detail).result.curve.creator.difference],
    [STOCK_RECONCILE_ALERT, DOCS, 'stock', '-1'])
  // The operations health page's alert summary reads it like any SOL reconciliation alert.
  const { rows: summary } = await pool.query(`select kind, count(*)::int as count from graduation_alerts where acknowledged_at is null group by kind`)
  assert.deepEqual(summary, [{ kind: 'RECONCILIATION_MISMATCH', count: 1 }])
  chain.creatorQuoteFee += 1n
})

test('partition: SOL jobs keep SOL markets, stock jobs take stock markets, together every indexed market and never both', async () => {
  const { rows: indexed } = await pool.query(`select github_repo_id::text as id from markets where status = 'confirmed' and indexed_at is not null
    and launch_finality = 'finalized' order by 1`)
  const { rows: stock } = await pool.query(`select github_repo_id::text as id from markets where quote_asset_id is not null and status = 'confirmed'
    and indexed_at is not null and launch_finality = 'finalized' order by 1`)
  // Builder reminders: a maintainer bound to a SOL market and a stock market is reconciled and emailed for the SOL one only.
  await pool.query(`insert into builder_reminders(github_user_id,email,revision,verified_at,next_check_at) values (583231,'maintainer@example.com',$1,now(),now())`, ['r'.repeat(32)])
  for (const id of indexed.map(row => row.id)) await pool.query(`insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values ($1,583231,$2)`, [id, `Wallet${id}`])
  const reconciled = [], sent = []
  const reminders = createBuilderReminders({ pool, secret: 's'.repeat(32), origin: 'https://repo.ing', send: async message => { sent.push(message); return 'id' },
    reconcile: async repoId => { reconciled.push(repoId); return { status: 'MATCH', onchainCreatorFee: 100_000_000n, recordedEarned: 100_000_000n } } })
  assert.deepEqual(await reminders.runOnce(), { status: 'CHECKED', accepted: 1, failed: 0 })
  assert.deepEqual(reconciled, [HELLO])
  assert.ok(sent[0].text.includes('octocat/Hello-World: 0.1 SOL'))
  assert.doesNotMatch(sent[0].text, /docusaurus|vscode/)
  const sol = indexed.map(row => row.id).filter(id => reconciled.includes(id))
  assert.deepEqual([...sol, ...stock.map(row => row.id)].sort(), indexed.map(row => row.id), 'SOL + stock = every indexed market')
  assert.equal(sol.filter(id => stock.some(row => row.id === id)).length, 0, 'no overlap')
  // Each side's reconciler refuses the other side's markets.
  await assert.rejects(createReconciler({ pool, connection, config: docs.config }).reconcile(DOCS), /Stock-paired market needs a quote-aware path/)
  await assert.rejects(reconciler().reconcile(HELLO), /SOL market is reconciled by src\/reconcile\.mjs/)
  assert.equal((await pool.query('select count(*)::int as n from fee_events')).rows[0].n, 0, 'no stock fee ever reached a SOL ledger')
})

test('/wallet of a stock launcher: its earnings in the stock and no builder claim; unreadable earnings say so, nothing else breaks', async () => {
  // The route builds its own connection from SOLANA_RPC_URL: no SOL, no token accounts, and the METAx mint for display units.
  const metax = JSON.parse(readFileSync(new URL('./fixtures/metax-mint.json', import.meta.url), 'utf8'))
  const rpc = await startJsonRpc({ getBalance: () => ({ context: { slot: 1 }, value: 0 }), getTokenAccountsByOwner: () => ({ context: { slot: 1 }, value: [] }),
    getAccountInfo: ([address]) => ({ context: { slot: 1 }, value: address === META.mint ? rpcAccount({ data: Buffer.from(metax.data, 'base64'), owner: metax.owner }) : null }) })
  const saved = { rpc: process.env.SOLANA_RPC_URL, fetch: globalThis.fetch }
  process.env.SOLANA_RPC_URL = rpc.url
  globalThis.fetch = async (input, init) => /^http:\/\/127\.0\.0\.1:/.test(String(input?.url ?? input)) ? saved.fetch(input, init) : Promise.reject(new TypeError('offline test'))
  try {
    const { GET } = await import('../app/api/wallet/overview/route.js')
    const overview = async wallet => { const response = await GET({ url: `https://repo.ing/api/wallet/overview?wallet=${wallet}` }); return { status: response.status, body: await response.json() } }
    const { rows: [sums] } = await pool.query(`select (select sum(launcher_amount) from stock_fee_events where github_repo_id = $1)
      + (select sum(launcher_credit) from stock_damm_fee_checkpoints where github_repo_id = $1) as earned`, [DOCS])
    let { status, body } = await overview(docs.launcherWallet)
    assert.equal(status, 200)
    const [launched] = body.markets
    assert.deepEqual([launched.repoId, launched.stockPair, launched.builderWallet, launched.stockLauncher.raw.earned], [DOCS, true, false, String(sums.earned)])
    assert.deepEqual(body.stockLauncher.totals.map(total => [total.asset.symbol, total.raw.earned, total.markets]), [['METAx', String(sums.earned), 1]])
    assert.ok(body.stockLauncher.totals[0].shown, 'shown in METAx units')
    await pool.query('drop table stock_launcher_payouts cascade')
    ;({ status, body } = await overview(docs.launcherWallet))
    assert.equal(status, 200, 'the overview still answers')
    assert.deepEqual([body.stockLauncher, body.markets[0].stockPair, body.markets[0].builderWallet], [null, true, false])
  } finally {
    process.env.SOLANA_RPC_URL = saved.rpc; if (saved.rpc === undefined) delete process.env.SOLANA_RPC_URL
    globalThis.fetch = saved.fetch
    await rpc.close()
  }
})
