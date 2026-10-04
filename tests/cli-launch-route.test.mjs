import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { AgentLaunchError } from '../src/agent-launch-draft.mjs'
import { takeAgentQuota } from '../src/agent-launch-http.mjs'
import { CLI_QUOTA, createCliLaunchHandler } from '../src/cli-launch-http.mjs'

// POST /api/cli/launch (src/cli-launch-http.mjs): every answer of the handler, and the CLI's own rate-limit buckets.
const SECRET = 'test-only-agent-draft-secret-at-least-32-bytes'
const post = (body, headers = {}) => new Request('https://repo.ing/api/cli/launch', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body) })
function harness({ allow = true, draft = async input => ({ draftCreated: true, reviewUrl: 'https://repo.ing/launch/1?draft=x', input }) } = {}) {
  const seen = { quota: [], drafts: [], logs: [] }
  const handler = createCliLaunchHandler({ setup: { service: { createDraft: async input => { seen.drafts.push(input); return draft(input) } } },
    quota: async client => { seen.quota.push(client); return allow }, log: (...args) => seen.logs.push(args) })
  return { handler, seen }
}
const answer = async response => ({ status: response.status, body: await response.json(), cache: response.headers.get('cache-control') })

test('a valid request makes the existing signed draft, with the name trimmed and no initial buy unless asked', async () => {
  const { handler, seen } = harness()
  const { status, body, cache } = await answer(await handler(post({ repository: 'https://github.com/octocat/Hello-World', tokenName: '  Hello  ', tokenSymbol: 'HELLO' })))
  assert.equal(status, 200)
  assert.equal(cache, 'no-store')
  assert.equal(body.draftCreated, true)
  assert.deepEqual(seen.drafts, [{ repository: 'https://github.com/octocat/Hello-World', tokenName: 'Hello', tokenSymbol: 'HELLO', initialBuy: 'none' }])
  assert.deepEqual(seen.quota, ['203.0.113.7'], 'rate-limited by the first forwarded address, as the MCP')
})

test('launch reviews switched off: 503 before any quota or draft', async () => {
  const seen = { quota: 0 }
  const handler = createCliLaunchHandler({ setup: null, quota: async () => { seen.quota++; return true } })
  const { status, body } = await answer(await handler(post({ repository: 'octocat/Hello-World' })))
  assert.deepEqual([status, body.error, seen.quota], [503, 'Launch reviews are currently unavailable.', 0])
})

test('over the CLI quota: 429 with Retry-After, and no draft', async () => {
  const { handler, seen } = harness({ allow: false })
  const response = await handler(post({ repository: 'octocat/Hello-World' }))
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '60')
  assert.equal(seen.drafts.length, 0)
})

test('bad requests are refused with a 400 and make no draft', async () => {
  const cases = [
    ['{not json', 'Invalid JSON request.'],
    [{ repository: 'octocat/Hello-World', privateKey: 'never-accepted' }, 'Unsupported field: privateKey.'],
    [{ repository: 'octocat/Hello-World', tokenSymbol: 'hello' }, 'Ticker must be 1–10 uppercase letters or numbers.'],
    [{ repository: 'octocat/Hello-World', initialBuy: '400' }, 'Initial buy must be none, 1%, 2%, or 3%.'],
    [{ repository: 'ab' }, 'Use a public GitHub repository URL or owner/repository.'],
    [[], 'Invalid launch request.'],
    [{ repository: 'octocat/Hello-World', tokenName: 'x'.repeat(5000) }, 'The launch request is empty or too large.'],
  ]
  for (const [input, error] of cases) {
    const { handler, seen } = harness()
    const { status, body } = await answer(await handler(post(input)))
    assert.deepEqual([status, body.error, seen.drafts.length], [400, error, 0], JSON.stringify(input).slice(0, 60))
  }
})

test("the draft service's refusals are 400s with its message; anything else is a 503 that leaks nothing", async () => {
  let { handler } = harness({ draft: async () => { throw new AgentLaunchError('The maintainer opted this repository out of repo.ing.') } })
  assert.deepEqual(Object.values(await answer(await handler(post({ repository: 'octocat/Hello-World' })))).slice(0, 2),
    [400, { error: 'The maintainer opted this repository out of repo.ing.' }])
  const failing = harness({ draft: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }) } })
  const { status, body } = await answer(await failing.handler(post({ repository: 'octocat/Hello-World' })))
  assert.deepEqual([status, body.error], [503, 'Repository service is temporarily unavailable. Try again later.'])
  assert.deepEqual(failing.seen.logs, [['cli_launch_draft_failed', { code: 'ECONNREFUSED' }]])
})

test("the CLI's rate limit has its own buckets and limits; the MCP's are unchanged", async () => {
  const calls = []
  const pool = { query: async (sql, params) => { calls.push(params ?? null); return { rows: params ? [{ hits: 1 }] : [] } } }
  const key = createHmac('sha256', SECRET).update('203.0.113.7').digest('hex')
  assert.equal(await takeAgentQuota(pool, '203.0.113.7', SECRET, CLI_QUOTA), true)
  assert.equal(await takeAgentQuota(pool, '203.0.113.7', SECRET), true)
  assert.deepEqual(calls, [['cli:global', 60], [`cli:client:${key}`, 10], null, ['global', 120], [`client:${key}`, 30], null])
  // A full CLI bucket refuses before the client bucket is touched.
  const refused = { query: async (sql, params) => ({ rows: [] }) }
  assert.equal(await takeAgentQuota(refused, '203.0.113.7', SECRET, CLI_QUOTA), false)
})
