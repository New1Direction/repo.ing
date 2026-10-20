// A listed Hooks coin's chart, trades and holders over HTTP (app/api/hook-lab/market/[mint]/{candles,trades,holders}).
// Display only, and only for coins launched through repo.ing: the same listing as the coin page and the market API
// (app/lib/hooklab-market.mjs listedCoin, from the trading runtime's coinProfile).
//
// Where the trade index runs: here, in the web service, on demand. Hook Lab is kept out of the general worker
// (docs/HOOK_LAB_EXECUTION_FOUNDATION.md), and its pinned RPC providers and database are installed only in the web process
// (src/hooklab-production-bootstrap.mjs), so a worker loop would need its own copy of both. A request first compares the
// chain's swap counter (from the coin read the trade panel already polls, cached 3 s) with the index's: equal, with no walk
// filling in older history, means no RPC at all. Otherwise one pass per coin runs at a time, at most every REFRESH_MIN_MS
// (ERROR_BACKOFF_MS after a failure), with at most MAX_RUNNING_REFRESHES coins at once; the request waits up to
// REFRESH_WAIT_MS for it and a longer pass finishes in the background. The index only moves while someone views a coin.
import { PublicKey } from '@solana/web3.js'
import { createRateLimiter } from './csp-report.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { inclusiveTradeRuntime } from './hooklab-inclusive-trade-runtime.mjs'
import { cached, cachedMarket, listedCoin } from './hooklab-market.mjs'
import { walletIdentityConfiguration } from './hooklab-wallet-identity.mjs'
import { cachedSolUsdPrice } from './sol-usd.mjs'
import { DEFAULT_HOOK_INTERVAL, hookIntervalSeconds } from './hooklab-coin-display.mjs'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { hookCoinTradeStore, indexHookCoinTrades } from '../../src/hooklab-coin-trades.mjs'
import { hookHolderLabels, readHookCoinHolders } from '../../src/hooklab-coin-activity.mjs'
import { hookCoinAddresses } from '../../src/hooklab-inclusive-max-wallet-swap.mjs'
import { isStackProfile } from '../../src/hooklab-stack.mjs'

export const REFRESH_MIN_MS = 10_000
export const ERROR_BACKOFF_MS = 60_000
export const REFRESH_WAIT_MS = 2_500
export const MAX_RUNNING_REFRESHES = 3
export const HOLDERS_TTL_MS = 60_000
// After a failed holders read, the coin answers 'unavailable' this long without asking the provider again.
export const HOLDERS_RETRY_MS = 15_000
const TRADES_PAGE = 20, TRADES_PAGE_MAX = 50

