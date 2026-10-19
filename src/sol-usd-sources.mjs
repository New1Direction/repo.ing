// Independent public SOL/USD sources. CoinGecko rate-limits shared hosting IPs, so the site price
// (app/lib/sol-usd.mjs) falls through them in order, and USD launch pricing reads them all for a quorum.
export const SOL_USD_SOURCES = Object.freeze([
  ['coingecko', 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', body => body?.solana?.usd],
  ['jupiter', 'https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', body => body?.So11111111111111111111111111111111111111112?.usdPrice],
  ['coinbase', 'https://api.coinbase.com/v2/prices/SOL-USD/spot', body => Number(body?.data?.amount)],
])

// A positive finite price, or null for any failure (status, timeout, body shape).
export async function readSolUsdSource(fetchImpl, url, pick) {
  try {
    const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2500) })
    if (!response.ok) return null
    const price = pick(await response.json())
    return Number.isFinite(price) && price > 0 ? price : null
  } catch { return null }
}

// Every source at once: [{ source, usd }] for the ones that answered.
export async function readSolUsdSources(fetchImpl = fetch) {
  const prices = await Promise.all(SOL_USD_SOURCES.map(([, url, pick]) => readSolUsdSource(fetchImpl, url, pick)))
  return SOL_USD_SOURCES.flatMap(([source], i) => prices[i] === null ? [] : [{ source, usd: prices[i] }])
}
