import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { activeSchedule, assertScheduleAllows, createLaunchSchedules, reconcileSchedules, SCHEDULE_CODES, upcomingSchedules } from '../src/launch-schedules.mjs'
import { launchCalendar, produceFeedEvents, readFeedEvents } from '../src/launch-feed.mjs'
import { createWebhookStore, deliverDue, fanOutDeliveries, WEBHOOK_LIMITS } from '../src/launch-webhooks.mjs'
import { buildMarketReport, createMarketTransparency, dueMarkets, readStoredReport, storeReport, TRANSPARENCY_LIMITS } from '../src/market-transparency.mjs'
import { readWalletLinks } from '../src/wallet-clusters.mjs'
import { readSeedFacts, seededLiquidity } from '../src/seeded-liquidity.mjs'
import { checkWalletFunding, dueFundingWallets, FUNDING_LIMITS, readFundingLinks } from '../src/wallet-funding.mjs'
import { loadOperatorReliability } from '../src/operator-reliability.mjs'
import { createWorkerReliability, WRITE_WORKER_SNAPSHOT } from '../src/worker-reliability.mjs'

// Real PostgreSQL with every committed migration (0071_launch_transparency): scheduled launches and their constraints, the launch feed
// and calendar, webhook subscriptions and deliveries, and the stored transparency report built from indexed swaps.
const url = process.env.LAUNCH_TRANSPARENCY_TEST_DATABASE_URL
const wallet = () => Keypair.generate().publicKey.toBase58()
const HOUR = 3_600_000
const SOL = 1_000_000_000n

async function open() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_launch_transparency_test', 'Disposable launch transparency database required')
  const pool = new pg.Pool({ connectionString: url })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query(`truncate launch_webhook_deliveries, launch_webhooks, launch_feed_events, launch_schedules, launch_quality_reports, market_liquidity_samples,
    lp_position_samples, wallet_links, wallet_funding, trade_events, bundles, maintainer_opt_outs, markets, repositories restart identity cascade`)
  return pool
}
const repo = (pool, id, name = `octo/r${id}`, extra = {}) => pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at,github_created_at)
  values($1,'octo',$2,$3,$4,$5,false,now(),$6)`, [String(id), name.split('/')[1], name, extra.stars ?? 150, extra.forks ?? 3, extra.createdAt ?? new Date('2025-01-01')])
const market = (pool, id, { mint = `Mint${id}`, launcher = wallet(), signature = `LaunchSig${id}`, at = new Date(), bundleId = null } = {}) => pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,
    token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at,launch_block_time,bundle_id)
  values($1,'confirmed',$2,$3,$4,'creator','Token','TKN',$5,1,'finalized',$6,$6,$6,$7)`, [String(id), mint, `Pool${id}`, launcher, signature, at, bundleId])

