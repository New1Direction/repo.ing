import { PublicKey } from '@solana/web3.js'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createMarketConfigResolver } from './market-config.mjs'
import { canonicalTradeEvents } from './trade-evidence.mjs'
import { dammSwapEvents, indexDammTrades } from './damm-trades.mjs'
import { loadTransactionAt } from './finalized-transaction.mjs'
import { chartMigration } from './market-chart.mjs'

// Live chart trades (drizzle/0057_live_trade_events.sql; docs/CHARTS_AND_RESPONSIVENESS.md, "Live trades").
// The worker listens on the primary RPC's websocket, at 'confirmed', to every approved DBC config (each curve swap names its
// config) and to each graduated market's verified DAMM pool. About a second after a swap confirms, its canonical swap events
// (the same parsers the finalized indexers use) go into live_trade_events, whose trigger sends the usual chart hint. Charts
// show them as confirming until the finalized ledgers hold the same swaps. Display only: nothing that moves or counts money
// reads these rows, and every row is deleted LIVE_TRADE_TTL_MS after it arrived, so a swap that never finalizes disappears.
// Best effort: a missed notification only means that swap appears when it is finalized, as before.

export const LIVE_TRADE_TTL_MS = 120_000
// Markets and pools are re-read this often, so new launches and graduations are watched within a minute.
export const LIVE_REFRESH_MS = 60_000
// A finalized trade of a watched market this much newer than the last notification means the websocket missed it (it can go
// deaf without closing): the watcher then reconnects on a fresh connection. Notifications arrive ~1.5 s after the block.
export const LIVE_DEAF_MARGIN_MS = 60_000
const RETRY_DELAYS_MS = [300, 700, 1500]
const SEEN_MAX = 4000
const QUEUE_MAX = 500

const SOL_MARKETS = `select github_repo_id::text as "repoId", mint, pool from markets
  where status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized' and quote_asset_id is null`

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const errorCode = error => error?.code === '42P01' ? 'NOT_MIGRATED' : /^[A-Z][A-Z0-9_]{3,60}$/.test(error?.message ?? '') ? error.message
  : error?.status ? `HTTP_${error.status}` : error?.code ? `DB_${error.code}` : 'UNAVAILABLE'

// SOL markets to watch: curve pools by pool address, and graduated markets by their verified DAMM pool (the immutable
// migration proof the chart itself checks, chartMigration). A market whose proof does not check is left out, not guessed.
export async function watchedMarkets(pool) {
  const [{ rows: markets }, { rows: graduations }] = await Promise.all([pool.query(SOL_MARKETS), pool.query('select * from graduation_events')])
  const byRepo = new Map(graduations.map(row => [String(row.github_repo_id), row]))
  const curves = new Map(), damms = new Map(), invalid = []
  for (const market of markets) {
    const proof = byRepo.get(market.repoId)
    if (!proof) { curves.set(market.pool, market); continue }
    try {
      const migration = chartMigration(market, proof)
      damms.set(migration.pool, { market, migration })
    } catch { invalid.push(market.repoId) }
  }
  return { curves, damms, invalid }
}

