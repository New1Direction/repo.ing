import { publicGraduation } from '../../src/graduation-readiness.mjs'
import { formatSolDisplay } from './format.mjs'

export const ABOUT_TO_GRADUATE_MIN_PERCENT = 50
export const ABOUT_TO_GRADUATE_LIMIT = 6

// Rows carry graduation_observations columns plus the migration evidence hash; each one must pass the
// same freshness gate as the public curve endpoint. A row that throws (stale, unverified) is skipped.
export function selectAboutToGraduate(rows, now = Date.now()) {
  const near = rows.flatMap(row => {
    let curve
    try { curve = publicGraduation(row, now) } catch { return [] }
    if (curve.phase !== 'CURVE' || curve.status !== 'active') return []
    const reserve = BigInt(curve.reserveLamports), threshold = BigInt(curve.thresholdLamports)
    if (threshold <= 0n || reserve * 100n < threshold * BigInt(ABOUT_TO_GRADUATE_MIN_PERCENT)) return []
    const { repoId, mint, fullName, symbol, tokenName } = row
    return [{ repoId, mint, fullName, symbol, tokenName, progressPercent: curve.progressPercent,
      reserveLamports: curve.reserveLamports, thresholdLamports: curve.thresholdLamports, remainingLamports: curve.remainingLamports }]
  })
  // Compare exact ratios (a.reserve/a.threshold vs b.reserve/b.threshold) instead of rounded percents.
  return near.sort((a, b) => {
    const d = BigInt(b.reserveLamports) * BigInt(a.thresholdLamports) - BigInt(a.reserveLamports) * BigInt(b.thresholdLamports)
    return d > 0n ? 1 : d < 0n ? -1 : a.mint.localeCompare(b.mint)
  }).slice(0, ABOUT_TO_GRADUATE_LIMIT)
}

// Floor so 99.9% never reads as 100% before the target is reached. Formats from raw lamports.
export const graduationPercentLabel = percent => `${Math.floor(percent)}%`
export const graduationSummary = market => `${graduationPercentLabel(market.progressPercent)} · ${formatSolDisplay(market.remainingLamports)} SOL to go`
