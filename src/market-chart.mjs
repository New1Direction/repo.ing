import { evidenceHash } from './graduation-state.mjs'

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

// A trade's stored price (drizzle/0089_trade_prices.sql price_sol: the SOL it actually paid per whole token, each side at its
// mint's real decimals) as a number; null while it is not priced yet. Never derived from a pool's sqrt price or reserves.
export function storedPrice(raw) {
  if (raw === null || raw === undefined || !/^\d*\.?\d+(e-?\d+)?$/i.test(String(raw))) return null
  const price = Number(raw)
  return Number.isFinite(price) && price > 0 ? price : null
}
const chartPrice = raw => storedPrice(raw) ?? (() => { throw Error('Invalid chart price evidence') })()

// SOL/USD at a moment (sol_usd_minutes): the newest minute at or before it, so USD uses the SOL price of the trade's own time.
// The site reads it through a security_barrier view (site_public), where an unbounded "newest at or before" sorts the whole
// history on every row (~2 ms each, growing daily: 4.5 s charts). The 15-minute window is an index range; the unbounded
// lookup runs only when that window is empty (a feed gap), so the answer is the same either way.
export const SOL_USD_RECENT_WINDOW = '15 minutes'
const solUsdBefore = (at, window) => `(select s.usd::text from sol_usd_minutes s where s.minute <= date_trunc('minute', ${at})${window
  ? ` and s.minute > date_trunc('minute', ${at}) - interval '${window}'` : ''} order by s.minute desc limit 1)`
export const solUsdAt = at => `coalesce(${solUsdBefore(at, SOL_USD_RECENT_WINDOW)}, ${solUsdBefore(at)})`

