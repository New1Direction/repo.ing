// Market-maker incentives and fee rebates, PREVIEW only (docs/LAUNCH_TRANSPARENCY.md#market-maker-incentives-and-fee-rebates).
// Only genuine two-sided liquidity can qualify: a DAMM v2 LP position holds both the token and SOL across the pool's whole price
// range, so it is quoted on both sides for as long as it exists. Trading volume never qualifies, so wash trading earns nothing.
// A position's owner is excluded when it is
//   labeled          a repo.ing or builder wallet (the migrated, permanently locked creator and partner positions are repo.ing's);
//   circular-volume  its controller (wallet cluster, src/wallet-clusters.mjs) round-tripped or traded both sides in one transaction
//                    in this market at least CIRCULAR_MIN_LAMPORTS, or for at least CIRCULAR_MIN_PERCENT of its own volume:
//                    LP fees farmed by trading against one's own position are circular;
//   owner-unknown    the position NFT's holder could not be read;
//   migrated-locked  the market's own migration positions (graduated_migration_proofs), repo.ing's permanently locked liquidity,
//                    excluded by position address whoever the labels name.
// Score = time-weighted share of pool liquidity × uptime. A share of an incentive budget follows the score; there is no budget and
// nothing is paid by this code.

export const INCENTIVE_VERSION = 1
export const INCENTIVE_WINDOW_DAYS = 7
export const CIRCULAR_MIN_LAMPORTS = 500_000_000n
export const CIRCULAR_MIN_PERCENT = 20

const SCALE = 1_000_000n

// samples: lp_position_samples rows of one pool over the window. integrity: tradeIntegrity(...) for the same market (its clusters).
export function lpIncentives(samples, { labels = new Map(), clusterOf = new Map(), integrity = null, migratedPositions = new Set() } = {}) {
  const times = [...new Set((samples ?? []).map(row => new Date(row.sampledAt).getTime()).filter(Number.isFinite))].sort((a, b) => a - b)
  const sampleCount = times.length
  const circular = new Map()
  for (const entry of integrity?.clusters ?? []) {
    const flagged = entry.roundTrip + entry.sameTransaction
    if (flagged >= CIRCULAR_MIN_LAMPORTS || (entry.volume > 0n && flagged * 100n >= entry.volume * BigInt(CIRCULAR_MIN_PERCENT))) {
      circular.set(entry.cluster, flagged)
    }
  }
  const owners = new Map()
  for (const row of samples ?? []) {
    const at = new Date(row.sampledAt).getTime()
    const liquidity = BigInt(row.liquidity ?? 0), pool = BigInt(row.poolLiquidity ?? 0)
    if (!Number.isFinite(at) || pool <= 0n) continue
    const migrated = migratedPositions.has(row.position)
    const key = migrated ? `migrated:${row.position}` : row.owner ?? `unknown:${row.position}`
    const entry = owners.get(key) ?? { owner: row.owner ?? null, migrated, positions: new Set(), shareByTime: new Map(), locked: 0n }
    entry.positions.add(row.position)
    entry.shareByTime.set(at, (entry.shareByTime.get(at) ?? 0n) + liquidity * SCALE / pool)
    if (BigInt(row.permanentLockedLiquidity ?? 0) > 0n) entry.locked += 1n
    owners.set(key, entry)
  }
  const rows = [...owners.values()].map(entry => {
    const shareSum = [...entry.shareByTime.values()].reduce((sum, value) => sum + value, 0n)
    const present = [...entry.shareByTime.values()].filter(value => value > 0n).length
    const cluster = entry.owner ? clusterOf.get(entry.owner) ?? entry.owner : null
    const label = entry.owner ? labels.get(entry.owner) ?? null : null
    const exclusion = entry.migrated ? 'migrated-locked' : !entry.owner ? 'owner-unknown' : label ? 'labeled' : circular.has(cluster) ? 'circular-volume' : null
    const timeWeightedSharePpm = sampleCount ? shareSum / BigInt(sampleCount) : 0n
    const uptimePercent = sampleCount ? Math.round(present * 10_000 / sampleCount) / 100 : 0
    const score = exclusion ? 0n : timeWeightedSharePpm * BigInt(Math.round(uptimePercent * 100)) / 10_000n
    return { owner: entry.owner, cluster, label: label?.label ?? null, positions: [...entry.positions].sort(),
      timeWeightedSharePercent: Number(timeWeightedSharePpm) / 10_000, uptimePercent, exclusion,
      circularLamports: circular.get(cluster)?.toString() ?? null, score }
  })
  const totalScore = rows.reduce((sum, row) => sum + row.score, 0n)
  return {
    version: INCENTIVE_VERSION,
    status: 'preview', paid: false, windowDays: INCENTIVE_WINDOW_DAYS, samples: sampleCount,
    providers: rows.map(({ score, ...row }) => ({ ...row,
      incentiveSharePercent: totalScore > 0n && score > 0n ? Number(score * 1_000_000n / totalScore) / 10_000 : 0 }))
      .sort((a, b) => b.incentiveSharePercent - a.incentiveSharePercent || b.timeWeightedSharePercent - a.timeWeightedSharePercent ||
        String(a.owner).localeCompare(String(b.owner))),
    rules: { twoSidedOnly: 'DAMM v2 LP positions', volumeNeverQualifies: true,
      circularMinLamports: CIRCULAR_MIN_LAMPORTS.toString(), circularMinPercent: CIRCULAR_MIN_PERCENT },
  }
}

// Pool-level market quality from liquidity samples (the market-maker feed's summary): uptime, median spread and depth.
export { sustainedLiquidity as poolLiquidityQuality } from './market-health.mjs'
