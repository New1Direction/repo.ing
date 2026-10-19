// The Hooks coin trade index (src/hooklab-coin-trades-schema.sql): a listed coin's swaps, read from finalized
// transactions that name its pool, for the coin page's chart and trades list. Display only.
//
// Like the DAMM trade index (src/damm-trades.mjs): one cursor per pool (the newest finalized transaction read), history
// walked newest first back to it, then read oldest first, the cursor moving after each transaction. Finalized reads only,
// so nothing indexed can be rolled back; rows are idempotent on (signature, event index), so a replay never doubles a
// trade. A transaction or history that does not add up throws before the cursor passes it.
import bs58 from 'bs58'
import { decodeHookTrades } from './hooklab-trade-events.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
const isSignature = value => { try { return typeof value === 'string' && bs58.decode(value).length === 64 } catch { return false } }

// History newer than the cursor, oldest first. rpc.signatures answers getSignaturesForAddress at finalized.
async function pendingHistory(rpc, pool, cursor, { pageSize, maxPages }) {
  const items = []
  let before
  for (let page = 0; ; page++) {
    check(page < maxPages, 'HOOK_TRADE_HISTORY_TOO_LONG')
    const list = await rpc.signatures(pool, { before, until: cursor?.signature, limit: pageSize })
    check(Array.isArray(list) && list.length <= pageSize, 'HOOK_TRADE_HISTORY_INVALID')
    let boundary = false
    for (const item of list) {
      check(isSignature(item?.signature) && Number.isSafeInteger(item.slot) && item.slot > 0 && item.err !== undefined, 'HOOK_TRADE_HISTORY_INVALID')
      // A provider that ignores `until` still stops here: at the cursor, or anything older than its slot.
      if (cursor && (item.signature === cursor.signature || item.slot < cursor.slot)) { boundary = true; break }
      check(!items.length || item.slot <= items.at(-1).slot, 'HOOK_TRADE_HISTORY_ORDER')
      items.push({ signature: item.signature, slot: item.slot, failed: item.err !== null })
    }
    if (boundary || list.length < pageSize) return items.reverse()
    before = list.at(-1).signature
  }
}

// One indexing pass for one coin ({ mint, pool }): reads at most maxTransactions transactions (concurrency at a time) and
// records each in order. Returns how many were read, the trades stored and how many transactions are left for a later pass.
export async function indexHookCoinTrades({ rpc, store, coin, decode = decodeHookTrades, maxTransactions = 40, concurrency = 4,
  pageSize = 1000, maxPages = 10 }) {
  const { mint, pool } = coin, cursor = await store.cursor(pool)
  check(!cursor || cursor.mint === mint, 'HOOK_TRADE_CURSOR_MINT')
  const pending = await pendingHistory(rpc, pool, cursor, { pageSize, maxPages })
  const batch = pending.slice(0, maxTransactions)
  let previous = cursor?.signature ?? null, trades = 0
  for (let at = 0; at < batch.length; at += concurrency) {
    const chunk = batch.slice(at, at + concurrency)
    // A failed transaction moved nothing: it advances the cursor without a read.
    const reads = await Promise.all(chunk.map(item => item.failed ? null : rpc.transaction(item.signature)))
    for (const [i, item] of chunk.entries()) {
      let found = []
      if (!item.failed) {
        const tx = reads[i]
        check(tx, 'HOOK_TRADE_TRANSACTION_MISSING')
        check(tx.slot === item.slot, 'HOOK_TRADE_SLOT_MISMATCH')
        found = decode(tx, { signature: item.signature, pool })
      }
      trades += await store.record({ pool, mint, previous, signature: item.signature, slot: item.slot, trades: found })
      previous = item.signature
    }
  }
  return { status: batch.length ? 'indexed' : 'current', transactions: batch.length, trades, remaining: pending.length - batch.length }
}

const TRADE_COLUMNS = `signature, event_index as "eventIndex", side, trader, traded_at as "tradedAt", slot::text, swap_count::text as "swapCount",
  quote_amount::text as "quoteAmount", base_amount::text as "baseAmount", curve_base::text as "curveBase", curve_quote::text as "curveQuote"`
const tradeRow = row => ({ ...row, tradedAt: row.tradedAt.toISOString() })
const priceSol = (curveQuote, curveBase, decimals) => Number(curveQuote) / Number(curveBase) * 10 ** (decimals - 9)

