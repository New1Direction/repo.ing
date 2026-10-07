import test from 'node:test'
import assert from 'node:assert/strict'
import { createGraduatedFees } from '../src/graduated-fees.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { EARLY_ACCESS_GRADUATION_PENDING } from '../src/early-access.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK } from '../src/early-access-hook.mjs'
import { earlyAccessMarketSQL, publicMarketSQL } from '../src/graduation-readiness.mjs'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'

// Steps 6a and 7a (docs/EARLY_ACCESS.md): which paths read an early access market's fees on its curve and after its graduation. On
// chain (the migration, the monitor, DAMM v2 fees): tests/early-access-launch-chain.test.mjs.
const config = Keypair.generate().publicKey, earlyAccess = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
const market = { githubRepoId: 7n, mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, earlyAccess).toBase58(), earlyAccessEnd: new Date(),
  transferHookProgram: HOOK.toBase58(), creatorWallet: Keypair.generate().publicKey.toBase58() }
const offline = new Connection('http://127.0.0.1:1', 'confirmed')
const state = migrated => ({ poolState: { config: earlyAccess, baseMint: mint, creator: new PublicKey(market.creatorWallet), isMigrated: migrated ? 1 : 0 } })

test('graduated reads: refused without the setting; on the curve with it; after migration only for a path that handles the graduated phase', async () => {
  // Unset, and by default (every caller that does not handle them): refused by name before any read.
  await assert.rejects(createGraduatedFees({ connection: offline, config: config.toBase58(), earlyAccess: null }).destination(market), /transfer-hook-aware path/)
  await assert.rejects(createGraduatedFees({ connection: offline, config: config.toBase58() }).destination(market), /transfer-hook-aware path/)
  // Set: before migration there are no graduated fees; after it, a path that does not handle the graduated phase is refused by name.
  const curveOnly = createGraduatedFees({ connection: offline, config: config.toBase58(), earlyAccess })
  assert.equal(await curveOnly.destination(market, state(false), { quoteMint: NATIVE_MINT }), null)
  await assert.rejects(curveOnly.destination(market, state(true), { quoteMint: NATIVE_MINT }), { message: EARLY_ACCESS_GRADUATION_PENDING })
  // One that handles it (the monitor, the fee indexer; step 7a) reads on: here the fixed config's checks are next.
  const graduated = createGraduatedFees({ connection: offline, config: config.toBase58(), earlyAccess, earlyAccessGraduated: true })
  await assert.rejects(graduated.destination(market, state(true), { quoteMint: NATIVE_MINT }), /Unsupported graduated fee configuration/)
  assert.ok(createReconciler({ pool: {}, connection: offline, config: config.toBase58(), earlyAccess, earlyAccessGraduated: true }), 'builds with the setting')
})

test('the monitor\'s market lists: SOL markets unchanged; early access markets in their own list, with their stamp', () => {
  assert.match(publicMarketSQL, /m\.early_access_end is null$/)
  assert.match(earlyAccessMarketSQL, /m\.early_access_end is not null$/)
  assert.match(earlyAccessMarketSQL, /m\.early_access_end as "earlyAccessEnd",m\.transfer_hook_program as "transferHookProgram"/)
  const columns = sql => sql.slice(sql.indexOf('select') + 6, sql.indexOf('from markets')).split(',').map(column => column.trim().split(' as ').at(-1)).slice(0, 6)
  assert.deepEqual(columns(earlyAccessMarketSQL), columns(publicMarketSQL), 'the same columns first')
})
