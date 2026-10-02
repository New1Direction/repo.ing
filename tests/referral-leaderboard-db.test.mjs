import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { readReferralLeaderboard, recordReferredTrade, truncateWallet } from '../src/referral-leaderboard.mjs'

// Real SQL for trade_referrers (migration 0043) against a throwaway local database (all committed migrations).
const url = process.env.REFERRALS_TEST_DATABASE_URL
const DAY = 24 * 60 * 60 * 1000

test('real PostgreSQL: referred trades record once and rank by estimated earnings over 7 days and all time', { skip: !url }, async () => {
  assert.equal(new URL(url).hostname, '127.0.0.1')
  const pool = new pg.Pool({ connectionString: url })
  try {
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    await pool.query('delete from trade_referrers')
    const now = Date.now()
    const [a, b, c] = [0, 1, 2].map(() => Keypair.generate().publicKey.toBase58())
    let n = 0
    // Records a verified referred trade through the real insert, then dates it.
    async function trade(referrer, fee, ageMs = 0, phase = 'curve') {
      const signature = bs58.encode(Buffer.alloc(64, ++n))
      const record = { phase, direction: n % 2 ? 'buy' : 'sell', githubRepoId: '42', referrer, tradingFeeLamports: String(fee),
        referral: getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(referrer)).toBase58() }
      assert.equal(await recordReferredTrade(pool, { record }, signature), true)
      assert.equal(await recordReferredTrade(pool, { record }, signature), false, 'the same signature again is a no-op')
      await pool.query('update trade_referrers set settled_at = $2 where signature = $1', [signature, new Date(now - ageMs)])
    }
    await trade(a, 1_000_000); await trade(a, 2_000_000, DAY); await trade(a, 99, 6 * DAY, 'graduated') // 40_000 + 80_000 + 3
    await trade(b, 10_000_000, 2 * DAY) // 400_000 this week
    for (let i = 0; i < 5; i++) await trade(b, 1_000_000, 30 * DAY) // 5 × 40_000, older than a week
    await trade(c, 50_000_000, 10 * DAY); await trade(c, 50_000_000, 400 * DAY) // 2 × 2_000_000, all time only
    const board = await readReferralLeaderboard(pool, { now })
    assert.deepEqual(board.week, [{ wallet: truncateWallet(b), trades: 1, estimatedLamports: '400000' },
      { wallet: truncateWallet(a), trades: 3, estimatedLamports: '120003' }])
    assert.deepEqual(board.allTime, [{ wallet: truncateWallet(c), trades: 2, estimatedLamports: '4000000' },
      { wallet: truncateWallet(b), trades: 6, estimatedLamports: '600000' }, { wallet: truncateWallet(a), trades: 3, estimatedLamports: '120003' }])
    assert.deepEqual((await readReferralLeaderboard(pool, { now, limit: 1 })).allTime.map(row => row.trades), [2])
    // Equal estimates rank the referrer with more trades first.
    await pool.query('delete from trade_referrers')
    await trade(a, 2_000_000); await trade(b, 1_000_000); await trade(b, 1_000_000)
    assert.deepEqual((await readReferralLeaderboard(pool, { now })).week.map(row => [row.wallet, row.trades]),
      [[truncateWallet(b), 2], [truncateWallet(a), 1]])
    await assert.rejects(pool.query(`insert into trade_referrers(signature, referrer, github_repo_id, phase, direction, trading_fee_lamports)
      values('x', $1, 1, 'curve', 'buy', -1)`, [a]), /check constraint/)
    await assert.rejects(pool.query(`insert into trade_referrers(signature, referrer, github_repo_id, phase, direction, trading_fee_lamports)
      values('y', $1, 1, 'amm', 'buy', 1)`, [a]), /check constraint/)
  } finally {
    await pool.query('delete from trade_referrers').catch(() => {})
    await pool.end()
  }
})
