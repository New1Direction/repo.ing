let cachedPrice = null
let expiresAt = 0
let pending = null

export async function solUsdPrice(fetchImpl = fetch, now = Date.now()) {
  if (cachedPrice !== null && now < expiresAt) return cachedPrice
  if (pending) return pending
  pending = loadPrice(fetchImpl, now).finally(() => { pending = null })
  return pending
}

async function loadPrice(fetchImpl, now) {
  try {
    const response = await fetchImpl('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null
    const price = (await response.json())?.solana?.usd
    if (!Number.isFinite(price) || price <= 0) return null
    cachedPrice = price
    expiresAt = now + 5 * 60 * 1000
    return price
  } catch { return null }
}
