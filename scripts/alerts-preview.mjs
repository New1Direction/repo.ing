// Prints the exact Telegram and X texts the next alert runs would send, and sends, claims and locks nothing
// (docs/ALERTS_SETUP.md): the next launch posts and the pending graduation-milestone posts, chosen by the jobs' own code
// (nextLaunchAlerts, milestoneMarkets, planMilestones) and written by their message builders. Every database read runs in
// one READ ONLY transaction that is rolled back, so PostgreSQL itself refuses any write, and the jobs' advisory locks are
// never taken. Model launch posts read their likes from Hugging Face afterwards, as the worker does when it posts.
// Works with the alerts off: cutoffs and caps come from the flags, else the environment, else the defaults below.
//   node scripts/alerts-preview.mjs [--since ISO] [--launch-since ISO] [--graduation-since ISO]
//                                   [--launch-max N] [--graduation-max N] [--models | --no-models]
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { createPromotionExclusions } from '../app/lib/promotion-exclusions.mjs'
import { hfMarketsEnabled } from '../src/hf-launch.mjs'
import { buildLaunchMessage, isModelAlert, xWeight, X_MAX_WEIGHT } from '../src/launch-alerts-message.mjs'
import { alertChannels, alertMaxPerDay, alertOrigin, alertSince, createLaunchAlertStore, createModelAlertFacts, LAUNCH_ALERT_CHANNELS,
  LAUNCH_ALERT_DEFAULTS, LaunchAlertConfigError, liveModelFacts, nextLaunchAlerts } from '../src/launch-alerts.mjs'
import { buildMilestoneMessage, planMilestones } from '../src/milestone-alerts-message.mjs'
import { createMilestoneAlertStore, MILESTONE_ALERT_DEFAULTS, milestoneMarkets } from '../src/milestone-alerts.mjs'

export const USAGE = `Usage: node scripts/alerts-preview.mjs [options]   (needs DATABASE_URL; reads only)
  --since ISO             cutoff for both jobs, e.g. 2026-10-05T16:00:00Z
  --launch-since ISO      launch-alert cutoff (default LAUNCH_ALERTS_SINCE, else 24 hours ago: every market still in the window)
  --graduation-since ISO  milestone cutoff (default GRADUATION_ALERTS_SINCE, else now: the go-live case)
  --launch-max N          launch posts per channel per 24 hours (default LAUNCH_ALERTS_MAX_PER_DAY, else ${LAUNCH_ALERT_DEFAULTS.maxPerDay})
  --graduation-max N      milestone posts per channel per 24 hours (default GRADUATION_ALERTS_MAX_PER_DAY, else ${MILESTONE_ALERT_DEFAULTS.maxPerDay})
  --models, --no-models   include Hugging Face model markets or not (default HF_MARKETS_ENABLED on this service)
`

// The settings a preview runs with. A flag wins (checked by the jobs' own validators, under its own name); then the
// environment, exactly as the worker reads it once the job is on; then defaults showing what turning it on now would do.
// An unset or invalid environment value falls back with a note, so a preview always runs.
export function previewSettings({ env = process.env, options = {}, now = Date.now() } = {}) {
  const notes = []
  const origin = alertOrigin(env)
  const models = options.models ?? hfMarketsEnabled(env)
  const setting = ({ flag, value, key, read, fallback, why }) => {
    if (value !== undefined) return read({ [flag]: value }, flag)
    if (!env[key]?.trim()) { notes.push(`${key} is not set: previewing with ${why}`); return fallback }
    try { return read(env, key) } catch (error) { notes.push(`${error.message}; previewing with ${why}`); return fallback }
  }
  const job = ({ defaults, enabled, since, max, sinceFlag, maxFlag, sinceValue, maxValue, fallbackSince, why }) => ({ ...defaults, origin, models,
    on: env[enabled] === 'true',
    since: setting({ flag: sinceFlag, value: sinceValue ?? options.since, key: since, read: alertSince, fallback: fallbackSince, why }),
    maxPerDay: setting({ flag: maxFlag, value: maxValue, key: max, read: (source, key) => alertMaxPerDay(source, key, defaults.maxPerDay),
      fallback: defaults.maxPerDay, why: `the default ${defaults.maxPerDay}` }) })
  let configured = []
  try { configured = alertChannels(env).channels } catch (error) { notes.push(`${error.message} (scripts/alerts-check.mjs explains)`) }
  const launch = job({ defaults: LAUNCH_ALERT_DEFAULTS, enabled: 'LAUNCH_ALERTS_ENABLED', since: 'LAUNCH_ALERTS_SINCE', max: 'LAUNCH_ALERTS_MAX_PER_DAY',
    sinceFlag: options.launchSince === undefined ? '--since' : '--launch-since', maxFlag: '--launch-max', sinceValue: options.launchSince,
    maxValue: options.launchMax, fallbackSince: new Date(now - LAUNCH_ALERT_DEFAULTS.maxAgeMs), why: 'every market from the last 24 hours' })
  const graduation = job({ defaults: MILESTONE_ALERT_DEFAULTS, enabled: 'GRADUATION_ALERTS_ENABLED', since: 'GRADUATION_ALERTS_SINCE',
    max: 'GRADUATION_ALERTS_MAX_PER_DAY', sinceFlag: options.graduationSince === undefined ? '--since' : '--graduation-since', maxFlag: '--graduation-max',
    sinceValue: options.graduationSince, maxValue: options.graduationMax, fallbackSince: new Date(now), why: 'now (the go-live case)' })
  // A cutoff still to come is exactly what the job would do (nothing yet), but it shows no text: say so up front.
  for (const [name, settings] of [['launch', launch], ['graduation', graduation]]) {
    if (settings.since.getTime() > now) notes.push(`the ${name} cutoff ${settings.since.toISOString()} is still to come, so nothing qualifies yet `
      + '(leave out --since, or give a past time, to preview what would go out now)')
  }
  return { origin, models, configured, channels: LAUNCH_ALERT_CHANNELS, notes, launch, graduation }
}

