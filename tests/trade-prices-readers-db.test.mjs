import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { evidenceHash } from '../src/graduation-state.mjs'
import { readMarketChart } from '../src/market-chart.mjs'

// Real PostgreSQL with every migration through 0089 (drizzle/0089_trade_prices.sql): the insert triggers store the price each
// trade paid from mint_facts, and every price reader (market rows, the token page, the watchlist, the wallet and the chart)
// reads that one price and the mint's on-chain supply. Everything is written inside one transaction and rolled back.
const url = process.env.TRADE_PRICES_TEST_DATABASE_URL
const SOL_MINT = 'So11111111111111111111111111111111111111112'
// Real repo.ing trades on mint 59PXVf… (6 decimals).
const REAL = { mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', supply: '999850848836751',
  sell: { base: '172810998534', lamports: '133581983', price: 0.000000772994682822333098 },
  buy: { base: '3854573608862', lamports: '2970000000', price: 0.000000770513239952588184 } }

async function fixtures(db) {
  const market = (id, mint) => db.query(`with r as (insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values($1,'octo',$2,$3,10,1,false,now()))
    insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,
      launch_finality,indexed_at,last_verified_at) values($1,'confirmed',$4,$5,'launcher','creator','Repo','REPO',$6,1,'finalized',now(),now())`,
  [id, `repo-${id}`, `octo/repo-${id}`, mint, `Curve${id}`, `Launch${id}`])
  await db.query(`insert into mint_facts(mint,decimals,supply,slot) values($1,9,0,1),($2,6,$3,1)`, [SOL_MINT, REAL.mint, REAL.supply])
  await market(8101, REAL.mint)
  await market(8102, 'MintWithoutFacts8102')
  const curve = (pool, signature, slot, side) => db.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,
      output_base_units,next_sqrt_price) values($1,$2,0,$3,now()-interval '1 hour',$4,$5,$6,'18446744073709551616')`,
  [pool, signature, slot, side, side === 'buy' ? REAL.buy.lamports : REAL.sell.base, side === 'buy' ? REAL.buy.base : REAL.sell.lamports])
  await curve('Curve8101', 'curve-sell', 10, 'sell')
  await curve('Curve8102', 'unpriced-buy', 10, 'buy')
  const migration = { mint: REAL.mint, curve: 'Curve8101', pool: 'Damm8101', signature: 'migration-8101', slot: 100 }
  await db.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation)
    values(8101,$1,$2,100,$3,$4,'{}')`, [migration.signature, migration.pool, evidenceHash(migration), JSON.stringify({ migration })])
  const damm = (pool, signature, slot, lamports, base) => db.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,
      quote_amount,base_amount,direction,evidence,next_sqrt_price) values(8101,$1,$2,0,$3,now()-interval '30 minutes',$4,$5,'buy','{}','18446744073709551616')`,
  [pool, signature, slot, lamports, base])
  await damm('Damm8101', 'graduated-buy', 120, REAL.buy.lamports, REAL.buy.base)
  // A newer swap in a pool the verified migration does not name: never a price.
  await damm('Elsewhere8101', 'unverified-pool', 130, '1', '1')
}

test('real PostgreSQL: rows, token page, watchlist and wallet read the price trades paid and the mint\'s on-chain supply', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(target.hostname === '127.0.0.1' && target.pathname.endsWith('_test'), 'A local test database only')
  const client = new pg.Client({ connectionString: target.href })
  await client.connect()
  const saved = { url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool }
  try {
    // Arrange
    await client.query('begin')
    await fixtures(client)
    process.env.DATABASE_URL = target.href
    globalThis.__gitfunPool = client
    const server = await import('../app/lib/server.mjs?trade-prices')
    const { GET } = await import('../app/api/watchlist/route.js')
    const { clearPriceCache, latestMarketPrices } = await import('../app/lib/portfolio-prices.mjs')
    clearPriceCache()
    // Act
    const stored = (await client.query(`select signature, price_sol::float8 as price from trade_prices where mint = $1 order by slot`, [REAL.mint])).rows
    const { markets } = await server.listMarkets()
    const byRepo = Object.fromEntries(markets.map(market => [market.repoId, market]))
    const { market: single } = await server.marketByMint(REAL.mint)
    const quotes = (await (await GET(new Request('https://repo.ing/api/watchlist?repos=8101,8102'))).json()).quotes
    const wallet = await latestMarketPrices(client, [byRepo[8101], byRepo[8102]])
    const chart = await readMarketChart(client, byRepo[8101], 'all')
    // Assert
    assert.deepEqual(stored, [{ signature: 'curve-sell', price: REAL.sell.price }, { signature: 'graduated-buy', price: REAL.buy.price }],
      'the triggers store quote / base at each mint\'s decimals; the unverified pool\'s swap is not in trade_prices')
    assert.equal(byRepo[8101].priceSol, REAL.buy.price, 'the newest trade is the graduated one')
    assert.deepEqual(byRepo[8101].supply, { baseUnits: REAL.supply, decimals: 6 })
    assert.deepEqual([single.priceSol, single.supply], [byRepo[8101].priceSol, byRepo[8101].supply], 'list and token page agree')
    assert.deepEqual([byRepo[8102].priceSol, byRepo[8102].supply], [null, null], 'no mint facts yet: no price and no supply, never guessed')
    const quote = Object.fromEntries(quotes.map(q => [q.repoId, q]))
    assert.equal(Number(quote[8101].priceSol), REAL.buy.price)
    assert.equal(quote[8101].event, 'graduated-buy:0', 'the watchlist includes graduated trades')
    assert.equal(quote[8102].priceSol, null)
    assert.deepEqual([wallet.get('8101'), wallet.get('8102')], [REAL.buy.price, null])
    assert.deepEqual([chart.latest.signature, chart.latest.priceSol, chart.supply], ['graduated-buy', REAL.buy.price, { baseUnits: REAL.supply, decimals: 6 }])
  } finally {
    process.env.DATABASE_URL = saved.url
    globalThis.__gitfunPool = saved.pool
    if (saved.url === undefined) delete process.env.DATABASE_URL
    await client.query('rollback'); await client.end()
  }
})
