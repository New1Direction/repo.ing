import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import {
  ActivationType, BaseFeeMode, buildCurve, DynamicBondingCurveClient, getFeeSchedulerMinBaseFeeNumerator,
  validateConfigParameters, validateFeeScheduler,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import {
  feeNumeratorAt, isApprovedLaunchFee, LAUNCH_FEE_SCHEDULE, launchFeeBaseFee, launchFeeJson, launchFeeTerms, launchFeeWindow,
  poolFeeFacts, quotePoint, readFeeSchedule, STANDARD_FEE_NUMERATOR,
} from '../src/launch-fee.mjs'
import {
  feePercentLabel, LAUNCH_FEE_SPLIT, launcherBuySentence, launchFeeNotice, launchFeeSentence, launchFeeTradeNote,
} from '../src/launch-fee-copy.mjs'
import { assertOnlyLaunchFeeDiffers, configDifferences, LAUNCH_FEE_FIELDS } from '../src/launch-fee-config.mjs'
import { launchBuyMinFee, launchBuyPreset, launchBuyQuote } from '../src/launch-buy.mjs'
import { handleBuyPost } from '../app/lib/solana-actions.mjs'

// SDK math only: no RPC call is made through this connection.
const client = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed')
const launchCurve = buildLaunchCurve('launch-fee'), buildersCurve = buildLaunchCurve('builders')
const schedule = readFeeSchedule(launchCurve)
const asConfig = curve => ({ ...curve, ...curve.tokenSupply })
const ceilDiv = (a, b) => (a + b - 1n) / b

// The DBC program's own exponential fee (fee_math.rs get_fee_in_period), written out independently of the SDK.
function programFeeInPeriod(cliff, reductionFactor, period) {
  const ONE = 1n << 64n
  let squared = ONE - (reductionFactor << 64n) / 10_000n, result = ONE
  for (let bits = BigInt(period); bits > 0n; bits >>= 1n) {
    if (bits & 1n) result = (result * squared) >> 64n
    squared = (squared * squared) >> 64n
  }
  return (result * cliff) >> 64n
}

test('launch fee matches the DBC program integer math and ends exactly at 1.75%', () => {
  const { cliffFeeNumerator, reductionFactor, numberOfPeriod } = LAUNCH_FEE_SCHEDULE
  for (let second = 0; second <= 240; second++) {
    const expected = programFeeInPeriod(cliffFeeNumerator, reductionFactor, Math.min(second, numberOfPeriod))
    assert.equal(feeNumeratorAt(schedule, 1_000n, 1_000n + BigInt(second)), expected, `second ${second}`)
  }
  // Charged by the mainnet DBC program binary 0 and 1 s after activation on 100,000,000-lamport buys.
  assert.equal(ceilDiv(100_000_000n * feeNumeratorAt(schedule, 0n, 0n), 1_000_000_000n), 50_440_960n)
  assert.equal(ceilDiv(100_000_000n * feeNumeratorAt(schedule, 0n, 1n), 1_000_000_000n), 49_507_802n)
  assert.equal(feeNumeratorAt(schedule, 0n, 179n) > STANDARD_FEE_NUMERATOR, true)
  assert.equal(feeNumeratorAt(schedule, 0n, 180n), STANDARD_FEE_NUMERATOR)
  assert.equal(feeNumeratorAt(schedule, 0n, 10n ** 9n), STANDARD_FEE_NUMERATOR)
  const table = Object.fromEntries([0, 5, 10, 30, 60, 90, 120, 150, 180].map(s => [s, feePercentLabel(feeNumeratorAt(schedule, 0n, BigInt(s)))]))
  assert.deepEqual(table, { 0: '50.44%', 5: '45.94%', 10: '41.85%', 30: '28.81%', 60: '16.45%', 90: '9.40%', 120: '5.37%', 150: '3.06%', 180: '1.75%' })
  let previous = feeNumeratorAt(schedule, 0n, 0n)
  for (let second = 1n; second <= 200n; second++) {
    const fee = feeNumeratorAt(schedule, 0n, second)
    assert.ok(fee <= previous, 'the fee never rises')
    previous = fee
  }
})

test('the schedule is inside Meteora fee scheduler limits', () => {
  const baseFee = launchFeeBaseFee()
  assert.equal(baseFee.baseFeeMode, BaseFeeMode.FeeSchedulerExponential)
  assert.ok(validateFeeScheduler(baseFee.firstFactor, baseFee.secondFactor, baseFee.thirdFactor, baseFee.cliffFeeNumerator, baseFee.baseFeeMode))
  assert.equal(getFeeSchedulerMinBaseFeeNumerator(baseFee.cliffFeeNumerator, baseFee.firstFactor, baseFee.thirdFactor, baseFee.baseFeeMode).toString(), '17500000')
  assert.ok(baseFee.cliffFeeNumerator.lte(new BN(990_000_000)), 'at most the 99% program maximum')
  assert.ok(baseFee.firstFactor <= 65_535, 'number of periods is a u16')
  assert.throws(() => launchFeeBaseFee({ ...LAUNCH_FEE_SCHEDULE, reductionFactor: 184n }), /exactly at the standard/)
  assert.throws(() => launchFeeBaseFee({ ...LAUNCH_FEE_SCHEDULE, cliffFeeNumerator: 995_000_000n }), /limits/)
})

test('the launch-fee config equals the builders config except for its base fee', () => {
  assert.deepEqual(configDifferences(launchCurve, buildersCurve).sort(), [...LAUNCH_FEE_FIELDS].sort())
  validateConfigParameters({ ...launchCurve, leftoverReceiver: Keypair.generate().publicKey })
  assert.equal(launchCurve.activationType, ActivationType.Timestamp)
  assert.equal(launchCurve.creatorTradingFeePercentage, 71)
  assert.equal(launchCurve.migrationQuoteThreshold.toString(), '85000000000')
  assert.deepEqual(assertOnlyLaunchFeeDiffers(launchCurve, buildersCurve).sort(), [...LAUNCH_FEE_FIELDS].sort())
  assert.throws(() => assertOnlyLaunchFeeDiffers({ ...launchCurve, creatorTradingFeePercentage: 70 }, buildersCurve), /beyond the launch fee: creatorTradingFeePercentage/)
  assert.throws(() => assertOnlyLaunchFeeDiffers(buildersCurve, buildersCurve), /approved launch fee/)
  assert.throws(() => assertOnlyLaunchFeeDiffers(launchCurve, launchCurve), /flat 1.75%/)
})

test('the size-scaled rate limiter is not available for new configs', () => {
  const rateLimited = { baseFeeMode: BaseFeeMode.RateLimiter, rateLimiterParam: { baseFeeBps: 175, feeIncrementBps: 100,
    referenceAmount: 0.1, maxLimiterDuration: 120 } }
  assert.throws(() => buildCurve({ token: { tokenType: 0, tokenBaseDecimal: 6, tokenQuoteDecimal: 9, tokenAuthorityOption: 1,
    totalTokenSupply: 1e9, leftover: 1000 }, fee: { baseFeeParams: rateLimited, dynamicFeeEnabled: false, collectFeeMode: 0,
    creatorTradingFeePercentage: 71, poolCreationFee: 0, enableFirstSwapWithMinFee: true },
    migration: { migrationOption: 1, migrationFeeOption: 2, migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 50, creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50 }, lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 }, activationType: 1,
    percentageSupplyOnMigration: 20, migrationQuoteThreshold: 85 }), /deprecated/i)
  const raw = { ...buildersCurve, poolFees: { ...buildersCurve.poolFees, baseFee: { cliffFeeNumerator: new BN(17_500_000),
    firstFactor: 100, secondFactor: new BN(120), thirdFactor: new BN(100_000_000), baseFeeMode: BaseFeeMode.RateLimiter } } }
  assert.throws(() => validateConfigParameters({ ...raw, leftoverReceiver: Keypair.generate().publicKey }), /deprecated/i)
  assert.equal(isApprovedLaunchFee(raw), false)
})

