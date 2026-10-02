import test from 'node:test'
import assert from 'node:assert/strict'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { database, listMarkets, marketByMint } from '../app/lib/server.mjs'

// Real PostgreSQL with every committed migration: 24h volume of graduated markets counts swaps in the verified DAMM v2
// pool only, and the list and single-market reads agree.
const url = process.env.MARKET_QUALITY_TEST_DATABASE_URL
const SOL = 1_000_000_000n

test('real PostgreSQL: graduated markets count verified DAMM v2 swaps in 24h volume', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_market_quality_test', 'Disposable market quality test database required')
  process.env.DATABASE_URL = url
  const pool = database()
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('truncate graduation_observations, graduation_events, trade_events, damm_trade_events, markets, repositories restart identity cascade')
    const ago = ms => new Date(Date.now() - ms)
    const market = async (id, hoursAgo) => {
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
        values($1,'octo',$2,$3,500,1,false,now())`, [id, `repo-${id}`, `octo/repo-${id}`])
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at) values($1,'confirmed',$2,$3,'launcher','creator','Repo','REPO',$4,1,'finalized',$5,now())`,
      [id, `Mint${id}`, `Curve${id}`, `Launch${id}`, ago(hoursAgo * 3_600_000)])
    }
    const dbc = (id, n, msAgo, direction, lamports) => pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
      values($1,$2,0,$3,$4,$5,$6,$7,'18446744073709551616')`, [`Curve${id}`, `dbc-${id}-${n}`, 100 + n, ago(msAgo), direction,
      direction === 'buy' ? lamports : '1000', direction === 'buy' ? '1000' : lamports])
    const damm = (id, poolName, n, msAgo, lamports) => pool.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence)
      values($1,$2,$3,0,$4,$5,$6,'buy','{}')`, [id, poolName, `damm-${id}-${n}`, 200 + n, ago(msAgo), lamports])

    // 7001: curve only: two swaps in the last day count, the older one does not.
    await market(7001, 3)
    await dbc(7001, 1, 3_600_000, 'buy', String(2n * SOL)); await dbc(7001, 2, 7_200_000, 'sell', String(SOL)); await dbc(7001, 3, 30 * 3_600_000, 'buy', String(5n * SOL))
    // 7002: graduated: its last curve swap plus swaps in the verified pool; a swap recorded under another pool and swaps
    // older than a day never count.
    await market(7002, 2)
    await pool.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation)
      values(7002,'migration-7002','DammPool7002',150,'hash','{}','{}')`)
    await dbc(7002, 1, 2 * 3_600_000, 'buy', String(SOL))
    await damm(7002, 'DammPool7002', 1, 3_600_000, String(4n * SOL)); await damm(7002, 'DammPool7002', 2, 20 * 3_600_000, String(SOL / 2n))
    await damm(7002, 'DammPool7002', 3, 30 * 3_600_000, String(9n * SOL)); await damm(7002, 'Elsewhere7002', 4, 3_600_000, String(100n * SOL))
    // 7003: never graduated: DAMM rows without a verified migration never count.
    await market(7003, 1)
    await damm(7003, 'DammPool7003', 1, 3_600_000, String(7n * SOL))

    const { markets, unavailable } = await listMarkets()
    assert.equal(unavailable, undefined)
    assert.deepEqual(Object.fromEntries(markets.map(m => [m.repoId, m.volume24hLamports])),
      { 7001: String(3n * SOL), 7002: String(SOL + 4n * SOL + SOL / 2n), 7003: '0' })
    for (const expected of markets) assert.equal((await marketByMint(expected.mint)).market.volume24hLamports, expected.volume24hLamports, expected.repoId)
  } finally { await pool.end() }
})
