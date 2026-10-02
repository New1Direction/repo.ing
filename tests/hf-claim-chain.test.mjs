import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { markets, repoBeneficiaries, repoClaims, repoVerifications } from '../src/db/schema.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createClaim } from '../src/claim.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
import { createHfClient } from '../src/hf-api.mjs'
import { createHfOAuth, createHfVerifier } from '../src/hf-verification.mjs'
import { marketSource } from '../src/market-identity.mjs'
import { startFakeHf } from './fixtures/hf-server.mjs'

// solana-test-validator and PostgreSQL: a GitHub market and a Hugging Face model market launch on the same fixed DBC
// config, take an identical trade, and are claimed. The model market's payout wallet is bound through the Hugging Face
// path (a fresh owner check against a local stand-in for huggingface.co, then the model binding message signed by the
// wallet), and its claim runs src/claim.mjs with a Hugging Face authority. Both pay exactly their bound wallets and both
// reconcile MATCH; the GitHub claim runs exactly as before, with a GitHub authority.
const url = process.env.HF_CHAIN_TEST_DATABASE_URL
const rpc = process.env.SOLANA_RPC_URL
const OWNER = '6426d3f3a7723d62b53c259b', GGUF = '64f5fd954d3b1dd311d30e28', TOKEN = 'hf_oauth_owner_token_test_only'
const GITHUB_REPO = 1384142611n
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const edWallet = () => {
  const pair = generateKeyPairSync('ed25519')
  return { publicKey: new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), signMessage: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey) }
}

async function finalized(connection, signature) {
  for (let i = 0; i < 160; i++) {
    if (await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })) return
    await sleep(250)
  }
  throw new Error(`not finalized: ${signature}`)
}

