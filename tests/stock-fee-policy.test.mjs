import test from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCHER_DEN, LAUNCHER_NUM, POLICY_VERSION, STOCK_CREATOR_FEE_PERCENTAGE, STOCK_POLICY_ERRORS, StockFeePolicyError,
  assertStockPolicyConfig, dammCheckpoint, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { buildStockLaunchCurve } from '../src/launch-curve.mjs'

// The stock fee policy (docs/STOCK_QUOTES.md): launcher floor(creator * 150 / 497) of each creator fee, forever; the rest of
// the creator fee and the whole partner fee to the stock's accumulator. Pure BigInt arithmetic on raw units.
const code = expected => error => {
  assert.ok(error instanceof StockFeePolicyError, `${error?.name}: ${error?.message}`)
  assert.equal(error.code, expected)
  return true
}
const LEDGER_MAX = (1n << 63n) - 1n
const floorShare = creator => creator * 150n / 497n

test('policy 1: the launcher gets 0.30 of the 0.994% builder share, calibrated for a 71% creator share', () => {
  assert.equal(POLICY_VERSION, 1)
  assert.equal(LAUNCHER_NUM, 150n)
  assert.equal(LAUNCHER_DEN, 497n)
  assert.equal(STOCK_CREATOR_FEE_PERCENTAGE, 71)
  // 150/497 is exactly 0.30/0.994: 1.75% total, Meteora 20% of it (0.35%), creator 71% of the remaining 1.40% (0.994%).
  assert.equal(150n * 994n, 300n * 497n)
  assert.equal(1750n * 80n / 100n * 71n / 100n, 994n)
  assert.ok(Object.isFrozen(STOCK_POLICY_ERRORS))
  assert.equal(STOCK_POLICY_ERRORS.STOCK_PAIR_NO_OWNER_CLAIM, 'STOCK_PAIR_NO_OWNER_CLAIM')
})

test('worked example: a 1 METAx buy pays the launcher 0.30% and the accumulator 1.10% of the trade, in raw METAx', () => {
  const volume = 100_000_000n // 1 METAx: 8 decimals
  const fee = volume * 175n / 10_000n, protocol = fee * 20n / 100n
  const creatorAmount = (fee - protocol) * 71n / 100n, partnerAmount = fee - protocol - creatorAmount
  assert.deepEqual([fee, protocol, creatorAmount, partnerAmount], [1_750_000n, 350_000n, 994_000n, 406_000n])
  const split = splitCurveFee({ creatorAmount, partnerAmount })
  assert.deepEqual(split, { launcherAmount: 300_000n, accumulatorAmount: 1_100_000n })
  assert.equal(split.launcherAmount * 10_000n / volume, 30n, '0.30% of volume')
  assert.equal(split.accumulatorAmount * 10_000n / volume, 110n, '0.694% builder remainder + 0.406% partner')
  assert.deepEqual(Object.keys(split), ['launcherAmount', 'accumulatorAmount'], 'exactly the contract shape')
})

test('the launcher share rounds down; the remainder stays in the accumulator', () => {
  for (const [creator, launcher] of [[0n, 0n], [1n, 0n], [3n, 0n], [4n, 1n], [7n, 2n], [496n, 149n], [497n, 150n], [993n, 299n],
    [994n, 300n], [995n, 300n], [LEDGER_MAX, floorShare(LEDGER_MAX)]]) {
    assert.deepEqual(splitCurveFee({ creatorAmount: creator, partnerAmount: 0n }), { launcherAmount: launcher, accumulatorAmount: creator - launcher },
      `creator ${creator}`)
  }
  assert.deepEqual(splitCurveFee({ creatorAmount: 7n, partnerAmount: 3n }), { launcherAmount: 2n, accumulatorAmount: 8n })
  assert.deepEqual(splitCurveFee({ creatorAmount: 0n, partnerAmount: 406n }), { launcherAmount: 0n, accumulatorAmount: 406n })
})

