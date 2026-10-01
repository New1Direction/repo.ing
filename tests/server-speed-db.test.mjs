import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readMarketChart } from '../src/market-chart.mjs'
import { createChartOrdering, recordChartBlock } from '../src/chart-ordering.mjs'
import { trendCandidate, trendOperatorView } from '../src/trend-intake.mjs'
import { createVitalsStore } from '../src/web-vitals-store.mjs'
import { parseVitalsBeacon } from '../app/lib/web-vitals.mjs'

// Real PostgreSQL with every committed migration (0038 included): the read indexes are chosen by the planner on seeded
// data, block positions match the full signature lists they replace, the batched trend view equals the per-candidate one,
// and the web vitals store aggregates p75 per route like a reference percentile.
const url = process.env.SERVER_SPEED_TEST_DATABASE_URL
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const key = n => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (n * 31 + i * 7 + 1) % 256))
const sig = n => bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (n * 13 + i * 11 + 3) % 256))
const sqrt = n => ((1n << 64n) * BigInt(n)).toString()

async function seedMarkets(pool, count) {
  const markets = Array.from({ length: count }, (_, i) => ({ repoId: String(5000 + i), mint: key(1000 + i), pool: key(2000 + i) }))
  for (const m of markets) {
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values($1,'o',$2,$3,1,0,false,now())`,
      [m.repoId, `r${m.repoId}`, `o/r${m.repoId}`])
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,
      launch_finality,indexed_at,last_verified_at,launch_block_time) values($1,'confirmed',$2,$3,'w','w','T','T',$4,1,'finalized',now(),now(),now() - interval '9 days')`,
    [m.repoId, m.mint, m.pool, `launch-${m.repoId}`])
  }
  return markets
}

// EXPLAIN (FORMAT JSON) and collect every node's type and index name.
async function planNodes(pool, sql) {
  const { rows: [{ 'QUERY PLAN': [plan] }] } = await pool.query(`explain (format json) ${sql}`)
  const nodes = []
  const walk = node => { nodes.push(`${node['Node Type']}${node['Index Name'] ? ` ${node['Index Name']}` : ''}`); for (const child of node.Plans ?? []) walk(child) }
  walk(plan.Plan)
  return nodes
}
const usesIndex = (nodes, name) => nodes.some(node => /^(Index Scan|Index Only Scan|Bitmap Index Scan) /.test(node) && node.endsWith(` ${name}`))

// PostgreSQL percentile_cont(0.75): linear interpolation between the closest ranks.
function percentile75(values) {
  const sorted = [...values].sort((a, b) => a - b), rank = 0.75 * (sorted.length - 1), low = Math.floor(rank)
  return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * (rank - low)
}