// A confirmed transaction's canonical swap events for every watched market it touches, as live_trade_events rows. A market
// whose events do not parse is skipped (and reported) without hiding another market's swaps in the same transaction.
export function liveTradeRows(transaction, signature, { curves, damms }, { resolveConfig, dbc, coder }, failures = []) {
  if (!transaction?.meta || transaction.meta.err) return []
  const rows = []
  const each = (parse, toRow) => { try { rows.push(...parse().map(toRow)) } catch (error) { failures.push(errorCode(error)) } }
  for (const address of new Set(transaction.transaction.message.accountKeys.map(key => key.toBase58()))) {
    const curve = curves.get(address), damm = damms.get(address)
    if (curve) each(() => canonicalTradeEvents(transaction, { ...curve, signature }, resolveConfig(curve), dbc), event => {
      const buy = event.direction === 'buy'
      return { signature, eventIndex: event.eventIndex, repoId: curve.repoId, venue: 'DBC', pool: curve.pool,
        slot: transaction.slot, tradedAt: event.tradedAt, direction: event.direction,
        quoteAmount: buy ? event.inputBaseUnits : event.outputBaseUnits, baseAmount: buy ? event.outputBaseUnits : event.inputBaseUnits,
        nextSqrtPrice: event.nextSqrtPrice }
    })
    if (damm) each(() => dammSwapEvents(transaction, damm.market, address, coder), event => ({ signature, eventIndex: event.eventIndex,
      repoId: damm.market.repoId, venue: 'DAMM', pool: address, slot: transaction.slot, tradedAt: event.tradedAt,
      direction: event.direction, quoteAmount: event.quoteAmount, baseAmount: event.baseAmount, nextSqrtPrice: event.nextSqrtPrice }))
  }
  // The table's checks, applied here so one odd event cannot fail the rest of the batch.
  return rows.filter(row => Number.isSafeInteger(row.slot) && row.slot > 0 && /^[1-9]\d*$/.test(String(row.quoteAmount)) &&
    /^[1-9]\d*$/.test(String(row.nextSqrtPrice)) && (row.baseAmount == null || /^\d+$/.test(String(row.baseAmount))) &&
    Number.isFinite(new Date(row.tradedAt).getTime()))
}

// The newest finalized trade among the watched markets, or null: the evidence a working websocket must have announced.
export async function newestFinalizedTrade(pool, { curves, damms }) {
  const curvePools = [...curves.keys()], repos = [...damms.values()].map(({ market }) => market.repoId)
  if (!curvePools.length && !repos.length) return null
  const { rows: [row] } = await pool.query(`select greatest(
      (select max(traded_at) from trade_events where pool = any($1::text[])),
      (select max(traded_at) from damm_trade_events where github_repo_id = any($2::bigint[]))) as newest`, [curvePools, repos])
  return row?.newest ?? null
}

// One statement, so its trigger hints each market once (identical notifications in a transaction are delivered once).
export async function insertLiveTrades(pool, rows) {
  if (!rows.length) return 0
  const params = [], values = rows.map((row, i) => {
    params.push(row.signature, row.eventIndex, row.repoId, row.venue, row.pool, String(row.slot), new Date(row.tradedAt),
      row.direction, String(row.quoteAmount), row.baseAmount == null ? null : String(row.baseAmount), String(row.nextSqrtPrice))
    return `(${Array.from({ length: 11 }, (_, k) => `$${i * 11 + k + 1}`).join(',')})`
  })
  const { rowCount } = await pool.query(`insert into live_trade_events (signature, event_index, github_repo_id, venue, pool, slot,
    traded_at, direction, quote_amount, base_amount, next_sqrt_price) values ${values.join(',')}
    on conflict (signature, event_index) do nothing`, params)
  return rowCount
}

export async function pruneLiveTrades(pool, maxAgeMs = LIVE_TRADE_TTL_MS) {
  const { rowCount } = await pool.query('delete from live_trade_events where received_at < now() - make_interval(secs => $1)', [maxAgeMs / 1000])
  return rowCount
}

