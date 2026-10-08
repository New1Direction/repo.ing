import bs58 from 'bs58'

const KEY = 'repoing:referrer'
export const REFERRAL_TTL_MS = 30 * 24 * 60 * 60 * 1000

// Shape check only; the server checks the address is on-curve and has a wrapped-SOL account.
export function validReferrer(value) {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return false
  try { return bs58.decode(value).length === 32 } catch { return false }
}

// Last touch wins: every visit with a valid ?ref replaces the stored referrer and restarts the 30 days.
export function captureReferral(search, storage, now = Date.now()) {
  const ref = new URLSearchParams(search).get('ref')
  if (!validReferrer(ref)) return null
  try { storage.setItem(KEY, JSON.stringify({ ref, at: now })) } catch { return null }
  return ref
}

// The referrer to send with a trade, or null when missing, expired, malformed or the trader's own wallet.
export function storedReferral(storage, wallet, now = Date.now()) {
  try {
    const { ref, at } = JSON.parse(storage.getItem(KEY) ?? 'null') ?? {}
    if (!validReferrer(ref) || !Number.isFinite(at) || at > now || now - at > REFERRAL_TTL_MS) return null
    return ref === wallet ? null : ref
  } catch { return null }
}

export function referralLink(origin, mint, wallet) {
  return `${origin}/token/${encodeURIComponent(mint)}?ref=${encodeURIComponent(wallet)}`
}

// The wallet's site-wide link (/referrals): any page captures ?ref, so it works from the home page too.
export function siteReferralLink(origin, wallet) {
  return `${origin}/?ref=${encodeURIComponent(wallet)}`
}

// GET /api/referral payload, or null when malformed.
export function referralStatus(result) {
  if (!result || typeof result.enabled !== 'boolean' || !/^\d+$/.test(result.earningsLamports) || !/^\d+$/.test(result.setupLamports)) return null
  // free: repo.ing pays the setup right now (src/referral-sponsorship.mjs); absent in older answers.
  return { enabled: result.enabled, earningsLamports: result.earningsLamports, setupLamports: result.setupLamports, free: result.free === true }
}