test('the launch guard accepts only the flat 1.75% configs and the exact launch-fee schedule', () => {
  const onChain = curve => ({ ...curve, enableFirstSwapWithMinFee: curve.enableFirstSwapWithMinFee ? 1 : 0 })
  assert.equal(isApprovedLaunchFee(onChain(buildersCurve)), true)
  assert.equal(isApprovedLaunchFee(onChain(buildLaunchCurve('legacy'))), true)
  assert.equal(isApprovedLaunchFee(onChain(launchCurve)), true)
  const withBase = changes => onChain({ ...launchCurve, poolFees: { ...launchCurve.poolFees, baseFee: { ...launchCurve.poolFees.baseFee, ...changes } } })
  for (const changes of [{ cliffFeeNumerator: new BN(504_409_596) }, { firstFactor: 179 }, { secondFactor: new BN(2) },
    { thirdFactor: new BN(186) }, { baseFeeMode: BaseFeeMode.FeeSchedulerLinear }]) assert.equal(isApprovedLaunchFee(withBase(changes)), false, JSON.stringify(changes))
  assert.equal(isApprovedLaunchFee({ ...onChain(launchCurve), enableFirstSwapWithMinFee: 0 }), false, 'launcher would pay the launch fee')
  assert.equal(isApprovedLaunchFee({ ...onChain(launchCurve), activationType: ActivationType.Slot }), false, 'periods would be slots')
  assert.equal(isApprovedLaunchFee({ ...buildersCurve, poolFees: { ...buildersCurve.poolFees, baseFee: { ...buildersCurve.poolFees.baseFee,
    cliffFeeNumerator: new BN(20_000_000) } } }), false)
  for (const garbage of [null, {}, { poolFees: {} }, { poolFees: { baseFee: { baseFeeMode: 7 } } }]) assert.equal(isApprovedLaunchFee(garbage), false)
})

