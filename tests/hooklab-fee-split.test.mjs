import test from 'node:test'
import assert from 'node:assert/strict'
import { splitFee, checkFeeSplit, launchRulesOf, describeFeeSplit, FEE_SHARE_TOTAL } from '../src/hooklab-fee-split.mjs'

// The owner's design (2026-10-27): one total fee up to 10%, split into shares that add up to 100%.
const bounds = { maxCreatorFeeBps: 500, maxRulesFeeBps: 1000, maxBurnBps: 1000, maxHolderFeeBps: 1000 }

test('one total fee splits into the creator fee and the burn, and the parts add up to the total exactly', () => {
  assert.deepEqual(splitFee({ totalBps: 1000, shares: { creator: 5000, burn: 5000 } }), { totalBps: 1000, creatorFeeBps: 500, burnBps: 500, holderFeeBps: 0 })
  assert.deepEqual(splitFee({ totalBps: 300, shares: { creator: 10000, burn: 0 } }), { totalBps: 300, creatorFeeBps: 300, burnBps: 0, holderFeeBps: 0 })
  assert.deepEqual(splitFee({ totalBps: 1000, shares: { creator: 0, burn: 10000 } }), { totalBps: 1000, creatorFeeBps: 0, burnBps: 1000, holderFeeBps: 0 })
  // Rounding: the hooks' shares round down and the creator takes the remainder, so the parts never exceed the total.
  for (let total = 0; total <= 1000; total += 7) for (let burn = 0; burn <= FEE_SHARE_TOTAL; burn += 1111) {
    const s = splitFee({ totalBps: total, shares: { creator: FEE_SHARE_TOTAL - burn, burn } })
    assert.equal(s.creatorFeeBps + s.burnBps + s.holderFeeBps, total, `${total} ${burn}`)
  }
  assert.deepEqual(splitFee({ totalBps: 333, shares: { creator: 3333, burn: 6667 } }), { totalBps: 333, creatorFeeBps: 111, burnBps: 222, holderFeeBps: 0 })
})

test('shares must add up to 100%, and the total is a whole number of basis points from 0 to 10%', () => {
  for (const bad of [{ totalBps: 1001, shares: { creator: 10000, burn: 0 } }, { totalBps: -1, shares: { creator: 10000, burn: 0 } },
    { totalBps: 1.5, shares: { creator: 10000, burn: 0 } }, { totalBps: 500, shares: { creator: 5000, burn: 4000 } },
    { totalBps: 500, shares: { creator: 6000, burn: 6000 } }, { totalBps: 500, shares: { creator: -1, burn: 10001 } }])
    assert.throws(() => splitFee(bad), /fee/i, JSON.stringify(bad))
})

test('the split is checked against the chain: creator within its ceiling, each hook within its bound, the sum within the combined bound', () => {
  assert.equal(checkFeeSplit(splitFee({ totalBps: 1000, shares: { creator: 5000, burn: 5000 } }), bounds), '')
  assert.match(checkFeeSplit(splitFee({ totalBps: 1000, shares: { creator: 6000, burn: 4000 } }), bounds), /creator fee.*5%/i)
  assert.match(checkFeeSplit(splitFee({ totalBps: 800, shares: { creator: 0, burn: 10000 } }), { ...bounds, maxBurnBps: 500 }), /burn.*5%/i)
  assert.match(checkFeeSplit(splitFee({ totalBps: 1000, shares: { creator: 5000, burn: 5000 } }), { ...bounds, maxRulesFeeBps: 900 }), /total.*9%/i)
  // The creator ceiling is the lower of the creator and the combined bounds (the chain's open-launch rule).
  assert.match(checkFeeSplit(splitFee({ totalBps: 400, shares: { creator: 10000, burn: 0 } }), { ...bounds, maxRulesFeeBps: 300 }), /3%/)
  // Holders Earn is not live: any holder share is refused.
  assert.match(checkFeeSplit({ totalBps: 100, creatorFeeBps: 50, burnBps: 0, holderFeeBps: 50 }, bounds), /Holders Earn/)
  // A bound the chain did not report refuses the split (never compares against undefined).
  for (const missing of Object.keys(bounds)) assert.match(checkFeeSplit(splitFee({ totalBps: 100, shares: { creator: 5000, burn: 5000 } }), { ...bounds, [missing]: undefined }), /limits are unavailable/, missing)
})

test('the launch rules carry the burn on both sides and nothing else; no burn is no rules', () => {
  assert.deepEqual(launchRulesOf(splitFee({ totalBps: 1000, shares: { creator: 5000, burn: 5000 } })), { holder_fee_buy_bps: 0, holder_fee_sell_bps: 0,
    burn_buy_bps: 500, burn_sell_bps: 500, max_wallet_bps: 0, creator_lock_secs: 0, early_window_secs: 0, early_lock_secs: 0 })
  assert.deepEqual(launchRulesOf({ totalBps: 100, creatorFeeBps: 100, burnBps: 0, holderFeeBps: 0 }).burn_buy_bps, 0)
})

test('the buyer reads one total, and each hook in plain words; a burn is a token burn, never a buyback', () => {
  const lines = describeFeeSplit(splitFee({ totalBps: 1000, shares: { creator: 5000, burn: 5000 } }))
  assert.equal(lines.total, 'Every buy and sell pays 10% in total.')
  assert.match(lines.creator, /5%.*creator/i)
  assert.match(lines.burn, /5%.*coins.*burned/i)
  assert.doesNotMatch(JSON.stringify(lines), /buy ?back/i)
})