test('real PostgreSQL: 0038 indexes, block positions, batched trend view and web vitals', { skip: !url }, async t => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_server_speed_test', 'Disposable server-speed test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query(`truncate web_vitals, finalized_chart_positions, finalized_chart_blocks, trade_events, damm_trade_events, fee_events, damm_fee_events,
      platform_fee_events, graduation_alerts, graduation_events, trend_signals, trend_observations, trend_candidates, markets, repositories restart identity cascade`)

    await t.test('the planner uses the 0038 indexes for the per-market reads that used to scan whole tables', async () => {
      const markets = await seedMarkets(pool, 40)
      await pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
        select m.pool, 'dbc-'||m.n||'-'||g, 0, 1000000 + m.n * 1000 + g, now() - (g || ' minutes')::interval, 'buy', '1000', '2000', $2
        from unnest($1::text[]) with ordinality as m(pool, n), generate_series(1, 100) g`, [markets.map(m => m.pool), sqrt(1)])
      await pool.query(`insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot)
        select m.repo::bigint, 'mint', m.pool, 'fee-'||m.repo||'-'||g, 0, 10, 'So11111111111111111111111111111111111111112', 'dbc_creator_quote', g
        from unnest($1::text[], $2::text[]) as m(repo, pool), generate_series(1, 100) g`, [markets.map(m => m.repoId), markets.map(m => m.pool)])
      for (const table of ['damm_fee_events', 'platform_fee_events']) await pool.query(`insert into ${table}(github_repo_id,pool,position,slot,amount_base_units,
        cumulative_earned,cumulative_claimed,evidence_hash,evidence) select m.repo::bigint, 'damm', 'pos-'||m.repo, g, 5, g * 5, 0, 'h', repeat('e', 1500)
        from unnest($1::text[]) as m(repo), generate_series(1, 60) g`, [markets.map(m => m.repoId)])
      await pool.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price)
        select m.repo::bigint, 'damm-'||m.repo, 'damm-'||m.repo||'-'||g, 0, 2000000 + g, now(), 7, 'sell', '{}', $2
        from unnest($1::text[]) as m(repo), generate_series(1, 75) g`, [markets.map(m => m.repoId), sqrt(2)])
      await pool.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail,acknowledged_at)
        select 'alert-'||g, ($1::bigint[])[1 + g % 40], case when g % 50 = 0 then 'RESERVE_MOVED' when g % 3 = 0 then 'TRADE_QUARANTINED' else 'TRADE_CANARY' end, '{}',
          case when g % 5 = 0 then null else now() end from generate_series(1, 1200) g`, [markets.map(m => m.repoId)])
      await pool.query('vacuum analyze')
      const [m] = markets
      const checks = [
        ['trade_events_pool_slot', `select slot, next_sqrt_price from trade_events where pool = '${m.pool}' order by slot desc, event_index desc limit 1`],
        ['trade_events_pool_slot', `select signature from trade_events where pool = '${m.pool}' order by slot desc, event_index desc limit 30`],
        ['trade_events_pool_time', `select sum(input_base_units::numeric) from trade_events where pool = '${m.pool}' and traded_at >= now() - interval '30 minutes'`],
        ['damm_trade_events_repo_slot', `select slot from damm_trade_events where github_repo_id = ${m.repoId} and next_sqrt_price is not null order by slot desc, event_index desc limit 1`],
        ['damm_trade_events_repo_slot', `select sum(quote_amount) from damm_trade_events where github_repo_id = ${m.repoId}`],
        ['fee_events_repo_slot', `select coalesce(sum(amount_base_units), 0) from builder_fee_credits where github_repo_id = ${m.repoId}`],
        ['damm_fee_events_repo', `select coalesce(sum(amount_base_units), 0) from builder_fee_credits where github_repo_id = ${m.repoId}`],
        ['fee_events_repo_slot', `select signature from fee_events where github_repo_id = ${m.repoId} order by slot desc, event_index desc limit 30`],
        ['platform_fee_events_repo', `select coalesce(sum(amount_base_units), 0) from platform_fee_events where github_repo_id = ${m.repoId}`],
        ['fee_events_pool_signature', `select f.signature from fee_events f where f.pool = '${m.pool}' group by f.signature order by f.signature limit 100`],
        ['graduation_alerts_open_repo_kind', `select id, detail from graduation_alerts where kind = 'TRADE_QUARANTINED' and github_repo_id = ${m.repoId} and acknowledged_at is null order by id limit 100`],
        ['graduation_alerts_kind', `select id from graduation_alerts where kind in ('RESERVE_MOVED', 'OPS_WALLET_LOW') order by id limit 5`],
      ]
      for (const [index, sql] of checks) {
        const nodes = await planNodes(pool, sql)
        assert.ok(usesIndex(nodes, index), `${index} not used: ${nodes.join(' / ')} for ${sql}`)
      }
      await pool.query(`truncate trade_events, fee_events, damm_fee_events, platform_fee_events, damm_trade_events, graduation_alerts, markets, repositories restart identity cascade`)
    })

    await t.test('block positions match the full signature lists and the chart reads them instead', async () => {
      await pool.query('truncate finalized_chart_positions, finalized_chart_blocks, trade_events, markets, repositories restart identity cascade')
      const [market] = await seedMarkets(pool, 1)
      const at = Date.now() - 60_000
      const insertDbc = (n, slot, eventIndex = 0, price = n) => pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
        values($1,$2,$3,$4,$5,'buy','1000','2000',$6)`, [market.pool, sig(n), eventIndex, slot, new Date(at + slot), sqrt(price)])
      for (let n = 1; n <= 30; n++) await insertDbc(n, 100 + Math.ceil(n / 3)) // three transactions per slot
      const blockFor = slot => ({ slot, blockhash: key(slot), previousBlockhash: key(slot + 1), parentSlot: slot - 1,
        signatures: [sig(600 + slot), ...[3, 2, 1].map(k => sig((slot - 100) * 3 - k + 1)), sig(650 + slot)] })
      // Blocks for the first five slots are recorded the normal way (positions stored with the block).
      for (let slot = 101; slot <= 105; slot++) await recordChartBlock(pool, blockFor(slot))
      const positions = async () => (await pool.query('select slot::text, signature, transaction_index from finalized_chart_positions order by slot, transaction_index')).rows
      assert.equal((await positions()).length, 15)
      const fromLists = (await pool.query(`select t.slot::text, t.signature, array_position(b.signatures, t.signature::text) as transaction_index
        from trade_events t join finalized_chart_blocks b on b.slot = t.slot order by t.slot, transaction_index`)).rows
      assert.deepEqual(await positions(), fromLists)

      // The migration's backfill statement rebuilds exactly the same rows.
      const backfill = readFileSync(new URL('../drizzle/0038_server_speed.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')
        .find(statement => /INSERT INTO finalized_chart_positions/.test(statement))
      await pool.query('truncate finalized_chart_positions')
      await pool.query(backfill)
      assert.deepEqual(await positions(), fromLists)

      // A late-indexed trade inside a recorded block: the chart falls back to the block list until the worker stores it.
      const before = await readMarketChart(pool, market, 'all', at + 3_600_000)
      await pool.query(`delete from finalized_chart_positions where slot = 103`)
      assert.deepEqual(await readMarketChart(pool, market, 'all', at + 3_600_000), before, 'fallback to the block list gives the same chart')

      // The ordering worker: fills that position from the stored block (no RPC), then verifies the unrecorded slots.
      const rpc = endpoint => ({ rpcEndpoint: endpoint, getGenesisHash: async () => MAINNET,
        getBlockSignatures: async slot => { const { blockhash, previousBlockhash, parentSlot, signatures } = blockFor(slot); return { blockhash, previousBlockhash, parentSlot, signatures } } })
      const worker = createChartOrdering({ pool, connection: rpc('primary'), verification: rpc('secondary') })
      const result = await worker.runOnce()
      assert.deepEqual([result.status, result.verified, result.pending, result.errors], ['checked', 5, 0, []])
      assert.equal((await positions()).length, 30)
      assert.deepEqual((await worker.runOnce()).pending, 0, 'nothing left to verify, and no block list is re-read')
      const after = await readMarketChart(pool, market, 'all', at + 3_600_000)
      assert.equal(after.candles.some(c => c.orderingPending), false)
      assert.equal(after.latestOrderingPending, false)

      // A trade absent from its recorded block never receives a position and keeps the latest price pending.
      await insertDbc(99, 110, 0, 40)
      assert.equal((await worker.runOnce()).errors[0]?.code, 'CHART_SIGNATURE_MISSING')
      assert.equal((await pool.query(`select count(*)::int as n from finalized_chart_positions where signature = $1`, [sig(99)])).rows[0].n, 0)
      assert.equal((await readMarketChart(pool, market, 'all', at + 3_600_000)).latestOrderingPending, true)
      await pool.query('truncate finalized_chart_positions, finalized_chart_blocks, trade_events, markets, repositories restart identity cascade')
    })

    await t.test('the batched trend view equals the per-candidate read it replaced', async () => {
      const now = Date.now()
      for (let c = 0; c < 30; c++) {
        const repoId = String(7000 + c)
        await pool.query(`insert into trend_candidates(github_repo_id,full_name,description,state,observed_at,detected_at) values($1,$2,'d',$3,$4,$5)`,
          [repoId, `o/t${c}`, ['detected', 'reviewed', 'approved', 'rejected'][c % 4], new Date(now - 600_000), new Date(now - c * 3_600_000)])
        for (let k = 0; k < 2 + (c % 5); k++) {
          const observedAt = new Date(now - 600_000 - k * 1_800_000).toISOString()
          await pool.query(`insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values($1,$2,$3,'h')`,
            [repoId, observedAt, JSON.stringify({ observedAt, stars: 500 - k * (c % 7) * 10, forks: 9 - k, releaseAt: null, activity: null, repo: { id: repoId } })])
        }
        // Two signals with the same timestamp: the order is now deterministic (newest id first) in both reads.
        for (const source of ['hn', 'github_trending'].slice(0, c % 3)) await pool.query(`insert into trend_signals(github_repo_id,source,url,note,occurred_at,expires_at)
          values($1,$2,$3,'n',$4,$5)`, [repoId, source, `https://news.ycombinator.com/item?id=${c}${source}`, new Date(now - 3_600_000), new Date(now + 86_400_000)])
      }
      const { rows: ids } = await pool.query('select github_repo_id::text as id from trend_candidates order by detected_at desc limit 200')
      const expected = []
      for (const { id } of ids) expected.push(await trendCandidate(pool, id, now))
      expected.sort((a, b) => b.score.total - a.score.total || (BigInt(a.repoId) < BigInt(b.repoId) ? -1 : 1))
      const { candidates } = await trendOperatorView(pool, now)
      assert.equal(candidates.length, 30)
      assert.deepEqual(candidates, expected)
    })

    await t.test('web vitals: beacons are stored as route patterns, p75 per window and device, and pruned after 14 days', async () => {
      const store = createVitalsStore(pool)
      const lcp = Array.from({ length: 21 }, (_, i) => 1000 + i * 137.5)
      for (const [i, value] of lcp.entries()) await store.record({ ...parseVitalsBeacon(JSON.stringify({ route: '/token/[mint]', metrics: [{ name: 'LCP', value }, { name: 'CLS', value: i / 100 }] })),
        device: i % 3 ? 'desktop' : 'mobile' })
      await pool.query(`insert into web_vitals(route,metric,value,rating,device,created_at) values
        ('/token/[mint]','LCP',9000,'poor','mobile',now() - interval '3 days'), ('/explore','INP',120,'good','desktop',now() - interval '2 days'),
        ('/explore','INP',90000,'poor','desktop',now() - interval '20 days')`)
      const summary = await store.summary()
      const row = (route, metric) => summary.find(r => r.route === route && r.metric === metric)
      assert.equal(row('/token/[mint]', 'LCP').samplesDay, 21)
      assert.equal(row('/token/[mint]', 'LCP').samplesWeek, 22)
      assert.ok(Math.abs(row('/token/[mint]', 'LCP').p75Day - percentile75(lcp)) < 1e-6)
      assert.ok(Math.abs(row('/token/[mint]', 'LCP').p75Week - percentile75([...lcp, 9000])) < 1e-6)
      assert.equal(row('/explore', 'INP').samplesDay, 0)
      assert.equal(row('/explore', 'INP').p75Day, null)
      assert.equal(row('/explore', 'INP').samplesWeek, 1, 'rows older than 7 days are outside the summary')
      const mobile = (await store.summary({ device: 'mobile' })).find(r => r.route === '/token/[mint]' && r.metric === 'LCP')
      assert.equal(mobile.samplesDay, 7)
      assert.ok(Math.abs(mobile.p75Day - percentile75(lcp.filter((_, i) => i % 3 === 0))) < 1e-6)
      assert.equal(await store.prune(), 1)
      assert.equal((await pool.query(`select count(*)::int as n from web_vitals where created_at < now() - interval '14 days'`)).rows[0].n, 0)
    })
  } finally { await pool.end() }
})
