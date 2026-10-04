import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Connection, Keypair } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { listPlatformFees } from '../src/platform-fee-operations.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { POLICY_VERSION, dammCheckpoint, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { stockAccumulator } from '../src/stock-accumulator.mjs'
import { STOCK_FEE_CUSTODY, createStockCollections, listStockMarkets } from '../src/stock-collections.mjs'
import { activeCanonicalPool, registerCanonicalPool } from '../src/stock-canonical-pools.mjs'
import { recordStockSettlementReceipt } from '../src/stock-settlement.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'

// The stock accumulator, collection previews, canonical pool registry and settlement receipts on real PostgreSQL with
// migration 0054 (docs/STOCK_QUOTES.md, "Accumulator and settlement"). The chain side of a preview is a stub here
// (tests/stock-accumulator-chain.test.mjs reads real pools); the ledgers, their sums and every refusal are real.
const DB = 'repoing_stock_accumulator_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const META = quoteAssetById('meta-xstock'), MSFT = quoteAssetById('msft-xstock')
const key = () => Keypair.generate().publicKey.toBase58()
// SOL: Hello-World (indexed), World (confirmed, not indexed), React (failed). METAx: Docusaurus (indexed, graduated), Jest
// (indexed). MSFTx: VSCode (indexed), TypeScript (confirmed, not indexed).
const HELLO = '1296269', WORLD = '2', REACT = '10270250', DOCS = '94911145', JEST = '15062869', VSCODE = '41881900', TS = '20929025'
const M = Object.fromEntries([DOCS, JEST, VSCODE, TS].map(id => [id, { mint: key(), pool: key(), creator: key(), launcher: key() }]))
// Docusaurus graduated into this DAMM v2 pool with these two positions.
const GRADUATED = { pool: key(), creator: key(), partner: key() }
// SOL markets first, alone; the stock markets and every stock ledger row come after (STOCK_SEED and the tests below).
const SOL_SEED = `
insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values
  (${HELLO},'octocat','Hello-World','octocat/Hello-World',1,1,false,now()), (${WORLD},'octocat','World','octocat/World',1,1,false,now()),
  (${REACT},'facebook','react','facebook/react',1,1,false,now()), (${DOCS},'facebook','docusaurus','facebook/docusaurus',1,1,false,now()),
  (${JEST},'facebook','jest','facebook/jest',1,1,false,now()), (${VSCODE},'microsoft','vscode','microsoft/vscode',1,1,false,now()),
  (${TS},'microsoft','TypeScript','microsoft/TypeScript',1,1,false,now());
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  (${HELLO},'confirmed','MintSol','PoolSol','LauncherSol','CreatorSol','Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now(),null,null,null),
  (${WORLD},'confirmed','MintWorld','PoolWorld','LauncherSol','CreatorSol','World','WORLD','LaunchWorld','Hash',100,null,null,null,null,null,null,null),
  (${REACT},'failed',null,null,'LauncherReact','CreatorReact','React','REACT',null,null,null,null,null,null,null,null,null,null);`
const STOCK_SEED = `
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  ${[[DOCS, META, true], [JEST, META, true], [VSCODE, MSFT, true], [TS, MSFT, false]].map(([id, asset, indexed]) =>
    `(${id},'confirmed','${M[id].mint}','${M[id].pool}','${M[id].launcher}','${M[id].creator}','T${id}','T${id}','Launch${id}','Hash',100,` +
    `${indexed ? `12,'finalized',now(),now()` : 'null,null,null,null'},'${asset.assetId}','${asset.mint}',1)`).join(',\n  ')};`
const indexedRepos = async pool => (await pool.query(`select github_repo_id::text as id from markets
  where status='confirmed' and indexed_at is not null and launch_finality='finalized' order by 1`)).rows.map(r => r.id)

