import test from 'node:test'
import assert from 'node:assert/strict'
import { X_MAX_WEIGHT, xWeight } from '../src/launch-alerts-message.mjs'
import { LaunchAlertConfigError } from '../src/launch-alerts.mjs'
import { buildMilestoneMessage, GRADUATED_MILESTONE, milestoneOf, planMilestones, solAmount } from '../src/milestone-alerts-message.mjs'
import { createMilestoneAlerts, MILESTONE_ALERT_DEFAULTS, milestoneAlertsConfig } from '../src/milestone-alerts.mjs'
import { graduationColumns, SOL } from './fixtures/graduation-rows.mjs'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const SINCE = new Date('2026-10-01T00:00:00Z')
const ORIGIN = 'https://repo.ing'
const MINT = 'So11111111111111111111111111111111111111112'
const level = (options) => milestoneOf(graduationColumns({ now: NOW, ...options }), NOW)?.milestone ?? null

// ---------- milestone detection ----------
test('milestones come from exact lamport ratios of fresh, verified progress', () => {
  const at = lamports => level({ reserveLamports: lamports, thresholdSol: 100n })
  assert.deepEqual([0n, 24_999_999_999n, 25n * SOL, 49_999_999_999n, 50n * SOL, 74n * SOL, 75n * SOL, 89_999_999_999n, 90n * SOL, 99_999_999_999n].map(at),
    [0, 0, 25, 25, 50, 50, 75, 75, 90, 90])
  assert.equal(level({ reserveSol: 85n, thresholdSol: 340n }), 25, 'each market against its own target')
  assert.equal(level({ reserveSol: 84n, thresholdSol: 340n }), 0)
  const { curve } = milestoneOf(graduationColumns({ now: NOW, reserveSol: 51n, thresholdSol: 85n }), NOW)
  assert.deepEqual([curve.remainingLamports, curve.thresholdLamports], [String(34n * SOL), String(85n * SOL)])
})

test('graduation needs durable migration evidence; migrating, stale and unverified progress announce nothing', () => {
  assert.equal(level({ reserveSol: 85n, graduated: true }), GRADUATED_MILESTONE)
  assert.equal(level({ reserveSol: 85n, graduated: true, proven: false }), null, 'no stored evidence hash')
  assert.equal(level({ reserveSol: 85n }), null, 'target reached but not migrated yet')
  assert.equal(level({ reserveSol: 60n, age: 301_000 }), null, 'stale')
  assert.equal(level({ reserveSol: 60n, age: -60_000 }), null, 'from the future')
  assert.equal(level({ reserveSol: 60n, rowStatus: 'REVIEW' }), null, 'unverified')
  assert.equal(milestoneOf({ status: 'VERIFIED', observation: null }, NOW), null)
  assert.equal(milestoneOf(null, NOW), null)
})

// ---------- planning (no backfill, first crossings only) ----------
const fresh = new Date(NOW - 3600_000), before = new Date(SINCE.getTime() - 1)
const plan = ({ markets, marks = {}, alerts = {}, now = NOW }) => planMilestones({ markets: markets.map(([repo, milestone]) => ({ githubRepoId: repo, milestone })),
  marks: new Map(Object.entries(marks).map(([repo, [milestone, markedAt = fresh]]) => [repo, { milestone, markedAt }])),
  alerts: new Map(Object.entries(alerts)), since: SINCE, now, maxAttempts: 3 })
const ids = result => result.posts.map(p => [p.githubRepoId, p.milestone, ...(p.alertId ? [p.alertId] : [])])

test('the first sight of a market only takes a mark: nothing it had already reached is announced', () => {
  const result = plan({ markets: [['1', 0], ['2', 50], ['3', 90], ['4', 100]] })
  assert.deepEqual(result.posts, [])
  assert.deepEqual(result.marks, [{ githubRepoId: '1', milestone: 0 }, { githubRepoId: '2', milestone: 50 }, { githubRepoId: '3', milestone: 90 }, { githubRepoId: '4', milestone: 100 }])
})

