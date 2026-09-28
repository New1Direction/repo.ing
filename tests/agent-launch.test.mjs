import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { signLaunchDraft, verifyLaunchDraft, agentLaunchConfigured, DRAFT_LIFETIME_MS } from '../src/agent-launch-draft.mjs'
import { createAgentLaunchService, projectLaunchStatus } from '../src/agent-launch.mjs'
import { createAgentMcpHandler, takeAgentQuota } from '../src/agent-launch-http.mjs'
import { launchRepositoryUrl, launchReadmeMarkdown } from '../src/launch-links.mjs'

const secret = 'test-only-agent-draft-secret-at-least-32-bytes'
const config = '1'.repeat(32), now = Date.parse('2026-09-27T12:00:00Z')
const input = { repoId: '123', fullName: 'owner/repo', config, discovery: true, allocation: true, tokenName: 'Repo', tokenSymbol: 'REPO', initialBuy: 'none' }
const context = { secret, repoId: '123', config, discovery: true, allocation: true, now }

test('drafts survive restart but fail closed for tampering, expiry, identity and config changes', () => {
  const { token } = signLaunchDraft(input, { secret, now })
  assert.equal(verifyLaunchDraft(token, context).tokenSymbol, 'REPO')
  // A second server needs no session state; opening again confers no spending authority.
  assert.equal(verifyLaunchDraft(token, { ...context, now: now + 1 }).repoId, '123')
  for (const patch of [{ repoId: '456' }, { config: '2'.repeat(32) }, { discovery: false }, { allocation: false },
    { secret: 'x'.repeat(32) }, { now: now + DRAFT_LIFETIME_MS }, { now: now - 1 }]) assert.throws(() => verifyLaunchDraft(token, { ...context, ...patch }))
  assert.throws(() => verifyLaunchDraft(token.replace('ey', 'ex'), context))
  assert.throws(() => verifyLaunchDraft(token + 'a', context))
  assert.throws(() => verifyLaunchDraft('x'.repeat(3000), context))
  assert.throws(() => signLaunchDraft({ ...input, initialBuy: '400' }, { secret, now }))
  assert.equal(agentLaunchConfigured({}), false)
  assert.equal(agentLaunchConfigured({ AGENT_LAUNCH_ENABLED: 'true' }), false)
  assert.equal(agentLaunchConfigured({ AGENT_LAUNCH_ENABLED: 'true', AGENT_LAUNCH_SECRET: secret }), true)
})
test('README links accept only repository roots, encode identity and never create launches', () => {
  assert.equal(launchRepositoryUrl('owner/repo'), 'https://github.com/owner/repo')
  assert.equal(launchRepositoryUrl('github.com/owner/repo.git/'), 'https://github.com/owner/repo')
  for (const value of ['javascript:alert(1)', 'https://github.com.evil.com/owner/repo', 'https://u:p@github.com/a/b', 'https://github.com/a/b/issues/1', 'https://github.com/a/b?x=y', 'https://github.com/a/..']) assert.throws(() => launchRepositoryUrl(value))
  assert.match(launchReadmeMarkdown('owner/repo'), /\/launch\?repo=https%3A%2F%2Fgithub.com%2Fowner%2Frepo/)
})
test('status withholds receipts until all finalized evidence exists', () => {
  const row = { status: 'confirmed', launch_finality: 'finalized', indexed_at: new Date(), mint: 'mint', pool: 'pool', launch_signature: 'sig', launcher_wallet: 'actual-wallet' }
  assert.equal(projectLaunchStatus(row, 'https://repo.ing').discoverer, 'actual-wallet')
  for (const key of ['indexed_at', 'mint', 'pool', 'launch_signature', 'launcher_wallet', 'launch_finality']) {
    const result = projectLaunchStatus({ ...row, [key]: null }, 'https://repo.ing')
    assert.equal(result.live, false); assert.equal(result.mint, undefined)
  }
  assert.equal(projectLaunchStatus(null, '').state, 'not_launched')
  assert.equal(projectLaunchStatus({ status: 'ambiguous' }, '').state, 'pending')
})

const request = (body, headers = {}) => new Request('https://repo.ing/api/mcp', { method: 'POST', headers: { host: 'repo.ing', 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) })
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }

test('HTTP rejects cross-origin/host, oversized body, unavailable quotas, and rate exhaustion', async () => {
  let count = 0
  const handler = createAgentMcpHandler({ service: {}, origin: 'https://repo.ing', quota: async () => ++count < 4 })
  assert.equal((await handler(request(list, { origin: 'https://evil.test' }))).status, 403)
  assert.equal((await handler(request(list, { host: 'evil.test' }))).status, 403)
  assert.equal(count, 0)
  assert.equal((await handler(request({ ...list, padding: 'x'.repeat(17000) }))).status, 413)
  assert.equal((await handler(request(list))).status, 200)
  assert.equal((await handler(request(list))).status, 200)
  const throttled = await handler(request(list)); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('Retry-After'), '60')
  const unavailable = createAgentMcpHandler({ service: {}, origin: 'https://repo.ing', quota: async () => { throw Error('database password=private') } })
  const res = await unavailable(request(list)); assert.equal(res.status, 503); assert.doesNotMatch(await res.text(), /password/)
})

