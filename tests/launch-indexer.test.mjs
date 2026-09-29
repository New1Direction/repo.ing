import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { markets } from '../src/db/schema.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'

test('finalized launch indexes, survives process restart, and reconciles contradictions', async () => {
  const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch'
  const connection = new Connection(rpc, 'confirmed')
  const pool = new pg.Pool({ connectionString: databaseUrl })
  try {
    await pool.query('truncate markets, repositories restart identity cascade')
    const { config, signature: configSignature } = await createFixedConfig(connection)
    const creator = Keypair.generate()
    const payer = Keypair.generate()
    const airdrop = await connection.requestAirdrop(payer.publicKey, 5_000_000_000)
    await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    const launcher = createMeteoraLauncher({ connection, config, creator })
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
      id: 1296269, name: 'Hello-World', full_name: 'octocat/Hello-World',
      owner: { login: 'octocat' }, description: null, stargazers_count: 1, forks_count: 1,
      archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
    }) })
    const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl })
    const market = await coordinator.launch({ repositoryUrl: 'https://github.com/octocat/Hello-World',
      tokenName: 'Indexed Repo', tokenSymbol: 'INDEX', launcherWallet: payer.publicKey.toBase58(),
      signTransaction: async tx => { tx.partialSign(payer); return tx },
    })
    assert.equal(market.status, 'confirmed')
    const verifier = createLaunchEvidenceVerifier({ connection, config })
    const indexer = createLaunchIndexer({ pool, verify: verifier })
    let finalityResult
    for (let i = 0; i < 120; i++) {
      finalityResult = await verifier(market)
      if (finalityResult.state === 'match') break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.equal(finalityResult.state, 'match', `launch must reach finalized commitment: ${finalityResult.state} ${finalityResult.reason ?? ''}`)
    const workerEnv = { ...process.env, DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc, DBC_CONFIG: config.toBase58() }
    const runWorker = () => JSON.parse(execFileSync(process.execPath, ['scripts/index-launches.mjs'],
      { cwd: process.cwd(), env: workerEnv, encoding: 'utf8' }))
    assert.equal(runWorker()[0].state, 'indexed')
    const first = (await drizzle(pool).select().from(markets))[0]
    assert.equal(first.status, 'confirmed')
    assert.equal(first.launchFinality, 'finalized')
    assert.ok(first.launchSlot > 0n)
    assert.ok(first.indexedAt && first.lastVerifiedAt)
    assert.equal((await indexer.reconcileMarket(first)).state, 'match')
    assert.equal(runWorker()[0].state, 'verified')
    const restarted = (await drizzle(pool).select().from(markets))[0]
    assert.equal(restarted.id, first.id)
    assert.equal(restarted.mint, first.mint)
    assert.equal(restarted.pool, first.pool)
    assert.equal(restarted.launchSignature, first.launchSignature)
    assert.equal(restarted.launchSlot, first.launchSlot)
    assert.equal(restarted.indexedAt.getTime(), first.indexedAt.getTime())
    assert.equal((await drizzle(pool).select().from(markets)).length, 1)
    assert.equal((await indexer.reconcileMarket(restarted)).state, 'match')

    const wrongMint = Keypair.generate().publicKey.toBase58()
    assert.equal((await indexer.reconcileMarket({ ...restarted, mint: wrongMint })).state, 'mismatch')
    assert.equal((await indexer.reconcileMarket({ ...restarted, pool: Keypair.generate().publicKey.toBase58() })).state, 'mismatch')
    assert.equal((await indexer.reconcileMarket({ ...restarted, launchSignature: 'bad' })).state, 'invalid')
    assert.equal((await indexer.reconcileMarket({ ...restarted, launchSignature: configSignature })).state, 'mismatch')
    assert.equal((await indexer.reconcileMarket({ ...restarted, launchSignature: null })).state, 'incomplete')
    assert.equal((await indexer.reconcileMarket({ ...restarted, launchSlot: restarted.launchSlot + 1n })).state, 'mismatch')

    const db = drizzle(pool)
    // Simulate out-of-band row corruption. The protect_indexed_discoverer trigger (0017) rightly
    // forbids rewriting an indexed launch, so bypass triggers for these fixture writes only.
    const tamper = async values => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('set local session_replication_role = replica')
        await drizzle(client).update(markets).set(values).where(eq(markets.id, first.id))
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }
    await tamper({ mint: wrongMint })
    assert.equal((await indexer.runOnce())[0].state, 'mismatch')
    assert.equal((await db.select().from(markets))[0].mint, wrongMint)
    await tamper({ mint: first.mint, pool: Keypair.generate().publicKey.toBase58() })
    assert.equal((await indexer.runOnce())[0].state, 'mismatch')
    await tamper({ pool: first.pool, launchSignature: 'bad' })
    assert.equal((await indexer.runOnce())[0].state, 'invalid')
    assert.equal((await db.select().from(markets))[0].launchSignature, 'bad')
    await tamper({ launchSignature: first.launchSignature })
    await tamper({ status: 'ambiguous', launchSignature: null, launchSlot: null,
      launchFinality: null, indexedAt: null, lastVerifiedAt: null })
    assert.equal((await indexer.runOnce())[0].state, 'incomplete')
    assert.equal((await db.select().from(markets))[0].status, 'ambiguous')
    await tamper({ launchSignature: first.launchSignature })
    assert.equal((await indexer.runOnce())[0].state, 'recovered')
    const recovered = (await db.select().from(markets))[0]
    assert.equal(recovered.status, 'confirmed')
    assert.equal(recovered.launchSlot, first.launchSlot)
    assert.equal((await indexer.reconcileMarket(recovered)).state, 'match')
    assert.equal((await db.select().from(markets)).length, 1)
    console.log(JSON.stringify({ signature: first.launchSignature, mint: first.mint, pool: first.pool,
      config: config.toBase58(), slot: first.launchSlot.toString(), firstWorker: 'indexed',
      restartedWorker: 'verified', incomplete: 'not promoted', ambiguous: 'recovered', reconcile: 'match' }))
  } finally { await pool.end() }
})
