import { PublicKey } from '@solana/web3.js'
import { createMarketConfigResolver } from '../../src/market-config.mjs'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress, deriveDammV2PoolAddress, DAMM_V2_MIGRATION_FEE_ADDRESS, DAMM_V2_PROGRAM_ID, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'

export function curveProgress(reserve, threshold, migrated = false) {
  const current = BigInt(reserve), target = BigInt(threshold)
  if (current < 0n || target <= 0n) throw Error('Invalid bonding reserves')
  return { status: migrated ? 'graduated' : current >= target ? 'migrating' : 'active',
    progressPercent: migrated || current >= target ? 100 : Number(current * 10000n / target) / 100,
    reserveLamports: current.toString(), thresholdLamports: target.toString(),
    remainingLamports: (migrated || current >= target ? 0n : target - current).toString() }
}

export function verifiedMigrationDestination(address, accountOwner, target, mint, quoteMint) {
  if (!accountOwner?.equals(DAMM_V2_PROGRAM_ID) || target.poolStatus !== 0) return null
  const pairMatches = target.tokenAMint.equals(mint) && target.tokenBMint.equals(quoteMint) ||
    target.tokenBMint.equals(mint) && target.tokenAMint.equals(quoteMint)
  return pairMatches ? { pool: address.toBase58(), url: `https://app.meteora.ag/dammv2/${address.toBase58()}` } : null
}

export async function readBondingStatus(connection, market, configAddress) {
  const config = createMarketConfigResolver(configAddress)(market), mint = new PublicKey(market.mint), pool = new PublicKey(market.pool)
  if (!deriveDbcPoolAddress(NATIVE_MINT, mint, config).equals(pool)) throw Error('Canonical pool mismatch')
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const [state, fixed] = await Promise.all([dbc.state.getPool(pool), dbc.state.getPoolConfig(config)])
  if (!state?.poolState.baseMint.equals(mint) || !state.poolState.config.equals(config) || !fixed?.quoteMint.equals(NATIVE_MINT)) throw Error('Canonical market unavailable')
  const progress = curveProgress(state.poolState.quoteReserve.toString(), fixed.migrationQuoteThreshold.toString(), state.poolState.isMigrated !== 0)
  let destination = null
  if (progress.status === 'graduated' && fixed.migrationOption === MigrationOption.MET_DAMM_V2) {
    const feeConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
    if (feeConfig) {
      const address = deriveDammV2PoolAddress(feeConfig, mint, fixed.quoteMint)
      try {
        const [info, target] = await Promise.all([connection.getAccountInfo(address, 'confirmed'), new CpAmm(connection).fetchPoolState(address)])
        destination = verifiedMigrationDestination(address, info?.owner, target, mint, fixed.quoteMint)
      } catch { /* Preserve the graduation state while the destination is unavailable. Never offer an unchecked pool link. */ }
    }
  }
  return { ...progress, destination, checkedAt: new Date().toISOString() }
}