test('real PostgreSQL: scheduled launches are created only by admins, gate every launch, and settle as launched or lapsed', { skip: !url }, async () => {
  const pool = await open()
  try {
    await repo(pool, 11); await repo(pool, 12); await repo(pool, 13)
    const launcher = wallet(), now = Date.now()
    const admin = createLaunchSchedules({ pool, verifyAdmin: async () => ({ githubUserId: 42n, githubLogin: 'maintainer' }) })
    const stranger = createLaunchSchedules({ pool, verifyAdmin: async () => { throw Error('not admin') } })
    const body = (repoId, hours = 2, extra = {}) => ({ repoId: String(repoId), scheduledAt: new Date(now + hours * HOUR).toISOString(), launcherWallet: launcher,
      maxInitialBuyLamports: '250000000', windowMinutes: 30, ...extra })
    await assert.rejects(stranger.create(body(11)), error => error.status === 403)
    const created = await admin.create(body(11))
    assert.equal(created.state, 'upcoming')
    assert.equal(created.announcedBy, 'maintainer')
    await assert.rejects(admin.create(body(11, 3)), error => error.status === 409 && /already has a scheduled launch/.test(error.message), 'one scheduled launch per repository')
    // The table refuses short notice on its own, whatever the application does.
    await assert.rejects(pool.query(`insert into launch_schedules (github_repo_id, scheduled_at, window_minutes, launcher_wallet, github_user_id, github_login)
      values (12, now() + interval '30 minutes', 30, $1, 1, 'x')`, [launcher]), error => error.code === '23514')
    // A repository with a market, a launch in progress, an opt-out or a live Group launch cannot be scheduled.
    await market(pool, 12)
    await assert.rejects(admin.create(body(12)), error => error.status === 409 && /already has a market/.test(error.message))
    await pool.query(`insert into maintainer_opt_outs (github_repo_id, kind, github_user_id) values (13, 'opt_out', 42)`)
    await assert.rejects(admin.create(body(13)), error => error.status === 409 && /opted out/.test(error.message))

    // The gate, against the stored row, as the coordinator calls it.
    await assert.rejects(assertScheduleAllows(pool, '11', { wallet: launcher, initialBuyLamports: '0' }), error => error.code === SCHEDULE_CODES.BEFORE)
    const windowOpen = now + 2 * HOUR + 60_000
    await assert.rejects(assertScheduleAllows(pool, '11', { wallet: wallet(), now: windowOpen }), error => error.code === SCHEDULE_CODES.LAUNCHER)
    await assert.rejects(assertScheduleAllows(pool, '11', { wallet: launcher, initialBuyLamports: '250000001', now: windowOpen }), error => error.code === SCHEDULE_CODES.BUY)
    assert.ok(await assertScheduleAllows(pool, '11', { wallet: launcher, initialBuyLamports: '250000000', now: windowOpen }))
    assert.deepEqual((await upcomingSchedules(pool, { now })).map(row => row.repoId), ['11'])

    // A launch that went through marks the schedule launched; a window that passed without one lapses it.
    await market(pool, 11, { launcher, at: new Date(windowOpen) })
    assert.deepEqual(await reconcileSchedules(pool, now), { launched: 1, lapsed: 0 })
    assert.equal((await pool.query('select status, launched_mint from launch_schedules where github_repo_id = 11')).rows[0].launched_mint, 'Mint11')
    await repo(pool, 14)
    await admin.create(body(14, 1.5))
    assert.deepEqual(await reconcileSchedules(pool, now + 2 * HOUR + 1), { launched: 0, lapsed: 1 })
    assert.equal(await activeSchedule(pool, '14'), null)
    // After the window anyone may launch, but a stranger's market never credits the schedule: it lapses instead.
    await repo(pool, 16)
    await admin.create(body(16, 1.5))
    await market(pool, 16, { at: new Date(now + 2 * HOUR + 5 * 60_000) })
    assert.deepEqual(await reconcileSchedules(pool, now + 2 * HOUR + 10 * 60_000), { launched: 0, lapsed: 1 })
    assert.equal((await pool.query('select status, launched_mint from launch_schedules where github_repo_id = 16')).rows[0].launched_mint, null)
    // The announced wallet's launch still in flight when the window closes keeps the schedule open until it resolves.
    await repo(pool, 17)
    await admin.create(body(17, 1.5))
    await pool.query(`insert into markets(github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol) values (17,'prepared',$1,'creator','T','T')`, [launcher])
    assert.deepEqual(await reconcileSchedules(pool, now + 3 * HOUR), { launched: 0, lapsed: 0 })
    await repo(pool, 15)
    await admin.create(body(15))
    const cancelled = await admin.cancel({ repoId: '15' })
    assert.equal(cancelled.state, 'cancelled')
    await assert.rejects(admin.cancel({ repoId: '15' }), error => error.status === 409)
  } finally { await pool.end() }
})