test('a crossing above the mark posts once; a jump posts only the highest milestone', () => {
  assert.deepEqual(ids(plan({ markets: [['1', 25]], marks: { 1: [0] } })), [['1', 25]])
  assert.deepEqual(ids(plan({ markets: [['1', 75]], marks: { 1: [0] } })), [['1', 75]], '20% to 80% posts 75% only')
  assert.deepEqual(ids(plan({ markets: [['1', 100]], marks: { 1: [90] } })), [['1', 100]], 'graduation')
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [50] } })), [], 'at the mark')
  assert.deepEqual(ids(plan({ markets: [['1', 25]], marks: { 1: [50] } })), [], 'below the mark (fell back)')
  assert.deepEqual(plan({ markets: [['1', 75]], marks: { 1: [0] } }).marks, [], 'marks never move while current')
})

test('claimed milestones are never posted again, and never followed by a lower one', () => {
  const sent = milestone => ({ id: `a${milestone}`, milestone, status: 'sent', attempts: 1 })
  assert.deepEqual(ids(plan({ markets: [['1', 25]], marks: { 1: [0] }, alerts: { 1: [sent(25)] } })), [], 'dropped and re-crossed')
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [0] }, alerts: { 1: [sent(75)] } })), [], 'never backwards')
  assert.deepEqual(ids(plan({ markets: [['1', 90]], marks: { 1: [0] }, alerts: { 1: [sent(25), sent(75)] } })), [['1', 90]])
  const unknown = { id: 'u', milestone: 50, status: 'unknown', attempts: 1 }
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [0] }, alerts: { 1: [unknown] } })), [], 'unknown is never retried')
})

test('a failed claim of the current milestone is retried when due; a superseded one is not', () => {
  const failed = (extra = {}) => ({ id: 'f1', milestone: 50, status: 'failed', attempts: 1, nextAttemptAt: new Date(NOW - 1), updatedAt: new Date(NOW - 600_000), ...extra })
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [0] }, alerts: { 1: [failed()] } })), [['1', 50, 'f1']])
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [0] }, alerts: { 1: [failed({ nextAttemptAt: new Date(NOW + 60_000) })] } })), [], 'not due yet')
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [0] }, alerts: { 1: [failed({ attempts: 3 })] } })), [], 'attempts used up')
  assert.deepEqual(ids(plan({ markets: [['1', 75]], marks: { 1: [0] }, alerts: { 1: [failed()] } })), [['1', 75]], 'a higher milestone replaces it')
  const sent75 = { id: 's75', milestone: 75, status: 'sent', attempts: 1 }
  assert.deepEqual(ids(plan({ markets: [['1', 50]], marks: { 1: [0] }, alerts: { 1: [failed(), sent75] } })), [], 'never retried after a higher post')
})

test('a mark from before the cutoff is re-taken at the current milestone (never lowered) instead of posting', () => {
  const result = plan({ markets: [['1', 75], ['2', 0], ['3', 50]], marks: { 1: [25, before], 2: [50, before], 3: [25] } })
  assert.deepEqual(result.marks, [{ githubRepoId: '1', milestone: 75 }, { githubRepoId: '2', milestone: 50 }])
  assert.deepEqual(ids(result), [['3', 50]])
  const failedOld = { id: 'f', milestone: 75, status: 'failed', attempts: 1, nextAttemptAt: new Date(NOW - 1) }
  assert.deepEqual(ids(plan({ markets: [['1', 75]], marks: { 1: [75] }, alerts: { 1: [failedOld] } })), [], 'a re-taken mark also stops older retries')
})

test('graduations go first, then higher milestones', () => {
  const result = plan({ markets: [['1', 25], ['2', 100], ['3', 75], ['4', 25]], marks: { 1: [0], 2: [90], 3: [0], 4: [0] } })
  assert.deepEqual(ids(result), [['2', 100], ['3', 75], ['1', 25], ['4', 25]])
})

// ---------- messages ----------
const POST = { githubRepoId: '7', fullName: 'New1Direction/webmcp-anything', tokenSymbol: 'RCAT', mint: MINT, milestone: 50,
  curve: { remainingLamports: String(42_500_000_000n), thresholdLamports: String(85n * SOL) } }

