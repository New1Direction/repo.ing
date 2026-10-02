import test from 'node:test'
import assert from 'node:assert/strict'
import { shareLabel, splitShare } from '../app/lib/builder-split.mjs'

test('the /stats split shows each side to 0.1%, from exact lamports', () => {
  assert.equal(splitShare('2350000000', '29400000000'), 8)
  assert.equal(splitShare('27050000000', '29400000000'), 92)
  assert.equal(splitShare('1', '3'), 33.3)
  assert.equal(splitShare('2', '3'), 66.7)
  assert.equal(splitShare(1n, 8n), 12.5, 'half rounds up')
  assert.equal(splitShare('0', '0'), null, 'nothing to split')
  assert.equal(shareLabel(91.7), '91.7%')
  assert.equal(shareLabel(50), '50%')
})
