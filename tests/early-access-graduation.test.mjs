import test from 'node:test'
import assert from 'node:assert/strict'
import { createGraduatedFees } from '../src/graduated-fees.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { EARLY_ACCESS_GRADUATION_PENDING, EARLY_ACCESS_NO_P3, EARLY_ACCESS_NO_REINVEST } from '../src/early-access.mjs'
import { createLiquidityDeployment } from '../src/liquidity-deployment.mjs'
import { createBuilderReinvest } from '../src/builder-reinvest.mjs'
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

// Owner decision (step 7): liquidity deployment and builder reinvest refuse an early access market by name, from its own stamp, before
// any chain read (not only because their config resolver has no approved config for it).
test('liquidity deployment and builder reinvest refuse an early access market by name', async () => {
  const asked = []
  const row = { githubRepoId: '7', mint: market.mint, pool: market.pool, creatorWallet: market.creatorWallet, earlyAccessEnd: market.earlyAccessEnd,
    transferHookProgram: market.transferHookProgram }
  const wallet = Keypair.generate().publicKey.toBase58()
  const answer = sql => {
    asked.push(sql.replace(/\s+/g, ' ').trim())
    if (/pg_advisory|platform_revenue_allocations/.test(sql)) return { rows: [] }
    if (/from repo_beneficiaries/.test(sql)) return { rows: [{ wallet, bound_at: new Date() }] }
    if (/from markets/.test(sql)) {
      assert.match(sql, /early_access_end as "earlyAccessEnd",transfer_hook_program as "transferHookProgram"/)
      return { rows: [row] }
    }
    throw Error(`unexpected query: ${sql}`)
  }
  const db = { query: async sql => answer(sql), release: () => {} }
  const liquidity = createLiquidityDeployment({ pool: db, connection: offline, config: config.toBase58(), partner: Keypair.generate() })
  assert.deepEqual(await liquidity.qualification(db, '7', {}), { eligible: false, reason: EARLY_ACCESS_NO_P3 })
  const local = port => ({ rpcEndpoint: `http://127.0.0.1:${port}`, getGenesisHash: async () => 'local' })
  const reinvest = createBuilderReinvest({ pool: { connect: async () => db }, connection: local(1), verification: local(2), config: config.toBase58(),
    githubVerifier: { verifyCurrentAuthority: async ({ githubRepoId }) => ({ verified: true, permission: 'admin', githubRepoId, githubUserId: '9', verifiedAt: new Date() }) },
    env: { BUILDER_REINVEST_ENABLED: 'true', BUILDER_REINVEST_LOCAL_REHEARSAL: 'true', NODE_ENV: 'test' } })
  await assert.rejects(reinvest.status({ repoId: '7', wallet, githubUserId: '9', claimSignature: '1' }), { message: EARLY_ACCESS_NO_REINVEST })
  assert.equal(asked.filter(sql => /from markets/.test(sql)).length, 2)
})