test('real PostgreSQL: the launch feed records each fact once, in order, leaves out excluded repositories, and feeds the calendar', { skip: !url }, async () => {
  const pool = await open()
  try {
    const now = Date.now(), launcher = wallet()
    for (const id of [21, 22, 23, 24]) await repo(pool, id)
    const admin = createLaunchSchedules({ pool, verifyAdmin: async () => ({ githubUserId: 7n, githubLogin: 'owner' }) })
    await admin.create({ repoId: '21', scheduledAt: new Date(now + 3 * HOUR).toISOString(), launcherWallet: launcher, windowMinutes: 60 })
    await market(pool, 22, { at: new Date(now - HOUR) })
    await market(pool, 23, { at: new Date(now - 2 * HOUR) })
    await pool.query(`insert into bundles (bundle_id, github_repo_id, address, creator_wallet, token_name, token_symbol, target_lamports, min_deposit_lamports, deadline, status)
      values (5, 24, 'BundleAddr', $1, 'Grp', 'GRP', 5000000000, 50000000, now() + interval '2 days', 'raising')`, [launcher])
    const first = await produceFeedEvents(pool, { excluded: new Set(['23']) })
    assert.equal(first.added, 3)
    assert.equal((await produceFeedEvents(pool, { excluded: new Set(['23']) })).added, 0, 'idempotent')
    const events = await readFeedEvents(pool, { limit: 10 })
    assert.deepEqual(events.map(event => event.kind).sort(), ['group_launch.raising', 'launch.scheduled', 'market.launched'])
    assert.ok(events.every(event => event.repoId !== '23'), 'a do-not-promote repository is never in the feed')
    // Polling with ?after returns the following events in id order; kinds and repositories filter.
    const ordered = await readFeedEvents(pool, { after: '0', limit: 10 })
    assert.deepEqual(ordered.map(event => event.id), [...ordered.map(event => event.id)].sort((a, b) => Number(a) - Number(b)))
    assert.deepEqual((await readFeedEvents(pool, { kinds: ['market.launched'], repos: ['22'] })).map(event => event.data.mint), ['Mint22'])
    const scheduled = events.find(event => event.kind === 'launch.scheduled')
    assert.equal(scheduled.data.schedule.launcherWallet, launcher)
    assert.equal(scheduled.data.schedule.state, undefined, 'state is not frozen into the event')
    // When the window opens, that is a new fact.
    assert.equal((await produceFeedEvents(pool, { now: now + 3 * HOUR + 1000 })).added, 2, 'window open, and market 23 now that it is no longer excluded')
    const calendar = await launchCalendar(pool, { now, excluded: new Set(['23']) })
    assert.deepEqual(calendar.scheduled.map(row => row.repoId), ['21'])
    assert.deepEqual(calendar.groupLaunches.map(row => row.bundleId), ['5'])
    assert.deepEqual(calendar.recentLaunches.map(row => [row.repoId, row.quality]), [['22', null]])
  } finally { await pool.end() }
})

test('real PostgreSQL: webhooks start at the newest event, receive matching events once, retry with backoff and pause after repeated failures', { skip: !url }, async () => {
  const pool = await open()
  try {
    await repo(pool, 31); await repo(pool, 32)
    await market(pool, 31, { at: new Date(Date.now() - HOUR) })
    await produceFeedEvents(pool)
    const store = createWebhookStore(pool)
    const hook = await store.create({ githubUserId: '9', githubLogin: 'dev', url: 'https://hooks.example.com/a', kinds: ['market.launched'], repoIds: ['32'] })
    const all = await store.create({ githubUserId: '9', githubLogin: 'dev', url: 'https://hooks.example.com/b' })
    for (let i = 0; i < WEBHOOK_LIMITS.perUser - 2; i++) await store.create({ githubUserId: '9', githubLogin: 'dev', url: `https://hooks.example.com/${i}` })
    await assert.rejects(store.create({ githubUserId: '9', githubLogin: 'dev', url: 'https://hooks.example.com/z' }), error => error.status === 409)
    for (const extra of (await store.list('9')).filter(row => ![hook.id, all.id].includes(row.id))) await store.remove('9', extra.id)
    // Existing events are not replayed to a new subscription.
    assert.deepEqual(await fanOutDeliveries(pool), { webhooks: 2, queued: 0 })
    await market(pool, 32, { at: new Date() })
    await produceFeedEvents(pool)
    assert.deepEqual(await fanOutDeliveries(pool), { webhooks: 2, queued: 2 }, 'both match market 32')
    assert.deepEqual(await fanOutDeliveries(pool), { webhooks: 2, queued: 0 })
    const key = (await import('../src/launch-webhooks.mjs')).signingKey({ LAUNCH_WEBHOOK_SIGNING_KEY: Buffer.alloc(32, 3).toString('base64') })
    let clock = Date.now()
    const sent = []
    const send = async (target, body, headers) => { sent.push({ target, body: JSON.parse(body), headers }); return { status: target.endsWith('/a') ? 204 : 500 } }
    const result = await deliverDue(pool, { send, key, now: () => clock })
    assert.deepEqual(result, { sent: 1, retrying: 1, failed: 0, disabled: 0 })
    assert.equal(sent[0].body.kind, 'market.launched')
    assert.match(sent[0].headers['x-repoing-signature'], /^ed25519=/)
    // Not due again until the backoff passes; then retried until the attempts run out.
    assert.deepEqual(await deliverDue(pool, { send, key, now: () => clock }), { sent: 0, retrying: 0, failed: 0, disabled: 0 })
    for (const wait of WEBHOOK_LIMITS.backoffMs) { clock += wait; await deliverDue(pool, { send, key, now: () => clock }) }
    const { rows: [delivery] } = await pool.query(`select status, attempts from launch_webhook_deliveries where webhook_id = $1`, [all.id])
    assert.deepEqual(delivery, { status: 'failed', attempts: WEBHOOK_LIMITS.attempts })
    // Twenty consecutive failures pause the subscription.
    const paused = await deliverDue(pool, { send, key, now: () => clock, limits: { ...WEBHOOK_LIMITS, disableAfterFailures: 1 } })
    assert.equal(paused.sent, 0)
    await pool.query(`update launch_webhook_deliveries set status = 'pending', next_attempt_at = now() - interval '1 minute', attempts = 0 where webhook_id = $1`, [all.id])
    assert.equal((await deliverDue(pool, { send, key, now: () => Date.now(), limits: { ...WEBHOOK_LIMITS, disableAfterFailures: 7 } })).disabled, 1)
    assert.equal((await store.list('9')).find(row => row.id === all.id).status, 'disabled')
  } finally { await pool.end() }
})