// Runs work with a pool-like reader whose every query goes through one READ ONLY transaction, rolled back at the end, with
// short statement and lock timeouts so a preview never holds up the worker or a migration. It has no connect(): nothing
// can take the jobs' advisory locks through it. A failed rollback never hides the error that came first; that connection
// is discarded.
export async function readOnly(pool, work) {
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('begin transaction read only')
    try {
      await client.query("select set_config('statement_timeout', '15s', true), set_config('lock_timeout', '3s', true)")
      return await work({ query: (text, params) => client.query(text, params) })
    } finally { await client.query('rollback').catch(() => { broken = true }) }
  } finally { client.release(broken) }
}

// Everything the next runs would act on, as the jobs read it, minus every write: no expired claims, no forgotten or new
// milestone marks (only reported), no claims.
async function readAlerts({ db, settings, env, now }) {
  const excluded = await createPromotionExclusions({ pool: db, env })()
  const launchStore = createLaunchAlertStore(db), milestoneStore = createMilestoneAlertStore(db)
  const launch = {}, graduation = {}
  for (const channel of settings.channels) {
    const held = [], sent = await launchStore.sentRecently(channel)
    launch[channel] = { sent, held, markets: await nextLaunchAlerts({ store: launchStore, config: settings.launch, channel, skip: excluded, now: () => now, held }) }
  }
  if (now < settings.graduation.since.getTime()) return { launch, graduation: null }
  const markets = milestoneMarkets(await milestoneStore.progressRows({ models: settings.graduation.models }), excluded, now)
  for (const channel of settings.channels) {
    const { marks, alerts } = await milestoneStore.channelState(channel)
    const plan = planMilestones({ markets, marks, alerts, since: settings.graduation.since, now, maxAttempts: settings.graduation.maxAttempts })
    const sent = await milestoneStore.sentRecently(channel)
    const budget = Math.min(settings.graduation.maxPerRun, settings.graduation.maxPerDay - sent)
    graduation[channel] = { sent, marks: plan.marks, queued: plan.posts.length, posts: budget > 0 ? plan.posts.slice(0, budget) : [] }
  }
  return { launch, graduation }
}

// Each post's text exactly as the job builds it; text that cannot be built is reported, as the job records it 'failed'.
const render = (build, item, channel, origin) => {
  try { return { text: build(item, { channel, origin }) } } catch (error) { return { error: String(error.message).slice(0, 200) } }
}

export async function previewAlerts({ pool, env = process.env, options = {}, now = Date.now(), modelFacts = null }) {
  const settings = previewSettings({ env, options, now })
  const { launch, graduation } = await readOnly(pool, db => readAlerts({ db, settings, env, now }))
  // After the transaction: the model facts the worker reads just before posting (display only; failures keep stored facts).
  const withFacts = liveModelFacts(settings.launch.models ? modelFacts : null)
  for (const channel of settings.channels) {
    launch[channel].markets = (await Promise.all(launch[channel].markets.map(withFacts)))
      .map(market => ({ ...market, ...render(buildLaunchMessage, market, channel, settings.origin) }))
    if (graduation) graduation[channel].posts = graduation[channel].posts
      .map(post => ({ ...post, ...render(buildMilestoneMessage, post, channel, settings.origin) }))
  }
  const preview = { settings, launch, graduation, now }
  return { ...preview, text: formatPreview(preview) }
}

// ---------- output ----------
const iso = value => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const indent = (text, pad = '      ') => text.split('\n').map(line => `${pad}${line}`).join('\n')
function textBlock(item, channel) {
  if (item.error) return `${indent(`(would fail, nothing sent: ${item.error})`)}`
  return `${indent(item.text)}${channel === 'x' ? `\n      (${xWeight(item.text)}/${X_MAX_WEIGHT} weighted characters)` : ''}`
}
const facts = market => !isModelAlert(market) ? '' : market.likes !== undefined || market.downloads30d !== undefined
  ? ' · live Hugging Face facts' : ' · stored facts only (no live Hugging Face read)'