test('a model market claim pays its Hugging Face-bound wallet and reconciles MATCH, next to an unchanged GitHub claim', { skip: !url || !rpc, timeout: 600_000 }, async () => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_hf_chain_test', 'Disposable chain test database required')
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'local validator only')
  const pool = new pg.Pool({ connectionString: url }), db = drizzle(pool)
  const connection = new Connection(rpc, 'confirmed')
  const server = await startFakeHf()
  server.route('/oauth/userinfo', (_, request) => request.headers.authorization === `Bearer ${TOKEN}`
    ? { status: 200, headers: {}, body: { sub: OWNER, preferred_username: 'TheBloke', orgs: [] } } : { status: 401, headers: {}, body: {} })
  try {
    await pool.query(`truncate model_verifications, payout_address_events, payout_address_requests, wallet_binding_challenges, repo_claims, repo_beneficiaries,
      repo_verifications, fee_events, markets, repositories, hf_models restart identity cascade`)
    const { config } = await createFixedConfig(connection)
    const creator = Keypair.generate(), launcherWallet = Keypair.generate(), trader = Keypair.generate()
    for (const wallet of [creator, launcherWallet, trader]) {
      const signature = await connection.requestAirdrop(wallet.publicKey, 3_000_000_000)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    }
    const launcher = createMeteoraLauncher({ connection, config, creator })
    const signLauncher = async tx => { tx.partialSign(launcherWallet); return tx }

    // GitHub market: the launch coordinator, exactly as tests/claim.test.mjs launches one.
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ id: Number(GITHUB_REPO), name: 'Waternot2', full_name: 'New1Direction/Waternot2',
      owner: { login: 'New1Direction' }, description: null, stargazers_count: 1, forks_count: 1, archived: false, private: false, visibility: 'public',
      updated_at: '2026-01-01T00:00:00Z' }) })
    const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl })
    await coordinator.launch({ repositoryUrl: 'https://github.com/New1Direction/Waternot2', tokenName: 'Claim Repo', tokenSymbol: 'CLAIM',
      launcherWallet: launcherWallet.publicKey.toBase58(), signTransaction: signLauncher })

    // Model market: registered by its _id (hf_models), its repositories row in the model id range, then prepared and
    // submitted through the same launcher and coordinator (the model launch flow itself is not this test's subject).
    const { rows: [{ marketId }] } = await pool.query(`insert into hf_models(hf_id, repo_path, owner_handle, owner_kind, owner_subject)
      values ($1, 'TheBloke/Llama-2-7B-GGUF', 'TheBloke', 'user', $2) returning market_ref::text as "marketId"`, [GGUF, OWNER])
    assert.equal(marketSource(marketId), 'huggingface')
    await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at, source, hf_model_ref)
      values ($1, 'TheBloke', 'Llama-2-7B-GGUF', 'TheBloke/Llama-2-7B-GGUF', 0, 0, false, now(), 'huggingface', $1)`, [marketId])
    const prepared = await launcher.prepare({ launcherWallet: launcherWallet.publicKey.toBase58(), tokenName: 'Llama GGUF', tokenSymbol: 'GGUF' })
    const [reserved] = await db.insert(markets).values({ githubRepoId: BigInt(marketId), status: 'prepared', mint: prepared.mint, pool: prepared.pool,
      launcherWallet: launcherWallet.publicKey.toBase58(), creatorWallet: creator.publicKey.toBase58(), tokenName: 'Llama GGUF', tokenSymbol: 'GGUF',
      blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight }).returning()
    await coordinator.submitPrepared({ marketId: reserved.id, githubRepoId: marketId, mint: prepared.mint, repo: null, prepared, signTransaction: signLauncher })

    const verifyLaunch = createLaunchEvidenceVerifier({ connection, config })
    let indexed = []
    for (let i = 0; i < 160 && indexed.length < 2; i++) {
      indexed = (await createLaunchIndexer({ pool, verify: verifyLaunch }).runOnce()).filter(result => ['indexed', 'verified'].includes(result.state))
      if (indexed.length < 2) await sleep(250)
    }
    assert.deepEqual(indexed.map(result => result.repoId).sort(), [String(GITHUB_REPO), marketId].sort())

    // One identical buy on each market, then the fee ledger from finalized evidence.
    const canonicalTrader = createCanonicalTrader({ pool, connection, config }), feeAccrual = createFeeAccrual({ pool, connection, config })
    const accrued = {}
    for (const id of [GITHUB_REPO, BigInt(marketId)]) {
      const order = await canonicalTrader.prepareBuy({ githubRepoId: id, wallet: trader.publicKey.toBase58(), amountLamports: 10_000_000n })
      const bought = await canonicalTrader.submitTrade(order, async tx => { tx.partialSign(trader); return tx })
      await finalized(connection, bought.signature)
      accrued[id] = (await feeAccrual.recordTradeFees({ githubRepoId: id, signatures: [bought.signature] })).earnedBaseUnits
    }
    assert.ok(accrued[GITHUB_REPO] > 0n)
    assert.equal(accrued[BigInt(marketId)], accrued[GITHUB_REPO], 'the same trade earns a model market the same creator fee')

    // Payout wallets. GitHub: as before. Model: a fresh Hugging Face owner check, then the model binding message.
    const githubWallet = Keypair.generate().publicKey, modelWallet = edWallet()
    await db.insert(repoVerifications).values({ githubRepoId: GITHUB_REPO, githubUserId: 285551516n, githubLogin: 'local-test-admin', permission: 'admin' })
    await db.insert(repoBeneficiaries).values({ githubRepoId: GITHUB_REPO, githubUserId: 285551516n, wallet: githubWallet.toBase58() })
    const verifier = createHfVerifier({ pool, hf: createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} }),
      oauth: createHfOAuth({ clientId: 'repoing-test', clientSecret: 'test-only-hf-secret', redirectUri: 'https://repo.ing/api/hf/callback', fetchImpl: server.fetchImpl }) })
    const hfAuthority = { source: 'huggingface', verifyCurrentAuthority: ({ githubRepoId }) => verifier.verifyMarketAuthority({ marketId: githubRepoId, accessToken: TOKEN, expectedSubject: OWNER }) }
    const binder = createWalletBinding({ pool })
    const authority = await hfAuthority.verifyCurrentAuthority({ githubRepoId: marketId })
    const challenge = await binder.requestChallenge({ githubRepoId: marketId, wallet: modelWallet.publicKey.toBase58(), authority })
    await binder.bindWallet({ githubRepoId: marketId, wallet: modelWallet.publicKey.toBase58(), nonce: challenge.nonce,
      signature: modelWallet.signMessage(challenge.message), authority })

    const reviewFor = async (repoId, purpose) => {
      const [bound] = await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, repoId))
      const { rows: [totals] } = await pool.query(`select (select coalesce(sum(amount_base_units), 0)::text from builder_fee_credits where github_repo_id = $1) as earned,
        (select coalesce(sum(amount_base_units), 0)::text from repo_claims where github_repo_id = $1 and status = 'settled') as paid`, [repoId.toString()])
      return { purpose, repoId: repoId.toString(), wallet: bound.wallet, boundAt: bound.boundAt.toISOString(), paid: totals.paid,
        amount: (BigInt(totals.earned) - BigInt(totals.paid)).toString(), expiresAt: Date.now() + 600_000 }
    }
    const reconciler = createReconciler({ pool, connection, config })
    const results = {}
    for (const [repoId, githubVerifier, purpose] of [
      [BigInt(marketId), hfAuthority, 'model-claim-review'],
      [GITHUB_REPO, { verifyCurrentAuthority: async ({ githubRepoId }) => ({ verified: true, permission: 'admin', githubRepoId, githubUserId: 285551516n, verifiedAt: new Date() }) }, 'creator-claim-review'],
    ]) {
      const review = await reviewFor(repoId, purpose)
      const result = await createClaim({ pool, connection, config, creator, githubVerifier }).claim({ githubRepoId: repoId, githubAuthorization: { session: true }, review })
      assert.equal(result.amountBaseUnits, accrued[repoId])
      assert.equal(result.receiverDeltaLamports - result.rentRefundLamports, result.amountBaseUnits)
      const [row] = await db.select().from(repoClaims).where(eq(repoClaims.claimSignature, result.signature))
      assert.deepEqual([row.status, row.beneficiaryWallet], ['settled', result.beneficiaryWallet])
      const reconciled = await reconciler.reconcile(repoId)
      assert.equal(reconciled.status, 'MATCH'); assert.equal(reconciled.onchainCreatorFee, 0n)
      results[repoId] = { result, reconciled }
    }
    const model = results[BigInt(marketId)].result, github = results[GITHUB_REPO].result
    assert.deepEqual([model.beneficiaryWallet, model.githubUserId, model.authoritySubject, model.ownerSubject], [modelWallet.publicKey.toBase58(), null, OWNER, OWNER])
    assert.equal(BigInt(await connection.getBalance(modelWallet.publicKey, 'finalized')), model.receiverDeltaLamports)
    assert.deepEqual([github.beneficiaryWallet, github.githubUserId, github.permission], [githubWallet.toBase58(), 285551516n, 'admin'])
    assert.equal(github.authoritySubject, undefined, 'the GitHub claim result is unchanged')
    console.log(JSON.stringify({ modelClaimProof: { marketId, wallet: model.beneficiaryWallet, lamports: model.amountBaseUnits.toString(), signature: model.signature,
      reconcile: results[BigInt(marketId)].reconciled.status }, githubClaimProof: { repoId: GITHUB_REPO.toString(), wallet: github.beneficiaryWallet,
      lamports: github.amountBaseUnits.toString(), signature: github.signature, reconcile: results[GITHUB_REPO].reconciled.status } }))
  } finally { await server.close(); await pool.end() }
})
