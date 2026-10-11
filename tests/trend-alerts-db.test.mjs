import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createTrendAlerts, createTrendAlertStore, trendAlertsConfig } from '../src/trend-alerts.mjs'
import { previewTrendAlerts } from '../scripts/trend-alerts-preview.mjs'

// Real PostgreSQL with every committed migration (0068_trend_alerts): which trends are read and posted, claims, retries,
// stale claims, constraints and the lock, then the whole job twice with fake senders.
const url = process.env.TREND_ALERTS_TEST_DATABASE_URL
const HOUR = 3600000

async function seed(pool, now) {
  await pool.query(`truncate trend_alerts, trend_launches, trend_reviews, trend_signals, trend_observations, trend_candidates,
    repository_participation, maintainer_invites, markets, repositories restart identity cascade`)
  const at = hoursAgo => new Date(now - hoursAgo * HOUR)
  const candidate = (id, name) => pool.query(`insert into trend_candidates(github_repo_id,full_name,description,state,observed_at) values($1,$2,$3,'detected',$4)`,
    [id, `acme/${name}`, `${name} <fixture>`, at(0.2)])
  const observe = (id, name, stars, hoursAgo, extra = {}) => pool.query(`insert into trend_observations(github_repo_id,observed_at,evidence,evidence_hash) values($1,$2,$3,$4)`,
    [id, at(hoursAgo), JSON.stringify({ repo: { id: String(id), fullName: `acme/${name}`, stars, forks: 3, ...extra }, observedAt: at(hoursAgo).toISOString(),
      stars, forks: 3, releaseAt: null, activity: { complete: false }, sources: {} }), `hash-${id}-${hoursAgo}`])
  const trend = async (id, name, gained, extra) => { await candidate(id, name); await observe(id, name, 1000 + gained, 0.2, extra); await observe(id, name, 1000, 4.2, extra) }
  await trend(2001, 'rocket', 800)
  await trend(2002, 'slow', 20)
  await trend(2003, 'launched', 900)
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(2003,'acme','launched','acme/launched',1,1,false,now())`)
  await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature)
    values(2003,'confirmed','mint2003','pool2003','l','c','T','T','sig2003')`)
  await trend(2004, 'forked', 900, { forkOf: 'other/upstream' })
  await trend(2005, 'hidden', 900)
  await trend(2006, 'second', 400)
  // Detected two days ago, before the cutoff; every refresh since has moved observed_at past it. Never announced.
  await trend(2007, 'before', 900)
  await pool.query(`update trend_candidates set detected_at=$2 where github_repo_id=$1`, [2007, at(48)])
  // A Group launch raise holds the repository's one market: a launch from the post would be refused.
  await trend(2008, 'raising', 900)
  await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at) values(2008,'acme','raising','acme/raising',1,1,false,now())`)
  await pool.query(`insert into bundles(bundle_id,github_repo_id,address,creator_wallet,token_name,token_symbol,target_lamports,min_deposit_lamports,deadline,status)
    values(2008,2008,'bundle2008','creator','T','T',1000000000,50000000,now() + interval '1 day','raising')`)
}

const sender = () => {
  const sent = []
  let n = 0
  return { sent, send: async message => { sent.push(message); n++; return { status: 'sent', messageId: String(n), messageUrl: `https://t.me/repoing_launches/${n}` } } }
}