test('milestone and graduation posts are short, factual and link the token page', () => {
  const telegram = buildMilestoneMessage(POST, { channel: 'telegram', origin: ORIGIN })
  assert.equal(telegram, `📈 $RCAT passed 50% of the way to graduating on repo.ing — 42.5 SOL to go.\nNew1Direction/webmcp-anything\nhttps://repo.ing/token/${MINT}`)
  assert.equal(buildMilestoneMessage(POST, { channel: 'x', origin: ORIGIN }), telegram)
  const graduated = buildMilestoneMessage({ ...POST, milestone: 100, curve: { remainingLamports: '0', thresholdLamports: String(85n * SOL) } }, { channel: 'x', origin: ORIGIN })
  assert.equal(graduated, `🎓 $RCAT graduated to Meteora after reaching its 85 SOL target on repo.ing.\nNew1Direction/webmcp-anything\nhttps://repo.ing/token/${MINT}`)
  for (const text of [telegram, graduated]) assert.doesNotMatch(text, /price|moon|profit|guarantee|100x|pump|buy now/i)
  assert.throws(() => buildMilestoneMessage({ ...POST, milestone: 60 }, { channel: 'x', origin: ORIGIN }), /Unknown milestone/)
  assert.throws(() => buildMilestoneMessage(POST, { channel: 'email', origin: ORIGIN }), /Unknown/)
})