test('real PostgreSQL: the stored report is built from indexed swaps, links and samples; reports and samples are due once per hour', { skip: !url }, async () => {
  const pool = await open()
  try {
    const now = Date.now(), launcher = wallet(), a = wallet(), b = wallet(), c1 = wallet(), c2 = wallet()
    await repo(pool, 41, 'octo/tool', { stars: 500, createdAt: new Date('2024-01-01') })
    await market(pool, 41, { launcher, at: new Date(now - 40 * 86_400_000) })
    let slot = 100
    const swap = (trader, direction, lamports, tokens, minutesAgo, signature = `s${slot}`) => pool.query(`insert into trade_events (pool, signature, event_index, slot, traded_at,
        direction, input_base_units, output_base_units, next_sqrt_price, trader) values ('Pool41', $1, 0, $2, $3, $4, $5, $6, '1', $7)`,
    [signature, slot++, new Date(now - minutesAgo * 60_000), direction, direction === 'buy' ? String(lamports) : String(tokens), direction === 'buy' ? String(tokens) : String(lamports), trader])
    await swap(launcher, 'buy', 100_000_000n, 10_000_000_000_000n, 40 * 1440, 'LaunchSig41')
    await swap(a, 'buy', 2n * SOL, 100_000_000_000_000n, 30 * 1440)
    await swap(b, 'buy', SOL, 50_000_000_000_000n, 20 * 1440)
    await swap(b, 'sell', 900_000_000n, 45_000_000_000_000n, 20 * 1440 - 10)
    await swap(c1, 'buy', 500_000_000n, 25_000_000_000_000n, 1440)
    await swap(c2, 'sell', 500_000_000n, 25_000_000_000_000n, 1440 - 5)
    // c1 and c2 are one controller, by an operator record with evidence.
    const [lo, hi] = [c1, c2].sort()
    await pool.query(`insert into wallet_links (wallet_a, wallet_b, evidence, recorded_by) values ($1, $2, 'Funded by the same wallet in tx abc', 'ops')`, [lo, hi])
    assert.equal((await readWalletLinks(pool, [c1])).length, 1)
    for (let h = 0; h < 24; h++) {
      await pool.query(`insert into market_liquidity_samples (github_repo_id, sampled_at, venue, pool, sqrt_price, fee_bps, quote_reserve_lamports, buy_depth_lamports,
          sell_depth_lamports, spread_bps, two_sided, profile) values (41, $1, 'curve', 'Pool41', 1000, 175, 5000000000, 800000000, 600000000, 380, true, '{"depth":[]}')`,
      [new Date(now - h * HOUR - 60_000)])
    }
    const [row] = await dueMarkets(pool, { kind: 'reports', limit: 5, now, everyMs: HOUR })
    assert.equal(row.githubRepoId, '41')
    const report = await buildMarketReport(pool, row, { now, holderSnapshot: async () => ({ mint: { fixedSupply: true, mintAuthorityRevoked: true, freezeAuthorityRevoked: true },
      holders: { topPercent: 22 }, observedAt: new Date(now).toISOString() }), launchFeeFor: async () => true })
    // Round trips: B 0.9 SOL matched (1.8), the linked C cluster 0.5 matched (1.0); organic: launcher 0.1, A 2.0, B's unmatched 0.1.
    assert.deepEqual(report.integrity.totals, { volume: '5000000000', organic: '2200000000', roundTrip: '2800000000', sameTransaction: '0', labeled: '0', unattributed: '0' })
    assert.equal(report.integrity.traders.linkedControllers, 1)
    const byId = Object.fromEntries(report.criteria.map(item => [item.id, item]))
    assert.equal(byId.organic_volume.status, 'fail', '44% organic')
    assert.equal(byId.launch_buy.value, 'Launcher bought 1% of supply')
    assert.equal(byId.liquidity_depth.status, 'pass')
    assert.equal(byId.maintainer.status, 'fail', 'not verified')
    assert.equal(report.health.liquidity.samples, 24)
    assert.equal(report.health.liquidity.uptimePercent, 100)
    assert.equal(report.health.builderReward.paid, false)
    await storeReport(pool, '41', report)
    assert.equal((await readStoredReport(pool, '41')).score, report.score)
    assert.deepEqual(await dueMarkets(pool, { kind: 'reports', limit: 5, now, everyMs: HOUR }), [], 'not due again within the hour')
    assert.deepEqual(await dueMarkets(pool, { kind: 'liquidity', limit: 5, now, everyMs: HOUR }), [], 'sampled within the hour')
    const seeded = seededLiquidity({ market: { launcherWallet: launcher, launchSignature: 'LaunchSig41', githubRepoId: '41', pool: 'Pool41' }, ...await readSeedFacts(pool,
      { launchSignature: 'LaunchSig41', pool: 'Pool41', githubRepoId: '41' }) })
    assert.deepEqual(seeded.map(entry => [entry.kind, entry.solLamports, entry.percentOfSupply, entry.lock]), [['launch-buy', '100000000', 1, 'unlocked']])
    // The job end to end without RPC: no sampling, but the feed and schedules run and nothing fails.
    const job = createMarketTransparency({ pool, connection: null, resolveConfig: () => null, sampling: false })
    const result = await job.runOnce()
    assert.deepEqual(Object.keys(result).sort(), ['feed', 'schedules'])
    assert.ok(!('error' in result.feed) && !('error' in result.schedules))
  } finally { await pool.end() }
})

