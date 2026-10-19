// The Hooks coin trade index (src/hooklab-coin-trades-schema.sql): a listed coin's swaps, read from finalized
// transactions that name its pool, for the coin page's chart and trades list. Display only.
//
// Cursors and finality as in the DAMM trade index (src/damm-trades.mjs): one cursor per pool, finalized reads only (so
// nothing indexed can be rolled back), rows idempotent on (signature, event index) so a replay never doubles a trade,
// and history that does not add up throws before the cursor passes it. Unlike it, a pass never rescans: history newer than
// the cursor is walked newest first, a bounded slice per pass, with the walk's place saved after every transaction, so a
// long backlog only takes more passes and the newest trades show first. The pool's swap counter is contiguous, so the walk
// ends as soon as it meets the swap right after the cursor's: anything older than that holds no swap and is never read.
import bs58 from 'bs58'
import { decodeHookTrades } from './hooklab-trade-events.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
const isSignature = value => { try { return typeof value === 'string' && bs58.decode(value).length === 64 } catch { return false } }
const point = item => ({ signature: item.signature, slot: item.slot })

// One page of the pool's finalized history (getSignaturesForAddress), newest first, cut at `until` (a provider that ignores
// `until` still stops at it, or at anything older than its slot). end: nothing older is left before `until`.
async function nextPage(run, { before = null, until = null, fromSlot = null }) {
  run.pages--
  const list = await run.rpc.signatures(run.coin.pool, { before: before?.signature, until: until?.signature, limit: run.pageSize })
  check(Array.isArray(list) && list.length <= run.pageSize, 'HOOK_TRADE_HISTORY_INVALID')
  const items = []
  let end = list.length < run.pageSize
  for (const item of list) {
    check(isSignature(item?.signature) && Number.isSafeInteger(item.slot) && item.slot > 0 && item.err !== undefined, 'HOOK_TRADE_HISTORY_INVALID')
    if (until && (item.signature === until.signature || item.slot < until.slot)) { end = true; break }
    check(item.slot <= (items.at(-1)?.slot ?? fromSlot ?? Infinity), 'HOOK_TRADE_HISTORY_ORDER')
    items.push({ signature: item.signature, slot: item.slot, failed: item.err !== null })
  }
  return { items, end }
}

// Each item with its trades, in order, reading up to `concurrency` transactions at once while the read budget lasts (a
// failed transaction moved nothing: no read, no budget). Stops before the first item the budget cannot read. Reads ahead
// within a chunk count against the budget even when the walk ends before using them.
async function* decoded(run, items) {
  for (let at = 0; at < items.length;) {
    const chunk = []
    for (; at < items.length && chunk.length < run.concurrency; at++) {
      if (!items[at].failed) { if (run.budget < 1) break; run.budget-- }
      chunk.push(items[at])
    }
    if (!chunk.length) return
    const txs = await Promise.all(chunk.map(item => item.failed ? null : run.rpc.transaction(item.signature)))
    for (const [i, item] of chunk.entries()) {
      if (item.failed) { yield { item, trades: [] }; continue }
      check(txs[i], 'HOOK_TRADE_TRANSACTION_MISSING')
      check(txs[i].slot === item.slot, 'HOOK_TRADE_SLOT_MISMATCH')
      yield { item, trades: run.decode(txs[i], { signature: item.signature, pool: run.coin.pool }) }
    }
  }
}

async function save(run, to, item = null, trades = []) {
  run.trades += await run.store.record({ ...run.coin, from: run.state, to, item, trades })
  run.state = to
  if (item) run.transactions++
}

// Walks one page down from the walk's place (or starts a walk at its first item), ending the walk at the swap after the
// floor or at the end of history.
async function walkPage(run, page, start = null) {
  if (!page.items.length) { if (page.end) await save(run, { done: run.state.walk.top, walk: null }); return }
  for await (const { item, trades } of decoded(run, page.items)) {
    const walk = run.state.walk ?? { top: point(start.top), floor: start.floor }
    const finished = trades.some(t => BigInt(t.swapCount) === walk.floor + 1n) || (page.end && item === page.items.at(-1))
    await save(run, finished ? { done: walk.top, walk: null } : { done: run.state.done, walk: { ...walk, before: point(item) } }, item, trades)
    if (finished) return
  }
}

// Transactions newer than a walk in progress, caught up in one go when they fit this pass (oldest first; each checks the
// cursor did not move), so new trades show while a long walk continues. Then the walk's top rises to the newest of them.
async function catchUpHead(run) {
  const walk = run.state.walk, head = await nextPage(run, { until: walk.top })
  if (!head.items.length || !head.end || head.items.filter(i => !i.failed).length > run.budget) return
  for await (const { item, trades } of decoded(run, [...head.items].reverse())) await save(run, run.state, item, trades)
  await save(run, { done: run.state.done, walk: { ...walk, top: point(head.items[0]) } })
}

