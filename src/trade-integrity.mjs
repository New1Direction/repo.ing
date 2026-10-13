// Trading integrity for one market (docs/LAUNCH_TRANSPARENCY.md#trading-integrity): which part of its finalized swap volume is
// organic, and which part cannot be: swaps by labeled repo.ing or builder wallets, swaps in a transaction that both buys and
// sells this market (one signer on both sides), and round trips, where one controller (a wallet or its linked cluster,
// src/wallet-clusters.mjs) buys and sells back within ROUND_TRIP_WINDOW_MS. Swaps whose owner is not indexed yet are
// "unattributed", never assumed organic. Volume is SOL lamports (bigint); every input is public chain evidence.
// No volume is ever rewarded: these numbers only exclude activity from metrics and incentives.

export const ROUND_TRIP_WINDOW_MS = 60 * 60 * 1000
export const INTEGRITY_VERSION = 1

const big = value => {
  try { return typeof value === 'bigint' ? value : BigInt(value ?? 0) } catch { return null }
}
const time = value => value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)

// Normalized, chain-ordered events; malformed rows are dropped (and counted).
export function normalizeTrades(rows) {
  const events = []
  let malformed = 0
  for (const row of rows ?? []) {
    const lamports = big(row?.lamports), tokens = big(row?.tokens), slot = big(row?.slot), at = time(row?.tradedAt)
    if (!row?.signature || !['buy', 'sell'].includes(row.direction) || lamports === null || lamports < 0n || tokens === null || tokens < 0n ||
        slot === null || !Number.isFinite(at)) { malformed++; continue }
    events.push({ signature: row.signature, eventIndex: Number(row.eventIndex ?? 0), slot, at, trader: row.trader || null,
      direction: row.direction, lamports, tokens, venue: row.venue ?? 'curve' })
  }
  events.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0) || a.at - b.at || a.signature.localeCompare(b.signature) || a.eventIndex - b.eventIndex)
  return { events, malformed }
}

// Signatures holding both a buy and a sell of this market.
export function twoSidedSignatures(events) {
  const sides = new Map()
  for (const event of events) sides.set(event.signature, (sides.get(event.signature) ?? 0) | (event.direction === 'buy' ? 1 : 2))
  return new Set([...sides].filter(([, mask]) => mask === 3).map(([signature]) => signature))
}

// FIFO matching of one controller's buys against its sells (and sells against later buys) within the window. Returns the matched
// lamports; both legs of a match count as round-trip volume.
export function matchRoundTrips(events, windowMs = ROUND_TRIP_WINDOW_MS) {
  const open = { buy: [], sell: [] }
  let matched = 0n
  for (const event of events) {
    const opposite = open[event.direction === 'buy' ? 'sell' : 'buy']
    while (opposite.length && event.at - opposite[0].at > windowMs) opposite.shift()
    let remaining = event.lamports
    while (remaining > 0n && opposite.length) {
      const head = opposite[0], take = head.remaining < remaining ? head.remaining : remaining
      matched += take
      head.remaining -= take
      remaining -= take
      if (head.remaining === 0n) opposite.shift()
    }
    if (remaining > 0n) open[event.direction].push({ at: event.at, remaining })
  }
  return matched
}

const percent = (part, whole) => whole > 0n ? Number(part * 10_000n / whole) / 100 : null

