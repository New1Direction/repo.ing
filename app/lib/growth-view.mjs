// /explore's highlights render three market lists and the top three discoverers without their
// per-market details or trend candidates; the client refresh reloads the full /api/growth payload.
export function exploreGrowthView(growth) {
  const { newMarkets, closest, earners, leaders, leaderboardPartial, checkedAt } = growth
  return { newMarkets, closest, earners, leaderboardPartial, checkedAt,
    leaders: leaders.slice(0, 3).map(({ markets, ...leader }) => leader) }
}
