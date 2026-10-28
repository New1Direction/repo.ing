// Hooks coins on Explore (app/(site)/explore/hooks and the strip on /explore): the listed coins with their last price,
// 24h volume and trade count from the trade index. Display only. The index moves while someone views a coin
// (app/lib/hooklab-coin-activity.mjs), and trades go through the coin page, so a coin's figures follow its trades closely.
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { hookCoinTradeStore } from '../../src/hooklab-coin-trades.mjs'
import { openLaunchesEnabled, siteLaunchesEnabled } from '../../src/hooklab-open-creation.mjs'
import { walletIdentityConfiguration } from './hooklab-wallet-identity.mjs'
import { cached } from './hooklab-market.mjs'
import { hookCoinRules } from './hooklab-coin-display.mjs'
import { coinImageUrl } from '../../src/hooklab-coin-profile.mjs'

// As short as the coin page's cache (COIN_PAGE_CACHE_MS), so an owner's delisting leaves the lists as quickly.
export const EXPLORE_HOOK_COINS_CACHE_MS = 3000
export const EXPLORE_HOOK_COINS_LIMIT = 100

// Listed coins (delisted ones left out), newest first, each with `stats` ({ priceSol, volume24hLamports, totalTrades,
// lastTradeAt }) or null before its first indexed trade. A failed trade read keeps the list and drops the figures; a failed
// listing read gives [] (the page shows its empty state, as Buy & sell does).
export function exploreHookCoins({ env = process.env, configuration = walletIdentityConfiguration, database = createHookLabDatabasePool,
  store = ownerApprovalStore, trades = hookCoinTradeStore, now = Date.now } = {}) {
  if (!siteLaunchesEnabled(env)) return Promise.resolve([])
  return cached('explore-hook-coins', EXPLORE_HOOK_COINS_CACHE_MS, async () => {
    let pool
    try {
      pool = database(configuration(env))
      const coins = await store(pool, { adminAddress: env.HOOK_LAUNCH_ADMIN_ADDRESS, openLaunches: openLaunchesEnabled(env) }).launchedCoins(EXPLORE_HOOK_COINS_LIMIT)
      const stats = await trades(pool).overview(coins.map(coin => coin.mint), { now: now() }).catch(() => new Map())
      return coins.map(coin => Object.freeze({ ...coin, stats: stats.get(coin.mint) ?? null }))
    } catch { return [] } finally { await pool?.end().catch(() => {}) }
  }, now)
}

export const EXPLORE_IMAGE_WIDTH = 128
// What the Explore list and strip show of a coin (plain data for the client components).
// The fee and rule numbers ride along for the browse chips, badges and one-number fee (app/lib/hooklab-ux.mjs).
export const hookCoinRow = coin => Object.freeze({ mint: coin.mint, name: coin.name, symbol: coin.symbol,
  image: coin.profile ? coinImageUrl('', coin.id, EXPLORE_IMAGE_WIDTH) : null, rules: hookCoinRules(coin), stats: coin.stats,
  capBps: coin.selectedHook ? 0 : Number(coin.capBps) || 0, creatorFeeBps: Number(coin.creatorFeeBps) || 0, burnBps: Number(coin.burnBps) || 0, holderBps: Number(coin.holderBps) || 0 })
