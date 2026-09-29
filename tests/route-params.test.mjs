import assert from 'node:assert/strict'
import test from 'node:test'
import { isMintAddress, isRepoId, malformedRouteId } from '../app/lib/route-params.mjs'

test('malformed token, claim, and launch ids are rejected before rendering', () => {
  assert.equal(isMintAddress('So11111111111111111111111111111111111111112'), true)
  assert.equal(isMintAddress('notamint'), false)
  assert.equal(isRepoId('123'), true)
  assert.equal(isRepoId('foo%2Fbar'), false)
  assert.equal(malformedRouteId('/token/notamint'), true)
  assert.equal(malformedRouteId('/claim/foo'), true)
  assert.equal(malformedRouteId('/launch/foo%2Fbar'), true)
  assert.equal(malformedRouteId('/launch/123'), false)
  assert.equal(malformedRouteId('/token/So11111111111111111111111111111111111111112'), false)
  assert.equal(malformedRouteId('/explore'), false)
})