// connect(): a new Connection to the primary RPC at 'confirmed' (its websocket carries the notifications); called once, and
// again whenever the websocket proves deaf. onDammSwap(repoId): a graduated market's swap just confirmed, so its finalized
// indexing can be due as soon as it finalizes. track(fn): runs each transaction's handling (the worker attributes its RPC
// reads to this job).
export function createLiveTrades({ pool, connect, config, legacyConfigs, loadTransaction = (rpc, signature) => loadTransactionAt(rpc, signature, 'confirmed'),
  onDammSwap = () => {}, now = Date.now, concurrency = 4, delays = RETRY_DELAYS_MS, refreshMs = LIVE_REFRESH_MS, deafMs = LIVE_DEAF_MARGIN_MS,
  markets = watchedMarkets, newestFinalized = newestFinalizedTrade, track = fn => fn() }) {
  const resolveConfig = createMarketConfigResolver(config, legacyConfigs)
  let connection = connect()
  const parsers = { resolveConfig, dbc: new DynamicBondingCurveClient(connection, 'confirmed'), coder: new CpAmm(connection)._program.coder }
  let watched = { curves: new Map(), damms: new Map() }, refreshedAt = -Infinity, renewedAt = now(), active = 0, stopped = false
  const subscriptions = new Map(), seen = new Set(), queue = []
  const stats = { notifications: 0, transactions: 0, inserted: 0, missing: 0, dropped: 0, renewals: 0, errors: {}, lastNotificationAt: null }
  const fail = code => { stats.errors[code] = (stats.errors[code] ?? 0) + 1 }

  async function handle(signature) {
    let transaction = null
    for (let attempt = 0; !transaction && attempt <= delays.length; attempt++) {
      if (attempt) await wait(delays[attempt - 1])
      transaction = await loadTransaction(connection, signature)
    }
    if (!transaction) { stats.missing++; return }
    stats.transactions++
    const failures = [], rows = liveTradeRows(transaction, signature, watched, parsers, failures)
    failures.forEach(fail)
    if (!rows.length) return
    stats.inserted += await insertLiveTrades(pool, rows)
    for (const repoId of new Set(rows.filter(row => row.venue === 'DAMM').map(row => row.repoId))) {
      try { onDammSwap(repoId) } catch { /* Waking is an optimization. */ }
    }
  }
  function pump() {
    while (!stopped && active < concurrency && queue.length) {
      const signature = queue.shift()
      active++
      Promise.resolve().then(() => track(() => handle(signature))).catch(error => fail(errorCode(error))).finally(() => { active--; pump() })
    }
  }
  function notify(logs) {
    stats.notifications++; stats.lastNotificationAt = now()
    if (stopped || logs?.err || typeof logs?.signature !== 'string' || seen.has(logs.signature)) return
    seen.add(logs.signature)
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value)
    if (queue.length >= QUEUE_MAX) { stats.dropped++; return }
    queue.push(logs.signature)
    pump()
  }
  // A callback of its own per subscription: web3.js keeps one Set of callbacks per identical subscription, so a shared
  // function would be removed from it by the previous subscription's teardown.
  function subscribe(address) {
    if (subscriptions.has(address)) return
    subscriptions.set(address, { connection, id: connection.onLogs(new PublicKey(address), (logs, context) => notify(logs, context), 'confirmed') })
  }
  // Not awaited: web3.js waits for the server's reply to an unsubscribe, which a half-open socket may never send.
  function unsubscribe(address) {
    const { connection: owner, id } = subscriptions.get(address)
    subscriptions.delete(address)
    Promise.resolve().then(() => owner.removeOnLogsListener(id)).catch(() => { /* Already gone with its socket. */ })
  }

  return {
    // Re-reads the watched markets at most every refreshMs and adjusts the subscriptions: every approved config with a
    // curve market, and every graduated market's DAMM pool. A finalized trade the websocket never announced (deafMs after
    // the last notification, or after the last (re)connect) moves every subscription to a fresh connection.
    async refresh({ force = false } = {}) {
      if (stopped || (!force && now() - refreshedAt < refreshMs)) return null
      const next = await markets(pool)
      const wanted = new Set(next.damms.keys()), heardCurves = new Map()
      for (const [address, market] of next.curves) {
        try { wanted.add(resolveConfig(market).toBase58()); heardCurves.set(address, market) } catch { fail('CONFIG_UNRESOLVED') }
      }
      watched = next; refreshedAt = now()
      // Evidence only from markets a subscription covers: a curve whose config does not resolve is never announced.
      const heard = Math.max(stats.lastNotificationAt ?? -Infinity, renewedAt)
      const newest = subscriptions.size ? await newestFinalized(pool, { curves: heardCurves, damms: next.damms }) : null
      const deaf = newest !== null && new Date(newest).getTime() > heard + deafMs
      for (const address of [...subscriptions.keys()]) if (deaf || !wanted.has(address)) unsubscribe(address)
      if (deaf) { connection = connect(); renewedAt = now(); stats.renewals++ }
      for (const address of wanted) subscribe(address)
      return { subscriptions: subscriptions.size, curves: next.curves.size, graduated: next.damms.size, invalid: next.invalid?.length ?? 0, renewed: deaf }
    },
    // Counters since the last read (subscriptions and the newest notification time are current values).
    stats() {
      const snapshot = { subscriptions: subscriptions.size, queued: queue.length, ...stats, errors: { ...stats.errors } }
      Object.assign(stats, { notifications: 0, transactions: 0, inserted: 0, missing: 0, dropped: 0, renewals: 0, errors: {} })
      return snapshot
    },
    async stop() {
      stopped = true
      queue.length = 0
      for (const address of [...subscriptions.keys()]) unsubscribe(address)
    },
  }
}

