import {
  ActivationType, BaseFeeMode, buildCurve, buildCurveWithCustomSqrtPrices, CollectFeeMode,
  createSqrtPrices, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { launchFeeBaseFee } from './launch-fee.mjs'

// Operator-selected profiles for review. Nothing imports these into production
// launch selection: activation still requires a new on-chain config and rollout.
export const CURVE_PROFILES = Object.freeze({
  legacy: { label: 'Existing curve' },
  balanced: { label: '85 SOL graduation', migrationQuoteThreshold: 85 },
  builders: { label: '85 SOL graduation with 1% builder allocation', migrationQuoteThreshold: 85 },
  // The builders profile with the anti-sniper launch fee (src/launch-fee.mjs); every other parameter is identical.
  'launch-fee': { label: '85 SOL graduation with 1% builder allocation and launch fee', migrationQuoteThreshold: 85 },
  deeper: { label: '170 SOL graduation', migrationQuoteThreshold: 170 },
  deepest: { label: '340 SOL graduation', migrationQuoteThreshold: 340 },
})

export function buildLaunchCurve(profile = 'balanced') {
  const selected = CURVE_PROFILES[profile]
  if (!selected) throw Error('Unknown launch curve profile')
  const launchFee = profile === 'launch-fee'
  const common = {
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000, leftover: profile === 'builders' || launchFee ? 10_001_000 : 1000 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 175, endingFeeBps: 175, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 71, poolCreationFee: 0, enableFirstSwapWithMinFee: launchFee },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp,
  }
  if (profile === 'legacy') return buildCurveWithCustomSqrtPrices({ ...common,
    sqrtPrices: createSqrtPrices([0.000000001, 0.00000000105, 0.000000002, 0.000001], 6, 9),
    liquidityWeights: [2, 1, 1] })
  const curve = buildCurve({ ...common, percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: selected.migrationQuoteThreshold })
  // The curve, supply and migration math never read the fee. The exact scheduler cliff (50.44%) is not a whole
  // basis-point value, so it replaces the flat 175 bps base fee after the curve is built.
  return launchFee ? { ...curve, poolFees: { ...curve.poolFees, baseFee: launchFeeBaseFee() } } : curve
}

// The contributor early access config's curve (docs/EARLY_ACCESS.md): exactly the builders profile (flat 1.75%, 1% builder
// allocation, 85 SOL graduation) with a Token-2022 base, which a transfer hook needs. No anti-sniper launch fee (owner decision,
// 2026-10-05): during the window only contributors can buy.
export function buildEarlyAccessCurve() {
  return { ...buildLaunchCurve('builders'), tokenType: TokenType.Token2022 }
}

// A stock-paired market's curve (docs/STOCK_QUOTES.md): the launch-fee profile's fees, split, migration and locked liquidity,
// with the stock's own decimals and a graduation threshold in whole units of that stock (the owner sets it when the config
// is created; it moves with the stock's price, not SOL's). No builder allocation: stock-paired markets do not carry it.
export function buildStockLaunchCurve({ quoteDecimals, migrationQuoteThreshold }) {
  const decimals = { 6: TokenDecimal.SIX, 7: TokenDecimal.SEVEN, 8: TokenDecimal.EIGHT, 9: TokenDecimal.NINE }[quoteDecimals]
  if (decimals === undefined) throw Error('Unsupported quote decimals')
  if (!Number.isFinite(migrationQuoteThreshold) || migrationQuoteThreshold <= 0) throw Error('Graduation threshold must be positive')
  const curve = buildCurve({
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX, tokenQuoteDecimal: decimals,
      tokenAuthorityOption: TokenAuthorityOption.Immutable, totalTokenSupply: 1_000_000_000, leftover: 1000 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 175, endingFeeBps: 175, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 71, poolCreationFee: 0, enableFirstSwapWithMinFee: true },
    migration: { migrationOption: MigrationOption.MET_DAMM_V2, migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
    liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50 },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0 },
    activationType: ActivationType.Timestamp, percentageSupplyOnMigration: 20, migrationQuoteThreshold,
  })
  return { ...curve, poolFees: { ...curve.poolFees, baseFee: launchFeeBaseFee() } }
}