test('repository text is reduced to safe characters, HTML-escaped for Telegram and within 280 weighted characters on X', () => {
  const hostile = { ...POST, fullName: 'a/<b>"x"&@everyone #tag', tokenSymbol: '<i>$X' }
  const telegram = buildMilestoneMessage(hostile, { channel: 'telegram', origin: ORIGIN })
  assert.match(telegram, /^📈 \$iX passed/)
  assert.equal(telegram.split('\n')[1], 'a/bxeveryonetag')
  assert.doesNotMatch(telegram, /[<>"]|@|#/)
  assert.equal(buildMilestoneMessage({ ...POST, tokenSymbol: '' }, { channel: 'x', origin: ORIGIN }).split('\n')[0],
    '📈 New1Direction/webmcp-anything passed 50% of the way to graduating on repo.ing — 42.5 SOL to go.', 'no ticker: the repository names it')
  const longest = { ...POST, fullName: `${'o'.repeat(39)}/${'r.io'.repeat(40)}`, tokenSymbol: 'S'.repeat(16), curve: { remainingLamports: String(339_999n * SOL), thresholdLamports: String(340_000n * SOL) } }
  for (const milestone of [25, 50, 75, 90, 100]) {
    const text = buildMilestoneMessage({ ...longest, milestone }, { channel: 'x', origin: ORIGIN })
    assert.ok(xWeight(text) <= X_MAX_WEIGHT, `${xWeight(text)} for ${milestone}`)
    assert.ok(text.endsWith(`\nhttps://repo.ing/token/${MINT}`))
  }
})

test('SOL amounts never read as zero or overstate precision', () => {
  assert.deepEqual(['0', '1', '9999999', '10000000', '42500000000', '1234567890123', String(85n * SOL)].map(solAmount), ['0', '<0.01', '<0.01', '0.01', '42.5', '1,234.57', '85'])
})

// ---------- configuration ----------
const TG = { TELEGRAM_BOT_TOKEN: '123:SECRET-token', TELEGRAM_CHAT_ID: '@repoing_launches' }
const X = { X_BOT_API_KEY: 'k', X_BOT_API_SECRET: 's', X_BOT_ACCESS_TOKEN: 't', X_BOT_ACCESS_SECRET: 'a' }
const ON = { GRADUATION_ALERTS_ENABLED: 'true', GRADUATION_ALERTS_SINCE: '2026-10-01T00:00:00Z' }

test('milestone alerts are off by default and need the switch, a cutoff and a fully configured channel', () => {
  assert.equal(milestoneAlertsConfig({}), null)
  assert.equal(milestoneAlertsConfig({ ...TG, GRADUATION_ALERTS_SINCE: '2026-10-01T00:00:00Z', LAUNCH_ALERTS_ENABLED: 'true' }), null, 'own master switch')
  assert.equal(milestoneAlertsConfig(ON), null, 'no channel')
  assert.throws(() => milestoneAlertsConfig({ ...TG, GRADUATION_ALERTS_ENABLED: 'true' }), /GRADUATION_ALERTS_SINCE/)
  assert.throws(() => milestoneAlertsConfig({ ...TG, ...ON, GRADUATION_ALERTS_SINCE: 'tomorrow' }), /GRADUATION_ALERTS_SINCE/)
  assert.throws(() => milestoneAlertsConfig({ ...ON, X_BOT_API_KEY: 'k' }), LaunchAlertConfigError)
  assert.throws(() => milestoneAlertsConfig({ ...TG, ...ON, GRADUATION_ALERTS_MAX_PER_DAY: '501' }), /GRADUATION_ALERTS_MAX_PER_DAY/)
  assert.throws(() => milestoneAlertsConfig({ ...TG, ...ON, APP_ORIGIN: 'http://repo.ing' }), /HTTPS/)
  try { milestoneAlertsConfig({ ...ON, TELEGRAM_BOT_TOKEN: TG.TELEGRAM_BOT_TOKEN }) } catch (error) { assert.doesNotMatch(error.message, /SECRET/) }
  const config = milestoneAlertsConfig({ ...TG, ...X, ...ON, GRADUATION_ALERTS_MAX_PER_DAY: '4' })
  assert.deepEqual([config.channels, config.since.toISOString(), config.origin, config.maxPerDay, config.maxPerRun], [['telegram', 'x'], '2026-10-01T00:00:00.000Z', 'https://repo.ing', 4, 2])
  assert.deepEqual(config.telegram, { token: '123:SECRET-token', chatId: '@repoing_launches' })
  assert.equal(milestoneAlertsConfig({ ...X, ...ON }).maxPerDay, MILESTONE_ALERT_DEFAULTS.maxPerDay)
  assert.equal(config.excluded.size, 0)
  assert.deepEqual([...milestoneAlertsConfig({ ...TG, ...ON, PROMOTION_EXCLUDED_REPO_IDS: ' 5, 6,x,' }).excluded], ['5', '6'], 'the do-not-promote list')
})

// ---------- job (in-memory store mirroring the SQL semantics) ----------
function memoryStore({ progress, now }) {
  const alerts = [], marks = new Map()
  let locked = false, nextId = 1
  const store = {
    alerts, marks,
    async withLock(fn) { if (locked) return { locked: false }; locked = true; try { return { locked: true, value: await fn() } } finally { locked = false } },
    async expireStale(ms) {
      const stale = alerts.filter(a => a.status === 'sending' && a.updatedAt < now() - ms)
      for (const a of stale) Object.assign(a, { status: 'unknown', updatedAt: now() })
      return stale
    },
    async sentRecently(channel) { return alerts.filter(a => a.channel === channel && ['sending', 'sent', 'unknown'].includes(a.status) && a.updatedAt > now() - 86_400_000).length },
    async progressRows() { return progress() },
    async channelState(channel) {
      const byRepo = new Map()
      for (const a of alerts.filter(row => row.channel === channel)) byRepo.set(a.repo, [...byRepo.get(a.repo) ?? [], { ...a, githubRepoId: a.repo }])
      return { marks: new Map([...marks].filter(([key]) => key.endsWith(`:${channel}`)).map(([key, mark]) => [key.split(':')[0], { ...mark }])), alerts: byRepo }
    },
    async mark(channel, list, since) {
      for (const { githubRepoId, milestone } of list) {
        const key = `${githubRepoId}:${channel}`, old = marks.get(key)
        if (!old) marks.set(key, { milestone, markedAt: new Date(now()) })
        else if (old.markedAt < since) marks.set(key, { milestone: Math.max(old.milestone, milestone), markedAt: new Date(now()) })
      }
    },
    async forgetMarks(repoIds) {
      for (const key of [...marks.keys()]) if (repoIds.includes(key.split(':')[0])) marks.delete(key)
    },
    async claim({ channel, post, maxAttempts }) {
      if (post.alertId) {
        const a = alerts.find(row => row.id === post.alertId && row.status === 'failed' && row.attempts < maxAttempts)
        if (!a) return null
        Object.assign(a, { status: 'sending', attempts: a.attempts + 1, updatedAt: now() })
        return a.id
      }
      if (alerts.some(row => row.repo === post.githubRepoId && row.channel === channel && row.milestone >= post.milestone)) return null
      alerts.push({ id: nextId++, repo: post.githubRepoId, channel, milestone: post.milestone, status: 'sending', attempts: 1, updatedAt: now() })
      return nextId - 1
    },
    async finish(id, outcome) {
      const a = alerts.find(row => row.id === id && row.status === 'sending')
      if (a) Object.assign(a, { status: outcome.status, updatedAt: now(), nextAttemptAt: outcome.nextAttemptAt ?? null })
    },
  }
  return store
}

// Markets keyed by repo id; set(repo, reserveSol) moves one. Observations are always fresh at the current clock.
function setup({ channels = ['telegram'], outcomes = {}, config = {}, start = NOW } = {}) {
  let clock = start
  const now = () => clock
  const markets = new Map()
  const progress = () => [...markets].map(([repo, { reserveSol, graduated, stale }]) => ({ githubRepoId: repo, mint: `${MINT.slice(0, -2)}${repo.padStart(2, '0')}`,
    tokenSymbol: `R${repo}`, fullName: `octo/repo-${repo}`, ...graduationColumns({ now: clock, reserveSol, thresholdSol: 100n, graduated, age: stale ? 400_000 : 5_000 }) }))
  const store = memoryStore({ progress, now })
  const sent = [], sleeps = []
  const senders = Object.fromEntries(channels.map(channel => [channel, async ({ text }) => {
    const [, repo] = text.match(/octo\/repo-(\d+)/)
    const milestone = text.includes('graduated') ? 100 : Number(text.match(/passed (\d+)%/)[1])
    assert.equal(store.alerts.find(a => a.repo === repo && a.channel === channel && a.milestone === milestone).status, 'sending', 'claimed before sending')
    sent.push([channel, repo, milestone])
    const queue = outcomes[channel]
    return (Array.isArray(queue) ? queue.shift() : undefined) ?? { status: 'sent', messageId: String(sent.length), messageUrl: `https://example.test/${sent.length}` }
  }]))
  const job = createMilestoneAlerts({ store, senders, now, sleep: async ms => { sleeps.push(ms) },
    config: { ...MILESTONE_ALERT_DEFAULTS, channels, since: SINCE, origin: ORIGIN, ...config } })
  return { job, store, sent, sleeps, markets, set: (repo, reserveSol, extra = {}) => markets.set(repo, { reserveSol, ...extra }), tick: ms => { clock += ms } }
}

test('turning the job on never announces crossings that already happened', async () => {
  const { job, sent, set, store } = setup({ channels: ['telegram', 'x'] })
  set('1', 10n); set('2', 60n); set('3', 95n); set('4', 100n, { graduated: true })
  assert.deepEqual(await job.runOnce(), { posts: [], interrupted: [] })
  assert.deepEqual(sent, [])
  assert.deepEqual([...store.marks].map(([key, mark]) => [key, mark.milestone]),
    [['1:telegram', 0], ['2:telegram', 50], ['3:telegram', 90], ['4:telegram', 100], ['1:x', 0], ['2:x', 50], ['3:x', 90], ['4:x', 100]])
  assert.deepEqual((await job.runOnce()).posts, [], 'still nothing new')
})

test('new crossings post once per channel, spaced out, and are never repeated', async () => {
  const { job, sent, sleeps, set, tick } = setup({ channels: ['telegram', 'x'] })
  set('1', 10n); set('2', 40n); set('3', 85n)
  await job.runOnce()
  tick(60_000); set('1', 26n); set('2', 80n); set('3', 85n, { graduated: true })
  const run = await job.runOnce()
  assert.deepEqual(run.posts.map(p => [p.channel, p.repo, p.milestone, p.status]), [['telegram', 'octo/repo-3', 100, 'sent'], ['telegram', 'octo/repo-2', 75, 'sent'],
    ['x', 'octo/repo-3', 100, 'sent'], ['x', 'octo/repo-2', 75, 'sent']], 'graduation first; at most two per channel per run')
  assert.deepEqual(sleeps, [MILESTONE_ALERT_DEFAULTS.spacingMs, MILESTONE_ALERT_DEFAULTS.spacingMs])
  tick(60_000)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.channel, p.repo, p.milestone]), [['telegram', 'octo/repo-1', 25], ['x', 'octo/repo-1', 25]])
  tick(60_000); set('1', 20n)
  await job.runOnce(); tick(60_000); set('1', 30n)
  assert.deepEqual((await job.runOnce()).posts, [], 'dropping back and re-crossing posts nothing')
  assert.equal(sent.length, 6)
})

