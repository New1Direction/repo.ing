import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { previewAlerts, readOnly } from '../scripts/alerts-preview.mjs'
import { HF_DISCLAIMER_SHORT } from '../src/hf-copy.mjs'
import { createLaunchAlerts, createLaunchAlertStore, LAUNCH_ALERT_DEFAULTS } from '../src/launch-alerts.mjs'
import { createMilestoneAlerts, createMilestoneAlertStore, MILESTONE_ALERT_DEFAULTS } from '../src/milestone-alerts.mjs'
import { graduationColumns } from './fixtures/graduation-rows.mjs'

// Real PostgreSQL with every committed migration: a GitHub market and a Hugging Face model market (registry row,
// repositories.source 'huggingface') through both alert stores and jobs, and the preview, which must change nothing.
const url = process.env.ALERTS_MODELS_TEST_DATABASE_URL
const ORIGIN = 'https://repo.ing'
const GITHUB_ID = '1384142609', GPT2_HF_ID = '621ffdc036468d709f17434d'
const tables = 'launch_alerts, milestone_alerts, milestone_alert_marks'

async function observe(pool, id, mint, reserveSol) {
  const columns = graduationColumns({ mint, reserveSol, thresholdSol: 100n })
  await pool.query(`insert into graduation_observations(github_repo_id,checked_at,status,observation,error_code) values($1,now(),$2,$3,$4)
    on conflict (github_repo_id) do update set checked_at=excluded.checked_at,status=excluded.status,observation=excluded.observation,error_code=excluded.error_code`,
  [id, columns.status, columns.observation, columns.error_code])
}
const counts = async pool => (await pool.query(`select (select count(*) from launch_alerts)::int as launch, (select count(*) from milestone_alerts)::int as milestones,
  (select count(*) from milestone_alert_marks)::int as marks`)).rows[0]

