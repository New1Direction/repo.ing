import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { launcherLines, launcherPosition, readLauncherTrades } from '../src/trust-signals.mjs'

// Real PostgreSQL with every committed migration: the launcher row of the token page trust panel.
const url = process.env.TRUST_TEST_DATABASE_URL
test('real PostgreSQL: launcher position from DBC and DAMM trades, with the launch-transaction buy', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/repoing_trust_test', 'Disposable trust test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('truncate repositories, trade_events, damm_trade_events cascade')
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values(7,'o','r','o/r',0,0,false,now()),(8,'o','s','o/s',0,0,false,now())`)
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
      launch_slot,launch_finality,indexed_at,last_verified_at) values(7,'confirmed','mint7','pool7','launcher','creator','R','R','launch7',1,'finalized',now(),now()),
      (8,'confirmed','mint8','pool8','quiet','creator','S','S','launch8',1,'finalized',now(),now())`)
    const dbc = (pool_, sig, index, trader, direction, input, output) => pool.query(`insert into trade_events
      (pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader)
      values($1,$2,$3,1,now(),$4,$5,$6,'1',$7)`, [pool_, sig, index, direction, input, output, trader])
    // The launch transaction's own buy, then later trades by the launcher and others.
    await dbc('pool7', 'launch7', 0, 'launcher', 'buy', '1000000000', '25000000000000')
    await dbc('pool7', 's2', 0, 'launcher', 'buy', '500000000', '5000000000000')
    await dbc('pool7', 's3', 0, 'launcher', 'sell', '7500000000000', '400000000')
    await dbc('pool7', 's4', 0, 'alice', 'buy', '900000000', '9000000000000')
    await dbc('pool7', 's5', 0, null, 'sell', '1000', '1') // unattributed: never counted
    await dbc('pool8', 's6', 0, 'launcher', 'buy', '1', '999') // another market
    const damm = (sig, trader, direction, quote, base) => pool.query(`insert into damm_trade_events
      (github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,trader,base_amount)
      values(7,'damm7',$1,0,2,now(),$2,$3,'{}',$4,$5)`, [sig, quote, direction, trader, base])
    await damm('d1', 'launcher', 'sell', '100000000', '2500000000000')
    await damm('d2', 'launcher', 'sell', '100000000', null) // no base amount: skipped, as in Backers

    const row = await readLauncherTrades(pool, 'mint7')
    assert.deepEqual(row, { wallet: 'launcher', boughtBaseUnits: '30000000000000', soldBaseUnits: '10000000000000',
      launchBuyBaseUnits: '25000000000000', trades: 4 })
    assert.deepEqual(launcherLines(launcherPosition(row)), { title: 'Launcher holds 2% of supply', launch: 'Bought 2.5% at launch',
      sold: 'Sold 33.3% of what they bought' })

    assert.deepEqual(await readLauncherTrades(pool, 'mint8'), { wallet: 'quiet', boughtBaseUnits: '0', soldBaseUnits: '0', launchBuyBaseUnits: '0', trades: 0 })
    assert.equal(await readLauncherTrades(pool, 'missing'), null)
  } finally {
    await pool.end()
  }
})
