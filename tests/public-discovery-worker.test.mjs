import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import assert from 'node:assert/strict'

function fixture(runPublicDiscovery) {
  const source = readFileSync(new URL('../scripts/public-discovery-worker.mjs', import.meta.url), 'utf8')
  return new Script(source.replace(/^import .*$/m, '').replace('export default', 'const worker =') + ';worker')
    .runInContext(createContext({ runPublicDiscovery, Response, console: { log() {} } }))
}

test('public HTTP cannot trigger ingestion; only the scheduled handler receives discovery bindings', async () => {
  let runs = 0
  const worker = fixture(async ({ env }) => {
    runs++
    assert.deepEqual(Object.keys(env).sort(), ['PROMOTION_EXCLUDED_REPO_IDS', 'PUBLIC_DISCOVERY_DATABASE_URL'])
    assert.equal(env.PUBLIC_DISCOVERY_DATABASE_URL, 'dedicated-login')
    return { status: 'WAITING' }
  })
  for (const method of ['GET', 'POST']) assert.equal((await worker.fetch(new Request('https://example.invalid/run', { method }))).status, 404)
  assert.equal(runs, 0)
  await worker.scheduled({ noRetry() {} }, { PUBLIC_DISCOVERY_DATABASE_URL: 'dedicated-login', DATABASE_URL: 'owner-must-not-pass', PRIVATE_KEY: 'must-not-pass' })
  assert.equal(runs, 1)
})

test('scheduled errors are redacted and cannot trigger immediate retries', async () => {
  let retriesDisabled = false
  const worker = fixture(async () => { throw Error('credential-must-not-appear') })
  await assert.rejects(worker.scheduled({ noRetry() { retriesDisabled = true } }, {}), /PUBLIC_DISCOVERY_UNAVAILABLE/)
  assert.equal(retriesDisabled, true)
})
