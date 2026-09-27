import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { feeEvents } from '../src/db/schema.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { NATIVE_MINT } from '@solana/spl-token'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch'
const connection = new Connection(rpc, 'confirmed')
const pool = new pg.Pool({ connectionString: databaseUrl })
const repoId = 1296269n
let config, market, signatures, accrual, recorded, observed

test.before(async () => {
  await pool.query('truncate fee_events, markets, repositories restart identity cascade')
  ;({ config } = await createFixedConfig(connection))
  const creator = Keypair.generate()
  const launcherWallet = Keypair.generate()
  const walletA = Keypair.generate()
  const walletB = Keypair.generate()
  for (const wallet of [launcherWallet, walletA, walletB]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    id: Number(repoId), name: 'Hello-World', full_name: 'octocat/Hello-World',
    owner: { login: 'octocat' }, description: null, stargazers_count: 1, forks_count: 1,
    archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
  }) })
  market = await createLaunchCoordinator({ pool, launcher: createMeteoraLauncher({ connection, config, creator }), fetchImpl }).launch({
    repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'Fee Repo', tokenSymbol: 'FEE',
    launcherWallet: launcherWallet.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(launcherWallet); return tx },
  })
  const verifyLaunch = createLaunchEvidenceVerifier({ connection, config })
  let finality
  for (let i = 0; i < 120; i++) {
    finality = await verifyLaunch(market)
    if (finality.state === 'match') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(finality.state, 'match', `Launch not finalized: ${finality.reason ?? finality.state}`)
  assert.equal((await createLaunchIndexer({ pool, verify: verifyLaunch }).runOnce())[0].state, 'indexed')
  const trader = createCanonicalTrader({ pool, connection, config })
  const buy = async (wallet, amountLamports) => {
    const prepared = await trader.prepareBuy({ githubRepoId: repoId, wallet: wallet.publicKey.toBase58(), amountLamports })
    return trader.submitTrade(prepared, async tx => { tx.partialSign(wallet); return tx })
  }
  const aBuy = await buy(walletA, 10_000_000n)
  const bBuy = await buy(walletB, 15_000_000n)
  const sell = await trader.prepareSell({ githubRepoId: repoId, wallet: walletA.publicKey.toBase58(),
    amountBaseUnits: aBuy.tokenDelta / 2n })
  const aSell = await trader.submitTrade(sell, async tx => { tx.partialSign(walletA); return tx })
  signatures = [aBuy.signature, bBuy.signature, aSell.signature]
  for (let i = 0; i < 120; i++) {
    const results = await Promise.all(signatures.map(signature => connection.getTransaction(signature,
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 })))
    if (results.every(Boolean)) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok((await Promise.all(signatures.map(signature => connection.getTransaction(signature,
    { commitment: 'finalized', maxSupportedTransactionVersion: 0 })))).every(Boolean))
  const state = await new DynamicBondingCurveClient(connection, 'finalized').state.getPool(market.pool)
  observed = BigInt(state.poolState.creatorQuoteFee.toString())
  assert.ok(observed > 0n)
  accrual = createFeeAccrual({ pool, connection, config })
})
test.after(async () => { await pool.end() })

test('verified Meteora trades create creator-fee attribution', async () => {
  recorded = await accrual.recordTradeFees({ githubRepoId: repoId, signatures })
  assert.ok(recorded.creditedBaseUnits > 0n)
  assert.equal(recorded.earnedBaseUnits, observed)
  assert.equal(recorded.observedCreatorFee, observed)
})

test('fee events belong to the canonical GitHub repository ID', async () => {
  const rows = await drizzle(pool).select().from(feeEvents)
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.githubRepoId === repoId && row.mint === market.mint && row.pool === market.pool &&
    row.asset === NATIVE_MINT.toBase58() && row.kind === 'dbc_creator_quote' && row.amountBaseUnits > 0n))
  assert.equal(rows.reduce((sum, row) => sum + row.amountBaseUnits, 0n), observed)
  console.log(JSON.stringify({ repoId: repoId.toString(), mint: market.mint, pool: market.pool,
    signatures, eventKeys: recorded.eventKeys, events: rows.map(row => ({ eventIndex: row.eventIndex,
      signature: row.signature, amountLamports: row.amountBaseUnits.toString(), slot: row.slot.toString() })),
    observedCreatorLamports: observed.toString(), earnedLamports: recorded.earnedBaseUnits.toString() }))
})

test('the same finalized fee evidence does not credit twice', async () => {
  const duplicate = await accrual.recordTradeFees({ githubRepoId: repoId, signatures })
  assert.equal(duplicate.creditedBaseUnits, 0n)
  assert.equal(duplicate.earnedBaseUnits, observed)
  assert.equal((await drizzle(pool).select().from(feeEvents)).length, 3)
})

test('a new process derives the same repository earnings from the ledger', async () => {
  const output = execFileSync(process.execPath, ['scripts/read-repo-earnings.mjs', repoId.toString()],
    { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' })
  const reread = JSON.parse(output)
  assert.equal(reread.githubRepoId, repoId.toString())
  assert.equal(reread.earnedLamports, observed.toString())
  assert.equal(await accrual.getRepositoryEarnings(repoId), observed)
})
