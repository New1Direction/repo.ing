import test from 'node:test'
import assert from 'node:assert/strict'
import { cliOptions, previewAlerts, previewSettings, readOnly } from '../scripts/alerts-preview.mjs'
import { HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { LaunchAlertConfigError } from '../src/launch-alerts.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

// scripts/alerts-preview.mjs against a fake PostgreSQL that records every statement and answers like the real tables:
// the preview must select exactly what the jobs would, print their exact texts, and run nothing but SELECTs inside one
// READ ONLY transaction that it rolls back.
const NOW = Date.parse('2026-10-03T12:00:00Z'), HOUR = 3600_000
const MINT_A = 'So11111111111111111111111111111111111111112', MINT_B = 'GPT2Mint1111111111111111111111111111111111'
const MODEL_ID = '4503599627370497', GPT2_HF_ID = '621ffdc036468d709f17434d'
const old = new Date(NOW - 400 * 86_400_000)
const graduation = (percent, mint) => {
  const columns = graduationColumns({ mint, reserveLamports: 850_000_000n * BigInt(percent), now: NOW })
  return { graduationStatus: columns.status, observation: columns.observation, graduationError: columns.error_code, migrationEvidenceHash: columns.migration_evidence_hash }
}
const none = { graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null, hfId: null, modelPath: null, alertId: null }
// Launch candidates as the store's SQL returns them, oldest first.
const CANDIDATES = [
  { ...none, githubRepoId: '7', mint: 'NewRepoMint', tokenSymbol: 'NEW', fullName: 'octo/brand-new', description: null, stars: 2, githubCreatedAt: new Date(NOW - 86_400_000), indexedAt: new Date(NOW - 4 * HOUR) },
  { ...none, githubRepoId: '99', mint: 'OptedOutMint', tokenSymbol: 'OUT', fullName: 'octo/opted-out', description: null, stars: 900, githubCreatedAt: old, indexedAt: new Date(NOW - 3 * HOUR) },
  { ...none, githubRepoId: '42', mint: MINT_A, tokenSymbol: 'HELLO', fullName: 'octo/hello-world', description: 'A friendly greeter.', stars: 12_345, githubCreatedAt: old, indexedAt: new Date(NOW - 2 * HOUR) },
  { ...none, ...graduation(30, MINT_B), githubRepoId: MODEL_ID, mint: MINT_B, tokenSymbol: 'GPT2', fullName: 'openai-community/gpt2', description: 'Text generation · License: mit',
    stars: 0, githubCreatedAt: null, indexedAt: new Date(NOW - HOUR), hfId: GPT2_HF_ID, modelPath: 'openai-community/gpt2' },
]
// Milestone progress rows (threshold 100 SOL) and this channel's marks: 42 crossed 50 since its 25 mark, the model 75 since
// its 50 mark, and 43 is seen for the first time.
const progress = (id, mint, symbol, name, reserveSol, extra = {}) => ({ githubRepoId: id, mint, tokenSymbol: symbol, fullName: name, modelPath: null,
  ...graduationColumns({ mint, reserveSol, thresholdSol: 100n, now: NOW }), ...extra })
const PROGRESS = [progress('42', MINT_A, 'HELLO', 'octo/hello-world', 55n), progress('43', 'Mint43', 'R43', 'octo/repo-43', 30n),
  progress(MODEL_ID, MINT_B, 'GPT2', 'openai-community/gpt2', 80n, { modelPath: 'openai-community/gpt2' })]
const MARKS = [{ githubRepoId: '42', milestone: 25, markedAt: new Date(NOW - HOUR) }, { githubRepoId: MODEL_ID, milestone: 50, markedAt: new Date(NOW - HOUR) }]
const isModel = id => BigInt(id) > 4503599627370496n

function fakePostgres({ launchSent = {}, milestoneSent = {} } = {}) {
  const statements = [], outside = []
  let released = 0
  const answer = (text, params = []) => {
    const sql = text.replace(/\s+/g, ' ').trim()
    statements.push(sql)
    if (sql === 'begin transaction read only' || sql === 'rollback' || sql.includes('set_config(')) return { rows: [] }
    if (sql.includes('from maintainer_opt_outs')) return { rows: [{ repoId: '99' }] }
    if (sql.startsWith('select count(*)::int as n from launch_alerts')) return { rows: [{ n: launchSent[params[0]] ?? 0 }] }
    if (sql.startsWith('select count(*)::int as n from milestone_alerts')) return { rows: [{ n: milestoneSent[params[0]] ?? 0 }] }
    if (sql.includes('left join launch_alerts a')) {
      const [, since, , , limit, offset, sources] = params
      return { rows: CANDIDATES.filter(row => row.indexedAt >= since && (sources.includes('huggingface') || !isModel(row.githubRepoId))).slice(offset, offset + limit) }
    }
    if (sql.includes('as migration_evidence_hash')) return { rows: PROGRESS.filter(row => params[0].includes('huggingface') || !isModel(row.githubRepoId)) }
    if (sql.includes('from milestone_alert_marks')) return { rows: MARKS }
    if (sql.includes('from milestone_alerts where channel')) return { rows: [] }
    throw Error(`unexpected query: ${sql}`)
  }
  return { statements, outside, released: () => released,
    async connect() { return { query: async (text, params) => answer(text, params), release: () => { released++ } } },
    async query(text) { outside.push(text); throw Error('a query ran outside the read-only transaction') } }
}
const ENV = { HF_MARKETS_ENABLED: 'true', PROMOTION_EXCLUDED_REPO_IDS: '', LAUNCH_ALERTS_ENABLED: 'true', LAUNCH_ALERTS_SINCE: '2026-10-03T00:00:00Z',
  GRADUATION_ALERTS_ENABLED: 'true', GRADUATION_ALERTS_SINCE: '2026-10-03T09:00:00Z', TELEGRAM_BOT_TOKEN: '7012345678:SECRET', TELEGRAM_CHAT_ID: '@repoing_launches' }
const likes = async market => market.hfId === GPT2_HF_ID ? { likes: 3149, downloads30d: 12_400_000, modelPath: market.modelPath } : null
const texts = (rows) => rows.map(row => row.text ?? row.error)

test('the preview runs only SELECTs, inside one READ ONLY transaction that it rolls back, and never takes a lock', async () => {
  // Arrange
  const pool = fakePostgres()

  // Act
  await previewAlerts({ pool, env: ENV, now: NOW, modelFacts: likes })

  // Assert
  const { statements } = pool
  assert.equal(statements[0], 'begin transaction read only')
  assert.equal(statements.at(-1), 'rollback')
  for (const sql of statements.slice(1, -1)) {
    assert.match(sql, /^select /i)
    assert.doesNotMatch(sql, /\b(insert|update|delete|merge|truncate|alter|create|drop|grant|lock|copy|call)\b|advisory|for (no key )?update|for share/i)
  }
  assert.equal(statements.filter(sql => sql === 'rollback').length, 1)
  assert.deepEqual(pool.outside, [], 'every read went through the read-only transaction')
  assert.equal(pool.released(), 1)
})

test('the preview shows the exact texts the next runs would send, chosen by the jobs\' own rules', async () => {
  // Arrange
  const pool = fakePostgres({ launchSent: { x: 14 } })

  // Act
  const preview = await previewAlerts({ pool, env: ENV, now: NOW, modelFacts: likes })

  // Assert: launch alerts, oldest first, past the do-not-promote list and the promotion gate; X has one post left today.
  const github = `🚀 New on repo.ing: octo/hello-world — $HELLO\n⭐ 12.3k · A friendly greeter.\nEvery trade pays the repo's builders.\nhttps://repo.ing/token/${MINT_A}`
  const model = '🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2\n❤️ 3.1k likes · Text generation · License: mit\n'
    + `Every trade pays the model's owner.\n${HF_DISCLAIMER_SHORT}\nhttps://repo.ing/token/${MINT_B}`
  assert.deepEqual(texts(preview.launch.telegram.markets), [github, model])
  assert.deepEqual(texts(preview.launch.x.markets), [github], '15 a day, 14 sent: one left')
  assert.deepEqual(preview.launch.telegram.held.map(market => [market.fullName, market.reason]), [['octo/brand-new', 'not earned yet'], ['octo/opted-out', 'do-not-promote']])
  // Milestones: the first sight of 43 only marks; the model's 75% goes before 42's 50%.
  assert.deepEqual(preview.graduation.telegram.marks, [{ githubRepoId: '43', milestone: 25 }])
  assert.deepEqual(texts(preview.graduation.x.posts), [
    `📈 $GPT2 passed 75% of the way to graduating on repo.ing — 20 SOL to go.\nHugging Face model openai-community/gpt2\n${HF_DISCLAIMER_SHORT}\nhttps://repo.ing/token/${MINT_B}`,
    `📈 $HELLO passed 50% of the way to graduating on repo.ing — 45 SOL to go.\nocto/hello-world\nhttps://repo.ing/token/${MINT_A}`])
  // The printed preview carries every text, the X weight and where each setting came from.
  assert.match(preview.text, /^repo\.ing alerts preview at 2026-10-03T12:00:00\.000Z\. Read only: nothing was claimed, locked or sent\.\n/)
  assert.match(preview.text, /Channels configured on this service: telegram \(texts are shown for both\)\./)
  assert.match(preview.text, /LAUNCH ALERTS: ON\. Markets indexed from 2026-10-03T00:00:00\.000Z and in the last 24 hours; at most 15 per channel per 24 hours, 2 per run\./)
  assert.match(preview.text, /  x \(not configured on this service: nothing would be sent\): 14 sent in the last 24 hours, so the next run posts at most 1\n/)
  assert.match(preview.text, /#2 openai-community\/gpt2 \(\$GPT2\) · market 4503599627370497 · indexed 2026-10-03T11:00:00\.000Z · live Hugging Face facts\n/)
  assert.match(preview.text, /      ❤️ 3\.1k likes · Text generation · License: mit\n/)
  assert.match(preview.text, /https:\/\/repo\.ing\/token\/So11111111111111111111111111111111111111112\n      \(153\/280 weighted characters\)\n/, 'X texts carry their weight')
  assert.match(preview.text, /passed over while filling this run: octo\/brand-new \(not earned yet\), octo\/opted-out \(do-not-promote\)/)
  assert.match(preview.text, /first sight of 1 market: the run only records its current milestone \(no post\)/)
  assert.match(preview.text, /#1 75% · openai-community\/gpt2 \(\$GPT2\) · market 4503599627370497\n/)
})

test('with the alerts off, flags (else defaults) say what would go out, and model markets follow --models', async () => {
  // Arrange
  const off = { PROMOTION_EXCLUDED_REPO_IDS: '' }

  // Act
  const defaults = await previewAlerts({ pool: fakePostgres(), env: off, now: NOW, modelFacts: likes })
  const flagged = await previewAlerts({ pool: fakePostgres(), env: off, now: NOW, modelFacts: likes,
    options: { launchSince: '2026-10-03T10:30:00Z', launchMax: '1', graduationSince: '2026-10-03T09:00:00Z', models: true } })

  // Assert
  assert.equal(defaults.settings.launch.since.toISOString(), '2026-10-02T12:00:00.000Z', 'no cutoff: everything still in the 24 hour window')
  assert.equal(defaults.settings.graduation.since.toISOString(), '2026-10-03T12:00:00.000Z', 'no cutoff: now, the go-live case')
  assert.deepEqual(defaults.launch.telegram.markets.map(market => market.fullName), ['octo/hello-world'], 'HF_MARKETS_ENABLED unset: models left out')
  assert.match(defaults.text, /LAUNCH ALERTS: OFF \(LAUNCH_ALERTS_ENABLED=true turns it on\)/)
  assert.match(defaults.text, /Note: LAUNCH_ALERTS_SINCE is not set: previewing with every market from the last 24 hours\./)
  assert.match(defaults.text, /Hugging Face model markets: left out \(HF_MARKETS_ENABLED is not true here; --models previews them\)/)
  assert.deepEqual(defaults.graduation.telegram.posts, [], 'marks from before the cutoff are re-taken, never posted')
  assert.deepEqual(flagged.launch.telegram.markets.map(market => market.fullName), ['openai-community/gpt2'], 'the cutoff and the cap of 1 from the flags')
  assert.deepEqual(flagged.graduation.telegram.posts.map(post => post.milestone), [75, 50])
  assert.match(flagged.text, /Hugging Face model markets: included\./)
})

test('the preview never reads Hugging Face for GitHub markets or with models left out, and reports a failed read', async () => {
  // Arrange
  const asked = []
  const failing = async market => { asked.push(market.githubRepoId); throw Error('Hugging Face request timed out') }

  // Act
  const without = await previewAlerts({ pool: fakePostgres(), env: { ...ENV, HF_MARKETS_ENABLED: 'false' }, now: NOW, modelFacts: failing })
  const failed = await previewAlerts({ pool: fakePostgres(), env: ENV, now: NOW, modelFacts: failing })

  // Assert
  assert.deepEqual(without.launch.telegram.markets.map(market => market.fullName), ['octo/hello-world'])
  assert.deepEqual(asked, [MODEL_ID], 'one read for the one model market, shared by both channels')
  assert.equal(texts(failed.launch.telegram.markets)[1].split('\n')[1], 'Text generation · License: mit', 'stored facts, as the worker would post')
  assert.match(failed.text, /· stored facts only \(no live Hugging Face read\)/)
})

test('a cutoff still to come previews nothing, and says so up front', async () => {
  // Arrange
  const options = { since: '2026-10-05T16:00:00Z' }

  // Act
  const preview = await previewAlerts({ pool: fakePostgres(), env: ENV, now: NOW, modelFacts: likes, options })

  // Assert
  assert.deepEqual([preview.launch.telegram.markets, preview.graduation], [[], null])
  assert.match(preview.text, /Note: the launch cutoff 2026-10-05T16:00:00\.000Z is still to come, so nothing qualifies yet \(leave out --since, or give a past time, /)
  assert.match(preview.text, /Note: the graduation cutoff 2026-10-05T16:00:00\.000Z is still to come/)
})

test('the transaction is always rolled back, and a failed rollback never hides the first error', async () => {
  // Arrange
  const client = ({ rollbackFails = false } = {}) => {
    const log = []
    return { log, pool: { async connect() { return {
      async query(text) { log.push(text); if (text === 'rollback' && rollbackFails) throw Error('connection lost') },
      release(destroy) { log.push(`release ${destroy}`) } } } } }
  }
  const failing = client(), broken = client({ rollbackFails: true })

  // Act
  const work = async () => { throw Error('read failed') }

  // Assert
  await assert.rejects(readOnly(failing.pool, work), /read failed/)
  assert.deepEqual(failing.log.filter(line => !line.includes('set_config')), ['begin transaction read only', 'rollback', 'release false'])
  await assert.rejects(readOnly(broken.pool, work), /read failed/, 'the rollback error does not replace it')
  assert.equal(broken.log.at(-1), 'release true', 'a connection whose rollback failed is discarded')
})

test('settings come from flags first, checked by the jobs\' validators; the command line is parsed strictly', () => {
  // Arrange
  const env = { LAUNCH_ALERTS_SINCE: 'yesterday', GRADUATION_ALERTS_MAX_PER_DAY: '999', HF_MARKETS_ENABLED: 'true' }

  // Act
  const settings = previewSettings({ env, now: NOW, options: { since: '2026-10-03T08:00:00Z', models: false } })
  const fallback = previewSettings({ env, now: NOW })

  // Assert
  assert.deepEqual([settings.launch.since.toISOString(), settings.graduation.since.toISOString(), settings.models], ['2026-10-03T08:00:00.000Z', '2026-10-03T08:00:00.000Z', false])
  assert.match(fallback.notes.join('\n'), /LAUNCH_ALERTS_SINCE must be an ISO timestamp, e\.g\. 2026-10-01T00:00:00Z; previewing with every market from the last 24 hours/)
  assert.match(fallback.notes.join('\n'), /GRADUATION_ALERTS_MAX_PER_DAY must be an integer from 1 to 500; previewing with the default 10/)
  assert.throws(() => previewSettings({ env, now: NOW, options: { launchSince: 'soon' } }), error => error instanceof LaunchAlertConfigError && /--launch-since must be an ISO timestamp/.test(error.message))
  assert.throws(() => previewSettings({ env, now: NOW, options: { graduationMax: '0' } }), /--graduation-max must be an integer from 1 to 500/)
  assert.deepEqual(cliOptions(['--since', '2026-10-05T16:00:00Z', '--launch-max', '5', '--no-models']),
    { help: false, since: '2026-10-05T16:00:00Z', launchSince: undefined, graduationSince: undefined, launchMax: '5', graduationMax: undefined, models: false })
  assert.equal(cliOptions(['--models']).models, true)
  assert.throws(() => cliOptions(['--send']), { code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION' })
})
