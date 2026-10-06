import { PublicKey } from '@solana/web3.js'

// Bundle markets (docs/BUNDLE_LAUNCH.md, migration 0060): what the rest of the site needs to know about them.
// Their pool is on the bundle DBC config (BUNDLE_DBC_CONFIG), whose fee claimer is the bundle program's router, not repo.ing's
// partner wallet: so every path that claims, counts or alerts on partner fees as repo.ing's skips them. Builder (creator) fees,
// trading, charts and graduation work as for any SOL market.

export const isBundleMarket = market => (market?.bundleId ?? null) !== null

// The bundle config, or null while none is set. A malformed value fails loudly: a wrong key must not silently approve nothing.
export function bundleCurveConfig(env = process.env) {
  const value = String(env.BUNDLE_DBC_CONFIG ?? '').trim()
  return value ? new PublicKey(value) : null
}
