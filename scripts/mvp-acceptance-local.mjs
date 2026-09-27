import http from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import pg from 'pg'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { repoBeneficiaries, repoClaims } from '../src/db/schema.mjs'
import { createFixedConfig } from '../tests/fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'
import { createClaim } from '../src/claim.mjs'
import { createReconciler } from '../src/reconcile.mjs'

const repoId = 1384142609n
const rpc = 'http://127.0.0.1:8899'
const databaseUrl = process.env.DATABASE_URL
const clientId = process.env.GITHUB_APP_CLIENT_ID ?? 'Iv23li0LF9CWsTgcIyQ0'
if (!databaseUrl) throw new Error('Dedicated local DATABASE_URL required')

// Clipboard input is never printed or persisted. Clear it before any network operation.
const clientSecret = execFileSync('pbpaste', { encoding: 'utf8' }).trim()
spawnSync('pbcopy', { input: '' })
if (clientSecret.length < 20) throw new Error('GitHub App Client secret was not available on the clipboard')

const pool = new pg.Pool({ connectionString: databaseUrl })
const db = drizzle(pool)
const connection = new Connection(rpc, 'confirmed')
let server
try {
  const [beneficiary] = await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, repoId)).limit(1)
  if (!beneficiary || beneficiary.githubUserId !== 285551516n) throw new Error('Expected previously bound beneficiary is missing')
  const existing = await db.select().from(repoClaims).where(eq(repoClaims.githubRepoId, repoId))
  if (existing.length) throw new Error('Acceptance database already has a claim for this repository')

  const { config } = await createFixedConfig(connection)
  const creator = Keypair.generate()
  const launcherWallet = Keypair.generate()
  const traderWallet = Keypair.generate()
  for (const wallet of [creator, launcherWallet, traderWallet]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const market = await createLaunchCoordinator({ pool,
    launcher: createMeteoraLauncher({ connection, config, creator }) }).launch({
    repositoryUrl: 'https://github.com/New1Direction/Waternot', tokenName: 'Acceptance Repo',
    tokenSymbol: 'ACCEPT', launcherWallet: launcherWallet.publicKey.toBase58(),
    signTransaction: async tx => { tx.partialSign(launcherWallet); return tx },
  })
  if (market.creatorWallet !== creator.publicKey.toBase58()) throw new Error('Canonical market creator does not match live signer')
  const verifyLaunch = createLaunchEvidenceVerifier({ connection, config })
  let finality
  for (let i = 0; i < 120; i++) {
    finality = await verifyLaunch(market)
    if (finality.state === 'match') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (finality.state !== 'match') throw new Error('Local canonical launch did not finalize')
  const indexed = await createLaunchIndexer({ pool, verify: verifyLaunch }).runOnce()
  if (!indexed.some(result => result.state === 'indexed')) throw new Error('Canonical market did not index')
  const trader = createCanonicalTrader({ pool, connection, config })
  const prepared = await trader.prepareBuy({ githubRepoId: repoId,
    wallet: traderWallet.publicKey.toBase58(), amountLamports: 10_000_000n })
  const trade = await trader.submitTrade(prepared, async tx => { tx.partialSign(traderWallet); return tx })
  let finalizedTrade = null
  for (let i = 0; i < 120; i++) {
    finalizedTrade = await connection.getTransaction(trade.signature,
      { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (finalizedTrade) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  if (!finalizedTrade) throw new Error('Local trade did not finalize')
  const accrued = await createFeeAccrual({ pool, connection, config }).recordTradeFees({
    githubRepoId: repoId, signatures: [trade.signature] })
  if (accrued.earnedBaseUnits <= 0n || accrued.earnedBaseUnits !== accrued.observedCreatorFee) {
    throw new Error('Creator fee accrual does not match Meteora before authorization')
  }

  const verifier = createGitHubAppVerifier({ pool, clientId, clientSecret,
    redirectUri: 'http://localhost:3001/api/github/callback' })
  let liveGitHubResult
  const checkedVerifier = { verifyCallback: async args => {
    const result = await verifier.verifyCallback(args)
    if (result.verified !== true || result.permission !== 'admin' ||
        result.githubRepoId !== repoId || result.githubUserId !== beneficiary.githubUserId) {
      throw new Error('Live GitHub admin does not match the bound beneficiary user')
    }
    liveGitHubResult = result
    return result
  } }
  const claimant = createClaim({ pool, connection, config, creator, githubVerifier: checkedVerifier })
  const authorization = verifier.authorizationUrl({ githubRepoId: repoId })
  const beneficiaryKey = new PublicKey(beneficiary.wallet)
  let used = false
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost:3001')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    if (used || request.method !== 'GET' || url.pathname !== '/api/github/callback') {
      response.writeHead(404).end(JSON.stringify({ error: 'not found' }))
      return
    }
    used = true
    try {
      const balanceBefore = await connection.getBalance(beneficiaryKey, 'finalized')
      const claimed = await claimant.claim({ githubRepoId: repoId, githubAuthorization: {
        code: url.searchParams.get('code'), state: url.searchParams.get('state'),
        expectedState: authorization.state } })
      const balanceAfter = await connection.getBalance(beneficiaryKey, 'finalized')
      const [settlement] = await db.select().from(repoClaims).where(eq(repoClaims.claimSignature, claimed.signature)).limit(1)
      const reconciled = await createReconciler({ pool, connection, config }).reconcile(repoId)
      if (claimed.beneficiaryWallet !== beneficiary.wallet ||
          balanceAfter - balanceBefore !== Number(claimed.receiverDeltaLamports) ||
          settlement?.status !== 'settled' || settlement.beneficiaryWallet !== beneficiary.wallet ||
          settlement.amountBaseUnits !== claimed.amountBaseUnits || reconciled.status !== 'MATCH') {
        throw new Error('Acceptance settlement or reconciliation evidence did not match')
      }
      const evidence = { repositoryId: repoId.toString(), repository: 'New1Direction/Waternot',
        githubUserId: liveGitHubResult.githubUserId.toString(), githubLogin: liveGitHubResult.githubLogin,
        permission: liveGitHubResult.permission, beneficiaryWallet: beneficiary.wallet,
        pool: market.pool, creatorFeeBeforeLamports: claimed.creatorFeeBefore.toString(),
        claimSignature: claimed.signature, feeReceivedLamports: claimed.amountBaseUnits.toString(),
        beneficiaryNativeDeltaLamports: String(balanceAfter - balanceBefore),
        reconciliation: { status: reconciled.status, earned: reconciled.recordedEarned.toString(),
          claimed: reconciled.recordedClaimed.toString(), remaining: reconciled.expectedRemaining.toString(),
          onchain: reconciled.onchainCreatorFee.toString() } }
      process.stdout.write(`ACCEPTANCE_RESULT ${JSON.stringify(evidence)}\n`)
      response.writeHead(200).end(JSON.stringify({ accepted: true, permission: 'admin',
        claimSignature: claimed.signature, reconciliation: 'MATCH' }))
    } catch (error) {
      process.stderr.write(`ACCEPTANCE_BLOCKED ${error.message}\n`)
      process.exitCode = 1
      response.writeHead(400).end(JSON.stringify({ accepted: false, error: 'acceptance proof blocked' }))
    } finally {
      server.close()
      await pool.end()
    }
  })
  await new Promise((resolve, reject) => server.once('error', reject).listen(3001, '127.0.0.1', resolve))
  process.stdout.write(`ACCEPTANCE_READY repository=${repoId} pool=${market.pool} beneficiary=${beneficiary.wallet} fee=${accrued.earnedBaseUnits}\n`)
  execFileSync('open', [authorization.url])
} catch (error) {
  if (server) server.close()
  await pool.end()
  process.stderr.write(`ACCEPTANCE_BLOCKED ${error.message}\n`)
  process.exitCode = 1
}