test('real PostgreSQL: funding sources link fresh sibling wallets and direct funding, never through a service or a repo.ing wallet', { skip: !url }, async () => {
  const pool = await open()
  try {
    const now = Date.now()
    const [x, y, z, funder, exchange, big, small] = Array.from({ length: 7 }, wallet)
    // A fake RPC: x and y were funded by `funder` in their first transaction; z by x itself; `big` has a long history; `small` was
    // never funded by a transfer (its oldest transaction moves SOL out).
    const firstTx = { [x]: funder, [y]: funder, [z]: x }
    const busy = new Set([big]), historyReads = []
    const connection = {
      getSignaturesForAddress: async key => (historyReads.push(key.toBase58()), busy.has(key.toBase58())) ? Array.from({ length: FUNDING_LIMITS.historyLimit }, (_, i) => ({ signature: `b${i}` }))
        : [{ signature: `new-${key.toBase58()}`, blockTime: 1760000000 }, { signature: `first-${key.toBase58()}`, blockTime: 1750000000 }],
      getParsedTransaction: async signature => {
        const owner = signature.split('-')[1], source = signature.startsWith('first-') ? firstTx[owner] : null
        const transfer = source ? { source, destination: owner, lamports: 50_000_000 } : { source: owner, destination: exchange, lamports: 1 }
        return { meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ programId: '11111111111111111111111111111111', parsed: { type: 'transfer', info: transfer } }] } } }
      },
    }
    for (const w of [x, y, z, big, small]) await checkWalletFunding(pool, connection, w)
    assert.equal(historyReads.filter(key => key === funder).length, 1, 'a funder\'s own history is read once')
    const { rows } = await pool.query('select wallet, status, funder from wallet_funding order by wallet')
    const byWallet = Object.fromEntries(rows.map(row => [row.wallet, [row.status, row.funder]]))
    assert.deepEqual([byWallet[x], byWallet[y], byWallet[z], byWallet[big], byWallet[small]],
      [['found', funder], ['found', funder], ['found', x], ['long-history', null], ['none', null]])
    const links = await readFundingLinks(pool, [x, y, z, small])
    const pairs = links.map(link => [link.a, link.b].sort().join(':')).sort()
    assert.deepEqual(pairs, [[x, y].sort().join(':'), [x, z].sort().join(':')].sort(), 'siblings of one funder, and a trader funding another')
    // A funder that funded many checked wallets is a service: its customers are not linked. A repo.ing wallet's funding is ignored.
    for (let i = 0; i < FUNDING_LIMITS.serviceMinWallets; i++) {
      await pool.query(`insert into wallet_funding (wallet, status, funder, funding_signature) values ($1, 'found', $2, $3)`, [wallet(), funder, `svc${i}`])
    }
    assert.deepEqual((await readFundingLinks(pool, [x, y, z])).map(link => link.kind + ':' + [link.a, link.b].sort().join(':')),
      [`funding:${[x, z].sort().join(':')}`])
    assert.deepEqual(await readFundingLinks(pool, [x, z], { ignoreFunders: new Set([x]) }), [])
    // A funder with a busy history of its own (an exchange hot wallet) never links its customers, however few were checked.
    const [p, q, hot] = [wallet(), wallet(), wallet()]
    busy.add(hot); Object.assign(firstTx, { [p]: hot, [q]: hot })
    for (const w of [p, q]) await checkWalletFunding(pool, connection, w)
    assert.deepEqual(await readFundingLinks(pool, [p, q]), [])
    // Due wallets: active traders above the volume floor, never checked yet.
    await repo(pool, 51); await market(pool, 51)
    for (const [trader, lamports] of [[wallet(), 200_000_000n], [x, 900_000_000n], [wallet(), 50_000_000n]]) {
      await pool.query(`insert into trade_events (pool, signature, event_index, slot, traded_at, direction, input_base_units, output_base_units, next_sqrt_price, trader)
        values ('Pool51', $1, 0, 1, now(), 'buy', $2, '1', '1', $3)`, [`t-${trader}`, lamports.toString(), trader])
    }
    const due = await dueFundingWallets(pool, { now })
    assert.equal(due.length, 1, 'x was checked already and the small trader is under the floor')
  } finally { await pool.end() }
})

