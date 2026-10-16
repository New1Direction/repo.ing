import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createCurveEmailSender, runCurveEmailDrill } from '../src/hooklab-curve-email.mjs'

const configuration = () => ({ HOOKLAB_CURVE_EMAIL_ENABLED: 'true', RESEND_API_KEY: 'synthetic-private-key',
  HOOKLAB_CURVE_ALERT_FROM: 'alerts@example.com', HOOKLAB_CURVE_ALERT_TO: 'owner@example.com' })

test('curve email is independently gated, fixed-destination, and conservative about ambiguous provider acceptance', async () => {
  assert.equal(createCurveEmailSender({}), null)
  assert.equal(createCurveEmailSender({ ...configuration(), HOOKLAB_CURVE_EMAIL_ENABLED: 'false', BUILDER_REMINDERS_ENABLED: 'true' }), null)
  assert.equal(createCurveEmailSender({ ...configuration(), RESEND_API_KEY: '' }), null)
  assert.throws(() => createCurveEmailSender({ ...configuration(), HOOKLAB_CURVE_ALERT_TO: 'owner@example.com\nBcc:other@example.com' }))
  const env = configuration(), messageId = randomUUID(), key = `hooklab-curve-alert/${randomUUID()}/4`
  const sender = createCurveEmailSender(env, async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers['Idempotency-Key'], key)
    assert.equal(options.headers.Authorization, 'Bearer synthetic-private-key')
    assert.deepEqual(JSON.parse(options.body), { from: 'alerts@example.com', to: ['owner@example.com'],
      subject: 'repo.ing Hook Lab private alert', text: 'Journal needs review' })
    return new Response(JSON.stringify({ id: messageId }), { status: 201 })
  })
  env.HOOKLAB_CURVE_ALERT_TO = 'replacement@example.com'
  assert.deepEqual(await sender({ key, text: 'Journal needs review', to: 'untrusted@example.com' }), { status: 'sent', messageId })
  for (const status of [400, 401, 403, 404, 405, 413, 422, 429, 408, 409, 500, 502, 503, 302, 200, 201]) {
    const send = createCurveEmailSender(configuration(), async () => new Response('sensitive provider failure', { status }))
    assert.deepEqual(await send({ key, text: 'Review' }), {
      status: [400, 401, 403, 404, 405, 413, 422, 429].includes(status) ? 'failed' : 'unknown',
    })
  }
  assert.deepEqual(await createCurveEmailSender(configuration(), async () => { throw Error('sensitive transport failure') })({ key, text: 'Review' }), { status: 'unknown' })
  assert.deepEqual(await createCurveEmailSender(configuration(), async () => new Response('{"id":"not-a-provider-id"}'))({ key, text: 'Review' }), { status: 'unknown' })
})

test('private email drill retains provider evidence and never replays accepted, ambiguous or interrupted claims', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curve-email-')), directory = join(root, 'private', 'drills')
  const requests = [], providerId = randomUUID()
  let loseResponse = false
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    requests.push({ key: request.headers['idempotency-key'], body: JSON.parse(body) })
    if (loseResponse) { response.destroy(); return }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: providerId }))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const options = { directory, env: configuration(), fetchImpl: (_url, init) => fetch(`http://127.0.0.1:${server.address().port}`, init) }
    const id = randomUUID()
    const attempts = await Promise.allSettled([runCurveEmailDrill({ ...options, id }), runCurveEmailDrill({ ...options, id })])
    assert.deepEqual(attempts.map(a => a.status).sort(), ['fulfilled', 'rejected'])
    const retained = JSON.parse(await readFile(join(directory, `${id}.json`)))
    assert.equal(retained.status, 'sent'); assert.equal(retained.messageId, providerId)
    assert.equal(retained.deliveryVerified, false); assert.equal(retained.acknowledged, false); assert.equal(retained.canSubmit, false)
    assert.equal(JSON.stringify(retained).includes(options.env.RESEND_API_KEY), false)
    assert.equal(JSON.stringify(retained).includes(options.env.HOOKLAB_CURVE_ALERT_TO), false)
    assert.equal(requests.length, 1); assert.equal(requests[0].key, `hooklab-curve-drill/${id}`)
    assert.match(requests[0].body.text, /DRILL ONLY/)
    await assert.rejects(runCurveEmailDrill({ ...options, id }), { code: 'EEXIST' })
    loseResponse = true
    const ambiguous = randomUUID()
    assert.equal((await runCurveEmailDrill({ ...options, id: ambiguous })).status, 'unknown')
    assert.equal(JSON.parse(await readFile(join(directory, `${ambiguous}.json`))).status, 'unknown')
    await assert.rejects(runCurveEmailDrill({ ...options, id: ambiguous }), { code: 'EEXIST' })
    const interrupted = randomUUID()
    await writeFile(join(directory, `${interrupted}.json`), '{"status":"sending"}')
    await assert.rejects(runCurveEmailDrill({ ...options, id: interrupted }), { code: 'EEXIST' })
    assert.equal(requests.length, 2)
  } finally {
    await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true })
  }
})
