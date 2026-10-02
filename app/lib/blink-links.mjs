import { withReferral } from './share-links.mjs'

// Client-safe link helpers. With actions.json live, the plain market URL is the Blink on X (for registered
// domains and Blink-enabled wallets); dial.to renders the same action for anyone, anywhere.
export const SITE_ORIGIN = 'https://repo.ing'
export const blinkApiPath = mint => `/api/actions/buy/${encodeURIComponent(mint)}`
export const sellApiPath = mint => `/api/actions/sell/${encodeURIComponent(mint)}`
export const marketUrl = (mint, origin = SITE_ORIGIN) => `${origin}/token/${encodeURIComponent(mint)}`
// ref: the sharer's wallet; the action carries it into every buy and sell it builds.
export const dialToUrl = (mint, origin = SITE_ORIGIN, ref = null) =>
  `https://dial.to/?action=${encodeURIComponent(`solana-action:${withReferral(`${origin}${blinkApiPath(mint)}`, ref)}`)}`
