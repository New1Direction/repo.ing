import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { markets } from '../src/db/schema.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createFixedConfig } from './fixed-config.mjs'

test('real Meteora DBC launch records only verified chain evidence', async () => {
  const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const connection = new Connection(rpc, 'confirmed')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch' })
  try {
    await pool.query('truncate markets, repositories restart identity cascade')
    const { config, signature: configSignature } = await createFixedConfig(connection)
    const creator = Keypair.generate()
    const payer = Keypair.generate()
    const airdrop = await connection.requestAirdrop(payer.publicKey, 5_000_000_000)
    await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    const launcher = createMeteoraLauncher({ connection, config, creator })
    const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({
      id: 1296269, name: 'Hello-World', full_name: 'octocat/Hello-World',
      owner: { login: 'octocat', avatar_url: 'https://github.com/images/error/octocat_happy.gif' },
      description: 'My first repository on GitHub!', stargazers_count: 1, forks_count: 1,
      archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
    }) })
    const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl: fakeFetch })
    const request = { repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'Hello Repo', tokenSymbol: 'HELLO',
      launcherWallet: payer.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(payer); return tx } }
    const market = await coordinator.launch(request)
    assert.equal(market.status, 'confirmed')
    assert.equal(market.githubRepoId, 1296269n)
    assert.notEqual(market.launcherWallet, market.creatorWallet)
    assert.ok(await launcher.inspect(market))
    const duplicate = await coordinator.launch(request)
    assert.equal(duplicate.id, market.id)
    assert.equal((await drizzle(pool).select().from(markets)).length, 1)
    console.log(JSON.stringify({ config: config.toBase58(), configSignature, repoId: market.githubRepoId.toString(),
      creator: market.creatorWallet, launcher: market.launcherWallet, signature: market.launchSignature,
      mint: market.mint, pool: market.pool, duplicateId: duplicate.id }))
  } finally { await pool.end() }
})
