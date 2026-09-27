import test from 'node:test'
import assert from 'node:assert/strict'
import { database, listMarkets, marketByRepo, marketByMint } from '../app/lib/server.mjs'
process.env.DATABASE_URL ??= 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_lookup'
const testDatabase = new URL(process.env.DATABASE_URL)
assert.ok(['127.0.0.1', 'localhost'].includes(testDatabase.hostname), 'Use a local disposable database only')
assert.match(testDatabase.pathname, /^\/(gitfun_lookup|repoing_claims|repoing_lookup_test)$/, 'Use a dedicated test database: this fixture truncates its tables')
const pool = database()
test.after(async () => pool.end())
test('single-market lookups preserve fee, payout and trade aggregates without mixing repositories', async () => {
  await pool.query('truncate repositories restart identity cascade')
  for (const id of ['991','992']) {
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at,synced_at)
      values($1::bigint,'fixture','repo-' || $1::text,'fixture/repo-' || $1::text,12,2,false,now(),now())`,[id])
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at)
      values($1::bigint,'confirmed','mint-' || $1::text,'pool-' || $1::text,'launcher','creator','Test','TEST','launch-' || $1::text,1,'finalized',now(),now())`,[id])
    await pool.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot)
      values($1::bigint,'mint-' || $1::text,'pool-' || $1::text,'fee-' || $1::text,0,$2,'SOL','dbc_creator_quote',1)`,[id,id==='991'?'1234':'99999'])
    await pool.query(`insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at)
      values($1::bigint,'wallet',200,'SOL','claim-' || $1::text,'settled',now())`,[id])
  }
  const { markets } = await listMarkets()
  for (const expected of markets) {
    const {market} = await marketByRepo(expected.repoId)
    assert.ok(market)
    for (const key of Object.keys(expected)) assert.deepEqual(market[key],expected[key],key)
    assert.deepEqual((await marketByMint(expected.mint)).market,market)
  }
  assert.equal((await marketByRepo('991')).market.remaining,'1034')
  assert.equal((await marketByRepo('missing')).market,null)
  assert.equal((await marketByMint('missing')).market,null)
})
