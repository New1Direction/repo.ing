// Prints the exact Telegram and X texts the next "first to launch" runs would send, and sends, claims and locks nothing
// (docs/ALERTS_SETUP.md): candidates, order and text come from the job's own code (trendAlertCandidates, planTrendAlerts,
// buildTrendMessage). Every database read runs in one READ ONLY transaction that is rolled back, so PostgreSQL itself
// refuses any write, and the job's advisory lock is never taken. Works with the alerts off: settings come from the flags,
// else the environment, else the defaults.
//   node scripts/trend-alerts-preview.mjs [--since ISO] [--min-stars N]
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import pg from 'pg'
import { createPromotionExclusions } from '../app/lib/promotion-exclusions.mjs'
import { xWeight, X_MAX_WEIGHT } from '../src/launch-alerts-message.mjs'
import { alertChannels, alertMaxPerDay, alertOrigin, alertSince, LAUNCH_ALERT_CHANNELS, LaunchAlertConfigError } from '../src/launch-alerts.mjs'
import { buildTrendMessage, trendAlertCandidates } from '../src/trend-alerts-message.mjs'
import { createTrendAlertStore, planTrendAlerts, TREND_ALERT_DEFAULTS, trendAlertMinStars } from '../src/trend-alerts.mjs'
import { TREND_FRESH_MS } from '../src/trend-rules.mjs'

export const USAGE = `Usage: node scripts/trend-alerts-preview.mjs [options]   (needs DATABASE_URL; reads only)
  --since ISO       cutoff (default TREND_ALERTS_SINCE, else ${TREND_FRESH_MS / 3600000} hours ago: every fresh trend)
  --min-stars N     star growth per day to qualify (default TREND_ALERTS_MIN_STARS_PER_DAY, else ${TREND_ALERT_DEFAULTS.minStarsPerDay})
`

// A flag wins (checked by the job's own validators, under its own name); then the environment, as the worker reads it;
// then a default. An unset or invalid environment value falls back with a note, so a preview always runs.
export function trendPreviewSettings({ env = process.env, options = {}, now = Date.now() } = {}) {
  const notes = []
  const setting = ({ flag, value, key, read, fallback, why }) => {
    if (value !== undefined) return read({ [flag]: value }, flag)
    if (!env[key]?.trim()) { notes.push(`${key} is not set: previewing with ${why}`); return fallback }
    try { return read(env, key) } catch (error) { notes.push(`${error.message}; previewing with ${why}`); return fallback }
  }
  let configured = []
  try { configured = alertChannels(env).channels } catch (error) { notes.push(`${error.message} (scripts/alerts-check.mjs explains)`) }
  return { ...TREND_ALERT_DEFAULTS, notes, configured, origin: alertOrigin(env), on: env.TREND_ALERTS_ENABLED === 'true',
    reward: env.DISCOVERY_REWARDS_ENABLED === 'true',
    since: setting({ flag: '--since', value: options.since, key: 'TREND_ALERTS_SINCE', read: alertSince, fallback: new Date(now - TREND_FRESH_MS),
      why: 'every fresh trend' }),
    minStarsPerDay: setting({ flag: '--min-stars', value: options.minStars, key: 'TREND_ALERTS_MIN_STARS_PER_DAY', read: trendAlertMinStars,
      fallback: TREND_ALERT_DEFAULTS.minStarsPerDay, why: `the default ${TREND_ALERT_DEFAULTS.minStarsPerDay}` }),
    maxPerDay: setting({ flag: '--max', value: undefined, key: 'TREND_ALERTS_MAX_PER_DAY', read: (source, key) => alertMaxPerDay(source, key, TREND_ALERT_DEFAULTS.maxPerDay),
      fallback: TREND_ALERT_DEFAULTS.maxPerDay, why: `the default ${TREND_ALERT_DEFAULTS.maxPerDay}` }) }
}

function draft(post, channel, settings) {
  try { return { ...post, text: buildTrendMessage(post, { channel, origin: settings.origin, reward: settings.reward }) } }
  catch (error) { return { ...post, error: error.message } }
}

