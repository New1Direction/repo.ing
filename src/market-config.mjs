import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'

// Only operator-approved configs may identify a canonical pool. Never trust a
// config supplied by a browser, database label, or arbitrary pool account.
export function createMarketConfigResolver(config, legacyConfigs = process.env.DBC_LEGACY_CONFIGS ?? '') {
  const values = [config, ...(Array.isArray(legacyConfigs) ? legacyConfigs : legacyConfigs.split(',').map(value => value.trim()).filter(Boolean))]
  const approved = [...new Set(values.map(value => new PublicKey(value).toBase58()))].map(value => new PublicKey(value))
  if (approved.length > 16) throw Error('Too many approved DBC configs')
  return market => {
    const mint = new PublicKey(market.mint), pool = new PublicKey(market.pool)
    const match = approved.find(key => deriveDbcPoolAddress(NATIVE_MINT, mint, key).equals(pool))
    if (!match) throw Error('Canonical market does not match an approved DBC config')
    return match
  }
}