export function chartBar(row) {
  const time = Number(row.time)
  const volumeLamports = String(row.volume)
  if (!Number.isSafeInteger(time) || !/^\d+$/.test(volumeLamports)) throw Error('Invalid chart bar evidence')
  const count = Number(row.count)
  if (!Number.isSafeInteger(count) || count < 1) throw Error('Invalid chart trade count')
  // Withhold open/close until finalized block evidence resolves boundary-slot order.
  if (row.ambiguous || row.missing_price) return { time, volumeLamports, count, orderingPending: true, priceEvidenceMissing: Boolean(row.missing_price) }
  // solUsd: SOL/USD at the minute of the close trade (null before any is recorded), so USD views use that candle's own price.
  return { time, open: chartPrice(row.open), high: chartPrice(row.high), low: chartPrice(row.low),
    close: chartPrice(row.close), solUsd: storedPrice(row.sol_usd), volumeLamports, count }
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
  select signature,event_index,slot,traded_at,direction,price_sol,
    (case when direction='buy' then input_base_units else output_base_units end)::numeric as quote_amount,
    (case when direction='buy' then output_base_units else input_base_units end)::numeric as base_amount,
    'DBC'::text as venue from trade_events where pool=$1
  union all
  select signature,event_index,slot,traded_at,direction,price_sol,quote_amount::numeric,base_amount::numeric,'DAMM'::text as venue
    from damm_trade_events where pool=$5 and github_repo_id=$6 and slot >= $7
)`
// A trade's place in its finalized block: the stored position (finalized_chart_positions), else the block's full
// signature list. The list is joined (and de-TOASTed) only for a trade indexed after its block was recorded, until the
// ordering worker stores that position; null while the block is unverified or the trade is not in it.
export const blockPosition = t => `coalesce(p.transaction_index,array_position(b.signatures,${t}.signature::text))`
export const blockJoins = t => `left join finalized_chart_positions p on p.slot=${t}.slot and p.signature=${t}.signature
  left join finalized_chart_blocks b on b.slot=${t}.slot and p.slot is null`

// One row (slot, signature, event_index, traded_at, `price`): a market's newest trade in `table`, ordered as the chart orders
// trades (newest slot, then place in its finalized block). Several transactions in one slot share event_index 0, so the slot
// and event index alone pick an arbitrary one. Its price is null while that slot holds several transactions whose block order
// is unproven, as the chart then withholds `latest` (app/lib/portfolio.mjs latestSlotTrade reads prices the same way).
// scope(alias): the condition selecting the market's rows; it may name columns of the outer query (a lateral join).
// price: the price column (price_sol on trade_prices and the trade tables; a stock pair's ledger keeps its sqrt price).
export const latestTradeSql = (table, scope, price = 'price_sol') => `select l.slot, l.signature, l.event_index, l.traded_at,
    case when l.unordered then null else l.${price} end as ${price}
  from (select t.slot, t.signature, t.event_index, t.traded_at, t.${price},
      bool_or(${blockPosition('t')} is null) over () and min(t.signature) over () <> max(t.signature) over () as unordered,
      row_number() over (order by ${blockPosition('t')} desc, t.signature desc, t.event_index desc) as n
    from ${table} t ${blockJoins('t')}
    where ${scope('t')} and t.slot = (select max(s.slot) from ${table} s where ${scope('s')})) l
  where l.n = 1`

// A market's newest trade (price_sol, traded_at, signature, event_index) as rows show it: the newest curve and graduated
// trades from trade_prices (graduated ones only on the verified migration pool from the migration slot on), each picked as
// latestTradeSql picks it. A DAMM trade in the same slot as the last curve trade came after it: the curve takes no swaps once
// complete, and its DAMM pool opens only at migration. mint: the SQL naming the market's mint (a lateral join's outer column).
export const latestPriceJoins = mint => `left join lateral (${latestTradeSql('trade_prices', t => `${t}.mint = ${mint} and ${t}.venue = 'DBC'`)}) cp on true
      left join lateral (${latestTradeSql('trade_prices', t => `${t}.mint = ${mint} and ${t}.venue = 'DAMM'`)}) dp on true`
export const latestPriceColumn = column => `case when coalesce(dp.slot, -1) >= coalesce(cp.slot, -1) then dp.${column} else cp.${column} end`

// Live trades (drizzle/0057_live_trade_events.sql, src/live-trades.mjs): confirmed swaps the finalized ledgers do not hold
// yet. Only the canonical curve pool's and the verified DAMM destination's, from the newest finalized slot on, at most
// LIVE_TRADE_MAX_AGE_SECONDS old (a swap that never finalizes drops out by itself), and never one a finalized ledger already
// holds. A database before 0057 has none.
export const LIVE_TRADE_MAX_AGE_SECONDS = 120
export async function readLiveTrades(db, market, migration, fromSlot) {
  if (!market.repoId) return []
  try {
    const { rows } = await db.query(`select l.signature, l.event_index as "eventIndex", l.slot::text, l.traded_at as "tradedAt",
        l.direction, l.venue, l.price_sol::text as "priceSol", ${solUsdAt('l.traded_at')} as "solUsd", l.quote_amount::text as "solLamports",
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
// withholding them. The newest becomes the latest price. Live trades are marked pending, their candles live, and the source
// says it includes confirmed trades. Same-slot live trades keep the order they were received in until finalized order
// replaces them. A swap the finalized trade list already holds (it finalized between this read's queries) is left out, and so
// is one not priced yet (its price_sol null): it is never guessed.
export function mergeLiveTrades(chart, rows, now = Date.now()) {
  const finalized = new Set(chart.trades.map(trade => `${trade.signature}:${trade.eventIndex}`))
  const live = rows.flatMap(row => {
    const priceSol = storedPrice(row.priceSol)
    if (finalized.has(`${row.signature}:${row.eventIndex}`) || priceSol === null) return []
    try {
      return [{ signature: row.signature, eventIndex: row.eventIndex, direction: row.direction, venue: row.venue,
        tradedAt: new Date(row.tradedAt).toISOString(), priceSol, solUsd: storedPrice(row.solUsd), solLamports: String(BigInt(row.solLamports)),
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
    if (!bar.orderingPending) Object.assign(bar, { high: Math.max(bar.high, trade.priceSol), low: Math.min(bar.low, trade.priceSol), close: trade.priceSol, solUsd: trade.solUsd })
    bars.set(time, { ...bar, volumeLamports: (BigInt(bar.volumeLamports) + BigInt(trade.solLamports)).toString(), count: bar.count + 1, live: true })
  }
  const dayAgo = now - 86_400_000
  const liveVolume = live.reduce((sum, trade) => Date.parse(trade.tradedAt) >= dayAgo ? sum + BigInt(trade.solLamports) : sum, 0n)
  return { ...chart, candles: [...bars.values()].sort((a, b) => a.time - b.time), trades: [...chart.trades, ...live].slice(-120),
    totalTrades: chart.totalTrades + live.length, volume24hLamports: (BigInt(chart.volume24hLamports) + liveVolume).toString(),
    latest: live.at(-1), latestOrderingPending: false, live: { trades: live.length }, source: `${chart.source}+confirmed` }
}

// Live trades are an addition: a failed read or merge leaves them out and never costs the finalized chart. Logged at most
// once a minute per process.
let liveFailureLoggedAt = -Infinity
function liveUnavailable(error) {
  if (Date.now() - liveFailureLoggedAt < 60_000) return
  liveFailureLoggedAt = Date.now()
  console.warn(JSON.stringify({ liveTradesUnavailable: { code: error?.code ?? String(error?.message ?? 'error').slice(0, 80) } }))
}

// A mint's on-chain supply (mint_facts, read from the mint by the prices job): { baseUnits, decimals }, null until it is read.
// Every market cap uses it (never a fixed 1B supply).
export const mintSupply = row => row && /^\d+$/.test(String(row.supply ?? '')) && Number.isInteger(Number(row.decimals))
  ? { baseUnits: String(row.supply), decimals: Number(row.decimals) } : null
export async function readMintSupply(db, mint) {
  if (!mint) return null
  return mintSupply((await db.query('select supply::text, decimals from mint_facts where mint=$1', [mint])).rows[0])
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
  let liveRows = []
  if (live) try { liveRows = await readLiveTrades(db, market, migration, summary.last_slot) } catch (error) { liveUnavailable(error) }
  const window = liveRows.length ? chartWindow(range, earliest(summary.first, liveRows[0].tradedAt), now, newest(summary.last, liveRows.at(-1).tradedAt))
    : chartWindow(range, summary.first, now, summary.last)
  const [{ rows }, { rows: recent }, supply] = await Promise.all([
    db.query(`${canonicalEvents}, events as (
      select t.*, ${blockPosition('t')} as transaction_index,
        floor(extract(epoch from traded_at)/$4)::bigint*$4 as bucket
      from canonical_events t ${blockJoins('t')}
      where traded_at >= $2 and traded_at <= $3
    ), bars as (
      select bucket as time, min(slot) as first_slot, max(slot) as last_slot,
        (array_agg(price_sol::text order by slot,transaction_index,signature,event_index))[1] as open,
        (array_agg(price_sol::text order by slot desc,transaction_index desc,signature desc,event_index desc))[1] as close,
        (array_agg(traded_at order by slot desc,transaction_index desc,signature desc,event_index desc))[1] as close_at,
        max(price_sol)::text as high, min(price_sol)::text as low,
        sum(quote_amount)::text as volume, bool_or(price_sol is null) as missing_price,
        count(*)::text as count
      from events group by bucket
    ), unordered_slots as materialized (
      -- Slots holding several transactions whose block order is not yet proven. Grouped once: a per-bar scan of every
      -- event made long histories quadratic (~0.3 s for ~460 bars over ~8.6K trades).
      select bucket, slot from events group by bucket, slot
      having count(distinct signature)>1 and bool_or(transaction_index is null)
    ) select bars.*, exists(select 1 from unordered_slots u where u.bucket=bars.time
      and u.slot in (bars.first_slot,bars.last_slot)) as ambiguous, ${solUsdAt('bars.close_at')} as sol_usd
      from bars order by time`, params(window.start, window.end, window.interval)),
    db.query(`${canonicalEvents} select t.signature,t.event_index as "eventIndex",t.slot::text,direction,traded_at as "tradedAt",venue,
      ${blockPosition('t')} as "transactionIndex",
      price_sol::text as "priceSol",${solUsdAt('t.traded_at')} as "solUsd",quote_amount::text as "solLamports",base_amount::text as "tokenBaseUnits"
      from canonical_events t ${blockJoins('t')}
      where traded_at <= $2 and $3::text is null and $4::text is null
      order by t.slot desc,"transactionIndex" desc,t.signature desc,t.event_index desc limit 120`, params(window.end, null, null)),
    readMintSupply(db, market.mint),
  ])
  const latestSlot = recent[0]?.slot
  const latestTrades = recent.filter(t => t.slot === latestSlot)
  const latestAmbiguous = latestTrades.some(t => t.transactionIndex === null) &&
    (new Set(latestTrades.map(t => t.signature)).size > 1 || (recent.length === 120 && latestTrades.length === 120))
  const trades = recent.reverse().map(row => ({ signature: row.signature, eventIndex: row.eventIndex,
    direction: row.direction, venue: row.venue, tradedAt: row.tradedAt.toISOString(),
    priceSol: storedPrice(row.priceSol), solUsd: storedPrice(row.solUsd),
    solLamports: row.solLamports ?? null, tokenBaseUnits: row.tokenBaseUnits ?? null }))
  const chart = { ...window, candles: rows.map(chartBar), trades, volume24hLamports: summary.volume,
    totalTrades: Number(summary.count), supply, latest: latestAmbiguous || !trades.at(-1)?.priceSol ? null : trades.at(-1),
    latestOrderingPending: latestAmbiguous, fetchedAt: new Date(now).toISOString(),
    source: migration ? 'finalized-dbc-and-damm-swaps' : 'finalized-dbc-swaps',
    graduation: migration ? { ...migration, indexedTrades: summary.damm_count } : null }
  if (!liveRows.length) return chart
  try { return mergeLiveTrades(chart, liveRows, now) } catch (error) { liveUnavailable(error); return chart }
}
