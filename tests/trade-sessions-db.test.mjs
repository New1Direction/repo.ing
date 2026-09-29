import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { preparedFromRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { acceptSignedTrade, createTradeSessionStore, SESSION_TTL_MS } from '../src/trade-sessions.mjs'
import { createTradeCanary, tradeCanarySummary, TRADE_CANARY_FAILING } from '../src/trade-canary.mjs'

// Real SQL for trade_sessions and trade_canary_status against a throwaway local database (all committed migrations).
const url = process.env.TRADE_SESSIONS_TEST_DATABASE_URL

function curveRecord(wallet) {
  const blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10 }))
  return { tx, record: { v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: wallet.publicKey.toBase58(), marketId: 1, githubRepoId: '42',
    mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(), referral: null, wsolRent: null,
    amountIn: '10000000', minimumAmountOut: '12345', message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx),
    blockhash, lastValidBlockHeight: 350_000_000, slippageBps: 100, priorityFee: { computeUnitLimit: 100000, microLamports: 200000, lamports: '20000' } } }
}

test('real PostgreSQL: sessions persist across store instances, first signature wins, TTL cleanup; canary upsert, alerts, summary',
  { skip: !url }, async () => {
    assert.equal(new URL(url).hostname, '127.0.0.1')
    const pool = new pg.Pool({ connectionString: url })
    try {
      await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      const curve = { name: 'curve' }, engineFor = phase => phase === 'curve' ? curve : null
      const wallet = Keypair.generate(), { tx, record } = curveRecord(wallet), id = randomUUID()
      let t = Date.now()
      const now = () => t
      await createTradeSessionStore({ db: pool, engineFor, now }).create(id, { prepared: preparedFromRecord(record), wallet: record.wallet })
      const store = createTradeSessionStore({ db: pool, engineFor, now })
      const session = await store.load(id)
      assert.equal(session.engine, curve)
      assert.equal(session.prepared.minimumAmountOut, 12345n)
      assert.ok(Math.abs(session.createdAt - t) < 2)
      tx.sign(wallet)
      const accepted = acceptSignedTrade(session, tx.serialize().toString('base64'), now())
      const submitted = await store.markSubmitted(session, accepted)
      assert.equal(submitted.signature, accepted.signature)
      assert.ok(submitted.submittedAt >= session.createdAt)
      // Same signature again (a retry on another replica) is fine; a different one is refused.
      await createTradeSessionStore({ db: pool, engineFor, now }).markSubmitted(await store.load(id), accepted)
      await assert.rejects(store.markSubmitted(session, { ...accepted, signature: 'X'.repeat(88) }), /different signature/)
      await store.saveResult(submitted, { state: 'confirmed', signature: accepted.signature, tokenDelta: '7' })
      const reread = await createTradeSessionStore({ db: pool, engineFor, now }).load(id)
      assert.equal(reread.result.tokenDelta, '7')
      assert.equal(reread.prepared.record.signedMessage, accepted.signedMessage)
      const { rows: [row] } = await pool.query('select phase, direction, github_repo_id::text as repo, amount_in::text as amount, last_valid_block_height::text as lvbh from trade_sessions where id=$1', [id])
      assert.deepEqual(row, { phase: 'curve', direction: 'buy', repo: '42', amount: '10000000', lvbh: '350000000' })
      t += SESSION_TTL_MS + 1000
      assert.equal(await store.load(id), null)
      assert.equal(await createTradeSessionStore({ db: pool, engineFor, now }).cleanup(), 1)
      assert.equal((await pool.query('select count(*)::int as n from trade_sessions')).rows[0].n, 0)

      let at = new Date('2026-09-29T10:50:00Z')
      const failing = new Set(['77'])
      const canary = createTradeCanary({ db: pool, connection: null, router: null, now: () => at,
        selectMarkets: async () => [{ repoId: '1388219884', symbol: 'REPOING', expectPhase: 'graduated' }, { repoId: '77', symbol: 'CURVE', expectPhase: 'curve' }],
        probe: async m => { if (failing.has(m.repoId)) throw Error('Prepared trade simulation failed'); return { phase: m.expectPhase, unitsWithAssertion: 91000, computeUnitLimit: 120000 } } })
      assert.deepEqual((await canary.runOnce()).alerted, [])
      at = new Date(at.getTime() + 5 * 60_000)
      assert.deepEqual((await canary.runOnce()).alerted, ['77'])
      at = new Date(at.getTime() + 60 * 60_000) // a long gap restarts the streak
      const later = await canary.runOnce()
      assert.equal(later.markets.find(m => m.repoId === '77').consecutiveFailures, 1)
      const { rows: alerts } = await pool.query('select kind, detail from graduation_alerts where kind=$1', [TRADE_CANARY_FAILING])
      assert.equal(alerts.length, 1)
      assert.equal(JSON.parse(alerts[0].detail).market, '77')
      const summary = await tradeCanarySummary({ query: (sql, params) => pool.query(sql.replace("now() - interval '1 day'", `'${new Date(at.getTime() - 86_400_000).toISOString()}'::timestamptz`), params) })
      assert.equal(summary.markets.length, 2)
      const official = summary.markets.find(m => m.repoId === '1388219884')
      assert.equal(official.ok, true)
      assert.equal(official.detail.unitsWithAssertion, 91000)
      assert.equal(summary.markets.find(m => m.repoId === '77').lastError, 'Prepared trade simulation failed')
    } finally { await pool.end() }
  })