const status = (job, key) => job.on ? 'ON' : `OFF (${key}=true turns it on)`
const channelHead = (settings, channel, sent, budget) => `  ${channel}${settings.configured.includes(channel) ? '' : ' (not configured on this service: nothing would be sent)'}: `
  + `${sent} sent in the last 24 hours, so the next run posts at most ${Math.max(0, budget)}`

export function formatPreview({ settings, launch, graduation, now }) {
  const { launch: l, graduation: g } = settings
  const out = [`repo.ing alerts preview at ${iso(now)}. Read only: nothing was claimed, locked or sent.`,
    'Telegram texts are HTML (sent with parse_mode HTML); X texts are plain.',
    `Links: ${settings.origin}/token/<mint>. Hugging Face model markets: ${settings.models ? 'included' : 'left out (HF_MARKETS_ENABLED is not true here; --models previews them)'}.`,
    `Channels configured on this service: ${settings.configured.join(', ') || 'none'} (texts are shown for both).`,
    ...settings.notes.map(note => `Note: ${note}.`), '',
    `LAUNCH ALERTS: ${status(l, 'LAUNCH_ALERTS_ENABLED')}. Markets indexed from ${iso(l.since)} and in the last 24 hours; at most ${l.maxPerDay} per channel per 24 hours, ${l.maxPerRun} per run.`]
  for (const channel of settings.channels) {
    const { sent, held, markets } = launch[channel]
    out.push(channelHead(settings, channel, sent, Math.min(l.maxPerRun, l.maxPerDay - sent)))
    if (!markets.length) out.push('    nothing to post')
    markets.forEach((market, index) => out.push(`    #${index + 1} ${market.fullName} ($${market.tokenSymbol}) · market ${market.githubRepoId} · indexed ${iso(market.indexedAt)}${facts(market)}`,
      textBlock(market, channel)))
    if (held.length) out.push(`    passed over while filling this run: ${held.map(market => `${market.fullName} (${market.reason})`).join(', ')}`)
  }
  if (settings.channels.some(channel => launch[channel].held.some(market => market.reason === 'not earned yet'))) {
    out.push('    ("not earned yet": a new repo, or any model market, is announced only once it reaches 10% of its graduation target within 24 hours)')
  }
  out.push('', `GRADUATION MILESTONE ALERTS: ${status(g, 'GRADUATION_ALERTS_ENABLED')}. Cutoff ${iso(g.since)}; at most ${g.maxPerDay} per channel per 24 hours, ${g.maxPerRun} per run.`)
  if (!graduation) out.push(`  nothing runs before the cutoff ${iso(g.since)}`)
  else for (const channel of settings.channels) {
    const { sent, marks, queued, posts } = graduation[channel]
    out.push(channelHead(settings, channel, sent, Math.min(g.maxPerRun, g.maxPerDay - sent)))
    if (marks.length) out.push(`    first sight of ${marks.length} market${marks.length === 1 ? '' : 's'}: the run only records ${marks.length === 1 ? 'its' : 'their'} current milestone (no post)`)
    if (!posts.length) out.push('    nothing to post')
    posts.forEach((post, index) => out.push(`    #${index + 1} ${post.milestone === 100 ? 'graduated' : `${post.milestone}%`} · ${post.fullName} ($${post.tokenSymbol}) · market ${post.githubRepoId}`,
      textBlock(post, channel)))
    if (queued > posts.length) out.push(`    ${queued - posts.length} more pending for later runs`)
  }
  return `${out.join('\n')}\n`
}

// ---------- command line ----------
const OPTIONS = { since: { type: 'string' }, 'launch-since': { type: 'string' }, 'graduation-since': { type: 'string' }, 'launch-max': { type: 'string' },
  'graduation-max': { type: 'string' }, models: { type: 'boolean' }, 'no-models': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } }
export function cliOptions(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false })
  return { help: values.help === true, since: values.since, launchSince: values['launch-since'], graduationSince: values['graduation-since'],
    launchMax: values['launch-max'], graduationMax: values['graduation-max'], models: values.models ? true : values['no-models'] ? false : undefined }
}

async function main() {
  const options = cliOptions(process.argv.slice(2))
  if (options.help) return process.stdout.write(USAGE)
  if (!process.env.DATABASE_URL) throw new LaunchAlertConfigError('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: 'repoing-alerts-preview' })
  let reader = null
  try {
    const { text } = await previewAlerts({ pool, options, modelFacts: market => (reader ??= createModelAlertFacts())(market) })
    process.stdout.write(text)
  } finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const known = error instanceof LaunchAlertConfigError || String(error?.code).startsWith('ERR_PARSE_ARGS')
    // In one transaction a read that tolerates a missing table (42P01) still aborts it, and the next read reports 25P02.
    const message = error?.code === '25P02' ? 'a table the alerts read is missing on this database (are all migrations applied?)'
      : String(error?.message ?? error).split(process.env.DATABASE_URL || '\u0000').join('[DATABASE_URL]').slice(0, 300)
    process.stderr.write(`${known ? message : `alerts preview failed: ${message}`}\n${known ? USAGE : ''}`)
    process.exitCode = 1
  })
}