// db: a pg Pool (record runs in its own transaction).
export function hookCoinTradeStore(db) {
  return Object.freeze({
    async cursor(pool) {
      const { rows: [row] } = await db.query('select mint, last_signature, last_slot from hook_lab_coin_trade_cursors where pool=$1', [pool])
      return row ? { mint: row.mint, signature: row.last_signature, slot: Number(row.last_slot) } : null
    },
    // The pool's newest indexed swap counter (0n before any): compared with the chain's to skip a pass with nothing new.
    async indexedSwapCount(pool) {
      const { rows: [row] } = await db.query('select coalesce(max(swap_count),0)::text as n from hook_lab_coin_trades where pool=$1', [pool])
      return BigInt(row.n)
    },
    // One transaction's trades and the cursor move past it, together. previous: the cursor this pass started from (or
    // the transaction it recorded last); if another pass moved it meanwhile, nothing is written.
    async record({ pool, mint, previous, signature, slot, trades }) {
      const client = await db.connect()
      try {
        await client.query('begin')
        const { rowCount: moved } = await client.query(`insert into hook_lab_coin_trade_cursors(pool,mint,last_signature,last_slot) values($1,$2,$3,$4)
          on conflict(pool) do update set last_signature=excluded.last_signature,last_slot=excluded.last_slot,updated_at=clock_timestamp()
          where hook_lab_coin_trade_cursors.last_signature is not distinct from $5 and hook_lab_coin_trade_cursors.mint=excluded.mint`,
        [pool, mint, signature, slot, previous])
        check(moved === 1, 'HOOK_TRADE_CURSOR_MOVED')
        let inserted = 0
        for (const t of trades) {
          check(t.signature === signature && t.pool === pool && t.slot === slot, 'HOOK_TRADE_EVIDENCE_MISMATCH')
          inserted += (await client.query(`insert into hook_lab_coin_trades(signature,event_index,event,quote_asset,pool,mint,slot,traded_at,swap_count,side,
            trader,quote_amount,base_amount,quote_fee,curve_base,curve_quote) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            on conflict(signature,event_index) do nothing`, [t.signature, t.eventIndex, t.event, t.quoteAsset, pool, mint, slot, t.tradedAt,
            t.swapCount, t.side, t.trader, t.quoteAmount, t.baseAmount, t.quoteFee, t.curveBase, t.curveQuote])).rowCount
        }
        await client.query('commit')
        return inserted
      } catch (error) { await client.query('rollback').catch(() => {}); throw error }
      finally { client.release() }
    },
    // Newest first; before: a swap counter from a previous page's `next`.
    async trades(pool, { before = null, limit = 20 } = {}) {
      const { rows } = await db.query(`select ${TRADE_COLUMNS} from hook_lab_coin_trades where pool=$1 and ($2::numeric is null or swap_count<$2)
        order by swap_count desc limit $3`, [pool, before, limit + 1])
      return { trades: rows.slice(0, limit).map(tradeRow), next: rows.length > limit ? rows[limit - 1].swapCount : null }
    },
    async summary(pool, { now = Date.now(), decimals = 6 } = {}) {
      const [{ rows: [totals] }, { rows: [latest] }] = await Promise.all([
        db.query(`select count(*)::int as total, min(traded_at) as first, max(traded_at) as last,
          coalesce(sum(quote_amount) filter (where traded_at > $2::timestamptz - interval '24 hours'),0)::text as volume
          from hook_lab_coin_trades where pool=$1`, [pool, new Date(now)]),
        db.query(`select signature, swap_count::text as "swapCount", traded_at as "tradedAt", curve_base::text as "curveBase", curve_quote::text as "curveQuote"
          from hook_lab_coin_trades where pool=$1 order by swap_count desc limit 1`, [pool])])
      return { totalTrades: totals.total, volume24hLamports: totals.volume, firstTradeAt: totals.first?.toISOString() ?? null,
        lastTradeAt: totals.last?.toISOString() ?? null,
        latest: latest ? { ...tradeRow(latest), priceSol: priceSol(latest.curveQuote, latest.curveBase, decimals) } : null }
    },
    // Price bars of `seconds` each, at most `bars` of them, ending at the last trade: SOL per whole coin after each swap,
    // opened and closed in swap order; volume in lamports.
    async candles(pool, { seconds, decimals, bars = 500 }) {
      const { rows } = await db.query(`with last as (select max(traded_at) as at from hook_lab_coin_trades where pool=$1),
        priced as (select floor(extract(epoch from t.traded_at)/$2)::bigint*$2 as bucket, t.swap_count, t.quote_amount,
            t.curve_quote*power(10::numeric,$4::int)/(t.curve_base*1000000000) as price
          from hook_lab_coin_trades t, last where t.pool=$1 and t.traded_at>=last.at-make_interval(secs=>$2::bigint*$3)),
        window_start as (select max(bucket)-($3-1)*$2 as at from priced)
        select bucket::text as time, (array_agg(price order by swap_count))[1]::text as open, (array_agg(price order by swap_count desc))[1]::text as close,
          max(price)::text as high, min(price)::text as low, sum(quote_amount)::text as volume, count(*)::int as count
        from priced, window_start where bucket>=window_start.at group by bucket order by bucket`, [pool, seconds, bars, decimals])
      return rows.map(row => ({ time: Number(row.time), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
        volumeLamports: row.volume, count: row.count }))
    },
  })
}