// Graduated markets' finalized DAMM swaps, read every everyMs instead of once per full graduation pass (which visits every
// market in turn). One primary read of the pool's newest finalized signature decides whether anything is new; only then
// does the existing two-provider walk run (indexDammTrades), under the graduation monitor's own per-market lock, so the
// two never index one market at once. wake(repoId): a swap just confirmed, so check again once it should be finalized.
export const GRADUATED_CHECK_MS = 10_000
export const FINALITY_WAIT_MS = 13_000
export const FINALITY_RECHECK_MS = 3_000
const FINALITY_RECHECKS = 5

export function createGraduatedTradeIndexer({ pool, connection, verification, now = Date.now, everyMs = GRADUATED_CHECK_MS,
  finalityMs = FINALITY_WAIT_MS, recheckMs = FINALITY_RECHECK_MS, busyMs = 2_000, errorMs = 30_000, marketsMs = 15_000,
  index = indexDammTrades, markets = watchedMarkets }) {
  const states = new Map()
  let graduated = null, readAt = -Infinity
  const stateOf = repoId => {
    if (!states.has(repoId)) states.set(repoId, { nextAt: 0, rechecks: 0 })
    return states.get(repoId)
  }
  return {
    wake(repoId, at = now() + finalityMs) {
      const state = stateOf(String(repoId))
      state.nextAt = Math.min(state.nextAt, at); state.rechecks = FINALITY_RECHECKS
    },
    async runOnce() {
      if (!verification) return [{ status: 'SKIPPED', code: 'VERIFICATION_RPC_REQUIRED' }]
      if (!graduated || now() - readAt >= marketsMs) { graduated = (await markets(pool)).damms; readAt = now() }
      const damms = graduated
      const results = []
      for (const [address, { market, migration }] of damms) {
        const state = stateOf(market.repoId)
        if (now() < state.nextAt) continue
        state.nextAt = now() + everyMs
        try {
          const [newest] = await connection.getSignaturesForAddress(new PublicKey(address), { limit: 1 }, 'finalized')
          const { rows: [cursor] } = await pool.query('select last_signature from pool_fee_cursors where pool = $1', [address])
          if (!newest || newest.signature === (cursor?.last_signature ?? migration.signature)) {
            // Woken for a confirmed swap that is not finalized yet: look again shortly instead of a full interval later.
            if (state.rechecks > 0) { state.rechecks--; state.nextAt = now() + recheckMs }
            results.push({ repoId: market.repoId, status: 'CURRENT' })
            continue
          }
          const db = await pool.connect()
          try {
            const key = `graduation:${market.repoId}`
            if (!(await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) as locked', [key])).rows[0].locked) {
              state.nextAt = now() + busyMs
              results.push({ repoId: market.repoId, status: 'BUSY' })
              continue
            }
            try {
              const indexed = await index({ db, connection, verification, market: { ...market, githubRepoId: market.repoId },
                graduation: { pool: migration.pool, signature: migration.signature, slot: Number(migration.slot) } })
              state.rechecks = 0
              results.push({ repoId: market.repoId, status: 'INDEXED', transactions: indexed?.transactions ?? 0 })
            } finally { await db.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]) }
          } finally { db.release() }
        } catch (error) {
          state.nextAt = now() + errorMs
          results.push({ repoId: market.repoId, status: 'ERROR', code: errorCode(error) })
        }
      }
      return results
    },
  }
}