// One indexing pass for one coin ({ mint, pool }): at most maxTransactions transaction reads and maxPages history pages.
// caughtUp: the cursor reached the newest history this pass saw (no walk left in progress).
export async function indexHookCoinTrades({ rpc, store, coin, decode = decodeHookTrades, maxTransactions = 40, concurrency = 4,
  pageSize = 1000, maxPages = 5 }) {
  const saved = await store.cursor(coin.pool)
  check(!saved || saved.mint === coin.mint, 'HOOK_TRADE_CURSOR_MINT')
  const run = { rpc, store, coin, decode, concurrency, pageSize, budget: maxTransactions, pages: maxPages, transactions: 0, trades: 0,
    state: { done: saved?.done ?? null, walk: saved?.walk ?? null } }
  if (run.state.walk) await catchUpHead(run)
  else {
    const first = await nextPage(run, { until: run.state.done })
    if (!first.items.length) return { status: 'current', transactions: 0, trades: 0, caughtUp: true }
    await walkPage(run, first, { top: first.items[0], floor: (await store.progress(coin.pool)).swapCount })
  }
  while (run.state.walk && run.budget > 0 && run.pages > 0) {
    const before = run.state.walk.before
    await walkPage(run, await nextPage(run, { before, until: run.state.done, fromSlot: before.slot }))
    if (run.state.walk?.before === before) break
  }
  return { status: 'indexed', transactions: run.transactions, trades: run.trades, caughtUp: !run.state.walk }
}

const TRADE_COLUMNS = `signature, event_index as "eventIndex", side, trader, traded_at as "tradedAt", slot::text, swap_count::text as "swapCount",
  quote_amount::text as "quoteAmount", base_amount::text as "baseAmount", curve_base::text as "curveBase", curve_quote::text as "curveQuote"`
const tradeRow = row => ({ ...row, tradedAt: row.tradedAt.toISOString() })
const priceSol = (curveQuote, curveBase, decimals) => Number(curveQuote) / Number(curveBase) * 10 ** (decimals - 9)
const at = (signature, slot) => signature ? { signature, slot: Number(slot) } : null

// db: a pg Pool (record runs in its own transaction).
export function hookCoinTradeStore(db) {
  return Object.freeze({
    // { mint, done: { signature, slot } | null, walk: { top, before, floor } | null } or null before the first pass.
    async cursor(pool) {
      const { rows: [row] } = await db.query('select * from hook_lab_coin_trade_cursors where pool=$1', [pool])
      if (!row) return null
      return { mint: row.mint, done: at(row.last_signature, row.last_slot), walk: row.scan_top
        ? { top: at(row.scan_top, row.scan_top_slot), before: at(row.scan_before, row.scan_before_slot), floor: BigInt(row.scan_floor) } : null }
    },
    // The newest indexed swap counter (0n before any), and whether a walk is still filling in older history.
    async progress(pool) {
      const { rows: [row] } = await db.query(`select coalesce((select max(swap_count) from hook_lab_coin_trades where pool=$1),0)::text as n,
        exists(select 1 from hook_lab_coin_trade_cursors where pool=$1 and scan_top is not null) as walking`, [pool])
      return { swapCount: BigInt(row.n), walking: row.walking }
    },
    // One transaction's trades (item: { signature, slot }, or none) and the cursor's move from `from` to `to`, together.
    // If another pass moved the cursor meanwhile (or it belongs to another mint), nothing is written.
    async record({ pool, mint, from, to, item = null, trades = [] }) {
      const client = await db.connect()
      try {
        await client.query('begin')
        await client.query('insert into hook_lab_coin_trade_cursors(pool,mint) values($1,$2) on conflict(pool) do nothing', [pool, mint])
        const { rowCount: moved } = await client.query(`update hook_lab_coin_trade_cursors set last_signature=$6,last_slot=$7,scan_top=$8,
          scan_top_slot=$9,scan_before=$10,scan_before_slot=$11,scan_floor=$12,updated_at=clock_timestamp()
          where pool=$1 and mint=$2 and last_signature is not distinct from $3 and scan_top is not distinct from $4 and scan_before is not distinct from $5`,
        [pool, mint, from.done?.signature ?? null, from.walk?.top.signature ?? null, from.walk?.before.signature ?? null,
          to.done?.signature ?? null, to.done?.slot ?? null, to.walk?.top.signature ?? null, to.walk?.top.slot ?? null,
          to.walk?.before.signature ?? null, to.walk?.before.slot ?? null, to.walk ? String(to.walk.floor) : null])
        check(moved === 1, 'HOOK_TRADE_CURSOR_MOVED')
        let inserted = 0
        for (const t of trades) {
          check(item && t.signature === item.signature && t.pool === pool && t.slot === item.slot, 'HOOK_TRADE_EVIDENCE_MISMATCH')
          inserted += (await client.query(`insert into hook_lab_coin_trades(signature,event_index,event,quote_asset,pool,mint,slot,traded_at,swap_count,side,
            trader,quote_amount,base_amount,quote_fee,curve_base,curve_quote) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
            on conflict(signature,event_index) do nothing`, [t.signature, t.eventIndex, t.event, t.quoteAsset, pool, mint, t.slot, t.tradedAt,
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
    // Index-backed only (pool, swap counter / time): the trade count is the newest swap counter, as the counter is contiguous.
    async summary(pool, { now = Date.now(), decimals = 6 } = {}) {
      const { rows: [row] } = await db.query(`select (select min(traded_at) from hook_lab_coin_trades where pool=$1) as first,
          (select max(traded_at) from hook_lab_coin_trades where pool=$1) as last,
          (select coalesce(sum(quote_amount),0)::text from hook_lab_coin_trades where pool=$1 and traded_at>$2::timestamptz-interval '24 hours') as volume`,
        [pool, new Date(now)])
      const { rows: [latest] } = await db.query(`select signature, swap_count::text as "swapCount", traded_at as "tradedAt", curve_base::text as "curveBase",
        curve_quote::text as "curveQuote" from hook_lab_coin_trades where pool=$1 order by swap_count desc limit 1`, [pool])
      return { totalTrades: latest ? Number(latest.swapCount) : 0, volume24hLamports: row.volume, firstTradeAt: row.first?.toISOString() ?? null,
        lastTradeAt: row.last?.toISOString() ?? null,
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