test('real PostgreSQL: a chain read that never answers costs one item timeout, and a spent run budget skips the rest', { skip: !url }, async () => {
  const pool = await open()
  try {
    for (const id of [61, 62]) {
      await repo(pool, id); await market(pool, id)
      await pool.query(`insert into graduation_events (github_repo_id, signature, pool, slot, evidence_hash, evidence, reconciliation)
        values ($1, $2, $3, 1, repeat('0', 64), '{}', '{}')`, [String(id), `Mig${id}`, Keypair.generate().publicKey.toBase58()])
    }
    const hang = () => new Promise(() => {})
    const connection = { getAccountInfo: hang, getSlot: hang, getBlockTime: hang, getMultipleAccountsInfo: hang, rpcEndpoint: 'http://127.0.0.1:9' }
    const logged = []
    const job = createMarketTransparency({ pool, connection, resolveConfig: () => null, log: line => logged.push(line),
      limits: { ...TRANSPARENCY_LIMITS, itemTimeoutMs: 150, runBudgetMs: 200 } })
    const started = Date.now()
    const result = await job.runOnce()
    assert.ok(Date.now() - started < 2000, 'the run returns instead of waiting on the chain')
    assert.deepEqual(result.liquidity, { done: 0, failed: 2 })
    assert.deepEqual(result.reports, { skipped: 'RUN_BUDGET' })
    assert.ok(logged.every(line => line.liquiditySampleFailed && /TRANSPARENCY_ITEM_TIMEOUT|DAMM pool unavailable/.test(line.code)))
    // Both markets back off: the next run does not spend its budget on them again.
    assert.deepEqual((await job.runOnce()).liquidity, { done: 0, failed: 0 })
  } finally { await pool.end() }
})

