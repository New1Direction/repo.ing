import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getScaledUiAmountConfig, unpackMint } from '@solana/spl-token'
import { quoteAssetById } from './quote-assets.mjs'
import { tipTokenPrices } from './tip-tokens.mjs'

// What the trade panel needs to show a stock pair's amounts (docs/STOCK_QUOTES.md):
// - the multiplier wallets show it with. A Token-2022 ScaledUiAmount mint (xStocks) is displayed as raw × multiplier while
//   trades, fees and settlement stay in raw units; the panel converts with it for display and back, rounded down, for
//   every request.
// - its USD price per whole raw token (Jupiter's prescaled price, read as tips read it), or null.
const MULTIPLIER_TTL_MS = 60_000
const MULTIPLIER_TEXT = /^\d{1,6}(\.\d{1,18})?$/
const multipliers = new Map()

// The multiplier in force at `unixSeconds`, as Token-2022 applies it: the new one from its effective time on. A mint without
// the extension is shown as it is.
export function currentMultiplier(config, unixSeconds) {
  if (!config) return 1
  return unixSeconds >= Number(config.newMultiplierEffectiveTimestamp) ? config.newMultiplier : config.multiplier
}

// A multiplier as exact decimal text for the browser; anything but a plain positive decimal fails closed.
export function multiplierText(value) {
  const text = String(value)
  if (!Number.isFinite(value) || value <= 0 || !MULTIPLIER_TEXT.test(text)) throw Error('Stock display multiplier is unavailable')
  return text
}

async function readMultiplier(connection, mint, nowMs) {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  if (!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error('Stock mint is unavailable')
  const config = getScaledUiAmountConfig(unpackMint(mint, info, TOKEN_2022_PROGRAM_ID))
  return multiplierText(currentMultiplier(config, Math.floor(nowMs / 1000)))
}

// A registry stock asset's display facts, or null for SOL and unknown ids. The multiplier is read from the mint (kept a
// minute; a failed read is never kept and fails the call). A missing price is null: the panel then shows no USD estimate.
export async function quoteAssetInfo(assetId, { connection, prices = tipTokenPrices, now = Date.now } = {}) {
  const asset = quoteAssetById(assetId)
  if (!asset || asset.type !== 'TOKENIZED_EQUITY') return null
  const at = now()
  let entry = multipliers.get(asset.mint)
  if (!entry || at - entry.at >= MULTIPLIER_TTL_MS) {
    entry = { at, value: readMultiplier(connection, new PublicKey(asset.mint), at) }
    multipliers.set(asset.mint, entry)
    entry.value.catch(() => { if (multipliers.get(asset.mint) === entry) multipliers.delete(asset.mint) })
  }
  const [uiMultiplier, usd] = await Promise.all([entry.value, prices().catch(() => ({}))])
  const usdPrice = usd?.[asset.mint]
  return { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, uiMultiplier,
    usdPrice: Number.isFinite(usdPrice) && usdPrice > 0 ? usdPrice : null }
}

export function clearQuoteAssetInfoCache() { multipliers.clear() }
