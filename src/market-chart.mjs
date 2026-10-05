import BN from 'bn.js'
import { evidenceHash } from './graduation-state.mjs'
import { getPriceFromSqrtPrice, TokenDecimal } from '@meteora-ag/dynamic-bonding-curve-sdk'

export const CHART_RANGES = {
  '1h': { seconds: 3600, interval: 60, label: '1 minute' },
  '24h': { seconds: 86400, interval: 300, label: '5 minutes' },
  '7d': { seconds: 604800, interval: 3600, label: '1 hour' },
  all: { seconds: null, interval: null, label: null },
}

export function chartWindow(range, firstTrade, now = Date.now(), lastTrade = now) {
  const selected = Object.hasOwn(CHART_RANGES, range) ? range : 'all'
  const spec = CHART_RANGES[selected]
  const start = spec.seconds ? now - spec.seconds * 1000 : Math.min(now, Date.parse(firstTrade) || now)
  const historyEnd = Math.min(now, new Date(lastTrade ?? now).getTime())
  const interval = spec.interval ?? Math.max(60, Math.ceil((historyEnd - start) / 1000 / 500 / 60) * 60)
  return { range: selected, start: new Date(start).toISOString(), end: new Date(now).toISOString(), interval,
    intervalLabel: spec.label ?? (interval < 3600 ? `${interval / 60} minutes` : `${Number((interval / 3600).toFixed(1))} hours`) }
}

export function chartSpotPrice(raw) {
  if (!/^\d+$/.test(String(raw)) || BigInt(raw) <= 0n) throw Error('Invalid chart price evidence')
  const price = Number(getPriceFromSqrtPrice(new BN(String(raw)), TokenDecimal.SIX, TokenDecimal.NINE).toString())
  if (!Number.isFinite(price) || price <= 0) throw Error('Invalid chart price')
  return price
}

export function chartBar(row) {
  const time = Number(row.time)
  const volumeLamports = String(row.volume)
  if (!Number.isSafeInteger(time) || !/^\d+$/.test(volumeLamports)) throw Error('Invalid chart bar evidence')
  const count = Number(row.count)
  if (!Number.isSafeInteger(count) || count < 1) throw Error('Invalid chart trade count')
  // Withhold open/close until finalized block evidence resolves boundary-slot order.
  if (row.ambiguous || row.missing_price) return { time, volumeLamports, count, orderingPending: true, priceEvidenceMissing: Boolean(row.missing_price) }
  return { time, open: chartSpotPrice(row.open), high: chartSpotPrice(row.high), low: chartSpotPrice(row.low),
    close: chartSpotPrice(row.close), volumeLamports, count }
}

// Historical prices require immutable migration proof, independently of short-lived
// progress observations. Trading links still require the fresh graduation checks.
export function chartMigration(market, row) {
  if (!row) return null
  const { migration } = JSON.parse(row.evidence)
  if (!migration || evidenceHash(migration) !== row.evidence_hash ||
      String(row.github_repo_id) !== String(market.repoId) || migration.mint !== market.mint ||
      migration.curve !== market.pool || migration.pool !== row.pool || migration.signature !== row.signature ||
      String(migration.slot) !== String(row.slot)) throw Error('CHART_MIGRATION_MISMATCH')
  return { pool: row.pool, slot: String(row.slot), signature: row.signature }
}
const canonicalEvents = `with canonical_events as (
  select signature,event_index,slot,traded_at,direction,next_sqrt_price,
    (case when direction='buy' then input_base_units else output_base_units end)::numeric as quote_amount,
    (case when direction='buy' then output_base_units else input_base_units end)::numeric as base_amount,
    'DBC'::text as venue from trade_events where pool=$1
  union all
  select signature,event_index,slot,traded_at,direction,next_sqrt_price,quote_amount::numeric,base_amount::numeric,'DAMM'::text as venue
    from damm_trade_events where pool=$5 and github_repo_id=$6 and slot >= $7
)`
// A trade's place in its finalized block: the stored position (finalized_chart_positions), else the block's full
// signature list. The list is joined (and de-TOASTed) only for a trade indexed after its block was recorded, until the
// ordering worker stores that position; null while the block is unverified or the trade is not in it.
export const blockPosition = t => `coalesce(p.transaction_index,array_position(b.signatures,${t}.signature::text))`
export const blockJoins = t => `left join finalized_chart_positions p on p.slot=${t}.slot and p.signature=${t}.signature
  left join finalized_chart_blocks b on b.slot=${t}.slot and p.slot is null`

