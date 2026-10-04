import { PUBLIC_GRADUATION_MAX_AGE_MS } from '../../src/graduation-state.mjs'
import { quoteAssetInfo } from '../../src/quote-asset-info.mjs'
import { quoteAssetById } from '../../src/quote-assets.mjs'
import { MARKET_TOKEN_DECIMALS, isStockMarket, stockChartMigration, stockQuoteOf, stockSpotPrice } from '../../src/stock-market-chart.mjs'

// Server-only: the market-list and token-page numbers of stock-paired markets (docs/STOCK_QUOTES.md), from the stock
// ledger, laid over the rows server.mjs builds. A stamped row keeps every field it had, claims no SOL value (priceSol and
// volume24hLamports are null: it has no SOL price or SOL volume), and gains `stock`:
//   assetId, symbol, decimals   the stamped stock (registry)
//   price                       last trade price, whole raw stock units per whole market token (null before a trade)
//   volume24h                   raw stock base units traded in the last 24h (curve, plus the recorded DAMM pool)
//   uiMultiplier, usdPrice      today's display multiplier and USD price per whole raw token, when read (lists only)
// bondingPercent and graduated are the row's usual unit-free fields, from the stock graduation tables. A stamped row whose
// figures cannot be read carries `stock.unavailable` instead. Nothing is read for SOL rows: a list without stamped rows
// comes back as it came, with no query.
const FUTURE_SKEW_MS = 5_000

// Per stamped market (parallel arrays): its stamp, curve and recorded DAMM pool. The trade reads use the
// (github_repo_id, slot) index; $7 is "now".
const SCOPE = `t.github_repo_id=m.repo_id and t.asset_id=m.asset_id and t.quote_mint=m.quote_mint
    and ((t.venue='dbc' and t.pool=m.pool) or (t.venue='damm' and t.pool=m.damm_pool and t.slot>=m.damm_slot))`
const FACTS = `select m.repo_id::text as "repoId",
  (select t.next_sqrt_price from stock_trade_events t where ${SCOPE} and t.next_sqrt_price is not null
    order by t.slot desc, t.event_index desc, t.signature desc limit 1) as "lastSqrtPrice",
  (select coalesce(sum(t.quote_amount),0)::text from stock_trade_events t where ${SCOPE}
    and t.traded_at >= $7::timestamptz - interval '24 hours' and t.traded_at <= $7::timestamptz) as "volume24h",
  o.pool as "observedPool", o.quote_reserve::text as "quoteReserve", o.migration_threshold::text as "migrationThreshold",
  o.is_migrated as "isMigrated", o.observed_at as "observedAt"
from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[]) as m(repo_id, pool, asset_id, quote_mint, damm_pool, damm_slot)
left join lateral (select pool, quote_reserve, migration_threshold, is_migrated, observed_at
  from stock_graduation_observations o where o.github_repo_id=m.repo_id and o.asset_id=m.asset_id and o.quote_mint=m.quote_mint
  order by o.observed_at desc, o.id desc limit 1) o on true`

// A stock-paired curve's progress as the token page's graduation bar reads it (the curve route's answer), in raw units of the
// stock: its recorded graduation, else the newest observation of its own curve under the public curve's freshness rule (at
// most PUBLIC_GRADUATION_MAX_AGE_MS old, never from the future). Throws, as publicGraduation does, when there is no such
// progress, so nothing stale or foreign is drawn. facts: the newest observation (FACTS' columns).
export function stockCurveProgress(facts, market, quote, migration, now = Date.now()) {
  const base = { quote: { assetId: quote.assetId, symbol: quote.symbol, decimals: quote.decimals } }
  if (migration) {
    return { ...base, phase: 'GRADUATED', status: 'graduated', progressPercent: 100, destination: { pool: migration.pool,
      url: `https://app.meteora.ag/dammv2/${migration.pool}` }, validUntil: new Date(now + PUBLIC_GRADUATION_MAX_AGE_MS).toISOString() }
  }
  if (!facts?.observedAt) throw Error('PROGRESS_NOT_INDEXED')
  const at = new Date(facts.observedAt).getTime()
  if (!Number.isFinite(at) || now - at > PUBLIC_GRADUATION_MAX_AGE_MS || at > now + FUTURE_SKEW_MS || facts.observedPool !== market.pool) throw Error('STALE_PROGRESS')
  if (!/^\d+$/.test(facts.quoteReserve ?? '') || !/^\d+$/.test(facts.migrationThreshold ?? '') || BigInt(facts.migrationThreshold) <= 0n) throw Error('INVALID_THRESHOLD')
  const reserve = BigInt(facts.quoteReserve), threshold = BigInt(facts.migrationThreshold), reached = facts.isMigrated || reserve >= threshold
  return { ...base, phase: 'CURVE', status: reached ? 'migrating' : 'active', reserve: String(reserve), threshold: String(threshold),
    remaining: String(reached ? 0n : threshold - reserve), progressPercent: reached ? 100 : Number(reserve * 10000n / threshold) / 100,
    checkedAt: new Date(at).toISOString(), validUntil: new Date(at + PUBLIC_GRADUATION_MAX_AGE_MS).toISOString(), destination: null }
}

// The row's unit-free progress fields from the same rule: a recorded graduation reads 100% and graduated; no fresh progress
// draws no line (null).
export function stockGraduation(facts, market, quote, migration, now = Date.now()) {
  try {
    const curve = stockCurveProgress(facts, market, quote, migration, now)
    return { bondingPercent: curve.progressPercent, graduated: curve.phase === 'GRADUATED' }
  } catch { return { bondingPercent: null, graduated: false } }
}