test('the launcher first buy pays 1.75% and the 3% cap is unchanged on the launch-fee config', () => {
  const launch = asConfig(launchCurve), builders = asConfig(buildersCurve)
  assert.equal(launchBuyMinFee(launch), true)
  assert.equal(launchBuyMinFee(builders), false)
  assert.equal(launchBuyMinFee({ enableFirstSwapWithMinFee: 1 }), true)
  for (const bps of [100, 200, 300]) assert.equal(launchBuyPreset(client, launch, bps), launchBuyPreset(client, builders, bps))
  assert.equal(launchBuyPreset(client, launch, 300), '856011397')
  for (const lamports of ['10000000', '100000000', '856011397']) {
    const fresh = launchBuyQuote(client, launch, lamports), flat = launchBuyQuote(client, builders, lamports)
    assert.equal(fresh.outputAmount.toString(), flat.outputAmount.toString())
    assert.equal(fresh.minimumAmountOut.toString(), fresh.outputAmount.toString(), 'exact: an ineligible first buy fails instead of paying more')
    assert.equal(BigInt(fresh.tradingFee.toString()), ceilDiv(BigInt(lamports) * STANDARD_FEE_NUMERATOR, 1_000_000_000n))
  }
  assert.throws(() => launchBuyQuote(client, launch, '856011398'), /exceeds 3%/)
  // The same buy as an ordinary first trade at activation would pay the full launch fee.
  const ordinary = client.pool.getQuoteFromInputAmount({ config: launch, swapBaseForQuote: false, amountIn: new BN(100_000_000),
    slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: false })
  assert.equal(BigInt(ordinary.tradingFee.add(ordinary.protocolFee).toString()), 50_440_960n)
})

test('quotes clamp to the activation point and can only over-estimate the fee charged later', () => {
  assert.equal(quotePoint(5n, 10n).toString(), '10')
  assert.equal(quotePoint(new BN(15), new BN(10)).toString(), '15')
  const pool = client.pool.buildSimulatedVirtualPool(launchCurve.sqrtStartPrice)
  pool.poolState.activationPoint = new BN(1_000)
  const config = client.pool.normalizeQuoteConfig(launchCurve)
  let previous = 0n
  for (let second = 990; second <= 1_200; second += 5) {
    const quote = client.pool.swapQuote({ virtualPool: pool, config, swapBaseForQuote: false, amountIn: new BN(500_000_000),
      slippageBps: 100, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint: quotePoint(second, 1_000) })
    const fee = BigInt(quote.tradingFee.add(quote.protocolFee).toString())
    assert.equal(fee, ceilDiv(500_000_000n * feeNumeratorAt(schedule, 1_000n, BigInt(second)), 1_000_000_000n), `second ${second}`)
    assert.ok(BigInt(quote.outputAmount.toString()) >= previous, 'a later execution never receives less')
    previous = BigInt(quote.outputAmount.toString())
  }
})

