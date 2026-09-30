import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readBackerNotes, readBackerRows, summarizeBackers } from '../src/backers.mjs'

// Real PostgreSQL with every committed migration: the grouped per-wallet query behind the token page "Backers" tab.
const url = process.env.BACKERS_TEST_DATABASE_URL
test('real PostgreSQL: backers from DBC and DAMM trades', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/repoing_backers_test', 'Disposable backers test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('truncate repositories, trade_events, damm_trade_events cascade')
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values(7,'o','r','o/r',0,0,false,now()),(8,'o','s','o/s',0,0,false,now())`)
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
      launch_slot,launch_finality,indexed_at,last_verified_at) values(7,'confirmed','mint7','pool7','launcher','creator','R','R','launch7',1,'finalized',now(),now()),
      (8,'confirmed','mint8','pool8','launcher','creator','S','S','launch8',1,'finalized',now(),now())`)
    // DBC: buy = SOL in (input) → tokens out (output); sell = tokens in → SOL out.
    const dbc = (pool_, sig, slot, trader, direction, input, output, at) => pool.query(`insert into trade_events
      (pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader)
      values($1,$2,0,$3,$4,$5,$6,$7,'1',$8)`, [pool_, sig, slot, at, direction, input, output, trader])
    await dbc('pool7', 's1', 10, 'alice', 'buy', '2000000000', '500000000', '2026-09-01T00:00:00Z')
    await dbc('pool7', 's2', 11, 'bob', 'buy', '1000000000', '300000000', '2026-09-01T00:01:00Z')
    await dbc('pool7', 's3', 12, 'alice', 'sell', '100000000', '350000000', '2026-09-01T00:02:00Z')
    await dbc('pool7', 's4', 13, 'carol', 'buy', '100000000', '40000000', '2026-09-01T00:03:00Z')
    await dbc('pool7', 's5', 14, 'carol', 'sell', '40000000', '90000000', '2026-09-01T00:04:00Z')
    await dbc('pool7', 's6', 15, null, 'buy', '5000000000', '900000000', '2026-09-01T00:05:00Z') // not yet attributed
    await dbc('pool8', 's7', 9, 'mallory', 'buy', '9000000000', '999000000', '2026-09-01T00:00:00Z') // another market
    // DAMM (post-graduation) rows count by repository; rows without base_amount are skipped, as in holding P&L.
    const damm = (sig, slot, trader, direction, quote, base) => pool.query(`insert into damm_trade_events
      (github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,trader,base_amount)
      values(7,'damm7',$1,0,$2,'2026-09-02T00:00:00Z',$3,$4,'{}',$5,$6)`, [sig, slot, quote, direction, trader, base])
    await damm('d1', 20, 'bob', 'buy', '700000000', '100000000')
    await damm('d2', 21, 'dave', 'buy', '300000000', '20000000')
    await damm('d3', 22, 'dave', 'buy', '300000000', null)
    await pool.query(`insert into holder_notes(mint,wallet,body,balance_at_post) values('mint7','bob','Shipping every week',1),
      ('mint7','alice','hidden note',1)`)
    await pool.query("update holder_notes set hidden_at = now(), hidden_by = 'mod' where wallet = 'alice'")

    const rows = await readBackerRows(pool, { pool: 'pool7', repoId: '7' })
    const byWallet = Object.fromEntries(rows.map(r => [r.wallet, r]))
    assert.deepEqual(Object.keys(byWallet).sort(), ['alice', 'bob', 'carol', 'dave'])
    assert.deepEqual([byWallet.alice.boughtBaseUnits, byWallet.alice.soldBaseUnits, byWallet.alice.spentLamports, byWallet.alice.buys],
      ['500000000', '100000000', '2000000000', 1])
    assert.deepEqual([byWallet.bob.boughtBaseUnits, byWallet.bob.spentLamports, byWallet.bob.buys, byWallet.bob.firstBuySlot], ['400000000', '1700000000', 2, '11'])
    assert.deepEqual([byWallet.dave.boughtBaseUnits, byWallet.dave.buys], ['20000000', 1])
    assert.equal(new Date(byWallet.bob.firstBuyAt).toISOString(), '2026-09-01T00:01:00.000Z')

    const summary = summarizeBackers(rows, { labels: new Map([['dave', { kind: 'team', label: 'repo.ing team' }]]) })
    assert.equal(summary.count, 2)
    assert.deepEqual(summary.top.map(b => [b.wallet, b.netBaseUnits, b.earlyRank]), [['alice', '400000000', 1], ['bob', '400000000', 2]])
    assert.deepEqual(summary.disclosed.map(d => d.wallet), ['dave'])

    const notes = await readBackerNotes(pool, 'mint7', ['alice', 'bob'])
    assert.deepEqual([...notes], [['bob', 'Shipping every week']])
    assert.deepEqual(await readBackerRows(pool, { pool: 'nope', repoId: '999' }), [])
  } finally { await pool.end() }
})