test('real PostgreSQL: reliability reads bounded evidence without payloads or writes', { skip: !url }, async () => {
  const pool = await open(), now = Date.now(), ago = ms => new Date(now - ms)
  try {
    for (const id of [71, 72, 73]) { await repo(pool, id); await market(pool, id, { at: ago(10_000_000) }) }
    await repo(pool, 74)
    await pool.query(`insert into markets (github_repo_id,status,launcher_wallet,creator_wallet,token_name,token_symbol,created_at)
      values (74,'submitted','launcher','creator','Pending','PND',$1)`, [ago(900_001)])
    await pool.query(`insert into launch_quality_reports (github_repo_id, version, assessed_at, score, coverage_percent, report)
      values (71, 1, $1, 10, 20, '{"private":"report-payload"}'), (72, 1, $2, 10, 20, '{}')`, [ago(7_200_000), ago(7_200_001)])
    await pool.query(`insert into market_liquidity_samples (github_repo_id, sampled_at, venue, pool, sqrt_price, fee_bps, buy_depth_lamports, sell_depth_lamports, two_sided, profile)
      values (71,$1,'curve','Pool71',1,100,1,1,true,'{}'), (71,$2,'curve','Pool71',1,100,1,1,true,'{}'), (72,$1,'curve','Pool72',1,100,1,1,true,'{}')`, [ago(7_200_001), ago(0)])
    await pool.query(`insert into launch_webhooks (id, github_user_id, github_login, url, kinds)
      values ('00000000-0000-0000-0000-000000000071', 7, 'private-user', 'https://private.example/token', '{}')`)
    await pool.query(`insert into launch_feed_events (id, kind, dedupe_key, github_repo_id, occurred_at, payload)
      select n, 'market.launched', 'reliability-' || n, 71, now(), '{}' from generate_series(1,4) n`)
    await pool.query(`insert into launch_webhook_deliveries (webhook_id, event_id, status, attempts, next_attempt_at, created_at)
      values ('00000000-0000-0000-0000-000000000071',1,'pending',1,$1,$2),
      ('00000000-0000-0000-0000-000000000071',2,'sending',1,$3,$2),
      ('00000000-0000-0000-0000-000000000071',3,'failed',6,$2,$2),
      ('00000000-0000-0000-0000-000000000071',4,'failed',6,$2,$4)`, [ago(-60_000), ago(0), ago(900_001), ago(86_400_001)])
    const recorder = createWorkerReliability({ now: () => now, write: value => pool.query(WRITE_WORKER_SNAPSHOT, [value]) })
    await recorder.track('transparency', async () => ({ reports: { done: 1, failed: 1 } }))
    await recorder.flush()
    const readOnly = new pg.Pool({ connectionString: url, options: '-c default_transaction_read_only=on', statement_timeout: 2000 })
    try {
      const data = await loadOperatorReliability({ query: (sql, values) => readOnly.query(sql, values), probeRpc: async () => 123, now: () => now, env: {} })
      assert.equal(data.markets.sampled, 3)
      assert.deepEqual([data.markets.reportsStale, data.markets.reportsMissing, data.markets.samplesStale, data.markets.samplesMissing], [1, 1, 1, 1])
      assert.deepEqual([data.pending.count, data.pending.overdue, data.webhooks.overdue, data.webhooks.retrying, data.webhooks.failed24h], [1, 1, 1, 1, 1])
      assert.equal(data.worker.stages[0].state, 'degraded')
      assert.equal(data.database.status, 'ok'); assert.equal(data.rpc.slot, 123)
      assert.doesNotMatch(JSON.stringify(data), /private|report-payload|Pool71/)
      // Enough rows to exceed coverage, without extending the API's response or claiming a fleet total.
      await pool.query(`insert into repositories (github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
        select n, 'fixture', 'r' || n, 'fixture/r' || n, 0, 0, false, now() from generate_series(1000,2001) n`)
      await pool.query(`insert into markets (github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,launch_slot,launch_finality,indexed_at,last_verified_at)
        select n,'confirmed','Mint' || n,'Pool' || n,'launcher','creator','Token','TKN','Sig' || n,1,'finalized',now(),now() from generate_series(1000,2001) n`)
      const capped = await loadOperatorReliability({ query: (sql, values) => readOnly.query(sql, values), now: () => now, env: {} })
      assert.equal(capped.markets.sampled, 1000); assert.equal(capped.markets.truncated, true)
    } finally { await readOnly.end() }
  } finally { await pool.end() }
})
