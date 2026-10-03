import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { quoteOfMarket } from './quote-assets.mjs'
import { stockQuoteConfigs } from './quote-configs.mjs'

// The operator-approved DBC configs: the current one first, then DBC_LEGACY_CONFIGS.
export function approvedConfigs(config, legacyConfigs = process.env.DBC_LEGACY_CONFIGS ?? '') {
  const values = [config, ...(Array.isArray(legacyConfigs) ? legacyConfigs : legacyConfigs.split(',').map(value => value.trim()).filter(Boolean))]
  const approved = [...new Set(values.map(value => new PublicKey(value).toBase58()))].map(value => new PublicKey(value))
  if (approved.length > 16) throw Error('Too many approved DBC configs')
  return approved
}

// Only operator-approved configs may identify a canonical pool. Never trust a
// config supplied by a browser, database label, or arbitrary pool account.
// SOL markets only: a stock-paired market (markets.quote_mint set, migration 0053) is refused here, so a path that still
// assumes SOL fails loudly on it instead of misreading its pool. Paths that handle any quote use
// createQuoteAwareConfigResolver.
export function createMarketConfigResolver(config, legacyConfigs = process.env.DBC_LEGACY_CONFIGS ?? '') {
  const approved = approvedConfigs(config, legacyConfigs)
  return market => {
    if (market.quoteMint || market.quoteAssetId) throw Error('Stock-paired market needs a quote-aware path')
    const mint = new PublicKey(market.mint), pool = new PublicKey(market.pool)
    const match = approved.find(key => deriveDbcPoolAddress(NATIVE_MINT, mint, key).equals(pool))
    if (!match) throw Error('Canonical market does not match an approved DBC config')
    return match
  }
}

// SOL markets exactly as createMarketConfigResolver; a stock-paired market only on the config registered for its stamped asset
// (STOCK_QUOTE_CONFIGS), with its pool derived from the stamped quote mint, which must still be the registry's mint for that
// asset (quoteOfMarket). stockConfigs (a Map, or a function returning one) is read only when a stock-paired market is resolved,
// so a malformed STOCK_QUOTE_CONFIGS can only fail stock markets, never a SOL path.
export function createQuoteAwareConfigResolver(config, legacyConfigs = process.env.DBC_LEGACY_CONFIGS ?? '', stockConfigs = () => stockQuoteConfigs()) {
  const sol = createMarketConfigResolver(config, legacyConfigs)
  return market => {
    if (!market.quoteMint && !market.quoteAssetId) return sol(market)
    const quote = quoteOfMarket(market)
    const key = (typeof stockConfigs === 'function' ? stockConfigs() : stockConfigs).get(quote.assetId)
    if (!key) throw Error('Stock-paired market has no registered config')
    if (!deriveDbcPoolAddress(new PublicKey(quote.mint), new PublicKey(market.mint), key).equals(new PublicKey(market.pool))) {
      throw Error('Canonical market does not match its stock config')
    }
    return key
  }
}

// A DBC config account is written only by createConfig (the program IDL marks it writable nowhere else), so its
// decoded state is kept per endpoint and commitment, with concurrent reads sharing one request. The TTL is a
// backstop; a missing config is never cached.
const POOL_CONFIG_TTL_MS = 3_600_000
const poolConfigs = new Map()
export function readPoolConfig(dbc, configKey, { now = Date.now, ttlMs = POOL_CONFIG_TTL_MS } = {}) {
  const key = `${dbc.connection?.rpcEndpoint ?? ''}\n${dbc.commitment ?? ''}\n${new PublicKey(configKey).toBase58()}`
  const hit = poolConfigs.get(key)
  if (hit?.pending) return hit.pending
  if (hit && now() < hit.expiresAt) return Promise.resolve(hit.value)
  const pending = dbc.state.getPoolConfig(configKey).then(value => {
    if (value) {
      if (poolConfigs.size >= 64) poolConfigs.delete(poolConfigs.keys().next().value)
      poolConfigs.set(key, { value, expiresAt: now() + ttlMs })
    } else poolConfigs.delete(key)
    return value
  }, error => { poolConfigs.delete(key); throw error })
  poolConfigs.set(key, { pending })
  return pending
}
