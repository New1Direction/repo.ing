import { referralStatus } from './referral.mjs'

// A wallet's referral payout status (GET /api/referral), shared by every component on the page (share menu, share card,
// Share on X, /referrals, /wallet): one read per wallet per minute, updated in place when setup completes. Browser only.
// A value is { enabled, earningsLamports, setupLamports }, or false when the status could not be read.
export const REFERRAL_STATUS_TTL_MS = 60_000
const entries = new Map(), listeners = new Map()

const notify = (wallet, value) => { for (const listener of listeners.get(wallet) ?? []) listener(value) }

export const peekReferralStatus = wallet => entries.get(wallet)?.value ?? null

export function loadReferralStatus(wallet, { fetcher = globalThis.fetch, now = Date.now } = {}) {
  const entry = entries.get(wallet)
  if (entry?.pending) return entry.pending
  if (entry && now() - entry.at < REFERRAL_STATUS_TTL_MS) return Promise.resolve(entry.value)
  const pending = fetcher(`/api/referral?wallet=${encodeURIComponent(wallet)}`, { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null).then(result => referralStatus(result) ?? false, () => false)
    .then(value => { setReferralStatus(wallet, value, now()); return value })
  entries.set(wallet, { ...entry, pending })
  return pending
}

export function setReferralStatus(wallet, value, at = Date.now()) {
  entries.set(wallet, { value, at })
  notify(wallet, value)
}

export function subscribeReferralStatus(wallet, listener) {
  const set = listeners.get(wallet) ?? new Set()
  set.add(listener)
  listeners.set(wallet, set)
  return () => { set.delete(listener); if (!set.size) listeners.delete(wallet) }
}

// Share links carry ?ref only for a wallet whose payouts are set up (no referral could be paid otherwise) and only while
// the sharer leaves it on. The link then holds the wallet address, which the share UI always says. offered: false for a market
// whose trades pay no referral (a stock pair: its swaps carry no referral account, src/stock-damm-trade.mjs), never a ?ref.
export const SHARE_REFERRAL_KEY = 'repoing:share-referral'

export const shareReferral = ({ wallet, status, include, offered = true }) => offered && wallet && status?.enabled === true && include ? wallet : null

export function readShareReferralChoice(storage) {
  try { return storage?.getItem(SHARE_REFERRAL_KEY) !== 'off' } catch { return true }
}

export function writeShareReferralChoice(storage, include) {
  try { storage?.setItem(SHARE_REFERRAL_KEY, include ? 'on' : 'off') } catch { /* The choice holds for this visit only. */ }
}
