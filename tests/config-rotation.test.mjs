import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { Connection, Keypair } from '@solana/web3.js'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { createClaim } from '../src/claim.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { readBondingStatus } from '../app/lib/bonding-status.mjs'

test('rotated config trades, indexes, resumes, pays, and reconciles both old and new markets', async () => {
  const rpc = process.env.SOLANA_RPC_URL
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
  assert.match(process.env.DATABASE_URL, /@(?:127\.0\.0\.1|localhost):\d+\//)
  const connection = new Connection(rpc, 'confirmed')
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  const oldEnvironment = process.env.DBC_LEGACY_CONFIGS
  try {
    await pool.query('truncate repositories restart identity cascade')
    const legacy = (await createFixedConfig(connection, 'legacy')).config
    const config = (await createFixedConfig(connection, 'balanced')).config
    process.env.DBC_LEGACY_CONFIGS = legacy.toBase58()
    const creator = Keypair.generate(), wallet = Keypair.generate(), receiver = Keypair.generate()
    for (const signer of [creator, wallet]) {
      const signature = await connection.requestAirdrop(signer.publicKey, 5_000_000_000)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
    }
    const finalize = async signature => {
      for (let i = 0; i < 160; i++) {
        if (await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })) return
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      throw Error('Local transaction did not finalize')
    }
    const launched = []
    for (const [i, key] of [legacy, config].entries()) {
      const repoId = String(9900100 + i)
      const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: Number(repoId),
        name: `curve-${i}`, full_name: `local/curve-${i}`, owner: { login: 'local' },
        stargazers_count: 1, forks_count: 0, private: false, archived: false, updated_at: '2026-01-01T00:00:00Z' }) })
      const market = await createLaunchCoordinator({ pool, fetchImpl,
        launcher: createMeteoraLauncher({ connection, config: key, creator }) }).launch({
        repositoryUrl: `https://github.com/local/curve-${i}`, tokenName: `Curve ${i}`, tokenSymbol: 'CURVE',
        launcherWallet: wallet.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(wallet); return tx } })
      launched.push({ ...market, repoId })
    }
    await Promise.all(launched.map(market => finalize(market.launchSignature)))
    const verify = createLaunchEvidenceVerifier({ connection, config })
    assert.ok((await createLaunchIndexer({ pool, verify }).runOnce()).every(item => item.state === 'indexed'))
    const trader = createCanonicalTrader({ pool, connection, config })
    const trades = []
    for (const market of launched) {
      const prepared = await trader.prepareBuy({ githubRepoId: market.repoId,
        wallet: wallet.publicKey.toBase58(), amountLamports: 100_000_000n })
      const bought = await trader.submitTrade(prepared, async tx => { tx.partialSign(wallet); return tx })
      const sell = await trader.prepareSell({ githubRepoId: market.repoId,
        wallet: wallet.publicKey.toBase58(), amountBaseUnits: bought.tokenDelta / 2n })
      const sold = await trader.submitTrade(sell, async tx => { tx.partialSign(wallet); return tx })
      trades.push(bought, sold)
      const bonding = await readBondingStatus(connection, market, config)
      assert.equal(bonding.thresholdLamports, market.repoId === '9900100' ? '29954748784' : '85000000000')
      assert.equal(bonding.status, 'active')
    }
    await Promise.all(trades.map(trade => finalize(trade.signature)))
    const worker = () => createExternalFeeIndexer({ pool, connection, config })
    const indexed = await worker().runOnce()
    assert.equal(indexed.length, 2)
    assert.ok(indexed.every(item => item.status === 'OK' && item.creditedBaseUnits > 0n))
    const restarted = await worker().runOnce()
    assert.ok(restarted.every(item => item.status === 'OK' && item.creditedBaseUnits === 0n))
    assert.equal((await pool.query('select count(*)::int as count from trade_events')).rows[0].count, 4)
    const githubVerifier = { verifyCurrentAuthority: async ({ githubRepoId }) => ({ verified: true,
      permission: 'admin', githubRepoId, githubUserId: 123n, verifiedAt: new Date() }) }
    const claims = createClaim({ pool, connection, config, creator, githubVerifier })
    const reconciler = createReconciler({ pool, connection, config })
    const payouts = []
    for (const market of launched) {
      await pool.query(`insert into repo_verifications (github_repo_id, github_user_id, github_login, permission)
        values ($1,123,'local-admin','admin')`, [market.repoId])
      await pool.query(`insert into repo_beneficiaries (github_repo_id, github_user_id, wallet) values ($1,123,$2)`,
        [market.repoId, receiver.publicKey.toBase58()])
      assert.equal((await reconciler.reconcile(market.repoId)).status, 'MATCH')
      const request = { githubRepoId: market.repoId, githubAuthorization: {} }
      const payout = await claims.claim(request)
      assert.ok(payout.amountBaseUnits > 0n)
      assert.equal((await reconciler.reconcile(market.repoId)).status, 'MATCH')
      await assert.rejects(() => claims.claim(request), /No accrued creator fees/)
      payouts.push({ repoId: market.repoId, signature: payout.signature, amount: payout.amountBaseUnits.toString() })
    }
    delete process.env.DBC_LEGACY_CONFIGS
    await assert.rejects(() => createCanonicalTrader({ pool, connection, config }).quoteBuy({
      githubRepoId: launched[0].repoId, amountLamports: 1000000n }), /approved DBC config/)
    console.log(JSON.stringify({ oldConfig: legacy.toBase58(), newConfig: config.toBase58(), payouts, reconciliation: 'MATCH' }))
  } finally {
    if (oldEnvironment === undefined) delete process.env.DBC_LEGACY_CONFIGS
    else process.env.DBC_LEGACY_CONFIGS = oldEnvironment
    await pool.end()
  }
})