test('do-not-promote repositories are never marked or posted; taken off the list, they start from a fresh mark', async () => {
  const excluded = new Set(['2'])
  const { job, sent, set, tick, store } = setup({ config: { excluded } })
  set('1', 10n); set('2', 10n); await job.runOnce()
  tick(60_000); set('1', 30n); set('2', 60n)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.repo, p.milestone]), [['octo/repo-1', 25]])
  assert.deepEqual([...store.marks.keys()], ['1:telegram'])
  excluded.delete('2')
  tick(60_000)
  assert.deepEqual((await job.runOnce()).posts, [], 'nothing from its excluded time is announced')
  assert.equal(store.marks.get('2:telegram').milestone, 50)
  tick(60_000); set('2', 80n)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.repo, p.milestone]), [['octo/repo-2', 75]])
  assert.equal(sent.length, 2)
})

test('a repository listed after it was marked loses its marks, so taking it off the list announces nothing from its excluded time', async () => {
  const excluded = new Set()
  const { job, sent, set, tick, store } = setup({ channels: ['telegram', 'x'], config: { excluded } })
  const marks = () => [...store.marks].map(([key, mark]) => [key, mark.milestone])
  set('1', 10n); await job.runOnce()
  assert.deepEqual(marks(), [['1:telegram', 0], ['1:x', 0]])
  excluded.add('1')
  tick(60_000); set('1', 80n)
  assert.deepEqual((await job.runOnce()).posts, [])
  assert.deepEqual(marks(), [], 'dropped on every channel')
  excluded.delete('1')
  tick(60_000)
  assert.deepEqual((await job.runOnce()).posts, [], 'its 75% crossing happened while it was listed')
  assert.deepEqual(marks(), [['1:telegram', 75], ['1:x', 75]])
  tick(60_000); set('1', 91n)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.channel, p.repo, p.milestone]), [['telegram', 'octo/repo-1', 90], ['x', 'octo/repo-1', 90]])
  assert.equal(sent.length, 2)
})

