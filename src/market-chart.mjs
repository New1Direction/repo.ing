import BN from 'bn.js'
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
  // The ledger has slot + instruction order, but no transaction order within a slot.
  // Never invent an open/close across different transactions in the same boundary slot.
  if (row.ambiguous) return { time, volumeLamports, count, orderingPending: true }
  return { time, open: chartSpotPrice(row.open), high: chartSpotPrice(row.high), low: chartSpotPrice(row.low),
    close: chartSpotPrice(row.close), volumeLamports, count }
}

export async function readMarketChart(db, market, range = 'all', now = Date.now()) {
  const { rows: [summary] } = await db.query(`select min(traded_at) as first, max(traded_at) as last,
    count(*)::text as count,
    coalesce(sum((case when direction='buy' then input_base_units else output_base_units end)::numeric)
      filter (where traded_at >= $2::timestamptz - interval '24 hours'),0)::text as volume
    from trade_events where pool=$1 and traded_at <= $2`, [market.pool, new Date(now)])
  const window = chartWindow(range, summary.first, now, summary.last)
  const [{ rows }, { rows: recent }] = await Promise.all([
    db.query(`with events as (
      select *, floor(extract(epoch from traded_at)/$4)::bigint*$4 as bucket
      from trade_events where pool=$1 and traded_at >= $2 and traded_at <= $3
    ), bars as (
      select bucket as time, min(slot) as first_slot, max(slot) as last_slot,
        (array_agg(next_sqrt_price order by slot,signature,event_index))[1] as open,
        (array_agg(next_sqrt_price order by slot desc,signature desc,event_index desc))[1] as close,
        max(next_sqrt_price::numeric)::text as high, min(next_sqrt_price::numeric)::text as low,
        sum((case when direction='buy' then input_base_units else output_base_units end)::numeric)::text as volume,
        count(*)::text as count
      from events group by bucket
    ) select bars.*, exists(select 1 from events e where e.bucket=bars.time
      and e.slot in (bars.first_slot,bars.last_slot) group by e.slot having count(distinct e.signature)>1) as ambiguous
      from bars order by time`, [market.pool, window.start, window.end, window.interval]),
    db.query(`select signature,event_index as "eventIndex",slot::text,direction,traded_at as "tradedAt",
      next_sqrt_price as "nextSqrtPrice" from trade_events t where pool=$1 and traded_at <= $2
      order by t.slot desc,t.signature desc,t.event_index desc limit 120`, [market.pool, window.end]),
  ])
  const latestSlot = recent[0]?.slot
  const latestAmbiguous = new Set(recent.filter(t => t.slot === latestSlot).map(t => t.signature)).size > 1 ||
    (recent.length === 120 && recent.every(t => t.slot === latestSlot))
  const trades = recent.reverse().map(row => ({ signature: row.signature, eventIndex: row.eventIndex,
    direction: row.direction, tradedAt: row.tradedAt.toISOString(), priceSol: chartSpotPrice(row.nextSqrtPrice) }))
  return { ...window, candles: rows.map(chartBar), trades, volume24hLamports: summary.volume,
    totalTrades: Number(summary.count), latest: latestAmbiguous ? null : trades.at(-1) ?? null,
    latestOrderingPending: latestAmbiguous, fetchedAt: new Date(now).toISOString(), source: 'finalized-dbc-swaps' }
}
