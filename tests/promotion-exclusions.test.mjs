import test from 'node:test'
import assert from 'node:assert/strict'
import { isPromotionExcluded, promotionExcludedRepoIds } from '../app/lib/promotion-exclusions.mjs'
import { selectWaiting } from '../app/lib/waiting.mjs'

test('do-not-promote IDs parse strictly and hide repos from /waiting', () => {
  const excluded = promotionExcludedRepoIds({ PROMOTION_EXCLUDED_REPO_IDS: ' 1103012935, 162625122,,abc,1181927 ' })
  assert.deepEqual([...excluded].sort(), ['1103012935', '1181927', '162625122'])
  assert.equal(promotionExcludedRepoIds({}).size, 0)
  assert.ok(isPromotionExcluded(1103012935, excluded))
  assert.ok(!isPromotionExcluded('42', excluded))
  const market = (repoId, remaining) => ({ repoId, remaining, beneficiaryWallet: null, wasVerified: false, stars: 1 })
  const shown = selectWaiting([market('1103012935', '900'), market('7', '100')], { optedOut: excluded })
  assert.deepEqual(shown.map(m => m.repoId), ['7'])
})