let feeSeq = 0
async function curveFee(pool, repoId, asset, creatorAmount, partnerAmount) {
  const { launcherAmount, accumulatorAmount } = splitCurveFee({ creatorAmount, partnerAmount })
  await pool.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,
    launcher_amount,accumulator_amount,policy_version) values ($1,$2,$3,$4,$5,0,$6,$7,$8,$9,$10,$11)`, [repoId, asset.assetId, asset.mint, M[repoId].pool,
    `FeeSig${++feeSeq}`, 100 + feeSeq, creatorAmount, partnerAmount, launcherAmount, accumulatorAmount, POLICY_VERSION])
  return { launcherAmount, accumulatorAmount }
}
async function checkpoint(pool, repoId, side, cumulativeEarned, previous, slot) {
  const c = dammCheckpoint({ side, cumulativeEarned, previous })
  await pool.query(`insert into stock_damm_fee_checkpoints(github_repo_id,asset_id,quote_mint,damm_pool,side,position,slot,cumulative_earned,
    cumulative_claimed,credit,launcher_cumulative,launcher_credit,accumulator_credit,policy_version) values ($1,'meta-xstock',$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12)`,
  [repoId, META.mint, GRADUATED.pool, side, GRADUATED[side], slot, cumulativeEarned, c.credit, c.launcherCumulative, c.launcherCredit, c.accumulatorCredit, POLICY_VERSION])
  return { ...c, cumulativeEarned: BigInt(cumulativeEarned) }
}
const verifiedPool = (pool, assetId = 'meta-xstock') => ({ assetId, quoteMint: quoteAssetById(assetId).mint, pool, repoingMint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be',
  position: `${pool}-position`, evidence: { pool: { address: pool, sides: { repoing: 'A', stock: 'B' } } } })
const receipt = (signature, quoteSpent, pool = 'CanonicalMeta') => ({ assetId: 'meta-xstock', quoteMint: META.mint, kind: 'add_liquidity', signature,
  quoteSpent: String(quoteSpent), repoingSpent: '5', repoingReceived: '7', evidence: { pool } })

test('stock accumulator, collection previews, canonical pools and settlement receipts on PostgreSQL', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL ?? URL_, URL_, 'a disposable database only')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let pool, created = false
  try {
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 6 })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    // The SOL platform-fee listing as the sweep and the operator panel read it, with every market enrolled and claimable.
    const solListing = async () => JSON.stringify(await listPlatformFees({ pool, review: (id, phase) => `${phase}:${id}`,
      feeService: phase => ({ status: async repoId => ({ enrolled: true, available: phase === 'DBC' ? '5000000' : '0', receiver: `Receiver${repoId}`, state: 'available' }) }) }))
    await pool.query(SOL_SEED)
    const solOnly = await solListing()
    await pool.query(STOCK_SEED)

    await t.test('SOL and stock listings partition the indexed markets: the SOL sweep never sees a stock market', async () => {
      const read = []
      const sol = await listPlatformFees({ pool, feeService: () => ({ status: async repoId => { read.push(repoId); return { enrolled: false } } }) })
      const stock = await listStockMarkets(pool)
      const solIds = sol.map(r => r.repoId).sort(), stockIds = stock.map(r => r.repoId).sort()
      assert.deepEqual(solIds, [HELLO])
      assert.deepEqual(read, [HELLO], 'the sweep reads only SOL markets')
      assert.deepEqual(stockIds, [DOCS, JEST, VSCODE].sort())
      assert.equal(solIds.filter(id => stockIds.includes(id)).length, 0, 'no overlap')
      assert.deepEqual([...solIds, ...stockIds].sort(), await indexedRepos(pool), 'together: every indexed market')
      assert.deepEqual((await listStockMarkets(pool, { assetId: 'msft-xstock' })).map(r => r.repoId), [VSCODE])
      assert.deepEqual((await listStockMarkets(pool, { repoId: JEST })).map(r => [r.repoId, r.quoteAssetId, r.quoteMint]), [[JEST, 'meta-xstock', META.mint]])
      assert.equal(await solListing(), solOnly, 'the SOL listing is byte-identical with the stock markets present')
    })

    // The ledgers as the indexers (PR-A, PR-B) and a later collection would write them.
    const docsFees = [await curveFee(pool, DOCS, META, 7100n, 2900n), await curveFee(pool, DOCS, META, 710n, 290n)]
    const jestFee = await curveFee(pool, JEST, META, 1000n, 500n)
    const vscodeFee = await curveFee(pool, VSCODE, MSFT, 994n, 406n)
    const c1 = await checkpoint(pool, DOCS, 'creator', 4970n, null, 500), c2 = await checkpoint(pool, DOCS, 'creator', 9940n, c1, 600)
    const p1 = await checkpoint(pool, DOCS, 'partner', 4060n, null, 500)
    await pool.query(`insert into stock_graduation_events(github_repo_id,asset_id,quote_mint,dbc_pool,damm_pool,migration_signature,slot,creator_position,
      partner_position,evidence) values ($1,'meta-xstock',$2,$3,$4,'MigrateDocs',450,$5,$6,'{}')`, [DOCS, META.mint, M[DOCS].pool, GRADUATED.pool,
      GRADUATED.creator, GRADUATED.partner])
    const docsCreator = 7810n, docsLauncher = docsFees.reduce((t, f) => t + f.launcherAmount, 0n)
    // Settled rows carry their signature, settlement time and receipt (and a collection its actual amount), as 0054 requires.
    await pool.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,actual_amount,launcher_amount,
      accumulator_amount,terms_hash,status,signature,receipt,settled_at) values ($1,'meta-xstock',$2,'dbc_creator',$3,$3,$4,$5,repeat('c',64),'settled',
      'CollectDocs','{"status":"settled"}',now())`, [DOCS, META.mint, docsCreator, docsLauncher, docsCreator - docsLauncher])
    await pool.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,launcher_amount,accumulator_amount,terms_hash,status)
      values ($1,'meta-xstock',$2,'dbc_partner',500,0,500,repeat('d',64),'pending')`, [JEST, META.mint])
    await pool.query(`insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,signature,receipt,settled_at)
      values ($1,'meta-xstock',$2,$3,1000,'settled','PayDocs','{"status":"settled"}',now())`, [DOCS, META.mint, M[DOCS].launcher])
    const collected = docsCreator - docsLauncher

    await t.test('the accumulator adds every ledger of one stock, and only that stock', async () => {
      const credited = docsFees.reduce((t, f) => t + f.accumulatorAmount, 0n) + jestFee.accumulatorAmount + c1.accumulatorCredit + c2.accumulatorCredit + p1.accumulatorCredit
      const launcher = docsLauncher + jestFee.launcherAmount + c1.launcherCredit + c2.launcherCredit
      const meta = await stockAccumulator(pool, 'meta-xstock')
      assert.equal(meta.status, 'MATCH', meta.problems.join('; '))
      assert.deepEqual(meta.totals, { credited: String(credited), inPools: String(credited - collected), collected: String(collected), spent: '0',
        available: String(collected), launcherCredited: String(launcher), launcherInPools: String(launcher - docsLauncher), collectedLauncher: String(docsLauncher),
        launcherPaid: '1000', owedToLaunchers: String(launcher - 1000n), custodyExpected: String(collected + docsLauncher - 1000n) })
      assert.deepEqual(meta.repositories.map(r => [r.repoId, r.indexed, r.pendingCollections]), [[JEST, true, 1], [DOCS, true, 0]], 'by repository id')
      assert.equal(meta.contributing, 2)
      assert.equal(meta.canonicalPool, null)
      const msft = await stockAccumulator(pool, 'msft-xstock')
      assert.deepEqual([msft.totals.credited, msft.totals.launcherCredited, msft.repositories.map(r => r.repoId)],
        [String(vscodeFee.accumulatorAmount), String(vscodeFee.launcherAmount), [TS, VSCODE]])
      await assert.rejects(stockAccumulator(pool, 'sol'), /Unknown stock asset/)
    })

    await t.test('a preview plans only sources whose pool matches the ledger, and never a pending one', async () => {
      const offline = new Connection('http://127.0.0.1:1', 'finalized')
      const chain = {
        [DOCS]: { dbc: { creatorFee: 0n, partnerFee: 3190n }, damm: { creator: { uncollected: 9940n, claimed: 0n }, partner: { uncollected: 4061n, claimed: 0n } } },
        [JEST]: { dbc: { creatorFee: 1000n, partnerFee: 500n }, damm: null },
        [VSCODE]: new Error('Stock-paired market has no registered config') }
      // Each market's accounts are fixed, as on chain; only the amounts move.
      const accounts = Object.fromEntries([DOCS, JEST].map(id => [id, { config: key(), baseVault: key(), quoteVault: key(), tokenAVault: key(),
        tokenBVault: key(), creatorNft: key(), partnerNft: key() }]))
      const reader = { local: true, programs: { dbc: new DynamicBondingCurveClient(offline, 'finalized').state.getProgram(), amm: new CpAmm(offline) },
        readMarket: async market => {
          const c = chain[market.repoId], a = accounts[market.repoId]
          if (c instanceof Error) throw c
          return { asset: META, slot: 900, verified: false, dbc: { pool: market.pool, config: a.config, baseVault: a.baseVault, quoteVault: a.quoteVault,
            creator: market.creatorWallet, feeClaimer: STOCK_FEE_CUSTODY, ...c.dbc }, damm: c.damm && { pool: market.dammPool, tokenAVault: a.tokenAVault,
            tokenBVault: a.tokenBVault, creator: { position: market.creatorPosition, nftAccount: a.creatorNft, owner: market.creatorWallet, ...c.damm.creator },
            partner: { position: market.partnerPosition, nftAccount: a.partnerNft, owner: STOCK_FEE_CUSTODY, ...c.damm.partner } } }
        } }
      const previews = await createStockCollections({ pool, reader }).previewAll()
      const docs = previews.find(p => p.repoId === DOCS), by = Object.fromEntries(docs.sources.map(s => [s.source, s]))
      assert.equal(docs.status, 'COLLECTABLE')
      assert.equal(docs.uncollected, String(3190n + 9940n + 4061n))
      assert.equal(by.dbc_creator.status, 'EMPTY')
      assert.deepEqual([by.dbc_partner.status, by.dbc_partner.amount, by.dbc_partner.launcherAmount], ['MATCH', '3190', '0'])
      assert.deepEqual([by.damm_creator.status, by.damm_creator.amount, by.damm_creator.launcherAmount, by.damm_creator.accumulatorAmount],
        ['MATCH', '9940', String(c2.launcherCumulative), String(9940n - c2.launcherCumulative)])
      assert.match(by.damm_creator.termsHash, /^[0-9a-f]{64}$/)
      assert.equal(by.damm_creator.instructions.at(-1).name, 'claim_position_fee')
      assert.deepEqual([by.damm_partner.status, by.damm_partner.reason], ['MISMATCH', 'The position has earned more than the last checkpoint; indexing must catch up'])
      const jest = Object.fromEntries(previews.find(p => p.repoId === JEST).sources.map(s => [s.source, s]))
      assert.deepEqual([jest.dbc_creator.status, jest.dbc_creator.launcherAmount, jest.dbc_partner.status], ['MATCH', String(jestFee.launcherAmount), 'PENDING'])
      const vscode = previews.find(p => p.repoId === VSCODE)
      assert.deepEqual([vscode.status, vscode.error, vscode.sources], ['UNREADABLE', 'Stock-paired market has no registered config', []])
      // The same state gives the same terms; a new fee changes them.
      const again = await createStockCollections({ pool, reader }).previewMarket((await listStockMarkets(pool, { repoId: JEST }))[0])
      assert.equal(again.sources.find(s => s.source === 'dbc_creator').termsHash, jest.dbc_creator.termsHash)
      chain[JEST].dbc.creatorFee = 1100n
      const moved = await createStockCollections({ pool, reader }).previewMarket((await listStockMarkets(pool, { repoId: JEST }))[0])
      assert.equal(moved.sources.find(s => s.source === 'dbc_creator').status, 'MISMATCH')
      // Custody can never be the market's own creator or launcher wallet.
      const refused = await createStockCollections({ pool, reader, custody: M[DOCS].launcher }).previewMarket((await listStockMarkets(pool, { repoId: DOCS }))[0])
      assert.equal(refused.status, 'REFUSED')
    })

    await t.test('one active canonical pool per stock; registering it again changes nothing', async () => {
      assert.equal((await registerCanonicalPool(pool, verifiedPool('CanonicalMeta'))).status, 'registered')
      assert.equal((await registerCanonicalPool(pool, verifiedPool('CanonicalMeta'))).status, 'already-registered')
      await assert.rejects(registerCanonicalPool(pool, verifiedPool('OtherMeta')), /already has an active canonical pool, CanonicalMeta/)
      assert.equal((await registerCanonicalPool(pool, verifiedPool('CanonicalMsft', 'msft-xstock'))).status, 'registered')
      await assert.rejects(pool.query(`insert into stock_canonical_pools(asset_id,quote_mint,pool,repoing_mint,evidence) values ('meta-xstock',$1,'Sneaky','R','{}')`, [META.mint]),
        error => error.constraint === 'stock_canonical_pools_one_active')
      await assert.rejects(registerCanonicalPool(pool, { ...verifiedPool('Bad'), quoteMint: MSFT.mint }), /another mint/)
      const active = await activeCanonicalPool(pool, 'meta-xstock')
      assert.deepEqual([active.pool, active.position, active.evidence.pool.sides.stock], ['CanonicalMeta', 'CanonicalMeta-position', 'B'])
      assert.equal((await stockAccumulator(pool, 'meta-xstock')).canonicalPool.pool, 'CanonicalMeta')
    })

    await t.test('settlement receipts spend only collected, unspent accumulator funds, once per signature', async () => {
      const first = await recordStockSettlementReceipt(pool, receipt('SettleOne', 1000n))
      assert.deepEqual([first.status, first.availableBefore, first.availableAfter], ['recorded', String(collected), String(collected - 1000n)])
      assert.equal((await recordStockSettlementReceipt(pool, receipt('SettleOne', 1000n))).status, 'already-recorded')
      await assert.rejects(recordStockSettlementReceipt(pool, receipt('SettleOne', 999n)), /already recorded with other terms/)
      await assert.rejects(recordStockSettlementReceipt(pool, receipt('TooMuch', collected)), /spends .* but only .* are unspent; collect first/)
      await assert.rejects(recordStockSettlementReceipt(pool, receipt('OtherPool', 1n, 'OtherMeta')), /canonical pool changed/)
      await assert.rejects(recordStockSettlementReceipt(pool, { ...receipt('WrongMint', 1n), quoteMint: MSFT.mint }), /another mint/)
      // Two receipts racing for the same funds: the asset lock lets exactly one through.
      const left = collected - 1000n, share = left * 6n / 10n
      const raced = await Promise.allSettled([recordStockSettlementReceipt(pool, receipt('RaceA', share)), recordStockSettlementReceipt(pool, receipt('RaceB', share))])
      assert.deepEqual(raced.map(r => r.status).sort(), ['fulfilled', 'rejected'])
      const meta = await stockAccumulator(pool, 'meta-xstock')
      assert.deepEqual([meta.totals.spent, meta.totals.available, meta.receipts.add_liquidity.count, meta.repoing.received],
        [String(1000n + share), String(collected - 1000n - share), 2, '14'])
      assert.equal(meta.status, 'MATCH', meta.problems.join('; '))
      assert.equal(await solListing(), solOnly, 'and with every stock ledger row present')
      // Deposits into a position count only while its permanently locked liquidity covers all of them, checked under the lock.
      const locked = permanent => [{ address: 'CanonicalMeta-position', fullyLocked: true, liquidity: { permanent: String(permanent), unlocked: '0', vested: '0' } }]
      const deposit = (signature, liquidity, permanent) => ({ ...receipt(signature, 1n), evidence: { pool: 'CanonicalMeta',
        liquidity: { 'CanonicalMeta-position': String(liquidity) }, positions: locked(permanent) } })
      assert.equal((await recordStockSettlementReceipt(pool, deposit('DepositOne', 60, 100))).status, 'recorded')
      await assert.rejects(recordStockSettlementReceipt(pool, deposit('DepositTwo', 50, 100)), /100 permanently locked liquidity, less than the 110 recorded/)
      assert.equal((await recordStockSettlementReceipt(pool, deposit('DepositTwo', 50, 110))).status, 'recorded')
    })

    await t.test('the operator route answers from the ledgers read-only; the chain side says what it lacks', async () => {
      const saved = Object.fromEntries(['GITHUB_APP_CLIENT_SECRET', 'PLATFORM_OPERATOR_GITHUB_IDS', 'DATABASE_URL', 'DBC_CONFIG', 'SOLANA_RPC_URL']
        .map(name => [name, process.env[name]]))
      try {
        // An RPC nobody answers: the chain side fails closed (no units, no custody balance) and the ledgers still answer.
        Object.assign(process.env, { GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'), PLATFORM_OPERATOR_GITHUB_IDS: '123', DATABASE_URL: URL_,
          SOLANA_RPC_URL: 'http://127.0.0.1:1' })
        delete process.env.DBC_CONFIG
        const { GET } = await import('../app/api/operations/stock-accumulator/route.js')
        const cookie = encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '123', accessToken: 'ghu_test_only',
          sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
        const request = query => ({ url: `https://repo.ing/api/operations/stock-accumulator${query}`, headers: new Headers(), cookies: { get: () => ({ value: cookie }) } })
        const response = await GET(request('?asset=meta-xstock'))
        assert.equal(response.status, 200)
        assert.match(response.headers.get('cache-control'), /no-store/)
        const body = await response.json()
        const meta = await stockAccumulator(pool, 'meta-xstock')
        assert.deepEqual([body.readOnly, body.stocks.length, body.stocks[0].ok, body.stocks[0].accumulator.totals], [true, 1, true, meta.totals])
        assert.equal(body.stocks[0].chainError, 'DBC_CONFIG is not set, so there are no collection previews.')
        assert.equal((await GET(request(''))).status, 200)
        assert.equal((await GET(request('?asset=sol'))).status, 404)
      } finally {
        for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
        await globalThis.__gitfunPool?.end()
        delete globalThis.__gitfunPool
      }
    })

    await t.test('one signature settling two collections is reported, never counted silently', async () => {
      await pool.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,actual_amount,launcher_amount,
        accumulator_amount,terms_hash,status,signature,receipt,settled_at) values ($1,'meta-xstock',$2,'dbc_creator',1,1,0,1,repeat('f',64),'settled',
        'CollectDocs','{"status":"settled"}',now())`, [JEST, META.mint])
      const meta = await stockAccumulator(pool, 'meta-xstock')
      assert.equal(meta.status, 'MISMATCH')
      assert.ok(meta.problems.includes('Signature CollectDocs settles more than one collection'), meta.problems.join('; '))
    })

    await t.test('the stock ledgers refuse rows for a SOL market (the market trigger the accumulator relies on)', async () => {
      await assert.rejects(pool.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,launcher_amount,
        accumulator_amount,terms_hash,status) values ($1,'meta-xstock',$2,'dbc_partner',1,0,1,repeat('e',64),'pending')`, [HELLO, META.mint]), /does not match a stock-paired market/)
    })
  } finally {
    await pool?.end()
    if (created) await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.end()
  }
})