test('official MCP client lists and calls tools; unknown/signing/invalid-buy inputs rejected', async () => {
  let called = 0
  const service = { findRepos: async () => ({ candidates: [] }), resolveRepo: async () => ({ repoId: '123' }),
    createDraft: async () => { called++; return { state: 'awaiting_browser_review', live: false } }, getStatus: async () => ({ state: 'not_launched', live: false }) }
  const handler = createAgentMcpHandler({ service, origin: 'https://repo.ing', quota: async () => true })
  const client = new Client({ name: 'repoing-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL('https://repo.ing/api/mcp'), { fetch: async (url, init) => {
    const req = new Request(url, init); req.headers.set('host', 'repo.ing'); return handler(req)
  } }))
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['create_launch_draft', 'find_repos', 'get_launch_status', 'resolve_repo'])
    const result = await client.callTool({ name: 'create_launch_draft', arguments: { repository: 'owner/repo' } })
    assert.equal(result.structuredContent.live, false); assert.equal(called, 1)
    for (const args of [{ repository: 'owner/repo', initialBuy: '400' }, { repository: 'owner/repo', privateKey: 'must-not-be-accepted' }]) {
      const rejected = await client.callTool({ name: 'create_launch_draft', arguments: args }); assert.equal(rejected.isError, true)
    }
    await assert.rejects(client.callTool({ name: 'sign_transaction', arguments: {} }), /not found/)
    assert.equal(called, 1)
  } finally { await client.close() }
})

test('real PostgreSQL: draft/retry/cancel do not reserve markets; renamed repos open canonical market; durable quotas', { skip: !process.env.CHART_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.CHART_TEST_DATABASE_URL); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55441')
  const db = new pg.Client({ connectionString: url.href }); await db.connect(); await db.query('begin')
  try {
    await db.query(readFileSync('drizzle/0022_agent_request_limits.sql', 'utf8').replaceAll('CREATE TABLE', 'CREATE TEMPORARY TABLE'))
    await db.query(`create temporary table repositories(github_repo_id bigint primary key, owner text,name text,full_name text,description text,avatar_url text,stars int,forks int,archived boolean,github_updated_at timestamptz,synced_at timestamptz default now());
      create temporary table markets(github_repo_id bigint primary key,status text,launch_finality text,indexed_at timestamptz,mint text,pool text,launch_signature text,launcher_wallet text)`)
    const repo = { githubRepoId: 123n, owner: 'owner', name: 'repo', fullName: 'owner/repo', stars: 1, forks: 0, archived: false, githubUpdatedAt: new Date() }
    const options = { pool: db, origin: 'https://repo.ing', secret, config, discovery: true, allocation: true, candidates: async () => [], resolve: async () => repo, now: () => now }
    const service = createAgentLaunchService(options)
    const draft = await service.createDraft({ repository: 'owner/repo' })
    assert.equal(draft.state, 'awaiting_browser_review'); assert.equal(draft.initialBuyPercent, 0)
    assert.equal(verifyLaunchDraft(new URL(draft.reviewUrl).searchParams.get('draft'), context).repoId, '123')
    const second = createAgentLaunchService(options); await second.createDraft({ repository: 'owner/repo' })
    assert.equal((await db.query('select count(*)::int n from markets')).rows[0].n, 0)
    assert.equal((await service.getStatus({ repoId: '123' })).state, 'not_launched')
    await db.query("insert into markets values(123,'ambiguous',null,null,null,null,null,'other-wallet')")
    await assert.rejects(service.createDraft({ repository: 'owner/repo' }), /progress or requiring review/)
    await db.query("update markets set status='confirmed',launch_finality='finalized',indexed_at=now(),mint='mint',pool='pool',launch_signature='sig'")
    repo.owner = 'new-owner'; repo.fullName = 'new-owner/repo'
    const existing = await service.createDraft({ repository: 'owner/repo' })
    assert.equal(existing.draftCreated, false); assert.equal(existing.discoverer, 'other-wallet'); assert.equal(existing.fullName, 'new-owner/repo')
    assert.equal(existing.marketUrl, 'https://repo.ing/token/mint')
    for (let i = 0; i < 30; i++) assert.equal(await takeAgentQuota(db, 'same-client', secret), true)
    assert.equal(await takeAgentQuota(db, 'same-client', secret), false)
    assert.equal((await db.query("select count(*)::int n from agent_request_limits where scope like '%same-client%'")).rows[0].n, 0)
    await db.query('update agent_request_limits set expires_at=now()-interval \'1 second\'')
    assert.equal(await takeAgentQuota(db, 'same-client', secret), true)
    for (let i = 1; i < 120; i++) assert.equal(await takeAgentQuota(db, `rotated-${i}`, secret), true)
    assert.equal(await takeAgentQuota(db, 'fresh-ip', secret), false)
  } finally { await db.query('rollback'); await db.end() }
})
