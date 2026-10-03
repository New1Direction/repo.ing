import { PublicKey } from '@solana/web3.js'
import { QUOTE_REGISTRY } from './quote-assets.mjs'

// The DBC config each stock pair launches on (docs/STOCK_QUOTES.md), from STOCK_QUOTE_CONFIGS: a JSON object of registry asset
// id → config address, e.g. {"meta-xstock":"<config>"}. Configs are created once per stock by the owner (on-chain) and set on
// both web and worker. The launcher still checks every field of the on-chain config before a launch, so a wrong address fails
// closed. A malformed value or an unknown asset id offers no stock config at all rather than a partial set.
export function stockQuoteConfigs(env = process.env, registry = QUOTE_REGISTRY) {
  const raw = env.STOCK_QUOTE_CONFIGS
  if (raw === undefined || raw.trim() === '') return new Map()
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw Error('STOCK_QUOTE_CONFIGS must be a JSON object') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('STOCK_QUOTE_CONFIGS must be a JSON object')
  const configs = new Map()
  for (const [assetId, value] of Object.entries(parsed)) {
    const asset = registry.assets.find(candidate => candidate.assetId === assetId)
    if (!asset) throw Error(`STOCK_QUOTE_CONFIGS names an unknown asset: ${assetId}`)
    const key = new PublicKey(value)
    if ([...configs.values()].some(existing => existing.equals(key))) throw Error('STOCK_QUOTE_CONFIGS repeats a config')
    configs.set(assetId, key)
  }
  return configs
}

// The launch config for one stock asset, or null when none is set.
export function stockConfigFor(assetId, env = process.env, registry = QUOTE_REGISTRY) {
  return stockQuoteConfigs(env, registry).get(assetId) ?? null
}
