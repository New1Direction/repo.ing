import test from 'node:test'
import assert from 'node:assert/strict'
import { createEarlyAccessReconcileWatch, EARLY_ACCESS_RECONCILE_FAILED } from '../src/early-access-reconcile.mjs'
import { createGraduatedFees } from '../src/graduated-fees.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { EARLY_ACCESS_GRADUATION_PENDING } from '../src/early-access.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK } from '../src/early-access-hook.mjs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'

// Step 6a (docs/EARLY_ACCESS.md): early access markets' builder fee ledgers are reconciled on their curve, and a worker pass records
// the monitor's operator alerts for them until their graduation ships. On chain: tests/early-access-launch-chain.test.mjs.
const HOLD = 15 * 60_000

// A scripted database: the early access markets, and graduation_alerts rows as the watch writes and clears them.
function database(markets) {
  const alerts = [], cleared = []
  return { alerts, cleared, query: async (sql, params) => {
    if (/from markets m join repositories/.test(sql)) return { rows: markets }
    if (/insert into graduation_alerts/.test(sql)) {
      if (alerts.some(alert => alert.key === params[0])) return { rows: [] }
      alerts.push({ key: params[0], repoId: params[1], kind: params[2], detail: JSON.parse(params[3]) })
      return { rows: [{ id: alerts.length }] }
    }
    if (/alert-queue:clear/.test(sql)) { cleared.push(params.slice(0, 2)); return { rows: [] } }
    throw Error(`unexpected query ${sql}`)
  } }
}

test('the watch: a difference that lasts its hold is recorded once as the monitor records it; a match clears it', async () => {
  const markets = [{ githubRepoId: '700002', mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(), fullName: 'octo/second' }]
  const db = database(markets)
  let at = Date.parse('2026-10-07T12:00:00Z'), result = { status: 'MISMATCH', difference: -5n, reason: undefined }
  const logged = []
  const watch = createEarlyAccessReconcileWatch({ pool: db, reconciler: { reconcile: async () => result }, now: () => at, log: entry => logged.push(entry) })
  assert.deepEqual((await watch.runOnce()).markets, [{ repoId: '700002', status: 'MISMATCH', difference: '-5', alert: null }], 'within the hold')
  at += HOLD
  const due = await watch.runOnce()
  assert.equal(due.markets[0].alert, 1)
  assert.equal(db.alerts.length, 1)
  assert.match(db.alerts[0].key, /^700002:RECONCILIATION_MISMATCH:fees:/)
  assert.deepEqual([db.alerts[0].kind, db.alerts[0].detail.ledger, db.alerts[0].detail.status, db.alerts[0].detail.difference, db.alerts[0].detail.fullName],
    ['RECONCILIATION_MISMATCH', 'fees', 'MISMATCH', '-5', 'octo/second'])
  at += 60_000
  assert.equal((await watch.runOnce()).markets[0].alert, null, 'recorded once')
  result = { status: 'MATCH', difference: 0n }
  assert.deepEqual((await watch.runOnce()).markets, [{ repoId: '700002', status: 'MATCH', difference: '0', alert: null }])
  assert.deepEqual(db.cleared, [['700002', 'fees']])
  assert.equal(logged.length, 3, 'only what does not match is logged')
})

test('a reconciliation that throws is unchecked with a fixed code; a failed read\'s message never reaches the log', async () => {
  const markets = [{ githubRepoId: '700001', mint: 'm', pool: 'p', fullName: 'octo/first' }]
  const logged = []
  const throwing = createEarlyAccessReconcileWatch({ pool: database(markets), reconciler: { reconcile: async () => { throw Error('https://rpc.example/?api-key=SECRET') } },
    log: entry => logged.push(entry) })
  assert.deepEqual((await throwing.runOnce()).markets, [{ repoId: '700001', status: 'UNAVAILABLE', reason: EARLY_ACCESS_RECONCILE_FAILED, alert: null }])
  const failedRead = createEarlyAccessReconcileWatch({ pool: database(markets), reconciler: { reconcile: async () => ({ status: 'UNAVAILABLE',
    reason: 'Meteora pool read failed: https://rpc.example/?api-key=SECRET' }) }, log: entry => logged.push(entry) })
  await failedRead.runOnce()
  assert.ok(!JSON.stringify(logged).includes('SECRET'))
  assert.equal(logged[1].reason, 'Meteora pool read failed')
  assert.deepEqual(await createEarlyAccessReconcileWatch({ pool: database([]), reconciler: {} }).runOnce(), { status: 'IDLE', markets: [] })
})

test('reconcile and graduated reads take an early access curve only with the setting; a graduated one waits for step 7', async () => {
  const config = Keypair.generate().publicKey, earlyAccess = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  const market = { githubRepoId: 7n, mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, earlyAccess).toBase58(), earlyAccessEnd: new Date(),
    transferHookProgram: HOOK.toBase58(), creatorWallet: Keypair.generate().publicKey.toBase58() }
  const offline = new Connection('http://127.0.0.1:1', 'confirmed')
  // Unset: the resolver refuses it by name before any read.
  await assert.rejects(createGraduatedFees({ connection: offline, config: config.toBase58(), earlyAccess: null }).destination(market), /transfer-hook-aware path/)
  // Set: its curve state decides. Not migrated: no graduated fees; migrated: refused by name.
  const state = migrated => ({ poolState: { config: earlyAccess, baseMint: mint, creator: new PublicKey(market.creatorWallet), isMigrated: migrated ? 1 : 0 } })
  const fees = createGraduatedFees({ connection: offline, config: config.toBase58(), earlyAccess })
  assert.equal(await fees.destination(market, state(false), { quoteMint: NATIVE_MINT }), null)
  await assert.rejects(fees.destination(market, state(true), { quoteMint: NATIVE_MINT }), { message: EARLY_ACCESS_GRADUATION_PENDING })
  assert.ok(createReconciler({ pool: {}, connection: offline, config: config.toBase58(), earlyAccess }), 'builds with the setting')
})