// Live trades (drizzle/0057_live_trade_events.sql, src/live-trades.mjs): confirmed swaps the finalized ledgers do not hold
// yet. Only the canonical curve pool's and the verified DAMM destination's, from the newest finalized slot on, at most
// LIVE_TRADE_MAX_AGE_SECONDS old (a swap that never finalizes drops out by itself), and never one a finalized ledger already
// holds. A database before 0057 has none.
export const LIVE_TRADE_MAX_AGE_SECONDS = 120
export async function readLiveTrades(db, market, migration, fromSlot) {
  if (!market.repoId) return []
  try {
    const { rows } = await db.query(`select l.signature, l.event_index as "eventIndex", l.slot::text, l.traded_at as "tradedAt",
        l.direction, l.venue, l.next_sqrt_price::text as "nextSqrtPrice", l.quote_amount::text as "solLamports",
        l.base_amount::text as "tokenBaseUnits"
      from live_trade_events l
      where l.github_repo_id = $1 and l.pool = any($2::text[]) and l.slot >= $3::bigint
        and l.received_at > now() - make_interval(secs => $4)
        and not exists (select 1 from trade_events t where t.signature = l.signature and t.event_index = l.event_index)
        and not exists (select 1 from damm_trade_events d where d.signature = l.signature and d.event_index = l.event_index)
      order by l.slot, l.received_at, l.signature, l.event_index limit 200`,
    [String(market.repoId), [market.pool, migration?.pool].filter(Boolean), fromSlot ?? '0', LIVE_TRADE_MAX_AGE_SECONDS])
    return rows
  } catch (error) { if (error?.code === '42P01') return []; throw error }
}

// A chart with its live trades after the finalized history. Each is appended to the trade list and folded into its
// bucket: a bucket the finalized history already has keeps its open, and one withholding prices for unproven order keeps
// withholding them. The newest becomes the latest price. Live trades are marked pending and their candles live. Same-slot
// live trades keep the order they were received in until finalized order replaces them.
export function mergeLiveTrades(chart, rows, now = Date.now()) {
  const live = rows.flatMap(row => {
    try {
      return [{ signature: row.signature, eventIndex: row.eventIndex, direction: row.direction, venue: row.venue,
        tradedAt: new Date(row.tradedAt).toISOString(), priceSol: chartSpotPrice(row.nextSqrtPrice), solLamports: String(row.solLamports),
        tokenBaseUnits: row.tokenBaseUnits ?? null, pending: true }]
    } catch { return [] } // An unreadable live row is left out; it never costs the finalized chart.
  })
  if (!live.length) return chart
  const start = Date.parse(chart.start), bars = new Map(chart.candles.map(bar => [bar.time, bar]))
  for (const trade of live) {
    const at = Date.parse(trade.tradedAt)
    if (at < start) continue
    const time = Math.floor(at / 1000 / chart.interval) * chart.interval
    const previous = bars.get(time)
    const bar = previous ? { ...previous } : { time, open: trade.priceSol, high: trade.priceSol, low: trade.priceSol, volumeLamports: '0', count: 0 }
    if (!bar.orderingPending) Object.assign(bar, { high: Math.max(bar.high, trade.priceSol), low: Math.min(bar.low, trade.priceSol), close: trade.priceSol })
    bars.set(time, { ...bar, volumeLamports: (BigInt(bar.volumeLamports) + BigInt(trade.solLamports)).toString(), count: bar.count + 1, live: true })
  }
  const dayAgo = now - 86_400_000
  const liveVolume = live.reduce((sum, trade) => Date.parse(trade.tradedAt) >= dayAgo ? sum + BigInt(trade.solLamports) : sum, 0n)
  return { ...chart, candles: [...bars.values()].sort((a, b) => a.time - b.time), trades: [...chart.trades, ...live].slice(-120),
    totalTrades: chart.totalTrades + live.length, volume24hLamports: (BigInt(chart.volume24hLamports) + liveVolume).toString(),
    latest: live.at(-1), latestOrderingPending: false, live: { trades: live.length } }
}

const earliest = (...values) => values.filter(value => value != null).sort((a, b) => new Date(a) - new Date(b))[0] ?? null
const newest = (...values) => values.filter(value => value != null).sort((a, b) => new Date(b) - new Date(a))[0] ?? null

