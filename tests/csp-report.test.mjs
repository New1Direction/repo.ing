import assert from 'node:assert/strict'
import test from 'node:test'
import { CSP_REPORT_MAX_BYTES, createCspStats, createRateLimiter, handleCspReport, readLimitedText, summarizeCspReport } from '../app/lib/csp-report.mjs'
import { reportOnlyPolicy } from '../app/lib/csp.mjs'

const report = (body, headers = {}) => new Request('http://localhost/api/csp-report', { method: 'POST', body, headers: { 'content-type': 'application/csp-report', ...headers } })
const legacy = JSON.stringify({ 'csp-report': { 'document-uri': 'https://repo.ing/launch/1?draft=secret', 'effective-directive': 'script-src-elem', 'blocked-uri': 'https://evil.example/x.js?k=1', 'source-file': 'https://repo.ing/_next/a.js', 'line-number': 3 } })

test('csp report handler logs a compact line without query strings and returns 204', async () => {
  const lines = []
  const response = await handleCspReport(report(legacy), { limiter: () => true, log: line => lines.push(line) })
  assert.equal(response.status, 204)
  assert.deepEqual(lines, ['csp-report directive=script-src-elem blocked=https://evil.example/x.js page=https://repo.ing/launch/1 source=https://repo.ing/_next/a.js:3'])
})

test('csp report handler records accepted reports into stats and keeps 204', async () => {
  const stats = createCspStats()
  assert.equal((await handleCspReport(report(legacy), { limiter: () => true, log() {}, stats })).status, 204)
  assert.equal((await handleCspReport(report('not json'), { limiter: () => true, log() {}, stats })).status, 400)
  const snap = stats.snapshot()
  assert.equal(snap.total, 1)
  assert.deepEqual(snap.hosts, [{ key: 'evil.example', count: 1 }])
  assert.equal(snap.recent[0].page, 'https://repo.ing/launch/1')
})

test('csp report handler rejects oversized bodies with 413 before logging', async () => {
  const lines = []
  const big = JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(CSP_REPORT_MAX_BYTES) } })
  const response = await handleCspReport(report(big), { limiter: () => true, log: line => lines.push(line) })
  assert.equal(response.status, 413)
  assert.equal(lines.length, 0)
})

test('readLimitedText stops at the cap even when content-length is missing or lies', async () => {
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 20; i++) c.enqueue(new Uint8Array(1024)); c.close() } })
  const request = new Request('http://localhost/', { method: 'POST', body: stream, duplex: 'half', headers: { 'content-length': '10' } })
  assert.equal(await readLimitedText(request, 16 * 1024), null)
  assert.equal(await readLimitedText(report('{}'), 16), '{}')
})

test('csp report handler rate limits and rejects malformed bodies', async () => {
  assert.equal((await handleCspReport(report(legacy), { limiter: () => false, log() {} })).status, 429)
  assert.equal((await handleCspReport(report('not json'), { limiter: () => true, log() {} })).status, 400)
})

test('summarizeCspReport accepts Reporting API arrays and strips control characters', () => {
  const lines = summarizeCspReport(JSON.stringify([{ type: 'csp-violation', body: { documentURL: 'https://repo.ing/', effectiveDirective: 'img-src', blockedURL: 'inline\nfake=1' } }, { type: 'deprecation', body: {} }]))
  assert.deepEqual(lines, ['csp-report directive=img-src blocked=inline fake=1 page=https://repo.ing/ source=-'])
})

test('rate limiter caps per client and globally within a window, then resets', () => {
  let now = 0
  const allow = createRateLimiter({ limit: 2, globalLimit: 3, windowMs: 1000, now: () => now })
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('b'), allow('c')], [true, true, false, true, false])
  now = 1000
  assert.equal(allow('a'), true)
})

test('report-only policy keeps frame-ancestors, the report endpoint, and wallet/GitHub hosts', () => {
  const policy = reportOnlyPolicy()
  for (const part of ["default-src 'self'", "frame-ancestors 'none'", 'report-uri /api/csp-report', 'https://avatars.githubusercontent.com', 'wss://mm-sdk-relay.api.cx.metamask.io', "object-src 'none'"]) assert.ok(policy.includes(part), part)
  assert.ok(!policy.includes('unsafe-eval'))
  assert.ok(reportOnlyPolicy({ dev: true }).includes("'unsafe-eval'"))
})
