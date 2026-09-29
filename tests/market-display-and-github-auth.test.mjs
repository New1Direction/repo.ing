import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { formatSolDisplay, formatSolRounded, formatUsdEstimate } from '../app/lib/format.mjs'
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
  assert.equal(formatSolRounded('14106900000'), '14.11')
  assert.equal(formatSolRounded('342829000'), '0.3428')
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
