import test from 'node:test'
import assert from 'node:assert/strict'
import bs58 from 'bs58'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { estimatedReferralLamports, LEADERBOARD_WINDOW_MS, readReferralLeaderboard, recordReferredTrade, referredTradeRow,
  truncateWallet } from '../src/referral-leaderboard.mjs'

const referrer = Keypair.generate().publicKey.toBase58()
const wsol = owner => getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(owner)).toBase58()
const record = { phase: 'curve', direction: 'buy', githubRepoId: '42', referral: wsol(referrer), referrer, tradingFeeLamports: '1750000' }
const signature = bs58.encode(Buffer.alloc(64, 7))
const [pda] = PublicKey.findProgramAddressSync([Buffer.from('ref')], SystemProgram.programId)

test('a verified trade is recorded only when its own prepared record vouches for a paid referral', () => {
  assert.deepEqual(referredTradeRow(record, signature),
    { signature, referrer, githubRepoId: '42', phase: 'curve', direction: 'buy', tradingFeeLamports: '1750000' })
  assert.equal(referredTradeRow({ ...record, phase: 'graduated', direction: 'sell' }, signature).phase, 'graduated')
  const refused = [
    { ...record, referral: null }, // the trader could not pay a referral (no payout account): nothing was earned
    { ...record, referrer: null }, // records prepared before this release
    { ...record, tradingFeeLamports: undefined },
    { ...record, referral: wsol(Keypair.generate().publicKey) }, // the pinned referral account is not this referrer's
    { ...record, referrer: pda.toBase58() }, // not a wallet
    { ...record, tradingFeeLamports: '-1' }, { ...record, tradingFeeLamports: '1.5' }, { ...record, tradingFeeLamports: 1750000 },
    { ...record, phase: 'amm' }, { ...record, direction: 'swap' }, { ...record, githubRepoId: '0' }, { ...record, githubRepoId: 'x' }, null,
  ]
  for (const bad of refused) assert.equal(referredTradeRow(bad, signature), null, JSON.stringify(bad))
  for (const bad of [null, '', 'not-a-signature', 'O'.repeat(88)]) assert.equal(referredTradeRow(record, bad), null, String(bad))
})

test('recording is best effort: one row per signature, never an error for the trader', async () => {
  const writes = []
  const db = { query: async (sql, params) => { writes.push({ sql, params }); return { rowCount: writes.length === 1 ? 1 : 0 } } }
  assert.equal(await recordReferredTrade(db, { record }, signature), true)
  assert.equal(await recordReferredTrade(db, { record }, signature), false, 'a repeat (status poll, other replica) changes nothing')
  assert.match(writes[0].sql, /on conflict\(signature\) do nothing/)
  assert.deepEqual(writes[0].params, [signature, referrer, '42', 'curve', 'buy', '1750000'])
  assert.equal(await recordReferredTrade(db, { record: { ...record, referral: null } }, signature), false)
  assert.equal(await recordReferredTrade(null, { record }, signature), false)
  assert.equal(writes.length, 2)
  const logs = []
  const missing = { query: async () => { throw Object.assign(Error('relation "trade_referrers" does not exist'), { code: '42P01' }) } }
  assert.equal(await recordReferredTrade(missing, { record }, signature, { log: (...args) => logs.push(args) }), false)
  assert.deepEqual(logs, [['referred trade not recorded', '42P01']])
})

test('estimated earnings are 4% of the trading fee, floored per trade; wallets are only ever shown truncated', () => {
  assert.equal(estimatedReferralLamports('1750000'), 70_000n)
  assert.equal(estimatedReferralLamports('99'), 3n)
  assert.equal(estimatedReferralLamports('0'), 0n)
  assert.equal(truncateWallet(referrer), `${referrer.slice(0, 4)}…${referrer.slice(-4)}`)
  for (const bad of [null, undefined, '', 'short']) assert.equal(truncateWallet(bad), '—')
})

test('the leaderboard reads 7 days and all time, ranked by estimated earnings, and never returns a whole wallet', async () => {
  const now = Date.parse('2026-10-01T12:00:00Z'), calls = []
  const db = { query: async (sql, params) => {
    calls.push({ sql, params })
    return { rows: [{ referrer, trades: 3, estimated: '120003' }, { referrer: Keypair.generate().publicKey.toBase58(), trades: 1, estimated: '7' }] }
  } }
  const board = await readReferralLeaderboard(db, { now })
  assert.deepEqual(calls.map(call => call.params), [[new Date(now - LEADERBOARD_WINDOW_MS), 4, 10], [null, 4, 10]])
  assert.match(calls[0].sql, /order by sum\(div\(trading_fee_lamports \* \$2, 100\)\) desc, count\(\*\) desc, referrer limit \$3/)
  assert.deepEqual(board.week[0], { wallet: truncateWallet(referrer), trades: 3, estimatedLamports: '120003' })
  assert.equal(board.allTime.length, 2)
  assert.doesNotMatch(JSON.stringify(board), new RegExp(referrer))
})
