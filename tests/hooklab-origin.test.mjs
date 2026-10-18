// Production runs behind Railway's proxy: the app sees http:// but the request was for the HTTPS origin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { servedFromConfiguredOrigin } from '../app/lib/hooklab-origin.mjs'

const at = (url, headers = {}) => new Request(url, { headers })
test('a proxied request for the configured host passes even though request.url says http', () => {
  assert.equal(servedFromConfiguredOrigin(at('http://repo.ing/api/hook-lab/wallet-identity', { host: 'repo.ing' }), 'https://repo.ing'), true)
  assert.equal(servedFromConfiguredOrigin(at('http://localhost:8080/api/x', { host: 'repo.ing' }), 'https://repo.ing'), true)
  assert.equal(servedFromConfiguredOrigin(at('http://10.0.0.5:8080/api/x', { 'x-forwarded-host': 'repo.ing', host: '10.0.0.5:8080' }), 'https://repo.ing'), true)
  assert.equal(servedFromConfiguredOrigin(at('https://repo.ing/api/x'), 'https://repo.ing'), true, 'no Host header falls back to the URL')
})
test('any other host is refused', () => {
  for (const host of ['evil.example', 'repo.ing.evil.example', 'www.repo.ing', 'repo.ing:8443'])
    assert.equal(servedFromConfiguredOrigin(at('http://repo.ing/api/x', { host }), 'https://repo.ing'), false, host)
  assert.equal(servedFromConfiguredOrigin(at('https://127.0.0.1:4443/api/x', { host: '127.0.0.1:4443' }), 'https://127.0.0.1:4443'), true, 'local acceptance keeps its port')
})