test('launch-fee window, terms and copy are factual and only exist for scheduled configs', () => {
  const window = launchFeeWindow(schedule, 1_000n, 1_030n)
  assert.deepEqual({ ...window }, { active: true, feeNumerator: 288_066_303n, startNumerator: 504_409_597n, endNumerator: 17_500_000n,
    activationPoint: 1_000n, endsAt: 1_180n, remaining: 150n })
  assert.equal(launchFeeWindow(schedule, 1_000n, 1_180n).active, false)
  assert.equal(launchFeeWindow(schedule, 1_000n, 990n).feeNumerator, 504_409_597n)
  assert.equal(launchFeeWindow(readFeeSchedule(buildersCurve), 1_000n, 1_030n), null)
  const json = launchFeeJson(window)
  assert.deepEqual(json, { active: true, feeNumerator: '288066303', endFeeNumerator: '17500000', startFeeNumerator: '504409597', endsAt: 1180, remainingSeconds: 150 })
  const terms = launchFeeTerms(schedule)
  assert.deepEqual({ ...terms }, { startPercent: '50.44%', endPercent: '1.75%', durationSeconds: 180, durationLabel: '3 minutes', launcherBuyPercent: '1.75%' })
  assert.equal(launchFeeTerms(readFeeSchedule(buildersCurve)), null)
  assert.equal(launchFeeSentence(terms), 'Trades in the first 3 minutes after launch pay a higher fee that starts at 50.44% and falls every second to 1.75%.')
  assert.equal(launcherBuySentence(terms), 'The launcher’s initial buy is part of the launch transaction and pays 1.75%.')
  assert.match(LAUNCH_FEE_SPLIT, /builders and repo\.ing.*Meteora’s 20% protocol share/)
  assert.equal(launchFeeNotice(json), 'Launch fee: 28.81% at quote time, falling every second to 1.75% within 150 s. It is split like the regular fee.')
  assert.match(launchFeeTradeNote(json), /^This market is in its launch-fee window: trades pay 28\.81% at this quote\. .*1\.75% within 150 s/)
  for (const inactive of [null, undefined, { ...json, active: false }, { ...json, feeNumerator: 'x' }]) {
    assert.equal(launchFeeNotice(inactive), null)
    assert.equal(launchFeeTradeNote(inactive), null)
  }
  assert.deepEqual([17_500_000, 504_409_597, 50_000, 49_999, 0].map(feePercentLabel), ['1.75%', '50.44%', '0.01%', '0.00%', '0.00%'])
  assert.throws(() => feePercentLabel(-1), /Invalid/)
})

test('pool fee facts never break quoting, even for an unexpected config', () => {
  assert.deepEqual(poolFeeFacts(null, 0, 0), { feeNumerator: null, launchFee: null })
  assert.deepEqual(poolFeeFacts({ poolFees: { baseFee: { baseFeeMode: BaseFeeMode.RateLimiter } } }, 0, 0), { feeNumerator: null, launchFee: null })
  assert.deepEqual(poolFeeFacts(buildersCurve, new BN(1_000), new BN(1_010)), { feeNumerator: 17_500_000n, launchFee: null })
  const facts = poolFeeFacts(launchCurve, new BN(1_000), new BN(1_010))
  assert.equal(facts.feeNumerator, 418_491_248n)
  assert.equal(facts.launchFee.remaining, 170n)
})

test('a Solana Action buy inside the launch-fee window says what fee it pays', async () => {
  const MINT = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be', wallet = Keypair.generate().publicKey
  const loadMarket = async () => ({ repoId: '1', mint: MINT, symbol: 'NEW', fullName: 'local/new', description: '' })
  const prepareBuy = launchFee => async request => {
    const payer = new PublicKey(request.wallet)
    const tx = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' })
      .add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }))
    return { transaction: tx, direction: 'buy', mint: MINT, amountIn: BigInt(request.amountLamports), minimumAmountOut: 1_000_000n, launchFee }
  }
  const post = launchFee => handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=0.1`,
    { method: 'POST', body: JSON.stringify({ account: wallet.toBase58() }) }), MINT, { loadMarket, prepareBuy: prepareBuy(launchFee) })
  const active = await (await post(launchFeeJson(launchFeeWindow(schedule, 0n, 30n)))).json()
  assert.match(active.message, /at least 1 \$NEW \(1% max slippage\)\. Launch fee: 28\.81% at quote time, falling every second to 1\.75% within 150 s\./)
  for (const launchFee of [null, launchFeeJson(launchFeeWindow(schedule, 0n, 400n))]) {
    assert.doesNotMatch((await (await post(launchFee)).json()).message, /Launch fee/)
  }
})