test('stale or unverified progress is skipped entirely: no marks, no posts', async () => {
  const { job, sent, set, store, tick } = setup()
  set('1', 60n, { stale: true })
  await job.runOnce()
  assert.equal(store.marks.size, 0)
  tick(60_000); set('1', 60n)
  await job.runOnce()
  assert.deepEqual([...store.marks.values()].map(m => m.milestone), [50], 'first fresh sight marks it')
  assert.deepEqual(sent, [])
})

test('a channel added later starts from its own marks', async () => {
  const first = setup({ channels: ['telegram'] })
  first.set('1', 10n); await first.job.runOnce()
  first.tick(60_000); first.set('1', 30n)
  assert.equal((await first.job.runOnce()).posts.length, 1)
  const both = createMilestoneAlerts({ store: first.store, now: () => NOW + 120_000, sleep: async () => {},
    senders: { telegram: async () => ({ status: 'sent', messageId: '9' }), x: async () => assert.fail('x must not post an old crossing') },
    config: { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram', 'x'], since: SINCE, origin: ORIGIN } })
  assert.deepEqual((await both.runOnce()).posts, [])
  assert.equal(first.store.marks.get('1:x').milestone, 25)
})

test('per-run and per-day caps hold back the rest for later runs', async () => {
  const { job, sent, set, tick } = setup({ config: { maxPerRun: 2, maxPerDay: 3 } })
  for (let repo = 1; repo <= 5; repo++) set(String(repo), 0n)
  await job.runOnce()
  tick(60_000); for (let repo = 1; repo <= 5; repo++) set(String(repo), 30n)
  assert.equal((await job.runOnce()).posts.length, 2)
  tick(60_000)
  assert.equal((await job.runOnce()).posts.length, 1)
  tick(60_000)
  assert.equal((await job.runOnce()).posts.length, 0, 'daily cap reached')
  tick(86_400_000)
  assert.equal((await job.runOnce()).posts.length, 2)
  assert.equal(sent.length, 5)
})

test('concurrent runs never post the same milestone twice', async () => {
  const { job, sent, set, tick, store } = setup()
  set('1', 0n); set('2', 0n); await job.runOnce()
  tick(60_000); set('1', 55n); set('2', 55n)
  const results = await Promise.all([job.runOnce(), job.runOnce()])
  assert.deepEqual(results.map(r => r.skipped).filter(Boolean), ['LOCKED'])
  assert.equal(sent.length, 2)
  store.withLock = async fn => ({ locked: true, value: await fn() })
  set('3', 0n); await job.runOnce(); tick(60_000); set('3', 77n)
  await Promise.all([job.runOnce(), job.runOnce(), job.runOnce()])
  assert.equal(sent.filter(([, repo]) => repo === '3').length, 1, 'the claim is the gate')
})

test('ambiguous outcomes are never retried; rejections retry after a delay, capped', async () => {
  const failed = { status: 'failed', error: 'HTTP 429', retryAfterMs: 900_000 }
  const { job, sent, set, tick, store } = setup({ outcomes: { telegram: [{ status: 'unknown', error: 'network: timeout' }, failed, failed, failed] } })
  set('1', 0n); set('2', 0n); await job.runOnce()
  tick(60_000); set('1', 30n); set('2', 52n)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.repo, p.status]), [['octo/repo-2', 'unknown']], 'the channel pauses after a failure')
  tick(60_000)
  assert.deepEqual((await job.runOnce()).posts.map(p => [p.repo, p.status]), [['octo/repo-1', 'failed']])
  tick(MILESTONE_ALERT_DEFAULTS.retryDelayMs)
  assert.deepEqual((await job.runOnce()).posts, [], 'the provider reset (15 min) is honoured')
  for (let i = 0; i < 4; i++) { tick(900_000); await job.runOnce() }
  assert.deepEqual(store.alerts.map(a => [a.repo, a.milestone, a.status, a.attempts]), [['2', 50, 'unknown', 1], ['1', 25, 'failed', 3]])
  assert.deepEqual(sent.map(([, repo]) => repo), ['2', '1', '1', '1'])
})

