import test from 'node:test'
import assert from 'node:assert/strict'
import { refusalLine } from '../src/hooklab-refusal-log.mjs'

test('a refused Hooks request is logged by code and a short message, never a secret or a stack', () => {
  const error = Object.assign(Error('slot lag 40 > 16 at https://mainnet.helius-rpc.com/?api-key=abcdef0123456789abcdef postgresql://u:p@db.example/x'), { code: 'STALE' })
  const line = refusalLine('native-launch wallet-request', error)
  assert.match(line, /^Hook Lab refused native-launch wallet-request: STALE slot lag 40 > 16/)
  assert.doesNotMatch(line, /\n/)
  assert.doesNotMatch(line, /abcdef0123456789|u:p@/)
  assert.ok(line.length <= 400)
  assert.equal(refusalLine('x', undefined), 'Hook Lab refused x: - -')
  function fresh() { throw Error() }
  try { fresh() } catch (blank) { assert.match(refusalLine('y', blank), /^Hook Lab refused y: - \s?\[fresh/) }
})