// Reads only, inside one READ ONLY transaction that is always rolled back.
export async function previewTrendAlerts({ pool, env = process.env, options = {}, now = Date.now() }) {
  const settings = trendPreviewSettings({ env, options, now })
  const client = await pool.connect()
  try {
    await client.query('begin read only')
    const promotionExcluded = await createPromotionExclusions({ pool: client, env })()
    const store = createTrendAlertStore(client)
    const trends = await store.trends({ now, promotionExcluded, config: env.DBC_CONFIG?.trim() || null, discoveryEnabled: settings.reward })
    const candidates = trendAlertCandidates(trends, settings)
    const channels = {}
    for (const channel of LAUNCH_ALERT_CHANNELS) {
      const sent = await store.sentRecently(channel)
      const plan = planTrendAlerts({ candidates, alerted: await store.channelState(channel), now, maxAttempts: settings.maxAttempts })
      channels[channel] = { sent, posts: plan.slice(0, Math.max(0, settings.maxPerDay - sent)).map(post => draft(post, channel, settings)) }
    }
    return { settings, channels, text: formatTrendPreview({ settings, channels, now }) }
  } finally {
    await client.query('rollback').catch(() => {})
    client.release()
  }
}

const iso = value => new Date(value).toISOString()
const indent = text => text.split('\n').map(line => `      ${line}`).join('\n')
export function formatTrendPreview({ settings, channels, now }) {
  const out = [`repo.ing "first to launch" preview at ${iso(now)}. Read only: nothing was claimed, locked or sent.`,
    'Telegram texts are HTML (sent with parse_mode HTML); X texts are plain.',
    `TREND ALERTS: ${settings.on ? 'ON' : 'OFF (TREND_ALERTS_ENABLED=true turns it on)'}. Trends observed from ${iso(settings.since)}, gaining at least `
      + `${settings.minStarsPerDay} stars a day; at most ${settings.maxPerDay} per channel per 24 hours, ${settings.maxPerRun} per run (every 5 minutes).`,
    `Launcher reward line: ${settings.reward ? 'shown (DISCOVERY_REWARDS_ENABLED=true here)' : 'left out (DISCOVERY_REWARDS_ENABLED is not true here: keep it the same as on web)'}.`,
    `Channels configured on this service: ${settings.configured.join(', ') || 'none'} (texts are shown for both).`,
    ...settings.notes.map(note => `Note: ${note}.`)]
  for (const [channel, { sent, posts }] of Object.entries(channels)) {
    out.push('', `  ${channel}${settings.configured.includes(channel) ? '' : ' (not configured on this service: nothing would be sent)'}: `
      + `${sent} sent in the last 24 hours, so up to ${posts.length} in the next runs`)
    if (!posts.length) out.push('    nothing to post')
    posts.forEach((post, index) => out.push(`    #${index + 1} ${post.fullName} · +${post.starsGained.delta} stars in ${Math.max(1, Math.round(post.starsGained.hours))}h · repo ${post.repoId}`,
      post.error ? indent(`(would fail, nothing sent: ${post.error})`)
        : `${indent(post.text)}${channel === 'x' ? `\n      (${xWeight(post.text)}/${X_MAX_WEIGHT} weighted characters)` : ''}`))
  }
  return `${out.join('\n')}\n`
}

const OPTIONS = { since: { type: 'string' }, 'min-stars': { type: 'string' }, help: { type: 'boolean', short: 'h' } }
export function cliOptions(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false })
  return { help: values.help === true, since: values.since, minStars: values['min-stars'] }
}

async function main() {
  const options = cliOptions(process.argv.slice(2))
  if (options.help) return process.stdout.write(USAGE)
  if (!process.env.DATABASE_URL) throw new LaunchAlertConfigError('DATABASE_URL is required')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, application_name: 'repoing-trend-alerts-preview' })
  try { process.stdout.write((await previewTrendAlerts({ pool, options })).text) }
  finally { await pool.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const known = error instanceof LaunchAlertConfigError || String(error?.code).startsWith('ERR_PARSE_ARGS')
    const message = error?.code === '25P02' || error?.code === '42P01' ? 'a table the preview reads is missing on this database (are all migrations applied?)'
      : String(error?.message ?? error).split(process.env.DATABASE_URL || '\u0000').join('[DATABASE_URL]').slice(0, 300)
    process.stderr.write(`${known ? message : `trend alerts preview failed: ${message}`}\n${known ? USAGE : ''}`)
    process.exitCode = 1
  })
}
