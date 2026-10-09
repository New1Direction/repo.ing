import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { formatSolDisplay, formatSolRounded, formatUsdEstimate, formatUtcDateTime, formatUtcDay, percentChange } from '../app/lib/format.mjs'
import { solUsdPrice } from '../app/lib/sol-usd.mjs'
import { resolvePublicRepository } from '../src/github.mjs'

test('small fee balances stay readable without showing a nonzero balance as zero', () => {
  assert.equal(formatSolDisplay('99400'), '0.000099')
  assert.equal(formatSolDisplay('1'), '<0.000001')
  assert.equal(formatSolDisplay('0'), '0')
  assert.equal(formatUsdEstimate('99400', 117.06), '$0.01')
  assert.equal(formatSolRounded('99400'), '0.0001')
  assert.equal(formatUsdEstimate('1', 117.06), '<$0.01')
  assert.equal(formatUsdEstimate('99400', null), null)
})

test('summary SOL amounts use 2 decimals from 1 SOL and ~4 significant digits below', () => {
  assert.equal(formatSolDisplay('320732496000'), '320.73')
  assert.equal(formatSolDisplay('2217021660653'), '2,217.02')
  assert.equal(formatSolDisplay('13750800000'), '13.75')
  assert.equal(formatSolDisplay('1000000000'), '1')
  assert.equal(formatSolDisplay('342812345'), '0.3428')
  assert.equal(formatSolDisplay('41838730'), '0.04184')
  assert.equal(formatSolDisplay('-320732496000'), '-320.73')
  // A loss too small to show keeps its minus (it read "<0.000001", a gain).
  assert.deepEqual(['-500', '-1', '500', '-1000'].map(formatSolDisplay), ['-<0.000001', '-<0.000001', '<0.000001', '-0.000001'])
  assert.equal(formatSolRounded('14106900000'), '14.11')
  assert.equal(formatSolRounded('342829000'), '0.3428')
})

test('percent changes are rounded before they are signed: a tiny fall reads 0.00%, never -0.00%', () => {
  assert.deepEqual(percentChange(-0.001), { sign: 0, value: '0.00%', label: '0.00%' })
  assert.deepEqual(percentChange(0.004), { sign: 0, value: '0.00%', label: '0.00%' })
  assert.deepEqual(percentChange(-0.006), { sign: -1, value: '0.01%', label: '−0.01%' })
  assert.deepEqual(percentChange(12.3456), { sign: 1, value: '12.35%', label: '+12.35%' })
  assert.deepEqual(percentChange(-14.2857), { sign: -1, value: '14.29%', label: '−14.29%' })
  assert.equal(percentChange(-0.04, 1).label, '0.0%')
  assert.deepEqual([null, undefined, NaN, Infinity, '5'].map(value => percentChange(value)), [null, null, null, null, null])
})

test('server-rendered dates are UTC, labeled, whatever the server\'s own time zone', () => {
  const zone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    // 03:47 UTC on Oct 9 is still Oct 8 in Los Angeles; the pages once showed "10/8/2026" or "10/9/2026, 3:47:13 AM" by server zone.
    assert.equal(formatUtcDay('2026-10-09T03:47:13Z'), 'Oct 9, 2026')
    assert.equal(formatUtcDateTime('2026-10-09T03:47:13Z'), 'Oct 9, 2026, 3:47 AM UTC')
    assert.equal(formatUtcDay(new Date('2026-01-31T23:59:00Z')), 'Jan 31, 2026')
  } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone }
})

test('SOL price is cached briefly and unavailable prices are omitted', async () => {
  let calls = 0
  const price = async () => { calls++; return { ok: true, json: async () => ({ solana: { usd: 117.06 } }) } }
  assert.equal(await solUsdPrice(price, 1000), 117.06)
  assert.equal(await solUsdPrice(price, 2000), 117.06)
  assert.equal(calls, 1)
  assert.equal(await solUsdPrice(async () => ({ ok: false }), 301001), null)
})

test('public repository lookup uses a cached GitHub App installation token', async () => {
  const old = ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_BASE64']
    .map(key => [key, process.env[key]])
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  process.env.GITHUB_APP_CLIENT_ID = 'Iv23test'
  process.env.GITHUB_APP_INSTALLATION_ID = '12345'
  process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' })).toString('base64')
  let tokenCalls = 0
  let repoCalls = 0
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/access_tokens')) {
      tokenCalls++
      assert.match(options.headers.Authorization, /^Bearer /)
      return { ok: true, json: async () => ({ token: 'fixture-installation-token', expires_at: new Date(Date.now() + 3600000).toISOString() }) }
    }
    repoCalls++
    assert.equal(options.headers.Authorization, 'Bearer fixture-installation-token')
    return { ok: true, json: async () => ({ id: 10270250, owner: { login: 'facebook' }, name: 'react',
      full_name: 'facebook/react', private: false, visibility: 'public', archived: false,
      updated_at: '2026-09-24T00:00:00Z' }) }
  }
  try {
    await resolvePublicRepository('https://github.com/facebook/react', fetchImpl)
    await resolvePublicRepository('https://github.com/facebook/react', fetchImpl)
    assert.equal(tokenCalls, 1)
    assert.equal(repoCalls, 2)
  } finally {
    for (const [key, value] of old) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
