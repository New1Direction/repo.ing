import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { markets, repositories } from '../src/db/schema.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const connection = new Connection(rpc, 'confirmed')
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch' })
const repoId = 1296269n
let config, market, trader, wallet, buyResult, buyPrepared

test.before(async () => {
  await pool.query('truncate markets, repositories restart identity cascade')
  ;({ config } = await createFixedConfig(connection))
  const creator = Keypair.generate()
  const launcherWallet = Keypair.generate()
  wallet = Keypair.generate()
  for (const key of [launcherWallet, wallet]) {
    const signature = await connection.requestAirdrop(key.publicKey, 2_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const launcher = createMeteoraLauncher({ connection, config, creator })
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    id: Number(repoId), name: 'Hello-World', full_name: 'octocat/Hello-World',
    owner: { login: 'octocat' }, description: null, stargazers_count: 1, forks_count: 1,
    archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
  }) })
  market = await createLaunchCoordinator({ pool, launcher, fetchImpl }).launch({
    repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'Trade Repo', tokenSymbol: 'TRADE',
    launcherWallet: launcherWallet.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(launcherWallet); return tx },
  })
  const verifier = createLaunchEvidenceVerifier({ connection, config })
  let result
  for (let i = 0; i < 120; i++) {
    result = await verifier(market)
    if (result.state === 'match') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(result.state, 'match', `Launch not finalized: ${result.reason ?? result.state}`)
  assert.equal((await createLaunchIndexer({ pool, verify: verifier }).runOnce())[0].state, 'indexed')
  trader = createCanonicalTrader({ pool, connection, config })
})
test.after(async () => { await pool.end() })

test('buy succeeds against the indexed canonical pool', async () => {
  const quote = await trader.quoteBuy({ githubRepoId: repoId, amountLamports: 10_000_000n })
  assert.ok(BigInt(quote.outputAmount) >= BigInt(quote.minimumAmountOut))
  assert.ok(BigInt(quote.minimumAmountOut) > 0n)
  const prepared = await trader.prepareBuy({ githubRepoId: repoId, wallet: wallet.publicKey.toBase58(), amountLamports: 10_000_000n })
  buyPrepared = prepared
  assert.equal(prepared.pool, market.pool)
  assert.ok(prepared.minimumAmountOut > 0n)
  buyResult = await trader.submitTrade(prepared, async tx => { tx.partialSign(wallet); return tx })
  assert.ok(buyResult.tokenDelta > 0n)
  assert.ok(buyResult.solDelta <= -10_000_000n)
  assert.equal(buyResult.pool, market.pool)
})

test('sell succeeds against the same canonical pool', async () => {
  const input = buyResult.tokenDelta / 2n
  assert.ok(input > 0n)
  const quote = await trader.quoteSell({ githubRepoId: repoId, amountBaseUnits: input })
  assert.ok(BigInt(quote.outputAmount) >= BigInt(quote.minimumAmountOut))
  assert.ok(BigInt(quote.minimumAmountOut) > 0n)
  const prepared = await trader.prepareSell({ githubRepoId: repoId, wallet: wallet.publicKey.toBase58(), amountBaseUnits: input })
  assert.equal(prepared.pool, market.pool)
  const result = await trader.submitTrade(prepared, async tx => { tx.partialSign(wallet); return tx })
  assert.equal(result.tokenDelta, -input)
  assert.ok(result.solDelta > 0n)
  assert.equal(result.pool, market.pool)
  assert.equal((await trader.verifyTrade(buyPrepared, buyResult.signature)).tokenDelta, buyResult.tokenDelta)
  console.log(JSON.stringify({ repoId: repoId.toString(), config: config.toBase58(), mint: market.mint, pool: market.pool,
    wallet: wallet.publicKey.toBase58(), buy: { signature: buyResult.signature, inputLamports: '10000000',
      tokenOut: buyResult.tokenDelta.toString(), walletSolDelta: buyResult.solDelta.toString(), slot: buyResult.slot.toString() },
    sell: { signature: result.signature, inputBaseUnits: input.toString(), solDelta: result.solDelta.toString(),
      walletTokenDelta: result.tokenDelta.toString(), slot: result.slot.toString() }, slippageBps: 100 }))
})

test('nonexistent or unconfirmed repository market cannot trade', async () => {
  const request = { wallet: wallet.publicKey.toBase58(), amountLamports: 1_000_000n }
  await assert.rejects(() => trader.prepareBuy({ ...request, githubRepoId: 999n }), /no indexed canonical market/)
  await assert.rejects(() => trader.quoteBuy({ githubRepoId: 999n, amountLamports: 1_000_000n }), /no indexed canonical market/)
  const db = drizzle(pool)
  await db.insert(repositories).values({ githubRepoId: 998n, owner: 'none', name: 'none', fullName: 'none/none',
    description: null, avatarUrl: null, stars: 0, forks: 0, archived: false, githubUpdatedAt: new Date() })
  await db.insert(markets).values({ githubRepoId: 998n, status: 'reserved', launcherWallet: wallet.publicKey.toBase58(),
    creatorWallet: Keypair.generate().publicKey.toBase58(), tokenName: 'None', tokenSymbol: 'NONE' })
  await assert.rejects(() => trader.prepareBuy({ ...request, githubRepoId: 998n }), /no indexed canonical market/)
})

test('caller cannot substitute a different pool or mint', async () => {
  const base = { githubRepoId: repoId, wallet: wallet.publicKey.toBase58(), amountLamports: 1_000_000n }
  await assert.rejects(() => trader.prepareBuy({ ...base, pool: Keypair.generate().publicKey.toBase58() }), /Pool and mint/)
  await assert.rejects(() => trader.prepareBuy({ ...base, mint: Keypair.generate().publicKey.toBase58() }), /Pool and mint/)
  await assert.rejects(() => trader.quoteBuy({ ...base, pool: Keypair.generate().publicKey.toBase58() }), /Pool and mint/)
})