test('a claim left "sending" by a crashed run becomes unknown and is never re-sent', async () => {
  const { job, sent, set, tick, store } = setup()
  set('1', 0n); await job.runOnce()
  tick(60_000); set('1', 30n)
  await store.claim({ channel: 'telegram', post: { githubRepoId: '1', milestone: 25 }, maxAttempts: 3 })
  assert.deepEqual((await job.runOnce()).posts, [])
  tick(MILESTONE_ALERT_DEFAULTS.staleSendingMs + 1)
  assert.equal((await job.runOnce()).interrupted.length, 1)
  assert.deepEqual(sent, [])
  assert.equal(store.alerts[0].status, 'unknown')
})

test('nothing runs before the cutoff; a throwing sender is unknown; a missing table skips quietly', async () => {
  const early = setup({ start: SINCE.getTime() - 60_000 })
  early.set('1', 30n)
  assert.equal((await early.job.runOnce()).skipped, 'BEFORE_SINCE')
  assert.equal(early.store.marks.size, 0)
  const { store, set, tick } = setup()
  set('1', 0n)
  const broken = createMilestoneAlerts({ store, now: () => NOW + 60_000, sleep: async () => {}, senders: { telegram: async () => { throw Error('boom') } },
    config: { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram'], since: SINCE, origin: ORIGIN } })
  await broken.runOnce(); tick(60_000); set('1', 30n)
  assert.deepEqual((await broken.runOnce()).posts.map(p => p.status), ['unknown'])
  const missing = createMilestoneAlerts({ store: { withLock: async () => { throw Object.assign(Error('relation "milestone_alerts" does not exist'), { code: '42P01' }) } },
    config: { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram'], since: SINCE, origin: ORIGIN }, senders: {}, now: () => NOW })
  assert.deepEqual(await missing.runOnce(), { skipped: 'MILESTONE_ALERTS_NOT_MIGRATED' })
})