test('every split routes each unit once: launcher + accumulator = creator + partner, launcher <= creator, launcher is the floor', () => {
  for (let creator = 0n; creator <= 3000n; creator++) {
    for (const partner of [0n, 1n, 406n, 12_345n]) {
      const { launcherAmount, accumulatorAmount } = splitCurveFee({ creatorAmount: creator, partnerAmount: partner })
      assert.equal(launcherAmount + accumulatorAmount, creator + partner)
      assert.ok(launcherAmount >= 0n && launcherAmount <= creator && accumulatorAmount >= partner)
      assert.ok(launcherAmount * 497n <= creator * 150n && creator * 150n < (launcherAmount + 1n) * 497n)
    }
  }
  // Per-swap floors never pay the launcher more than its share of the total.
  const fees = Array.from({ length: 500 }, (_, i) => BigInt((i * 7919) % 1013))
  const paid = fees.reduce((sum, creatorAmount) => sum + splitCurveFee({ creatorAmount, partnerAmount: 0n }).launcherAmount, 0n)
  assert.ok(paid <= floorShare(fees.reduce((a, b) => a + b, 0n)))
})

test('amounts: BigInt, safe integers and decimal strings convert exactly; negative, fractional or malformed input is refused', () => {
  const expected = { launcherAmount: 300n, accumulatorAmount: 1100n }
  assert.deepEqual(splitCurveFee({ creatorAmount: 994n, partnerAmount: 406n }), expected)
  assert.deepEqual(splitCurveFee({ creatorAmount: 994, partnerAmount: 406 }), expected)
  assert.deepEqual(splitCurveFee({ creatorAmount: '994', partnerAmount: '406' }), expected)
  for (const bad of [-1n, -1, '-1', 1.5, '1.5', Number.NaN, Infinity, 2 ** 53, '', ' 994', '0994', '1e3', '0x10', null, undefined, {}, [],
    true, LEDGER_MAX + 1n, '9223372036854775808']) {
    assert.throws(() => splitCurveFee({ creatorAmount: bad, partnerAmount: 0n }), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID), `creator ${String(bad)}`)
    assert.throws(() => splitCurveFee({ creatorAmount: 0n, partnerAmount: bad }), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID), `partner ${String(bad)}`)
  }
  assert.throws(() => splitCurveFee(), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID))
  assert.throws(() => splitCurveFee({ creatorAmount: 1n }), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID))
  // Both parts fit a bigint column, but their total would not.
  assert.throws(() => splitCurveFee({ creatorAmount: LEDGER_MAX, partnerAmount: 1n }), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID))
})

test('the stock config must give the creator 71%: the stock launch curve passes, any other share is refused', () => {
  assert.equal(assertStockPolicyConfig(buildStockLaunchCurve({ quoteDecimals: 8, migrationQuoteThreshold: 1000 })), true)
  assert.equal(assertStockPolicyConfig({ creatorTradingFeePercentage: 71 }), true)
  for (const share of [70, 72, 0, 100, 71.5, '71', 71n, null, undefined]) {
    assert.throws(() => assertStockPolicyConfig({ creatorTradingFeePercentage: share }), code(STOCK_POLICY_ERRORS.STOCK_POLICY_CONFIG_MISMATCH), String(share))
  }
  for (const config of [undefined, null, {}]) assert.throws(() => assertStockPolicyConfig(config), code(STOCK_POLICY_ERRORS.STOCK_POLICY_CONFIG_MISMATCH))
})

// Chains checkpoints the way a ledger does: each result, stored, becomes the next call's previous.
function checkpoints(side, cumulatives) {
  let previous = null
  return cumulatives.map(cumulativeEarned => {
    const result = dammCheckpoint({ side, cumulativeEarned, previous })
    previous = { cumulativeEarned, launcherCumulative: result.launcherCumulative, side, policyVersion: POLICY_VERSION }
    return result
  })
}

