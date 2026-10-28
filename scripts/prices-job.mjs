// The prices job (owner 2026-10-28: one source of truth for prices). Runs on the indexer host every 15 s with the chart
// role (drizzle/0089_trade_prices.sql):
//   1. reads every mint in use (markets, Hooks coins, the SOL mint) from the chain in one batched call and stores its
//      decimals and on-chain supply in mint_facts, so no price or market cap uses a hardcoded 6/9 or a fixed 1e9 supply;
//   2. fills price_sol on trade rows the insert triggers could not price yet (their mint was first read after the trade);
//   3. stores SOL/USD per UTC minute (Coinbase 1-minute candles, close), backfilling from the oldest trade, so USD and
//      market cap use the SOL price at the trade's or candle's time, never today's.
// Env: RECOVERY_CHART_DATABASE_URL, SOLANA_RPC_URL. Exits non-zero on any failure (the unit's OnFailure alerts).
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import bs58 from 'bs58'

export const SOL_MINT = 'So11111111111111111111111111111111111111112'
const MINT_BATCH = 100, CANDLES_PER_REQUEST = 300, CANDLE_REQUESTS_PER_RUN = 20, MINUTE_MS = 60_000
const COINBASE_CANDLES = 'https://api.exchange.coinbase.com/products/SOL-USD/candles'

// Decimals and supply from a jsonParsed SPL mint account (Token or Token-2022).
export function mintFacts(mint, account, slot) {
  const info = account?.data?.parsed?.type === 'mint' ? account.data.parsed.info : null
  if (!info || !Number.isInteger(info.decimals) || info.decimals < 0 || info.decimals > 18 || !/^\d+$/.test(info.supply ?? '')) {
    throw Error(`MINT_UNREADABLE ${mint}`)
  }
  return { mint, decimals: info.decimals, supply: info.supply, slot }
}

// Coinbase candles ([time s, low, high, open, close, volume], newest first) as minute → close, oldest first.
export function solUsdMinutes(candles) {
  if (!Array.isArray(candles)) throw Error('SOL_USD_UNREADABLE')
  return candles.map(([time, , , , close]) => {
    if (!Number.isSafeInteger(time) || time % 60 !== 0 || !(Number(close) > 0)) throw Error('SOL_USD_UNREADABLE')
    return { minute: new Date(time * 1000).toISOString(), usd: String(close) }
  }).sort((a, b) => a.minute.localeCompare(b.minute))
}

const isAddress = value => { try { return bs58.decode(value).length === 32 } catch { return false } }

async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body || body.error) throw Error(`RPC_FAILED ${method} HTTP ${response.status} ${body?.error?.code ?? ''}`)
  return body.result
}

async function storeMintFacts(db, rpcUrl) {
  const hooks = (await db.query(`select to_regclass('public.hook_lab_coin_trades') is not null as present`)).rows[0].present
  const { rows } = await db.query(`select mint from markets where mint is not null union select $1
    ${hooks ? 'union select distinct mint from hook_lab_coin_trades' : ''}`, [SOL_MINT])
  // A mint that is not a valid address or not a readable mint is reported and skipped: its trades stay unpriced (the
  // chart withholds them) instead of blocking every other market's prices.
  const unreadable = [], mints = rows.map(r => r.mint).filter(m => isAddress(m) || !unreadable.push(m))
  for (let i = 0; i < mints.length; i += MINT_BATCH) {
    const batch = mints.slice(i, i + MINT_BATCH)
    const { context, value } = await rpc(rpcUrl, 'getMultipleAccounts', [batch, { encoding: 'jsonParsed', commitment: 'finalized' }])
    const facts = batch.flatMap((mint, k) => { try { return [mintFacts(mint, value[k], context.slot)] } catch { unreadable.push(mint); return [] } })
    await db.query(`insert into mint_facts(mint, decimals, supply, slot, read_at)
      select m, d, s, $4, now() from unnest($1::text[], $2::smallint[], $3::numeric[]) as t(m, d, s)
      on conflict(mint) do update set decimals=excluded.decimals, supply=excluded.supply, slot=excluded.slot, read_at=excluded.read_at
      where mint_facts.slot <= excluded.slot`, [facts.map(f => f.mint), facts.map(f => f.decimals), facts.map(f => f.supply), context.slot])
  }
  return { mints: mints.length - unreadable.filter(m => mints.includes(m)).length, unreadable, hooks }
}

