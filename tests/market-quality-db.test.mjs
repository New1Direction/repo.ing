import test from 'node:test'
import assert from 'node:assert/strict'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { database, listMarkets, marketByMint } from '../app/lib/server.mjs'
import { orderMarkets } from '../app/lib/market-order.mjs'
import { createPulseStore } from '../src/dev-pulse.mjs'
import { persistLaunchRepository } from '../src/repository-store.mjs'
import { createLaunchAlertStore, launchAlertEarned } from '../src/launch-alerts.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'
import { recordChartBlock } from '../src/chart-ordering.mjs'
import { chartSpotPrice } from '../src/market-chart.mjs'

// Real PostgreSQL with every committed migration (0045 included): 24h volume of graduated markets counts swaps in the
// verified DAMM v2 pool only, market rows carry the repository quality and Official signals (list and single reads
// agree), the worker paths that fill repositories.github_created_at never erase it, and a row's last price is the chart's.
const url = process.env.MARKET_QUALITY_TEST_DATABASE_URL
const SOL = 1_000_000_000n
const DAY = 86_400_000

test('real PostgreSQL: graduated 24h volume, quality signals and creation-time backfill', { skip: !url }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_market_quality_test', 'Disposable market quality test database required')
  process.env.DATABASE_URL = url
  const pool = database()
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query(`truncate repo_pulse_state, launch_alerts, repo_verifications, repo_beneficiaries, graduation_observations, graduation_events,
      trade_events, damm_trade_events, finalized_chart_positions, finalized_chart_blocks, markets, repositories restart identity cascade`)
    const ago = ms => new Date(Date.now() - ms)
    const market = async (id, { stars, created, hoursAgo = 1, launcher = `Launcher${id}` }) => {
      await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at,github_created_at)
        values($1,'octo',$2,$3,$4,1,false,now(),$5)`, [id, `repo-${id}`, `octo/repo-${id}`, stars, created])
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at) values($1,'confirmed',$2,$3,$4,'creator','Repo','REPO',$5,1,'finalized',$6,now())`,
      [id, `Mint${id}`, `Curve${id}`, launcher, `Launch${id}`, ago(hoursAgo * 3_600_000)])
    }
    const dbc = (id, n, msAgo, direction, lamports) => pool.query(`insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
      values($1,$2,0,$3,$4,$5,$6,$7,'18446744073709551616')`, [`Curve${id}`, `dbc-${id}-${n}`, 100 + n, ago(msAgo), direction,
      direction === 'buy' ? lamports : '1000', direction === 'buy' ? '1000' : lamports])
    const damm = (id, poolName, n, msAgo, lamports) => pool.query(`insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence)
      values($1,$2,$3,0,$4,$5,$6,'buy','{}')`, [id, poolName, `damm-${id}-${n}`, 200 + n, ago(msAgo), lamports])
    const observe = async (id, observation) => {
      const columns = graduationColumns({ mint: `Mint${id}`, ...observation })
      await pool.query('insert into graduation_observations(github_repo_id,checked_at,status,observation,error_code) values($1,now(),$2,$3,$4)',
        [id, columns.status, columns.observation, columns.error_code])
    }

    // 7001: established, curve only: two swaps in the last day count, the older one does not.
    await market(7001, { stars: 500, created: ago(400 * DAY), hoursAgo: 5 })
    await dbc(7001, 1, 3_600_000, 'buy', String(2n * SOL)); await dbc(7001, 2, 7_200_000, 'sell', String(SOL)); await dbc(7001, 3, 30 * 3_600_000, 'buy', String(5n * SOL))
    // 7002: graduated (3 stars, so a new repo that earned promotion by graduating): its last curve swap plus swaps in the verified
    // pool; a swap recorded under another pool and swaps older than a day never count.
    await market(7002, { stars: 3, created: ago(400 * DAY), hoursAgo: 4 })
    await pool.query(`insert into graduation_events(github_repo_id,signature,pool,slot,evidence_hash,evidence,reconciliation)
      values(7002,'migration-7002','DammPool7002',150,'hash','{}','{}')`)
    await dbc(7002, 1, 2 * 3_600_000, 'buy', String(SOL))
    await damm(7002, 'DammPool7002', 1, 3_600_000, String(4n * SOL)); await damm(7002, 'DammPool7002', 2, 20 * 3_600_000, String(SOL / 2n))
    await damm(7002, 'DammPool7002', 3, 30 * 3_600_000, String(9n * SOL)); await damm(7002, 'Elsewhere7002', 4, 3_600_000, String(100n * SOL))
    // 7003: brand new, under its 10% mark, never graduated: DAMM rows without a verified migration never count.
    await market(7003, { stars: 2, created: ago(5 * DAY), hoursAgo: 3 })
    await damm(7003, 'DammPool7003', 1, 3_600_000, String(7n * SOL))
    // 7004: new (5 days old) but 12% of the way to graduating; its verified maintainer launched it from their payout wallet.
    await market(7004, { stars: 50, created: ago(5 * DAY), hoursAgo: 2, launcher: 'MaintainerWallet' })
    await observe(7004, { reserveLamports: 10_200_000_000n })
    await pool.query("insert into repo_verifications(github_repo_id,github_user_id,github_login,permission) values(7004,99,'octo','admin')")
    await pool.query("insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values(7004,99,'MaintainerWallet')")
    // 7005: verified, but someone else launched it; creation time not known yet, so 50 stars decide (established).
    await market(7005, { stars: 50, created: null, hoursAgo: 1 })
    await pool.query("insert into repo_verifications(github_repo_id,github_user_id,github_login,permission) values(7005,98,'octo','admin')")
    await pool.query("insert into repo_beneficiaries(github_repo_id,github_user_id,wallet) values(7005,98,'MaintainerWallet5')")

    const { markets, unavailable } = await listMarkets()
    assert.equal(unavailable, undefined)
    const byRepo = Object.fromEntries(markets.map(m => [m.repoId, m]))
    assert.deepEqual(Object.fromEntries(markets.map(m => [m.repoId, m.volume24hLamports])),
      { 7001: String(3n * SOL), 7002: String(SOL + 4n * SOL + SOL / 2n), 7003: '0', 7004: '0', 7005: '0' })
    // newRepo is the label: only the new repository that has not earned promotion (7003) carries it; 7002 graduated and
    // 7004 reached 12% of its target, so theirs is gone.
    assert.deepEqual(Object.fromEntries(markets.map(m => [m.repoId, [m.newRepo, m.promoted, m.officialLaunch, m.wasVerified]])), {
      7001: [false, true, false, false], 7002: [false, true, false, false], 7003: [true, false, false, false],
      7004: [false, true, true, true], 7005: [false, true, false, true] })
    assert.ok(byRepo[7001].githubCreatedAt instanceof Date)
    assert.equal(byRepo[7005].githubCreatedAt, null)
    assert.deepEqual(orderMarkets(markets, 'Trending').map(m => m.repoId), ['7002', '7001', '7005', '7004', '7003'],
      'Trending: promoted markets by volume (graduated volume included), the new repo under its mark last')
    // The token page reads one market with the same numbers and signals.
    for (const expected of markets) {
      const { market: single } = await marketByMint(expected.mint)
      for (const key of Object.keys(expected)) assert.deepEqual(single[key], expected[key], `${expected.repoId} ${key}`)
    }

    // Launch alerts read the same facts: only markets that earned promotion are announced.
    const candidates = await createLaunchAlertStore(pool).candidates({ channel: 'x', since: ago(DAY), maxAgeMs: DAY, maxAttempts: 3, limit: 100 })
    assert.deepEqual(Object.fromEntries(candidates.map(c => [c.githubRepoId, launchAlertEarned(c, Date.now())])),
      { 7001: true, 7002: true, 7003: false, 7004: true, 7005: true })

    // The Dev Pulse check refreshes stars and forks and fills the creation time once; it never erases or moves it.
    const pulse = createPulseStore(pool)
    const due = Object.fromEntries((await pulse.due(10, new Set())).map(row => [row.repoId, row.needsCreatedAt]))
    assert.deepEqual([due[7001], due[7005]], [false, true])
    const state = { fullName: 'octo/repo-7005', defaultBranch: 'main', stars: 60, pushedAt: null, activityReadFor: null, etags: {}, hnCheckedAt: null,
      checkedAt: new Date().toISOString(), nextCheckAt: new Date(Date.now() + 600_000).toISOString(), error: null }
    const save = (repository, stars = repository.stars) => pulse.save('7005', { events: [], starHours: [], state: { ...state, stars }, repository })
    const stored = async () => (await pool.query('select stars, forks, github_created_at as created from repositories where github_repo_id = 7005')).rows[0]
    await save({ stars: 60, forks: 7, createdAt: '2025-01-02T03:04:05.000Z' })
    assert.deepEqual(await stored(), { stars: 60, forks: 7, created: new Date('2025-01-02T03:04:05Z') })
    await save({ stars: 61, forks: null, createdAt: '2026-01-01T00:00:00.000Z' })
    assert.deepEqual(await stored(), { stars: 61, forks: 7, created: new Date('2025-01-02T03:04:05Z') }, 'a creation time is never moved')
    assert.equal((await pulse.due(10, new Set())).some(row => row.repoId === '7005'), false, 'checked: not due again yet')

    // A launch or lookup that misses the creation time keeps the stored one.
    await persistLaunchRepository(pool, { githubRepoId: 7001n, owner: 'octo', name: 'repo-7001', fullName: 'octo/repo-7001', description: null,
      avatarUrl: null, stars: 501, forks: 1, archived: false, githubUpdatedAt: new Date() })
    assert.ok((await pool.query('select github_created_at from repositories where github_repo_id = 7001')).rows[0].github_created_at instanceof Date)

    // The last price, list and token page alike, is the newest trade as the chart orders it (src/market-chart.mjs latestTradeSql).
    // Separate transactions in one slot all have event_index 0: no price until their block order is recorded, then the later one's.
    // Curve trades (7001) and DAMM trades (7002) alike.
    const sqrtOf = n => String((1n << 64n) * BigInt(n))
    const sameSlot = async (table, id, slot, prices) => {
      for (const [signature, n] of prices) await pool.query(table === 'trade_events'
        ? `insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price)
          values($1,$2,0,$3,now(),'buy','1000','1000',$4)`
        : `insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price)
          values($1,$2,$3,0,$4,now(),1000,'buy','{}',$5)`,
      table === 'trade_events' ? [`Curve${id}`, signature, slot, sqrtOf(n)] : [id, `DammPool${id}`, signature, slot, sqrtOf(n)])
    }
    await sameSlot('trade_events', 7001, 900, [['curve-a', 2], ['curve-b', 3]])
    await sameSlot('damm_trade_events', 7002, 901, [['damm-a', 2], ['damm-b', 3]])
    // A fresh server module each time: the list is memoized for 15 s.
    const prices = async tag => {
      const server = await import(`../app/lib/server.mjs?${tag}`)
      const { markets: listed } = await server.listMarkets()
      const rows = await Promise.all(['7001', '7002'].map(async id => [listed.find(m => m.repoId === id), (await server.marketByMint(`Mint${id}`)).market]))
      return rows.map(([row, single]) => { assert.equal(single.priceSol, row.priceSol, 'list and token page agree'); return row.priceSol })
    }
    assert.deepEqual(await prices('unordered'), [null, null], 'order unproven: no price, as the chart withholds it')
    for (const [slot, signatures] of [[900, ['curve-b', 'curve-a']], [901, ['damm-b', 'damm-a']]]) {
      await recordChartBlock(pool, { slot, blockhash: `hash${slot}`, previousBlockhash: `prev${slot}`, parentSlot: slot - 1, signatures })
    }
    assert.deepEqual(await prices('ordered'), [chartSpotPrice(sqrtOf(2)), chartSpotPrice(sqrtOf(2))], 'the later transaction in each block')
  } finally { await pool.end() }
})