test('DAMM creator checkpoints: the launcher total is floor(earned * 150 / 497), each credit is the growth, none is negative', () => {
  const cumulatives = [0n, 1n, 3n, 4n, 4n, 497n, 994_000n, 1_988_000n, 1_988_001n, 1n << 62n]
  const results = checkpoints('creator', cumulatives)
  results.forEach((result, i) => {
    const before = i ? cumulatives[i - 1] : 0n
    assert.deepEqual(Object.keys(result), ['credit', 'launcherCumulative', 'launcherCredit', 'accumulatorCredit'], 'exactly the contract shape')
    assert.equal(result.credit, cumulatives[i] - before)
    assert.equal(result.launcherCumulative, floorShare(cumulatives[i]))
    assert.equal(result.launcherCredit, floorShare(cumulatives[i]) - floorShare(before))
    assert.equal(result.credit, result.launcherCredit + result.accumulatorCredit)
    for (const value of Object.values(result)) assert.ok(value >= 0n, `checkpoint ${i}: ${value}`)
  })
  // Worked: the position's first 994,000 raw units pay the launcher 300,000 in all (150 of it at the 497 checkpoint), and so do
  // the next 994,000.
  assert.deepEqual(results[6], { credit: 993_503n, launcherCumulative: 300_000n, launcherCredit: 299_850n, accumulatorCredit: 693_653n })
  assert.deepEqual(results[7], { credit: 994_000n, launcherCumulative: 600_000n, launcherCredit: 300_000n, accumulatorCredit: 694_000n })
  // Floors catch up: 3 units pay the launcher nothing, the 4th unit pays it 1 and the accumulator nothing.
  assert.deepEqual(results[2], { credit: 2n, launcherCumulative: 0n, launcherCredit: 0n, accumulatorCredit: 2n })
  assert.deepEqual(results[3], { credit: 1n, launcherCumulative: 1n, launcherCredit: 1n, accumulatorCredit: 0n })
  assert.deepEqual(results[4], { credit: 0n, launcherCumulative: 1n, launcherCredit: 0n, accumulatorCredit: 0n }, 'an unchanged position credits nothing')
  const sum = key => results.reduce((total, result) => total + result[key], 0n)
  assert.equal(sum('credit'), cumulatives.at(-1))
  assert.equal(sum('launcherCredit'), floorShare(cumulatives.at(-1)))
  assert.equal(sum('launcherCredit') + sum('accumulatorCredit'), cumulatives.at(-1))
})

test('DAMM creator checkpoints: the launcher total does not depend on how often the position is read', () => {
  let seed = 20261004n
  // A fixed-seed LCG; its high bits (the low bits of a power-of-two LCG cycle quickly).
  const next = bound => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n), (seed >> 16n) % bound)
  for (let round = 0; round < 50; round++) {
    const total = next(10_000_000_000n), cuts = Array.from({ length: Number(next(12n)) }, () => next(total + 1n)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const results = checkpoints('creator', [...cuts, total])
    assert.equal(results.reduce((sum, result) => sum + result.launcherCredit, 0n), floorShare(total))
    assert.equal(results.reduce((sum, result) => sum + result.accumulatorCredit, 0n), total - floorShare(total))
    for (const result of results) assert.ok(result.launcherCredit >= 0n && result.accumulatorCredit >= 0n)
  }
})

test('DAMM partner checkpoints never pay the launcher: every credit goes to the accumulator', () => {
  const cumulatives = [0n, 1n, 4n, 406_000n, 406_000n, 1n << 62n]
  checkpoints('partner', cumulatives).forEach((result, i) => {
    const credit = cumulatives[i] - (i ? cumulatives[i - 1] : 0n)
    assert.deepEqual(result, { credit, launcherCumulative: 0n, launcherCredit: 0n, accumulatorCredit: credit })
  })
  assert.deepEqual(dammCheckpoint({ side: 'partner', cumulativeEarned: '994000', previous: { cumulativeEarned: 0n, launcherCumulative: 0n } }),
    { credit: 994_000n, launcherCumulative: 0n, launcherCredit: 0n, accumulatorCredit: 994_000n })
})

