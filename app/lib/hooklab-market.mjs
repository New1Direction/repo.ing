// Public read of one Hooks coin's market (and optionally a wallet's balances) for the coin page and trade panel.
// Display only: trades and funding re-verify everything on two providers before signing.
import { PublicKey } from '@solana/web3.js'
import { createRateLimiter } from './csp-report.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { inclusiveTradeRuntime } from './hooklab-inclusive-trade-runtime.mjs'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { walletIdentityConfiguration } from './hooklab-wallet-identity.mjs'
import { tradingOpenFor } from './hooklab-inclusive-trade.mjs'

const reply = (body, status = 200, cache = 'no-store') => Response.json(body, { status, headers: { 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' } })
const address = value => { try { return new PublicKey(value).toBase58() === value ? value : null } catch { return null } }
const defaultLimiter = createRateLimiter({ limit: 120, globalLimit: 3000, windowMs: 60_000 })
// Short shared caches collapse repeated reads (many viewers, polling panels) into one RPC or database read.
const caches = new Map()
export function cached(key, ttlMs, load, now = Date.now) {
  const hit = caches.get(key)
  if (hit && now() - hit.at < ttlMs) return hit.value
  const value = Promise.resolve().then(load)
  caches.set(key, { at: now(), value }); value.catch(() => caches.delete(key))
  if (caches.size > 5000) caches.delete(caches.keys().next().value)
  return value
}
export const cachedMarket = (service, mint, wallet = null) => cached(`market:${mint}:${wallet ?? ''}`, 3000, () => service.market(mint, wallet))

// The launch request (image, links) behind a coin listed on repo.ing, or null for any other coin. A failed read throws,
// so an unreachable database shows as unavailable rather than as "not listed".
export const listedCoin = (service, mint) => cached(`listed:${mint}`, 60_000, () => service.coinProfile(mint))

export function createMarketHandler({ env = process.env, runtime = inclusiveTradeRuntime, allowed = defaultLimiter } = {}) {
  return async (request, { mint }) => {
    if (!address(mint)) return reply({ error: 'Unknown coin.' }, 404)
    const walletParam = new URL(request.url).searchParams.get('wallet'), wallet = walletParam ? address(walletParam) : null
    if (walletParam && !wallet) return reply({ error: 'Invalid wallet.' }, 400)
    if (!allowed(clientAddress(request) ?? 'unknown')) return reply({ error: 'Too many requests. Try again shortly.' }, 429)
    const service = runtime()
    if (!service?.market || !service.coinProfile) return reply({ status: 'unavailable', error: 'Trading data is unavailable right now.' }, 503)
    try {
      // The listing is checked first (one cached database read), so unlisted coins are never read from Solana.
      const coin = await listedCoin(service, mint)
      if (!coin) return reply({ error: 'This coin isn’t listed on repo.ing.' }, 404, 'public, max-age=60')
      const view = await cachedMarket(service, mint, wallet)
      if (!view) return reply({ error: 'This coin isn’t listed on repo.ing.' }, 404, 'public, max-age=60')
      // tradingOpen: whether this wallet may start trades yet (everyone once HOOK_TRADING_PUBLIC=true, else listed testers).
      return reply({ status: 'available', ...view, coin, funding: !!service.walletFunding, tradingOpen: env.HOOK_TRADING_PUBLIC === 'true' || (!!wallet && tradingOpenFor(env, wallet)) },
        200, wallet ? 'no-store' : 'public, max-age=5')
    } catch { return reply({ status: 'unavailable', error: 'Trading data is unavailable right now.' }, 503) }
  }
}

// A wallet's SOL and Hook Lab SOL, for My coins and the withdraw button.
export function createWalletBalancesHandler({ runtime = inclusiveTradeRuntime, allowed = defaultLimiter } = {}) {
  return async (request, { wallet }) => {
    if (!address(wallet)) return reply({ error: 'Invalid wallet.' }, 400)
    if (!allowed(clientAddress(request) ?? 'unknown')) return reply({ error: 'Too many requests. Try again shortly.' }, 429)
    const service = runtime()
    if (!service?.walletBalances) return reply({ status: 'unavailable', error: 'Balances are unavailable right now.' }, 503)
    try { return reply({ status: 'available', wallet: await cached(`wallet:${wallet}`, 3000, () => service.walletBalances(wallet)), funding: !!service.walletFunding }) }
    catch { return reply({ status: 'unavailable', error: 'Balances are unavailable right now.' }, 503) }
  }
}

// Coins launched through repo.ing approval, for the Buy & sell list.
export async function launchedCoins({ env = process.env, database = createHookLabDatabasePool, store = ownerApprovalStore, limit = 50 } = {}) {
  if (env.HOOK_OWNER_APPROVED_LAUNCHES !== 'true') return []
  let pool
  try { pool = database(walletIdentityConfiguration(env)); return await store(pool, { adminAddress: env.HOOK_LAUNCH_ADMIN_ADDRESS }).launchedCoins(limit) }
  catch { return [] } finally { await pool?.end().catch(() => {}) }
}
