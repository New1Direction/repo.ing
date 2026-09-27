import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'

test('external swaps are indexed once across worker restarts and cursor replay', async () => {
  const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_external_fees'
  const connection = new Connection(rpc, 'confirmed')
  const pool = new pg.Pool({ connectionString: databaseUrl })
  const repoId = 1296269n
  async function waitForFinalized(signature) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      if (tx) return tx
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`Transaction ${signature} did not finalize`)
  }

  try {
    await pool.query('truncate pool_fee_cursors, fee_events, markets, repositories restart identity cascade')
    const { config } = await createFixedConfig(connection)
    const creator = Keypair.generate()
    const launcher = Keypair.generate()
    const traderA = Keypair.generate()
    const traderB = Keypair.generate()
    for (const wallet of [launcher, traderA, traderB]) {
      const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    }
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
      id: Number(repoId), name: 'Hello-World', full_name: 'octocat/Hello-World',
      owner: { login: 'octocat' }, description: null, stargazers_count: 1, forks_count: 1,
      archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
    }) })
    const market = await createLaunchCoordinator({ pool,
      launcher: createMeteoraLauncher({ connection, config, creator }), fetchImpl }).launch({
      repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'External Fee Repo',
      tokenSymbol: 'EXT', launcherWallet: launcher.publicKey.toBase58(),
      signTransaction: async tx => { tx.partialSign(launcher); return tx },
    })
    await waitForFinalized(market.launchSignature)
    const verify = createLaunchEvidenceVerifier({ connection, config })
    assert.equal((await createLaunchIndexer({ pool, verify }).runOnce())[0].state, 'indexed')

    const trader = createCanonicalTrader({ pool, connection, config })
    const buy = async (wallet, amountLamports) => {
      const prepared = await trader.prepareBuy({ githubRepoId: repoId,
        wallet: wallet.publicKey.toBase58(), amountLamports })
      return trader.submitTrade(prepared, async tx => { tx.partialSign(wallet); return tx })
    }
    const firstBuy = await buy(traderA, 10_000_000n)
    const secondBuy = await buy(traderB, 15_000_000n)
    await Promise.all([firstBuy.signature, secondBuy.signature].map(waitForFinalized))
    assert.equal((await pool.query('select count(*)::int as count from fee_events')).rows[0].count, 0)

    const worker = createExternalFeeIndexer({ pool, connection, config })
    const first = (await worker.runOnce())[0]
    assert.equal(first.status, 'OK')
    assert.equal(first.discovered, 2)
    assert.equal(first.eventKeys.length, 2)
    assert.ok(first.creditedBaseUnits > 0n)
    assert.equal(first.cursorAfter.signature, secondBuy.signature)
    const observedFirst = BigInt((await new DynamicBondingCurveClient(connection, 'finalized')
      .state.getPool(market.pool)).poolState.creatorQuoteFee.toString())
    assert.equal(first.creditedBaseUnits, observedFirst)

    const workerEnv = { ...process.env, DATABASE_URL: databaseUrl, SOLANA_RPC_URL: rpc,
      DBC_CONFIG: config.toBase58() }
    const runNewProcess = () => JSON.parse(execFileSync(process.execPath,
      ['scripts/index-external-fees.mjs', '--once'], { cwd: process.cwd(), env: workerEnv, encoding: 'utf8' }))[0]
    const restart = runNewProcess()
    assert.equal(restart.status, 'OK')
    assert.equal(restart.discovered, 0)
    assert.equal(restart.creditedBaseUnits, '0')

    await pool.query('delete from pool_fee_cursors where pool = $1', [market.pool])
    const replay = (await worker.runOnce())[0]
    assert.equal(replay.status, 'OK')
    assert.equal(replay.discovered, 2)
    assert.equal(replay.creditedBaseUnits, 0n)
    assert.equal(replay.cursorAfter.signature, secondBuy.signature)

    const preparedSell = await trader.prepareSell({ githubRepoId: repoId,
      wallet: traderA.publicKey.toBase58(), amountBaseUnits: firstBuy.tokenDelta / 2n })
    const sell = await trader.submitTrade(preparedSell, async tx => { tx.partialSign(traderA); return tx })
    await waitForFinalized(sell.signature)
    const later = runNewProcess()
    assert.equal(later.status, 'OK')
    assert.equal(later.discovered, 1)
    assert.equal(later.cursorAfter.signature, sell.signature)
    assert.ok(BigInt(later.creditedBaseUnits) > 0n)
    const ledger = await pool.query('select signature, amount_base_units::text as amount from fee_events order by slot')
    assert.equal(ledger.rows.length, 3)
    assert.deepEqual(new Set(ledger.rows.map(row => row.signature)),
      new Set([firstBuy.signature, secondBuy.signature, sell.signature]))
    const total = ledger.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n)
    const observedTotal = BigInt((await new DynamicBondingCurveClient(connection, 'finalized')
      .state.getPool(market.pool)).poolState.creatorQuoteFee.toString())
    assert.equal(total, observedTotal)
    assert.equal(runNewProcess().discovered, 0)
    await pool.query('update pool_fee_cursors set last_signature = $1 where pool = $2',
      ['not-in-finalized-history', market.pool])
    const missingHistory = (await worker.runOnce())[0]
    assert.equal(missingHistory.status, 'ERROR')
    assert.match(missingHistory.error, /history does not contain cursor/)
    assert.equal((await pool.query('select count(*)::int as count from fee_events')).rows[0].count, 3)
    await pool.query('update pool_fee_cursors set last_signature = $1 where pool = $2',
      [sell.signature, market.pool])
    console.log(JSON.stringify({ repoId: repoId.toString(), config: config.toBase58(),
      mint: market.mint, pool: market.pool, signatures: [firstBuy.signature, secondBuy.signature, sell.signature],
      earnedLamports: total.toString(), cursor: sell.signature }))
  } finally { await pool.end() }
})