test('a DAMM cumulative that goes backwards is refused, never credited negative', () => {
  for (const side of ['creator', 'partner']) {
    assert.throws(() => dammCheckpoint({ side, cumulativeEarned: 999n, previous: { cumulativeEarned: 1000n } }),
      code(STOCK_POLICY_ERRORS.STOCK_DAMM_CUMULATIVE_DECREASED))
    assert.throws(() => dammCheckpoint({ side, cumulativeEarned: 0n, previous: { cumulativeEarned: 1n } }), code(STOCK_POLICY_ERRORS.STOCK_DAMM_CUMULATIVE_DECREASED))
  }
  const [, last] = checkpoints('creator', [994n, 1988n])
  assert.throws(() => dammCheckpoint({ side: 'creator', cumulativeEarned: 1987n,
    previous: { cumulativeEarned: 1988n, launcherCumulative: last.launcherCumulative, side: 'creator', policyVersion: POLICY_VERSION } }),
  code(STOCK_POLICY_ERRORS.STOCK_DAMM_CUMULATIVE_DECREASED))
})

test('a previous checkpoint from the other side, another policy, or with another launcher total is refused', () => {
  const creator = { side: 'creator', cumulativeEarned: 2000n }
  for (const previous of [
    { cumulativeEarned: 994n, launcherCumulative: 0n, side: 'partner' },
    { cumulativeEarned: 994n, launcherCumulative: 299n },
    { cumulativeEarned: 994n, launcherCumulative: 300n, policyVersion: 2 },
  ]) assert.throws(() => dammCheckpoint({ ...creator, previous }), code(STOCK_POLICY_ERRORS.STOCK_DAMM_PREVIOUS_MISMATCH), JSON.stringify(previous, (_, v) => String(v)))
  for (const previous of [{ cumulativeEarned: 994n, launcherCumulative: 300n, side: 'creator' }, { cumulativeEarned: 994n, launcherCumulative: 5n }]) {
    assert.throws(() => dammCheckpoint({ side: 'partner', cumulativeEarned: 2000n, previous }), code(STOCK_POLICY_ERRORS.STOCK_DAMM_PREVIOUS_MISMATCH))
  }
  // The stored row as drizzle reads it chains; a row read with snake_case columns is refused loudly rather than read as zero.
  assert.deepEqual(dammCheckpoint({ ...creator, previous: { cumulativeEarned: 994n, launcherCumulative: 300n, side: 'creator', policyVersion: 1 } }),
    { credit: 1006n, launcherCumulative: 603n, launcherCredit: 303n, accumulatorCredit: 703n })
  assert.throws(() => dammCheckpoint({ ...creator, previous: { cumulative_earned: '994', launcher_cumulative: '300' } }), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID))
})

test('DAMM checkpoints refuse an unknown side and negative or non-integer amounts', () => {
  for (const side of ['launcher', 'Creator', '', undefined, null]) {
    assert.throws(() => dammCheckpoint({ side, cumulativeEarned: 1n }), code(STOCK_POLICY_ERRORS.STOCK_DAMM_SIDE_INVALID), String(side))
  }
  assert.throws(() => dammCheckpoint(), code(STOCK_POLICY_ERRORS.STOCK_DAMM_SIDE_INVALID))
  for (const bad of [-1n, -1, 1.5, '1.5', '-1', Number.NaN, null, undefined, LEDGER_MAX + 1n]) {
    assert.throws(() => dammCheckpoint({ side: 'creator', cumulativeEarned: bad }), code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID), String(bad))
    assert.throws(() => dammCheckpoint({ side: 'creator', cumulativeEarned: 10n, previous: { cumulativeEarned: bad } }),
      code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID), `previous ${String(bad)}`)
    if (bad !== undefined) {
      assert.throws(() => dammCheckpoint({ side: 'creator', cumulativeEarned: 10n, previous: { cumulativeEarned: 1n, launcherCumulative: bad } }),
        code(STOCK_POLICY_ERRORS.STOCK_FEE_AMOUNT_INVALID), `previous launcher ${String(bad)}`)
    }
  }
})
