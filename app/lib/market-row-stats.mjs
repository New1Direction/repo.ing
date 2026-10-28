import { mintSupply, storedPrice } from '../../src/market-chart.mjs'
import { publicGraduation } from '../../src/graduation-readiness.mjs'

// Server-only: turns the joined price and graduation columns of a market list row into the few
// public numbers the list renders. Raw observation JSON never leaves the server. lastPriceSol: the newest trade's stored price
// (trade_prices.price_sol); supplyBaseUnits/supplyDecimals: the mint's on-chain supply (mint_facts), null until read.
export function marketRowStats(row, now = Date.now()) {
  let bondingPercent = null, graduated = false
  const priceSol = storedPrice(row.lastPriceSol), supply = mintSupply({ supply: row.supplyBaseUnits, decimals: row.supplyDecimals })
  if (row.graduationStatus) {
    try {
      // Same freshness and migration-proof gate as the public curve endpoint; stale progress draws no line.
      const curve = publicGraduation({ status: row.graduationStatus, observation: row.observation, error_code: row.graduationError,
        migration_evidence_hash: row.migrationEvidenceHash }, now)
      graduated = curve.phase === 'GRADUATED'
      bondingPercent = Number.isFinite(curve.progressPercent) ? curve.progressPercent : null
    } catch {}
  }
  return { priceSol, supply, bondingPercent, graduated }
}
