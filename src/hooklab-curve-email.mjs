import { createHash } from 'node:crypto'
import { mkdir, open, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { reminderEmail } from './builder-reminders.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const digest = value => createHash('sha256').update(value).digest('hex')

/** Server-owned destination only. `sent` means provider acceptance, NOT inbox delivery or
 * human acknowledgement. This separate opt-in never enables builder reminders or trading.
 */
export function createCurveEmailSender(env = process.env, fetchImpl = fetch) {
  if (env.HOOKLAB_CURVE_EMAIL_ENABLED !== 'true' || !env.RESEND_API_KEY ||
    !env.HOOKLAB_CURVE_ALERT_FROM || !env.HOOKLAB_CURVE_ALERT_TO) return null
  const from = reminderEmail(env.HOOKLAB_CURVE_ALERT_FROM), to = reminderEmail(env.HOOKLAB_CURVE_ALERT_TO)
  const authorization = `Bearer ${env.RESEND_API_KEY}`
  if (/[\r\n]/.test(authorization)) throw Error('Invalid email provider configuration')
  return async ({ key, text }) => {
    if (!/^hooklab-curve-(?:alert|drill)\/[a-zA-Z0-9/_-]{1,128}$/.test(key ?? '') ||
      typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 2000) return { status: 'failed' }
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: { Authorization: authorization, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ from, to: [to], subject: 'repo.ing Hook Lab private alert', text }),
      })
      // Never echo a provider body/error: it may contain private configuration. Conflict,
      // timeout and 5xx responses may follow acceptance and must NOT trigger an automatic retry.
      if ([400, 401, 403, 404, 405, 413, 422, 429].includes(response.status)) return { status: 'failed' }
      if (![200, 201].includes(response.status)) return { status: 'unknown' }
      const body = await response.json()
      return typeof body?.id === 'string' && uuid.test(body.id)
        ? { status: 'sent', messageId: body.id } : { status: 'unknown' }
    } catch { return { status: 'unknown' } }
  }
}

/** Explicit one-off operator drill. Exclusive, fsynced claim precedes HTTP; any existing claim
 * prevents replay even after a crash, provider ambiguity or expiry of provider idempotency keys.
 * Storage must be private and durable. This does not configure a worker or adopt curve tables.
 */
export async function runCurveEmailDrill({ id, directory, env = process.env, fetchImpl = fetch }) {
  if (!uuid.test(id ?? '')) throw Error('Drill requires a lowercase UUID')
  const send = createCurveEmailSender(env, fetchImpl)
  if (!send) throw Error('Curve email is not configured and explicitly enabled')
  const key = `hooklab-curve-drill/${id}`
  const text = `DRILL ONLY: repo.ing Hook Lab private alert. Drill ${id}. Confirm receipt with the owner using this ID. No deployment, funding, signing or trading is authorized.`
  const claim = { schema: 'repoing/curve-email-drill/1', id, createdAt: new Date().toISOString(),
    status: 'sending', destinationSha256: digest(reminderEmail(env.HOOKLAB_CURVE_ALERT_TO)),
    textSha256: digest(text), deliveryVerified: false, acknowledged: false, canSubmit: false }
  directory = resolve(directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${id}.json`)
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(`${JSON.stringify(claim)}\n`); await file.sync() } finally { await file.close() }
  const syncDirectory = async (path = directory) => {
    const handle = await open(path, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  await syncDirectory()
  // Persist parent entries too, including directories created by a competing claimant.
  for (let parent = dirname(directory); ; parent = dirname(parent)) {
    await syncDirectory(parent)
    if (parent === dirname(parent)) break
  }
  const result = { ...claim, ...await send({ key, text }), completedAt: new Date().toISOString() }
  // A crash while persisting the response leaves the original claim, never permission to resend.
  const completed = await open(`${path}.completed`, 'wx', 0o600)
  try { await completed.writeFile(`${JSON.stringify(result)}\n`); await completed.sync() } finally { await completed.close() }
  await rename(`${path}.completed`, path)
  await syncDirectory()
  return result
}