// live: also show confirmed trades the finalized ledgers do not hold yet (the market page and its API; see mergeLiveTrades).
export async function readMarketChart(db, market, range = 'all', now = Date.now(), { live = false } = {}) {
  const migration = market.repoId ? chartMigration(market, (await db.query('select * from graduation_events where github_repo_id=$1', [market.repoId])).rows[0]) : null
  const params = (start, end, interval) => [market.pool, start, end, interval, migration?.pool ?? null, market.repoId ?? null, migration?.slot ?? null]
  const { rows: [summary] } = await db.query(`${canonicalEvents} select min(traded_at) as first, max(traded_at) as last,
    count(*)::text as count, count(*) filter(where venue='DAMM')::int as damm_count, max(slot)::text as last_slot,
    coalesce(sum(quote_amount) filter (where traded_at >= $2::timestamptz - interval '24 hours'),0)::text as volume
    from canonical_events where traded_at <= $2 and $3::text is null and $4::text is null`, params(new Date(now), null, null))
  const liveRows = live ? await readLiveTrades(db, market, migration, summary.last_slot) : []
  const window = liveRows.length ? chartWindow(range, earliest(summary.first, liveRows[0].tradedAt), now, newest(summary.last, liveRows.at(-1).tradedAt))
    : chartWindow(range, summary.first, now, summary.last)
  const [{ rows }, { rows: recent }] = await Promise.all([
    db.query(`${canonicalEvents}, events as (
      select t.*, ${blockPosition('t')} as transaction_index,
        floor(extract(epoch from traded_at)/$4)::bigint*$4 as bucket
      from canonical_events t ${blockJoins('t')}
      where traded_at >= $2 and traded_at <= $3
    ), bars as (
      select bucket as time, min(slot) as first_slot, max(slot) as last_slot,
        (array_agg(next_sqrt_price order by slot,transaction_index,signature,event_index))[1] as open,
        (array_agg(next_sqrt_price order by slot desc,transaction_index desc,signature desc,event_index desc))[1] as close,
        max(next_sqrt_price::numeric)::text as high, min(next_sqrt_price::numeric)::text as low,
        sum(quote_amount)::text as volume, bool_or(next_sqrt_price is null) as missing_price,
        count(*)::text as count
      from events group by bucket
    ), unordered_slots as materialized (
      -- Slots holding several transactions whose block order is not yet proven. Grouped once: a per-bar scan of every
      -- event made long histories quadratic (~0.3 s for ~460 bars over ~8.6K trades).
      select bucket, slot from events group by bucket, slot
      having count(distinct signature)>1 and bool_or(transaction_index is null)
    ) select bars.*, exists(select 1 from unordered_slots u where u.bucket=bars.time
      and u.slot in (bars.first_slot,bars.last_slot)) as ambiguous
      from bars order by time`, params(window.start, window.end, window.interval)),
    db.query(`${canonicalEvents} select t.signature,t.event_index as "eventIndex",t.slot::text,direction,traded_at as "tradedAt",venue,
      ${blockPosition('t')} as "transactionIndex",
      next_sqrt_price as "nextSqrtPrice",quote_amount::text as "solLamports",base_amount::text as "tokenBaseUnits"
      from canonical_events t ${blockJoins('t')}
      where traded_at <= $2 and $3::text is null and $4::text is null
      order by t.slot desc,"transactionIndex" desc,t.signature desc,t.event_index desc limit 120`, params(window.end, null, null)),
  ])
  const latestSlot = recent[0]?.slot
  const latestTrades = recent.filter(t => t.slot === latestSlot)
  const latestAmbiguous = latestTrades.some(t => t.transactionIndex === null) &&
    (new Set(latestTrades.map(t => t.signature)).size > 1 || (recent.length === 120 && latestTrades.length === 120))
  const trades = recent.reverse().map(row => ({ signature: row.signature, eventIndex: row.eventIndex,
    direction: row.direction, venue: row.venue, tradedAt: row.tradedAt.toISOString(),
    priceSol: row.nextSqrtPrice ? chartSpotPrice(row.nextSqrtPrice) : null,
    solLamports: row.solLamports ?? null, tokenBaseUnits: row.tokenBaseUnits ?? null }))
  const chart = { ...window, candles: rows.map(chartBar), trades, volume24hLamports: summary.volume,
    totalTrades: Number(summary.count), latest: latestAmbiguous || !trades.at(-1)?.priceSol ? null : trades.at(-1),
    latestOrderingPending: latestAmbiguous, fetchedAt: new Date(now).toISOString(),
    source: migration ? 'finalized-dbc-and-damm-swaps' : 'finalized-dbc-swaps',
    graduation: migration ? { ...migration, indexedTrades: summary.damm_count } : null }
  return liveRows.length ? mergeLiveTrades(chart, liveRows, now) : chart
}