const OBSERVATION = `select pool as "observedPool", quote_reserve::text as "quoteReserve", migration_threshold::text as "migrationThreshold",
    is_migrated as "isMigrated", observed_at as "observedAt" from stock_graduation_observations
  where github_repo_id=$1 and asset_id=$2 and quote_mint=$3 order by observed_at desc, id desc limit 1`

// The curve route's answer for a stock-paired market (see stockCurveProgress).
export async function readStockCurve(db, market, now = Date.now()) {
  const quote = stockQuoteOf(market)
  const [{ rows: [event] }, { rows: [facts] }] = await Promise.all([
    db.query('select * from stock_graduation_events where github_repo_id=$1', [market.repoId]),
    db.query(OBSERVATION, [market.repoId, quote.assetId, quote.mint])])
  return stockCurveProgress(facts, market, quote, stockChartMigration(market, quote, event), now)
}

// The row fields and `stock` figures of one stamped market from its ledger facts; `units` are its stock's display facts
// (quoteAssetInfo) or null.
export function stockRowStats(market, quote, facts, migration, units = null, now = Date.now()) {
  let price = null
  if (facts?.lastSqrtPrice) { try { price = stockSpotPrice(facts.lastSqrtPrice, MARKET_TOKEN_DECIMALS, quote.decimals) } catch { price = null } }
  return { priceSol: null, volume24hLamports: null, ...stockGraduation(facts, market, quote, migration, now),
    stock: { assetId: quote.assetId, symbol: quote.symbol, decimals: quote.decimals, price,
      volume24h: /^\d+$/.test(facts?.volume24h ?? '') ? facts.volume24h : '0',
      uiMultiplier: units?.uiMultiplier ?? null, usdPrice: units?.usdPrice ?? null } }
}

export function unavailableStockRow(market) {
  const asset = quoteAssetById(market.quoteAssetId)
  return { priceSol: null, volume24hLamports: null, bondingPercent: null, graduated: false,
    stock: { assetId: market.quoteAssetId ?? null, symbol: asset?.type === 'TOKENIZED_EQUITY' ? asset.symbol : null, unavailable: true } }
}

// A stock's display facts read within `ms`, else null (logged): the reads that need them (the shared market list, /stats)
// never wait on a stalled RPC, and rows without units show no converted figures.
export const UNITS_WAIT_MS = 1_500
export async function unitsWithin(read, label, ms = UNITS_WAIT_MS) {
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), ms) })
  try {
    const value = await Promise.race([Promise.resolve().then(read), late])
    if (value === 'timeout') { console.error('stock units unavailable', label, 'timeout'); return null }
    return value ?? null
  } catch (error) { console.error('stock units unavailable', label, error?.code ?? error?.message ?? 'error'); return null }
  finally { clearTimeout(timer) }
}

// Today's display facts per stock asset (one bounded read each). connection: a Connection or a function making one (called
// only here, so a SOL-only list never needs the RPC).
async function unitsByAsset(assetIds, connection, info) {
  let rpc
  try { rpc = typeof connection === 'function' ? connection() : connection }
  catch (error) { console.error('stock units unavailable', error?.message ?? 'error'); return new Map() }
  return new Map(await Promise.all([...new Set(assetIds)].map(async assetId => [assetId, await unitsWithin(() => info(assetId, { connection: rpc }), assetId)])))
}

// A stamped market's stock and recorded graduation, or null (logged) when its stamp or graduation record does not hold up.
function resolvedStamp(market, event) {
  try {
    const quote = stockQuoteOf(market)
    return { market, quote, migration: stockChartMigration(market, quote, event) }
  } catch (error) { console.error('stock market stats unavailable', market.repoId, error?.code ?? error?.message ?? 'error'); return null }
}

// markets: rows as server.mjs builds them (repoId, pool and, for stamped rows, quoteAssetId and quoteMint). Returns the same
// array when no row is stamped. withUnits: also read today's multiplier and USD price through `connection` (the market
// list renders them on the server; a token page reads them from the metrics route instead, so single-market reads, which
// every market API route makes, stay off the RPC).
// A failure here never takes SOL rows down: the stamped rows then carry `stock.unavailable`.
export async function withStockStats(markets, { db, connection = null, withUnits = false, now = Date.now(), info = quoteAssetInfo } = {}) {
  const stamped = markets.filter(isStockMarket)
  if (!stamped.length) return markets
  const overlay = new Map(stamped.map(market => [market.repoId, unavailableStockRow(market)]))
  try {
    const { rows: events } = await db.query('select * from stock_graduation_events where github_repo_id = any($1::bigint[])', [stamped.map(m => m.repoId)])
    const byRepo = new Map(events.map(row => [String(row.github_repo_id), row]))
    const resolved = stamped.map(market => resolvedStamp(market, byRepo.get(String(market.repoId)))).filter(Boolean)
    if (resolved.length) {
      const [{ rows }, units] = await Promise.all([
        db.query(FACTS, [resolved.map(r => r.market.repoId), resolved.map(r => r.market.pool), resolved.map(r => r.quote.assetId),
          resolved.map(r => r.quote.mint), resolved.map(r => r.migration?.pool ?? null), resolved.map(r => r.migration?.slot ?? null), new Date(now)]),
        withUnits && connection ? unitsByAsset(resolved.map(r => r.quote.assetId), connection, info) : new Map(),
      ])
      const facts = new Map(rows.map(row => [row.repoId, row]))
      for (const { market, quote, migration } of resolved) {
        overlay.set(market.repoId, stockRowStats(market, quote, facts.get(String(market.repoId)), migration, units.get(quote.assetId) ?? null, now))
      }
    }
  } catch (error) { console.error('stock market stats unavailable', error?.code ?? error?.message ?? 'error') }
  return markets.map(market => overlay.has(market.repoId) ? { ...market, ...overlay.get(market.repoId) } : market)
}
