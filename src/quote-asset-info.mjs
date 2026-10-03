import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getScaledUiAmountConfig, unpackMint } from '@solana/spl-token'
import { quoteAssetById } from './quote-assets.mjs'
import { currentMultiplier, multiplierText, scaledConfig } from './scaled-ui-amount.mjs'
import { tipTokenPrices } from './tip-tokens.mjs'

// What the trade panel needs to show a stock pair's amounts (docs/STOCK_QUOTES.md):
// - the multiplier wallets show it with (src/scaled-ui-amount.mjs), with how long the panel may keep using it: never past
//   a change the issuer has scheduled, and at most UNITS_VALID_SECONDS, so units that cannot be refreshed lapse;
// - its USD price per whole raw token (Jupiter's prescaled price, read as tips read it), or null.
const CONFIG_TTL_MS = 30_000
const PRICE_WAIT_MS = 800
export const UNITS_VALID_SECONDS = 120
const configs = new Map()

async function readScaledConfig(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed')
  if (!info?.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error('Stock mint is unavailable')
  return scaledConfig(getScaledUiAmountConfig(unpackMint(mint, info, TOKEN_2022_PROGRAM_ID)))
}

// The mint's extension, read at most every CONFIG_TTL_MS per mint; concurrent reads share one request and a failed read is
// never kept.
function mintScaledConfig(connection, mintAddress, at) {
  let entry = configs.get(mintAddress)
  if (!entry || at - entry.at >= CONFIG_TTL_MS) {
    entry = { at, value: readScaledConfig(connection, new PublicKey(mintAddress)) }
    configs.set(mintAddress, entry)
    entry.value.catch(() => { if (configs.get(mintAddress) === entry) configs.delete(mintAddress) })
  }
  return entry.value
}

// How long amounts shown with the multiplier in force at `unixSeconds` stay right: until a scheduled change, at most
// UNITS_VALID_SECONDS.
export function unitsValidSeconds(config, unixSeconds) {
  const untilChange = config && config.effectiveAt > unixSeconds ? config.effectiveAt - unixSeconds : Infinity
  return Math.max(1, Math.min(UNITS_VALID_SECONDS, untilChange))
}

// The multiplier in force now for a stock asset's mint, as exact decimal text.
export async function stockMultiplier(connection, asset, now = Date.now) {
  const at = now()
  return multiplierText(currentMultiplier(await mintScaledConfig(connection, asset.mint, at), Math.floor(at / 1000)))
}

const within = (promise, ms, fallback) => {
  let timer
  return Promise.race([promise.catch(() => fallback), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms) })])
    .finally(() => clearTimeout(timer))
}

// A registry stock asset's display facts, or null for SOL and unknown ids. A failed mint read fails the call; a slow or
// missing price is null (the panel then shows no USD estimate), and never holds up the units.
export async function quoteAssetInfo(assetId, { connection, prices = tipTokenPrices, now = Date.now } = {}) {
  const asset = quoteAssetById(assetId)
  if (!asset || asset.type !== 'TOKENIZED_EQUITY') return null
  const at = now(), seconds = Math.floor(at / 1000)
  const [config, usd] = await Promise.all([mintScaledConfig(connection, asset.mint, at), within(Promise.resolve().then(prices), PRICE_WAIT_MS, {})])
  const usdPrice = usd?.[asset.mint]
  return { assetId: asset.assetId, symbol: asset.symbol, decimals: asset.decimals, uiMultiplier: multiplierText(currentMultiplier(config, seconds)),
    validForSeconds: unitsValidSeconds(config, seconds), usdPrice: Number.isFinite(usdPrice) && usdPrice > 0 ? usdPrice : null }
}

export function clearQuoteAssetInfoCache() { configs.clear() }