// rows: swaps of one market (readMarketTrades). labels: Map wallet → { kind, label }. clusterOf: Map wallet → cluster id.
export function tradeIntegrity(rows, { labels = new Map(), clusterOf = new Map(), windowMs = ROUND_TRIP_WINDOW_MS } = {}) {
  const { events, malformed } = normalizeTrades(rows)
  const bundled = twoSidedSignatures(events)
  const totals = { volume: 0n, organic: 0n, roundTrip: 0n, sameTransaction: 0n, labeled: 0n, unattributed: 0n }
  const byCluster = new Map()
  const clusterEntry = id => {
    if (!byCluster.has(id)) byCluster.set(id, { cluster: id, wallets: new Set(), events: [], volume: 0n, roundTrip: 0n, sameTransaction: 0n })
    return byCluster.get(id)
  }
  for (const event of events) {
    totals.volume += event.lamports
    if (!event.trader) { totals.unattributed += event.lamports; continue }
    if (labels.has(event.trader)) { totals.labeled += event.lamports; continue }
    const entry = clusterEntry(clusterOf.get(event.trader) ?? event.trader)
    entry.wallets.add(event.trader)
    entry.volume += event.lamports
    if (bundled.has(event.signature)) { totals.sameTransaction += event.lamports; entry.sameTransaction += event.lamports; continue }
    entry.events.push(event)
  }
  for (const entry of byCluster.values()) {
    const matched = matchRoundTrips(entry.events, windowMs)
    entry.roundTrip = matched * 2n
    totals.roundTrip += entry.roundTrip
    delete entry.events
  }
  totals.organic = totals.volume - totals.labeled - totals.unattributed - totals.sameTransaction - totals.roundTrip
  const clusters = [...byCluster.values()].map(entry => ({ ...entry, wallets: [...entry.wallets].sort(),
    organic: entry.volume - entry.roundTrip - entry.sameTransaction }))
  const attributed = totals.volume - totals.unattributed
  return {
    version: INTEGRITY_VERSION,
    windowMinutes: Math.round(windowMs / 60_000),
    events: events.length,
    malformed,
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.toString()])),
    // Shares of attributed volume: unattributed swaps are reported, not guessed.
    organicPercent: percent(totals.organic, attributed),
    roundTripPercent: percent(totals.roundTrip, attributed),
    sameTransactionPercent: percent(totals.sameTransaction, attributed),
    labeledPercent: percent(totals.labeled, attributed),
    unattributedPercent: percent(totals.unattributed, totals.volume),
    traders: { controllers: clusters.length, organic: clusters.filter(entry => entry.organic > 0n).length,
      linkedControllers: clusters.filter(entry => entry.wallets.length > 1).length },
    clusters,
  }
}

// Public JSON view (no per-cluster rows beyond the ten largest round-trip controllers, by volume).
export function integrityView(result) {
  if (!result) return null
  const { clusters, ...rest } = result
  const flagged = clusters.filter(entry => entry.roundTrip > 0n || entry.sameTransaction > 0n)
    .sort((a, b) => { const x = a.roundTrip + a.sameTransaction, y = b.roundTrip + b.sameTransaction; return x > y ? -1 : x < y ? 1 : a.cluster.localeCompare(b.cluster) }).slice(0, 10)
    .map(entry => ({ cluster: entry.cluster, wallets: entry.wallets, volumeLamports: entry.volume.toString(),
      roundTripLamports: entry.roundTrip.toString(), sameTransactionLamports: entry.sameTransaction.toString() }))
  return { ...rest, flagged }
}

// Every finalized swap of one market with its owner, curve trades by pool and post-graduation DAMM trades by repository (the
// sources Backers and the chart use). since: optional Date lower bound.
export async function readMarketTrades(db, { pool, repoId, since = null }) {
  const { rows } = await db.query(`select signature, event_index as "eventIndex", slot::text as slot, traded_at as "tradedAt", trader, direction,
      (case when direction = 'buy' then input_base_units else output_base_units end) as lamports,
      (case when direction = 'buy' then output_base_units else input_base_units end) as tokens, 'curve' as venue
    from trade_events where pool = $1 and ($3::timestamptz is null or traded_at >= $3)
    union all
    select d.signature, d.event_index, d.slot::text, d.traded_at, d.trader, d.direction, d.quote_amount::text, coalesce(d.base_amount, 0)::text, 'damm'
    from damm_trade_events d join graduation_events g on g.github_repo_id = d.github_repo_id and g.pool = d.pool
    where d.github_repo_id = $2::bigint and ($3::timestamptz is null or d.traded_at >= $3)`,
  [pool, repoId == null ? null : String(repoId), since])
  return rows
}
