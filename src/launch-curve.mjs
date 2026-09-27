import {
  ActivationType, BaseFeeMode, buildCurve, buildCurveWithCustomSqrtPrices, CollectFeeMode,
  createSqrtPrices, MigrationFeeOption, MigrationOption, TokenAuthorityOption, TokenDecimal, TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

// Operator-selected profiles for review. Nothing imports these into production
// launch selection: activation still requires a new on-chain config and rollout.
export const CURVE_PROFILES = Object.freeze({
  legacy: { label: 'Existing curve' },
  balanced: { label: '85 SOL graduation', migrationQuoteThreshold: 85 },
  builders: { label: '85 SOL graduation with 1% builder allocation', migrationQuoteThreshold: 85 },
  deeper: { label: '170 SOL graduation', migrationQuoteThreshold: 170 },
  deepest: { label: '340 SOL graduation', migrationQuoteThreshold: 340 },
})

export function buildLaunchCurve(profile = 'balanced') {
  const selected = CURVE_PROFILES[profile]
  if (!selected) throw Error('Unknown launch curve profile')
  const common = {
    token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000, leftover: profile === 'builders' ? 10_001_000 : 1000 },
    fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
      feeSchedulerParam: { startingFeeBps: 175, endingFeeBps: 175, numberOfPeriod: 0, totalDuration: 0 } },
      dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 71, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
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
  return buildCurve({ ...common, percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: selected.migrationQuoteThreshold })
}
