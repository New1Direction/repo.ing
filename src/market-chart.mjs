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
const blockPosition = t => `coalesce(p.transaction_index,array_position(b.signatures,${t}.signature::text))`
const blockJoins = t => `left join finalized_chart_positions p on p.slot=${t}.slot and p.signature=${t}.signature
  left join finalized_chart_blocks b on b.slot=${t}.slot and p.slot is null`

export async function readMarketChart(db, market, range = 'all', now = Date.now()) {
  const migration = market.repoId ? chartMigration(market, (await db.query('select * from graduation_events where github_repo_id=$1', [market.repoId])).rows[0]) : null
  const params = (start, end, interval) => [market.pool, start, end, interval, migration?.pool ?? null, market.repoId ?? null, migration?.slot ?? null]
  const { rows: [summary] } = await db.query(`${canonicalEvents} select min(traded_at) as first, max(traded_at) as last,
    count(*)::text as count, count(*) filter(where venue='DAMM')::int as damm_count,
    coalesce(sum(quote_amount) filter (where traded_at >= $2::timestamptz - interval '24 hours'),0)::text as volume
    from canonical_events where traded_at <= $2 and $3::text is null and $4::text is null`, params(new Date(now), null, null))
  const window = chartWindow(range, summary.first, now, summary.last)
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
  return { ...window, candles: rows.map(chartBar), trades, volume24hLamports: summary.volume,
    totalTrades: Number(summary.count), latest: latestAmbiguous || !trades.at(-1)?.priceSol ? null : trades.at(-1),
    latestOrderingPending: latestAmbiguous, fetchedAt: new Date(now).toISOString(),
    source: migration ? 'finalized-dbc-and-damm-swaps' : 'finalized-dbc-swaps',
    graduation: migration ? { ...migration, indexedTrades: summary.damm_count } : null }
}