test('real PostgreSQL: posts each strong, launchable trend once per channel; claims, retries and stale claims behave', { skip: !url }, async () => {
  const parsed = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.pathname === '/repoing_trend_alerts_test', 'Disposable trend alerts test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    const now = Date.now()
    await seed(pool, now)
    // The preview reads in a rolled-back READ ONLY transaction: the exact texts, nothing claimed.
    const preview = await previewTrendAlerts({ pool, now, env: { PROMOTION_EXCLUDED_REPO_IDS: '2005', DISCOVERY_REWARDS_ENABLED: 'true' } })
    assert.deepEqual(preview.channels.x.posts.map(post => post.repoId), ['2001', '2006'])
    assert.match(preview.text, /TREND ALERTS: OFF \(TREND_ALERTS_ENABLED=true turns it on\)/)
    assert.match(preview.text, /#1 acme\/rocket · \+800 stars in 4h · repo 2001\n      🔥 acme\/rocket: \+800 GitHub stars in 4h, no market yet\./)
    assert.match(preview.text, /launch wallet earns 50% of repo\.ing's trading fees until graduation, 30 days or 2\.5 SOL\./)
    assert.match(preview.text, /\(\d+\/280 weighted characters\)/)
    assert.equal((await pool.query('select count(*)::int as n from trend_alerts')).rows[0].n, 0)
    const store = createTrendAlertStore(pool)
    const config = { ...trendAlertsConfig({ TREND_ALERTS_ENABLED: 'true', TREND_ALERTS_SINCE: new Date(now - 24 * HOUR).toISOString(),
      TELEGRAM_BOT_TOKEN: '1:a', TELEGRAM_CHAT_ID: '@repoing_launches', X_BOT_API_KEY: 'k', X_BOT_API_SECRET: 's', X_BOT_ACCESS_TOKEN: 't', X_BOT_ACCESS_SECRET: 'a' }) }
    const telegram = sender(), x = sender()
    const job = createTrendAlerts({ store, config, senders: { telegram: telegram.send, x: x.send }, sleep: async () => {}, now: () => now,
      excluded: async () => new Set(['2005']) })

    // Run 1: the strongest launchable trend on each channel. Run 2: the next one. Run 3: nothing is left to post.
    const first = await job.runOnce()
    assert.deepEqual(first.posts.map(post => [post.channel, post.repo, post.status]), [['telegram', 'acme/rocket', 'sent'], ['x', 'acme/rocket', 'sent']])
    assert.match(telegram.sent[0].text, /^🔥 acme\/rocket: \+800 GitHub stars in 4h, no market yet\.\nrocket &lt;fixture&gt;\n/)
    assert.equal(x.sent[0].url, `https://repo.ing/launch/2001`)
    const second = await job.runOnce()
    assert.deepEqual(second.posts.map(post => post.repo), ['acme/second', 'acme/second'])
    assert.deepEqual((await job.runOnce()).posts, [], 'slow growth, a market, a fork, a raise, the do-not-promote set and a repo detected before the cutoff are never posted')
    const { rows } = await pool.query(`select github_repo_id::text as repo, channel, status, stars_gained, message_id, sent_at is not null as sent
      from trend_alerts order by github_repo_id, channel`)
    assert.deepEqual(rows.map(row => [row.repo, row.channel, row.status, row.stars_gained, row.sent]),
      [['2001', 'telegram', 'sent', 800, true], ['2001', 'x', 'sent', 800, true], ['2006', 'telegram', 'sent', 400, true], ['2006', 'x', 'sent', 400, true]])
    assert.equal(await store.sentRecently('telegram'), 2)

    // A repository is claimed once per channel; a failed post is re-claimed only while attempts remain.
    assert.equal(await store.claim({ channel: 'telegram', post: { repoId: '2001', starsGained: { delta: 900 } }, maxAttempts: 3 }), null)
    await pool.query(`update trend_alerts set status='failed', sent_at=null, message_id=null, attempts=1, next_attempt_at=now() - interval '1 minute'
      where github_repo_id=2001 and channel='x'`)
    const failed = (await store.channelState('x')).get('2001')
    assert.equal(failed.status, 'failed')
    const retried = await store.claim({ channel: 'x', post: { repoId: '2001', alertId: failed.id, starsGained: { delta: 950 } }, maxAttempts: 3 })
    assert.equal(retried, failed.id)
    const { rows: [again] } = await pool.query(`select status, attempts, stars_gained from trend_alerts where id=$1`, [retried])
    assert.deepEqual([again.status, again.attempts, again.stars_gained], ['sending', 2, 950])
    assert.equal(await store.claim({ channel: 'x', post: { repoId: '2001', alertId: failed.id, starsGained: { delta: 950 } }, maxAttempts: 3 }), null,
      'a claim already sending is never taken twice')

    // A claim left 'sending' by a crashed run becomes 'unknown' and is never retried.
    await pool.query(`update trend_alerts set updated_at=now() - interval '1 hour' where id=$1`, [retried])
    assert.deepEqual((await store.expireStale(10 * 60_000)).map(row => [row.channel, row.mint]), [['x', '2001']])
    assert.equal((await store.channelState('x')).get('2001').status, 'unknown')

    // Constraints: a 'sent' row needs its message id and time; one channel per row from the known set.
    await assert.rejects(pool.query(`insert into trend_alerts(github_repo_id,channel,stars_gained,status) values(9,'x',5,'sent')`), /trend_alerts_sent_check/)
    await assert.rejects(pool.query(`insert into trend_alerts(github_repo_id,channel,stars_gained,status) values(9,'email',5,'sending')`), /trend_alerts_channel_check/)
    await assert.rejects(pool.query(`insert into trend_alerts(github_repo_id,channel,stars_gained,status) values(9,'x',0,'sending')`), /trend_alerts_stars_gained_check/)

    // One run at a time across workers.
    let inner
    const outer = await store.withLock(async () => { inner = await store.withLock(async () => 'ran'); return 'outer' })
    assert.deepEqual([outer, inner], [{ locked: true, value: 'outer' }, { locked: false }])
  } finally { await pool.end() }
})
