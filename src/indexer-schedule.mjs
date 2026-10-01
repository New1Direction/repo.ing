import { PublicKey } from '@solana/web3.js'
import { backoffDelay } from './rpc-usage.mjs'

// Idle-aware polling for the per-market fee/trade indexer. Markets are checked often while they trade and less often
// the longer they stay quiet; any newer activity signal (a config-feed hit, a repo.ing trade session, the graduation
// monitor moving a DAMM cursor) makes a market due on the next pass. Upper bounds are the tier intervals below.

// [idle for less than, check at most every]
export const ACTIVITY_TIERS = Object.freeze([
  [10 * 60_000, 30_000],
  [2 * 3_600_000, 120_000],
  [Infinity, 300_000],
])

export function checkInterval(idleMs, tiers = ACTIVITY_TIERS) {
  for (const [below, every] of tiers) if (idleMs < below) return every
  return tiers.at(-1)[1]
}

const millis = value => {
  if (value === null || value === undefined) return null
  const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(at) ? at : null
}

export function createActivitySchedule({ now = Date.now, tiers = ACTIVITY_TIERS, errorBaseMs = 5000, errorMaxMs = 120_000,
  random = Math.random } = {}) {
  const markets = new Map()
  const entry = key => {
    if (!markets.has(key)) markets.set(key, { checkedAt: null, activeAt: null, wokenAt: null, errors: 0, retryAt: 0 })
    return markets.get(key)
  }
  return {
    // activityAt: the newest activity recorded anywhere for this market (database timestamps). Newer than the last
    // successful check means something happened since, so the market is due regardless of its tier.
    due(key, { activityAt = null } = {}) {
      const state = entry(key), at = now()
      if (at < state.retryAt) return false
      if (state.checkedAt === null) return true
      if (state.wokenAt !== null && state.wokenAt > state.checkedAt) return true
      const seen = millis(activityAt)
      if (seen !== null && seen > state.checkedAt) return true
      const last = Math.max(state.activeAt ?? -Infinity, seen ?? -Infinity)
      return at - state.checkedAt >= checkInterval(Number.isFinite(last) ? at - last : Infinity, tiers)
    },
    // A failed check keeps any pending wake and backs off (5 s doubling to 2 min) instead of retrying every pass.
    checked(key, { startedAt = now(), active = false, error = false } = {}) {
      const state = entry(key)
      if (error) {
        state.errors++
        state.retryAt = startedAt + backoffDelay(state.errors, { baseMs: errorBaseMs, maxMs: errorMaxMs, random })
        return
      }
      state.errors = 0; state.retryAt = 0; state.checkedAt = startedAt
      if (active) state.activeAt = startedAt
    },
    wake(key, at = now()) { entry(key).wokenAt = at },
    state: key => ({ ...entry(key) }),
  }
}

// The graduated (DAMM position) fee snapshot changes only with DAMM swaps and claims. activityAt is the newest sign
// of DAMM activity (the graduation monitor moving the DAMM cursor, a repo.ing trade session). Read it when there was
// activity since the last read, every 30 s while the pool traded in the last 15 minutes (reconciliation and claims
// compare chain fees with these records), when the curve itself moved (a migration is a curve transaction), on the
// first pass, and otherwise on a slow fallback; a curve market only needs the hourly fallback.
export function graduatedReadDue({ now = Date.now(), lastReadAt = null, lastReadGraduated = false, discovered = 0,
  dammPool = null, activityAt = null, activeWindowMs = 15 * 60_000, activeEveryMs = 30_000,
  graduatedEveryMs = 10 * 60_000, curveEveryMs = 60 * 60_000 }) {
  if (lastReadAt === null || discovered > 0) return true
  if (dammPool || lastReadGraduated) {
    const active = millis(activityAt)
    if (active !== null && active >= lastReadAt) return true
    if (active !== null && now - active < activeWindowMs && now - lastReadAt >= activeEveryMs) return true
    return now - lastReadAt >= graduatedEveryMs
  }
  return now - lastReadAt >= curveEveryMs
}

// Every DBC swap and migration names its config account, so one finalized signature list per approved config shows
// which canonical pools traded since the last poll. Hints only: a miss or failure falls back to the tier schedule,
// and the per-pool cursor walk stays the source of truth. Transactions read here are the ones the indexer then
// credits, so the finalized-transaction cache serves them again for free.
export function createConfigActivityFeed({ connection, configs, loadTransaction, limit = 100, pollEveryMs = 10_000, now = Date.now }) {
  const keys = configs.map(config => new PublicKey(config))
  const cursors = new Map()
  let polledAt = -Infinity
  return {
    // { all: true } on the first poll, on overflow and when a listed transaction cannot be read yet; otherwise the
    // market pools named by new successful transactions.
    async poll(pools) {
      if (now() - polledAt < pollEveryMs) return { all: false, pools: new Set() }
      polledAt = now()
      const watched = new Set(pools), woken = new Set(), advanced = new Map()
      let all = false
      for (const key of keys) {
        const address = key.toBase58(), cursor = cursors.get(address)
        const page = await connection.getSignaturesForAddress(key, { limit: cursor ? limit : 1, ...(cursor ? { until: cursor } : {}) }, 'finalized')
        if (!cursor || page.length >= limit) all = true
        else for (const item of page) {
          if (item.err) continue
          const tx = await loadTransaction(connection, item.signature)
          if (!tx) { all = true; continue }
          for (const account of tx.transaction.message.accountKeys) {
            const pool = account.toBase58()
            if (watched.has(pool)) woken.add(pool)
          }
        }
        if (page.length) advanced.set(address, page[0].signature)
      }
      // Cursors move only once every config was read: a failed poll is retried whole (waking twice is harmless).
      for (const [address, signature] of advanced) cursors.set(address, signature)
      return { all, pools: woken }
    },
  }
}