const reply = (body, status = 200, cache = 'no-store') => Response.json(body, { status, headers: { 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' } })
const unavailable = () => reply({ status: 'unavailable', error: 'Trading data is unavailable right now.' }, 503)
const address = value => { try { return new PublicKey(value).toBase58() === value ? value : null } catch { return null } }
const defaultLimiter = createRateLimiter({ limit: 120, globalLimit: 3000, windowMs: 60_000 })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
// The coin's accounts under its own stack (the profile the trade runtime names for it: legacy or our own stack).
const addressesOf = (mint, profile) => cached(`hook-addresses:${profile.programs.swap}:${profile.quoteMint}:${mint}`, 3_600_000, () => hookCoinAddresses(profile, mint))

// A failure is logged by its code, at most once a minute each, never with RPC or database detail.
const logged = new Map()
export function reportOnce(error, now = Date.now()) {
  const code = error?.code === '42P01' ? 'HOOK_TRADES_NOT_MIGRATED' : /^[A-Z][A-Z0-9_]{3,60}$/.test(error?.code ?? '') ? error.code : 'UNAVAILABLE'
  if (now - (logged.get(code) ?? -Infinity) < 60_000) return
  logged.set(code, now)
  console.warn(JSON.stringify({ hookCoinActivityError: { code } }))
}

export function openHookCoinStore(env = process.env) {
  const pool = createHookLabDatabasePool(walletIdentityConfiguration(env))
  return { store: hookCoinTradeStore(pool), close: () => pool.end().catch(() => {}) }
}

// ensure({ coin, rpc, behind }) resolves to 'current' (not behind), 'recent' (this coin was refreshed under minMs ago, or
// failed under errorMs ago), 'busy' (enough coins are refreshing), or the pass's outcome: 'indexed', 'current', 'error',
// or 'pending' while it keeps running.
export function createOnDemandIndexer({ openStore = () => openHookCoinStore(), index = indexHookCoinTrades, now = Date.now, minMs = REFRESH_MIN_MS,
  errorMs = ERROR_BACKOFF_MS, waitMs = REFRESH_WAIT_MS, maxRunning = MAX_RUNNING_REFRESHES, onError = reportOnce } = {}) {
  const states = new Map()
  let running = 0
  function start(coin, rpc) {
    const state = { at: now(), pass: null, failed: false }
    states.set(coin.pool, state); running++
    state.pass = (async () => {
      const { store, close } = openStore()
      try { return (await index({ rpc, store, coin })).status } finally { await close() }
    })().catch(error => { onError(error); state.failed = true; return 'error' }).finally(() => { running--; state.pass = null })
    if (states.size > 1000) states.delete(states.keys().next().value)
    return state
  }
  return Object.freeze({
    async ensure({ coin, rpc, behind }) {
      if (!behind) return 'current'
      let state = states.get(coin.pool)
      if (!state?.pass) {
        if (state && now() - state.at < (state.failed ? errorMs : minMs)) return 'recent'
        if (running >= maxRunning) return 'busy'
        state = start(coin, rpc)
      }
      return Promise.race([state.pass, wait(waitMs).then(() => 'pending')])
    },
  })
}
let sharedIndexer = null
const defaultIndexer = () => (sharedIndexer ??= createOnDemandIndexer())

const publicTrade = t => ({ signature: t.signature, eventIndex: t.eventIndex, side: t.side, trader: t.trader, tradedAt: t.tradedAt,
  solLamports: t.quoteAmount, tokenBaseUnits: t.baseAmount, swapCount: t.swapCount })

export function createCoinActivityHandlers({ runtime = inclusiveTradeRuntime, listed = listedCoin, openStore = () => openHookCoinStore(),
  indexer = null, allowed = defaultLimiter, holdersTtlMs = HOLDERS_TTL_MS, holdersRetryMs = HOLDERS_RETRY_MS, now = Date.now,
  solUsd = () => cachedSolUsdPrice() } = {}) {
  const holderFailures = new Map()
  // A listed coin's market read, then work({ market, profile, rpc, addresses }). As in the market API, the listing is
  // checked first (one cached database read; a failed read throws, so it answers unavailable, never "not listed"), so an
  // unlisted coin is never read from Solana. Every address and read comes from the coin's own stack: its profile
  // (service.profileFor(coin)) and the reads bound to it (service.activityFor(coin)). A runtime that cannot name them (no
  // bundle for that stack) answers unavailable, never a guessed stack.
  const guarded = work => async (request, { mint }) => {
    if (!address(mint)) return reply({ error: 'Unknown coin.' }, 404)
    if (!allowed(clientAddress(request) ?? 'unknown')) return reply({ error: 'Too many requests. Try again shortly.' }, 429)
    const service = runtime()
    if (!service?.market || !service.coinProfile || typeof service.profileFor !== 'function' || typeof service.activityFor !== 'function') return unavailable()
    try {
      const coin = await listed(service, mint)
      if (!coin) return reply({ error: 'This coin is not listed on repo.ing.' }, 404, 'public, max-age=60')
      const profile = service.profileFor(coin), rpc = service.activityFor(coin)
      if (typeof profile?.programs?.swap !== 'string' || typeof profile.quoteMint !== 'string' || !rpc) return unavailable()
      const view = await cachedMarket(service, mint, null, coin)
      if (!view?.market) return reply({ error: 'This coin is not listed on repo.ing.' }, 404, 'public, max-age=60')
      return await work({ market: view.market, profile, rpc, addresses: await addressesOf(mint, profile), url: new URL(request.url) })
    } catch (error) { reportOnce(error); return unavailable() }
  }
  // The index caught up to the chain's swap counter (or as far as one short wait allows), then read(store, pool, sync):
  // sync.syncing is how many newer swaps are not indexed yet, sync.backfilling whether older history is still being read.
  const indexed = async ({ market, profile, rpc, addresses }, read) => {
    // A coin on our own stack trades only native SOL: every swap on its pool must carry its SwappedNative.
    const { store, close } = openStore(), coin = { mint: market.mint, pool: addresses.pool, programs: profile.programs, native: isStackProfile(profile) }
    const chainSwapCount = BigInt(market.pool.swapCount)
    try {
      const before = await store.progress(coin.pool), behind = before.walking || before.swapCount < chainSwapCount
      if (behind) await (indexer ?? defaultIndexer()).ensure({ coin, rpc, behind })
      const after = behind ? await store.progress(coin.pool) : before
      return await read(store, coin.pool, { syncing: Number(chainSwapCount > after.swapCount ? chainSwapCount - after.swapCount : 0n), backfilling: after.walking })
    } finally { await close() }
  }
  return Object.freeze({
    trades: guarded(async context => {
      const before = context.url.searchParams.get('before'), limitText = context.url.searchParams.get('limit')
      const limit = limitText === null ? TRADES_PAGE : Number(limitText)
      if (before !== null && !/^[1-9]\d{0,19}$/.test(before)) return reply({ error: 'Invalid page.' }, 400)
      if (!Number.isInteger(limit) || limit < 1 || limit > TRADES_PAGE_MAX) return reply({ error: 'Invalid page size.' }, 400)
      return indexed(context, async (store, pool, sync) => {
        const page = await store.trades(pool, { before, limit })
        return reply({ status: 'available', decimals: context.market.decimals, next: page.next, ...sync, trades: page.trades.map(publicTrade) },
          200, before ? 'public, max-age=60' : 'public, max-age=5')
      })
    }),
    candles: guarded(async context => {
      const interval = context.url.searchParams.get('interval') ?? DEFAULT_HOOK_INTERVAL, seconds = hookIntervalSeconds(interval)
      if (!seconds) return reply({ error: 'Choose 1m, 5m, 15m, 1h, 4h or 1d.' }, 400)
      const decimals = context.market.decimals
      return indexed(context, async (store, pool, sync) => {
        const [candles, summary] = await Promise.all([store.candles(pool, { seconds, decimals }), store.summary(pool, { decimals })])
        // The site's cached SOL/USD price (null while unknown), never waited on: the chart shows USD with it, SOL without.
        return reply({ status: 'available', interval, intervalSeconds: seconds, decimals, solUsd: solUsd() ?? null, ...sync, totalTrades: summary.totalTrades,
          volume24hLamports: summary.volume24hLamports, firstTradeAt: summary.firstTradeAt, lastTradeAt: summary.lastTradeAt,
          latest: summary.latest ? { priceSol: summary.latest.priceSol, tradedAt: summary.latest.tradedAt } : null, candles }, 200, 'public, max-age=5')
      })
    }),
    holders: guarded(async ({ market, profile, rpc, addresses }) => {
      if (now() - (holderFailures.get(market.mint) ?? -Infinity) < holdersRetryMs) return unavailable()
      const labels = hookHolderLabels(addresses, { graduated: market.graduated })
      try {
        const value = await cached(`hook-holders:${market.mint}`, holdersTtlMs, () =>
          readHookCoinHolders({ rpc, mint: market.mint, supply: market.supply ?? market.initialSupply, labels,
            programs: profile.programs, hidden: [profile.quoteMint] }))
        return reply({ status: 'available', decimals: market.decimals, ...value }, 200, 'public, max-age=30')
      } catch (error) {
        holderFailures.set(market.mint, now())
        if (holderFailures.size > 1000) holderFailures.delete(holderFailures.keys().next().value)
        throw error
      }
    }),
  })
}
