import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultTokenName, defaultTokenSymbol, tokenDetailsComplete } from '../app/lib/launch-defaults.mjs'

test('defaults derive name and ticker from the repository within launch limits', () => {
  assert.equal(defaultTokenName('hindsight'), 'hindsight')
  assert.equal(defaultTokenName('a'.repeat(40)).length, 32)
  assert.equal(defaultTokenSymbol('next.js-app_router'), 'NEXTJSAPPR')
  assert.equal(defaultTokenSymbol('---'), '')
})

test('token details are complete only with a valid name, ticker and image', () => {
  const image = { image: 'data:image/png;base64,AAAA' }
  assert.equal(tokenDetailsComplete({ name: 'hindsight', symbol: 'HIND', image }), true)
  assert.equal(tokenDetailsComplete({ name: 'hindsight', symbol: 'HIND', image: null }), false)
  assert.equal(tokenDetailsComplete({ name: '   ', symbol: 'HIND', image }), false)
  assert.equal(tokenDetailsComplete({ name: 'a'.repeat(33), symbol: 'HIND', image }), false)
  assert.equal(tokenDetailsComplete({ name: 'bad\nname', symbol: 'HIND', image }), false)
  assert.equal(tokenDetailsComplete({ name: 'hindsight', symbol: '', image }), false)
  assert.equal(tokenDetailsComplete({ name: 'hindsight', symbol: 'hind', image }), false)
  assert.equal(tokenDetailsComplete({ name: 'hindsight', symbol: 'ELEVENCHARS', image }), false)
})
