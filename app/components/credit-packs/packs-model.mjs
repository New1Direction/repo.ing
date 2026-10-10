// What the /credits page shows about packs and pulls: names, rarities and amounts. The odds and the money come from the
// server (src/credits-packs.mjs); this only names them.
export const PACK_NAMES = Object.freeze({ 10: 'Starter', 25: 'Builder', 50: 'Pro', 100: 'Founder' })
export const TIERS = Object.freeze([10, 25, 50, 100])
export const RARITIES = Object.freeze([{ bps: 10_000, key: 'common', name: 'Common' }, { bps: 12_000, key: 'rare', name: 'Rare' },
  { bps: 20_000, key: 'epic', name: 'Epic' }, { bps: 50_000, key: 'legendary', name: 'Legendary' }].map(Object.freeze))
export const rarityOf = bps => RARITIES.find(r => r.bps === bps) ?? { bps, key: 'common', name: `${bps / 10_000}×` }
/** 25000000 (micro-USD) → "$25.00". */
export const money = micro => `$${(Number(BigInt(micro) / 10_000n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const times = bps => `${bps / 10_000}×`
export const percent = probabilityBps => `${(probabilityBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`
