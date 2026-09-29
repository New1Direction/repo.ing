import bs58 from 'bs58'
import { marketByMint } from '../../../../../../lib/server.mjs'
import { settleWithin } from '../../../../../../lib/og-card.mjs'
import { parseReturnParam } from '../../../../../../lib/share-links.mjs'
import { SOURCE_MS, cardCache, fallback, marketLogo, renderPng } from '../../../../../../lib/og-image'
import { ReturnCard } from '../../../../../../lib/og-return-card'
export const runtime = 'nodejs'
// The URL holds only { mint, pct }: no wallet, amount or position size. Anyone can edit pct, so the
// card states it as the sharer's own reported return rather than a verified figure.
const cards = cardCache()

export async function GET(_request, { params }) {
  const { mint, pct: raw } = await params
  try {
    const pct = parseReturnParam(raw)
    if (pct === null || typeof mint !== 'string' || mint.length > 44 || bs58.decode(mint).length !== 32) return fallback()
    const key = `${mint}/${raw}`, cached = cards.get(key)
    if (cached) return cached
    const { market } = await marketByMint(mint)
    if (!market) return fallback()
    const logo = await settleWithin(marketLogo(market), SOURCE_MS)
    return cards.put(key, await renderPng(<ReturnCard market={market} logo={logo} pct={pct}/>), Boolean(logo))
  } catch {
    return fallback()
  }
}