test('real PostgreSQL: model markets through the alert stores, both jobs and the read-only preview', { skip: !url, timeout: 120_000 }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_alerts_models_test', 'Disposable alerts test database required')
  const pool = new pg.Pool({ connectionString: url })
  try {
    // Arrange
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query(`truncate ${tables}, graduation_observations, graduation_events, markets, repositories, hf_models restart identity cascade`)
    const { rows: [{ ref: MODEL_ID }] } = await pool.query(`insert into hf_models(hf_id,repo_path,owner_handle,owner_kind) values ($1,'openai-community/gpt2','openai-community','org')
      returning market_ref::text as ref`, [GPT2_HF_ID])
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,stars,forks,archived,github_updated_at,github_created_at)
      values ($1,'octo','hello-world','octo/hello-world','A friendly greeter.',1234,5,false,now(),'2025-01-01T00:00:00Z')`, [GITHUB_ID])
    // As the model launch writes it (src/hf-launch.mjs): stars stay 0, so the model must earn promotion by its curve.
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,stars,forks,archived,github_updated_at,source,hf_model_ref)
      values ($1,'openai-community','gpt2','openai-community/gpt2','Text generation · License: mit',0,0,false,now(),'huggingface',$1)`, [MODEL_ID])
    for (const [id, mint, symbol, hoursAgo] of [[GITHUB_ID, 'MintRepo', 'HELLO', 2], [MODEL_ID, 'MintGpt2', 'GPT2', 1]]) {
      await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,
        launch_slot,launch_finality,indexed_at,last_verified_at) values ($1,'confirmed',$2,$3,'w','w',$4,$5,$6,1,'finalized',now() - make_interval(hours => $7),now())`,
      [id, mint, `Pool${symbol}`, symbol.toLowerCase(), symbol, `Sig${symbol}`, hoursAgo])
      await observe(pool, id, mint, 30n)
    }
    const launchStore = createLaunchAlertStore(pool), milestoneStore = createMilestoneAlertStore(pool)
    const scan = models => launchStore.candidates({ channel: 'x', since: new Date(Date.now() - 6 * 3600_000), maxAgeMs: 86_400_000, maxAttempts: 3, limit: 100, models })

    // Act + Assert: reads stay GitHub-only by default; models: true adds the model with its registry _id and path.
    assert.deepEqual((await scan()).map(row => row.githubRepoId), [GITHUB_ID])
    const both = await scan(true)
    assert.deepEqual(both.map(row => [row.githubRepoId, row.hfId, row.modelPath, row.stars]), [[GITHUB_ID, null, null, 1234], [MODEL_ID, GPT2_HF_ID, 'openai-community/gpt2', 0]])
    assert.deepEqual((await milestoneStore.progressRows()).map(row => row.githubRepoId), [GITHUB_ID])
    assert.deepEqual((await milestoneStore.progressRows({ models: true })).map(row => [row.githubRepoId, row.modelPath]), [[GITHUB_ID, null], [MODEL_ID, 'openai-community/gpt2']])

    // The preview reads the same, and leaves every table as it was.
    const before = await counts(pool)
    const preview = await previewAlerts({ pool, now: Date.now(), modelFacts: async () => ({ likes: 3149, downloads30d: 1 }),
      env: { HF_MARKETS_ENABLED: 'true', LAUNCH_ALERTS_SINCE: new Date(Date.now() - 6 * 3600_000).toISOString(), GRADUATION_ALERTS_SINCE: new Date(Date.now() - 3600_000).toISOString() } })
    assert.deepEqual(preview.launch.x.markets.map(market => market.text.split('\n')[0]), ['🚀 New on repo.ing: octo/hello-world — $HELLO',
      '🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2'])
    assert.deepEqual(preview.graduation.x.marks.map(mark => mark.githubRepoId), [GITHUB_ID, MODEL_ID], 'first sight: would mark, not post')
    assert.deepEqual(await counts(pool), before, 'the preview wrote nothing')
    await assert.rejects(readOnly(pool, db => db.query(`insert into launch_alerts(github_repo_id,mint,channel,status) values ($1,'m','x','sending')`, [GITHUB_ID])),
      error => error.code === '25006', 'PostgreSQL itself refuses a write inside the preview')
    assert.deepEqual(await counts(pool), before)

    // The launch job posts both, each once per channel; claims accept the model's market id.
    const sent = []
    const senders = Object.fromEntries(['telegram', 'x'].map(channel => [channel, async ({ text }) => { sent.push([channel, text]); return { status: 'sent', messageId: String(sent.length) } }]))
    const launchJob = createLaunchAlerts({ store: launchStore, senders, sleep: async () => {}, modelFacts: async () => ({ likes: 3149, downloads30d: 1 }),
      config: { ...LAUNCH_ALERT_DEFAULTS, channels: ['telegram', 'x'], since: new Date(Date.now() - 6 * 3600_000), origin: ORIGIN, excluded: new Set(), models: true } })
    await Promise.all([launchJob.runOnce(), launchJob.runOnce()])
    await launchJob.runOnce()
    assert.equal(sent.length, 4, 'never twice')
    assert.equal(sent.find(([channel, text]) => channel === 'x' && text.includes('gpt2'))[1], '🚀 New on repo.ing: Hugging Face model openai-community/gpt2 — $GPT2\n'
      + `❤️ 3.1k likes · Text generation · License: mit\nEvery trade pays the model's owner.\n${HF_DISCLAIMER_SHORT}\n${ORIGIN}/token/MintGpt2`)
    assert.deepEqual((await pool.query(`select github_repo_id::text as id, channel, status from launch_alerts where github_repo_id=$1 order by channel`, [MODEL_ID])).rows,
      [{ id: MODEL_ID, channel: 'telegram', status: 'sent' }, { id: MODEL_ID, channel: 'x', status: 'sent' }])

    // The milestone job marks the model on first sight, then posts its next crossing with model copy.
    const posted = []
    const milestoneJob = createMilestoneAlerts({ store: milestoneStore, sleep: async () => {}, senders: { telegram: async ({ text }) => { posted.push(text); return { status: 'sent', messageId: '1' } } },
      config: { ...MILESTONE_ALERT_DEFAULTS, channels: ['telegram'], since: new Date(Date.now() - 3600_000), origin: ORIGIN, excluded: new Set(), models: true } })
    await milestoneJob.runOnce()
    assert.deepEqual((await pool.query(`select github_repo_id::text as id, milestone from milestone_alert_marks order by 1`)).rows, [{ id: GITHUB_ID, milestone: 25 }, { id: MODEL_ID, milestone: 25 }])
    await observe(pool, MODEL_ID, 'MintGpt2', 55n)
    await milestoneJob.runOnce()
    assert.deepEqual(posted, [`📈 $GPT2 passed 50% of the way to graduating on repo.ing — 45 SOL to go.\nHugging Face model openai-community/gpt2\n${HF_DISCLAIMER_SHORT}\n${ORIGIN}/token/MintGpt2`])
    assert.deepEqual((await pool.query(`select github_repo_id::text as id, milestone, status from milestone_alerts`)).rows, [{ id: MODEL_ID, milestone: 50, status: 'sent' }])
  } finally { await pool.end() }
})