// Prices the triggers could not set (the mint's facts arrived after the trade). Only rows still null are touched.
async function fillPrices(db, hooks) {
  const filled = {}
  filled.curve = (await db.query(`update trade_events t set price_sol = trade_price(
      (case when t.direction='buy' then t.input_base_units else t.output_base_units end)::numeric,
      (case when t.direction='buy' then t.output_base_units else t.input_base_units end)::numeric,
      coalesce(m.quote_mint, $1), m.mint)
    from markets m where m.pool = t.pool and t.price_sol is null and exists (select 1 from mint_facts f where f.mint = m.mint)`, [SOL_MINT])).rowCount
  for (const [key, table] of [['graduated', 'damm_trade_events'], ['live', 'live_trade_events']]) {
    filled[key] = (await db.query(`update ${table} d set price_sol = trade_price(d.quote_amount::numeric, d.base_amount::numeric, coalesce(m.quote_mint, $1), m.mint)
      from markets m where m.github_repo_id = d.github_repo_id and d.price_sol is null and exists (select 1 from mint_facts f where f.mint = m.mint)`, [SOL_MINT])).rowCount
  }
  if (hooks) {
    filled.hooks = (await db.query(`update hook_lab_coin_trades h set price_sol = trade_price(h.quote_amount::numeric, h.base_amount::numeric, $1, h.mint)
      where h.price_sol is null and exists (select 1 from mint_facts f where f.mint = h.mint)`, [SOL_MINT])).rowCount
  }
  return filled
}

async function storeSolUsd(db, now = Date.now()) {
  const { rows: [range] } = await db.query(`select (select max(minute) from sol_usd_minutes) as newest,
    (select date_trunc('minute', min(traded_at)) from trade_prices) as oldest_trade`)
  let from = range.newest ? new Date(range.newest).getTime() + MINUTE_MS : new Date(range.oldest_trade ?? now - 3_600_000).getTime()
  const until = Math.floor(now / MINUTE_MS) * MINUTE_MS - MINUTE_MS // the last finished minute
  let stored = 0, requests = 0
  while (from <= until && requests < CANDLE_REQUESTS_PER_RUN) {
    const end = Math.min(until, from + (CANDLES_PER_REQUEST - 1) * MINUTE_MS)
    const url = `${COINBASE_CANDLES}?granularity=60&start=${new Date(from).toISOString()}&end=${new Date(end).toISOString()}`
    const response = await fetch(url, { headers: { 'user-agent': 'repoing-prices/1' }, signal: AbortSignal.timeout(15_000) })
    requests++
    if (!response.ok) throw Error(`SOL_USD_FAILED HTTP ${response.status}`)
    // One insert per page: a row-at-a-time insert costs a database round trip per minute.
    const minutes = solUsdMinutes(await response.json())
    stored += (await db.query(`insert into sol_usd_minutes(minute, usd, source)
      select m, u, 'coinbase-1m-close' from unnest($1::timestamptz[], $2::numeric[]) as t(m, u) on conflict(minute) do nothing`,
    [minutes.map(m => m.minute), minutes.map(m => m.usd)])).rowCount
    from = end + MINUTE_MS
  }
  return { stored, requests, caughtUp: from > until }
}

export async function runPricesJob(env = process.env) {
  if (!env.RECOVERY_CHART_DATABASE_URL || !env.SOLANA_RPC_URL) throw Error('PRICES_ENV_REQUIRED')
  const db = new pg.Client({ connectionString: env.RECOVERY_CHART_DATABASE_URL, application_name: 'repoing-prices',
    statement_timeout: 15_000, connectionTimeoutMillis: 15_000 })
  await db.connect()
  try {
    const facts = await storeMintFacts(db, env.SOLANA_RPC_URL)
    const filled = await fillPrices(db, facts.hooks)
    const solUsd = await storeSolUsd(db)
    return { lane: 'prices', status: 'COMPLETED', at: new Date().toISOString(), mints: facts.mints, unreadableMints: facts.unreadable, filled, solUsd }
  } finally { await db.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await runPricesJob())) }
  catch (error) { console.log(JSON.stringify({ lane: 'prices', status: 'FAILED', reason: String(error.message).slice(0, 160) })); process.exitCode = 1 }
}
