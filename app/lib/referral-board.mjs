import { readReferralLeaderboard } from '../../src/referral-leaderboard.mjs'
import { database } from './server.mjs'
import { ttlMemo } from './ttl-memo.mjs'

// Public and read-only: one leaderboard read per minute per web process serves every /referrals view. Failures are not
// kept, so the next view retries.
export const REFERRAL_BOARD_TTL_MS = 60_000

export const referralLeaderboard = ttlMemo(async () => {
  const pool = database()
  if (!pool) return { board: null, unavailable: 'The leaderboard is unavailable right now.' }
  try { return { board: await readReferralLeaderboard(pool), unavailable: null } }
  catch (error) {
    console.error('referral leaderboard failed', { error: error.message })
    return { board: null, unavailable: 'The leaderboard is temporarily unavailable. Please try again shortly.' }
  }
}, REFERRAL_BOARD_TTL_MS, { keep: result => !result.unavailable })
