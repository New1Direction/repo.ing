import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Connection, Keypair } from '@solana/web3.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { repoBeneficiaries, repoClaims, repoVerifications } from '../src/db/schema.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createClaim } from '../src/claim.mjs'
import { claimBuilderQueue } from '../src/builder-queue.mjs'
import { createPayoutAddresses } from '../src/payout-address.mjs'

const rpc = process.env.SOLANA_RPC_URL ?? 'http://127.0.0.1:8899'
assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_claim'
const connection = new Connection(rpc, 'confirmed')
const pool = new pg.Pool({ connectionString: databaseUrl })
const db = drizzle(pool)
const repoId = 1384142609n
let config, market, creator, beneficiary, trader, accrued, claimService, result, laterAccrued, laterSignature, githubChecks = 0
let reviewedRequest
let permission = 'admin'
let verifiedAt = () => new Date()
const githubVerifier = { verifyCallback: async ({ githubRepoId, expectedGithubRepoId, code, state, expectedState }) => {
  githubChecks++
  assert.equal(githubRepoId, repoId)
  assert.equal(expectedGithubRepoId, repoId)
  assert.equal(code, 'local-test-code')
  assert.equal(state, expectedState)
  return { verified: permission === 'admin', permission, githubRepoId: repoId,
    githubUserId: 285551516n, verifiedAt: verifiedAt() }
} }
const request = () => ({ githubRepoId: repoId,
  githubAuthorization: { code: 'local-test-code', state: 'local-test-state', expectedState: 'local-test-state' } })

test.before(async () => {
  await pool.query('truncate repo_claims, wallet_binding_challenges, repo_beneficiaries, repo_verifications, fee_events, markets, repositories restart identity cascade')
  ;({ config } = await createFixedConfig(connection))
  creator = Keypair.generate()
  beneficiary = Keypair.generate()
  const launcherWallet = Keypair.generate()
  trader = Keypair.generate()
  for (const wallet of [creator, launcherWallet, trader]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, 2_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({
    id: Number(repoId), name: 'Waternot', full_name: 'New1Direction/Waternot',
    owner: { login: 'New1Direction' }, description: null, stargazers_count: 1, forks_count: 1,
    archived: false, private: false, visibility: 'public', updated_at: '2026-01-01T00:00:00Z',
  }) })
  market = await createLaunchCoordinator({ pool, launcher: createMeteoraLauncher({ connection, config, creator }), fetchImpl }).launch({
    repositoryUrl: 'https://github.com/New1Direction/Waternot', tokenName: 'Claim Repo', tokenSymbol: 'CLAIM',
    launcherWallet: launcherWallet.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(launcherWallet); return tx },
  })
  const verifyLaunch = createLaunchEvidenceVerifier({ connection, config })
  let finality
  for (let i = 0; i < 120; i++) {
    finality = await verifyLaunch(market)
    if (finality.state === 'match') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.equal(finality.state, 'match')
  assert.equal((await createLaunchIndexer({ pool, verify: verifyLaunch }).runOnce())[0].state, 'indexed')
  const canonicalTrader = createCanonicalTrader({ pool, connection, config })
  const prepared = await canonicalTrader.prepareBuy({ githubRepoId: repoId,
    wallet: trader.publicKey.toBase58(), amountLamports: 10_000_000n })
  const bought = await canonicalTrader.submitTrade(prepared, async tx => { tx.partialSign(trader); return tx })
  for (let i = 0; i < 120; i++) {
    if (await connection.getTransaction(bought.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  accrued = await createFeeAccrual({ pool, connection, config }).recordTradeFees({ githubRepoId: repoId,
    signatures: [bought.signature] })
  assert.ok(accrued.earnedBaseUnits > 0n)
  await db.insert(repoVerifications).values({ githubRepoId: repoId, githubUserId: 285551516n,
    githubLogin: 'local-test-admin', permission: 'admin' })
  await db.insert(repoBeneficiaries).values({ githubRepoId: repoId, githubUserId: 285551516n,
    wallet: beneficiary.publicKey.toBase58() })
  claimService = createClaim({ pool, connection, config, creator, githubVerifier })
})
test.after(async () => { await pool.end() })

test('an unfunded payout signer cannot create a pending claim', async () => {
  const unfundedConnection = Object.create(connection)
  unfundedConnection.getBalance = async () => 0
  const checksBefore = githubChecks
  const guarded = createClaim({ pool, connection: unfundedConnection, config, creator, githubVerifier })
  await assert.rejects(guarded.claim(request()), /Payout signer needs SOL/)
  assert.equal(githubChecks, checksBefore)
  assert.equal((await db.select().from(repoClaims)).length, 0)
})

test('stale or non-admin GitHub authority is rejected before payout', async () => {
  const before = await connection.getBalance(beneficiary.publicKey)
  permission = 'write'
  await assert.rejects(claimService.claim(request()), /Current GitHub admin authority required/)
  permission = 'admin'
  verifiedAt = () => new Date(Date.now() - 120_000)
  await assert.rejects(claimService.claim(request()), /Current GitHub admin authority required/)
  verifiedAt = () => new Date()
  assert.equal(await connection.getBalance(beneficiary.publicKey), before)
  assert.equal((await db.select().from(repoClaims)).length, 0)
})

test('caller cannot substitute the bound receiver', async () => {
  const other = Keypair.generate().publicKey.toBase58()
  await assert.rejects(claimService.claim({ ...request(), receiver: other }), /receiver and market/)
  assert.equal((await db.select().from(repoClaims)).length, 0)
})

test('review cannot replace the recipient or use an outdated amount', async () => {
  const [bound] = await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, repoId))
  reviewedRequest = { ...request(), review: { repoId: String(repoId), wallet: bound.wallet,
    boundAt: bound.boundAt.toISOString(), amount: accrued.earnedBaseUnits.toString(), paid: '0', expiresAt: Date.now() + 600_000 } }
  await assert.rejects(claimService.claim({ ...reviewedRequest, review: { ...reviewedRequest.review, wallet: Keypair.generate().publicKey.toBase58() } }), /Payout details changed/)
  await assert.rejects(claimService.claim({ ...reviewedRequest, review: { ...reviewedRequest.review, amount: '1' } }), /Claim amount changed/)
  assert.equal((await db.select().from(repoClaims)).length, 0)
})

test('fresh admin check sends accrued creator fees directly to bound beneficiary', async () => {
  const checksBefore = githubChecks
  const originalSimulate = connection.simulateTransaction.bind(connection)
  connection.simulateTransaction = async (...args) => {
    // One-shot hook: restore first, because preparing the side trade simulates too (trade-landing CU sizing).
    connection.simulateTransaction = originalSimulate
    const simulation = await originalSimulate(...args)
    const canonicalTrader = createCanonicalTrader({ pool, connection, config })
    const prepared = await canonicalTrader.prepareBuy({ githubRepoId: repoId, wallet: trader.publicKey.toBase58(), amountLamports: 10_000_000n })
    const bought = await canonicalTrader.submitTrade(prepared, async tx => { tx.partialSign(trader); return tx })
    for (let i = 0; i < 120; i++) {
      if (await connection.getTransaction(bought.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    laterSignature = bought.signature
    const updated = await new DynamicBondingCurveClient(connection, 'finalized').state.getPool(market.pool)
    laterAccrued = BigInt(updated.poolState.creatorQuoteFee.toString()) - accrued.earnedBaseUnits
    assert.ok(laterAccrued > 0n)
    return simulation
  }
  const sessionService = createClaim({ pool, connection, config, creator, githubVerifier: {
    verifyCurrentAuthority: async ({ githubRepoId }) => githubVerifier.verifyCallback({ githubRepoId,
      expectedGithubRepoId: repoId, ...request().githubAuthorization }) } })
  result = await sessionService.claim(reviewedRequest)
  await createFeeAccrual({ pool, connection, config }).recordTradeFees({ githubRepoId: repoId, signatures: [laterSignature] })
  assert.equal(githubChecks, checksBefore + 1)
  assert.equal(result.permission, 'admin')
  assert.equal(result.pool, market.pool)
  assert.equal(result.beneficiaryWallet, beneficiary.publicKey.toBase58())
  assert.equal(result.creatorFeeBefore, accrued.earnedBaseUnits)
  assert.equal(result.amountBaseUnits, accrued.earnedBaseUnits)
  assert.equal(result.creatorFeeAfter, laterAccrued)
  assert.equal(result.receiverDeltaLamports - result.rentRefundLamports, result.amountBaseUnits)
  const [row] = await db.select().from(repoClaims).where(eq(repoClaims.claimSignature, result.signature))
  assert.equal(row.status, 'settled')
  assert.equal(row.beneficiaryWallet, beneficiary.publicKey.toBase58())
  assert.equal(row.amountBaseUnits, result.amountBaseUnits)
  console.log(JSON.stringify({ repoId: repoId.toString(), network: rpc, config: config.toBase58(),
    mint: market.mint, pool: market.pool, creator: creator.publicKey.toBase58(),
    beneficiary: result.beneficiaryWallet, creatorFeeBeforeLamports: result.creatorFeeBefore.toString(),
    claimSignature: result.signature, receivedFeeLamports: result.amountBaseUnits.toString(),
    receiverNativeDeltaLamports: result.receiverDeltaLamports.toString(),
    receiverRentRefundLamports: result.rentRefundLamports.toString(),
    creatorFeeAfterLamports: result.creatorFeeAfter.toString(), slot: result.slot.toString(),
    githubChecks }))
})

test('a consumed review cannot also claim fees that arrived during its payout', async () => {
  const before = await connection.getBalance(beneficiary.publicKey)
  await assert.rejects(claimService.claim(reviewedRequest), /already used/)
  assert.equal(await connection.getBalance(beneficiary.publicKey), before)
  assert.equal((await db.select().from(repoClaims)).length, 1)
  console.log(JSON.stringify({ repeat: 'rejected', reason: 'Review already used; later accrual requires new approval',
    beneficiaryBalanceUnchanged: true }))
})

test('the same approved review cannot be replayed after settlement', async () => {
  const before = await connection.getBalance(beneficiary.publicKey)
  await assert.rejects(claimService.claim(reviewedRequest), /already used/)
  assert.equal(await connection.getBalance(beneficiary.publicKey), before)
  assert.equal((await db.select().from(repoClaims)).length, 1)
})

test('a new review can claim the later accrual, then an empty repeat is rejected', async () => {
  const next = { ...reviewedRequest, review: { ...reviewedRequest.review, paid: accrued.earnedBaseUnits.toString(), amount: laterAccrued.toString() } }
  const payout = await claimService.claim(next)
  assert.equal(payout.amountBaseUnits, laterAccrued)
  assert.equal(payout.creatorFeeAfter, 0n)
  await assert.rejects(claimService.claim(request()), /No accrued creator fees remain to claim/)
  assert.equal((await db.select().from(repoClaims)).length, 2)
})

test('claim-all settles two canonical repositories once and leaves unreviewed fees in the pool',async()=>{
  const secondId=1384142610n, launcher=Keypair.generate()
  const airdrop=await connection.requestAirdrop(launcher.publicKey,1_000_000_000)
  await connection.confirmTransaction({signature:airdrop,...await connection.getLatestBlockhash('confirmed')},'confirmed')
  const fetchImpl=async()=>({ok:true,status:200,json:async()=>({id:Number(secondId),name:'Second',full_name:'fixture/Second',owner:{login:'fixture'},description:null,stargazers_count:0,forks_count:0,archived:false,private:false,visibility:'public',updated_at:'2026-01-01T00:00:00Z'})})
  const second=await createLaunchCoordinator({pool,launcher:createMeteoraLauncher({connection,config,creator}),fetchImpl}).launch({repositoryUrl:'https://github.com/fixture/Second',tokenName:'Second',tokenSymbol:'SECOND',launcherWallet:launcher.publicKey.toBase58(),signTransaction:async tx=>{tx.partialSign(launcher);return tx}})
  const verifyLaunch=createLaunchEvidenceVerifier({connection,config})
  for(let i=0;i<120;i++){if((await verifyLaunch(second)).state==='match')break;await new Promise(resolve=>setTimeout(resolve,250))}
  await createLaunchIndexer({pool,verify:verifyLaunch}).runOnce()
  await db.insert(repoBeneficiaries).values({githubRepoId:secondId,githubUserId:285551516n,wallet:beneficiary.publicKey.toBase58()})
  const canonicalTrader=createCanonicalTrader({pool,connection,config}),requests=[]
  for(const id of [repoId,secondId]){
    const prepared=await canonicalTrader.prepareBuy({githubRepoId:id,wallet:trader.publicKey.toBase58(),amountLamports:10_000_000n})
    const trade=await canonicalTrader.submitTrade(prepared,async tx=>{tx.partialSign(trader);return tx})
    for(let i=0;i<120;i++){if(await connection.getTransaction(trade.signature,{commitment:'finalized',maxSupportedTransactionVersion:0}))break;await new Promise(resolve=>setTimeout(resolve,250))}
    await createFeeAccrual({pool,connection,config}).recordTradeFees({githubRepoId:id,signatures:[trade.signature]})
    const [bound]=await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId,id))
    const {rows:[totals]}=await pool.query(`select (select coalesce(sum(amount_base_units),0)::text from fee_events where github_repo_id=$1) earned,(select coalesce(sum(amount_base_units),0)::text from repo_claims where github_repo_id=$1 and status='settled') paid`,[id.toString()])
    const outstanding=BigInt(totals.earned)-BigInt(totals.paid)
    requests.push({repoId:id.toString(),review:{purpose:'builder-claim-review',repoId:id.toString(),wallet:bound.wallet,boundAt:bound.boundAt.toISOString(),paid:totals.paid,amount:(id===repoId?outstanding/2n:outstanding).toString(),expiresAt:Date.now()+600_000}})
  }
  const checked=[]
  const service=createClaim({pool,connection,config,creator,githubVerifier:{verifyCurrentAuthority:async({githubRepoId})=>{checked.push(String(githubRepoId));return {verified:true,permission:'admin',githubRepoId,githubUserId:285551516n,verifiedAt:new Date()}}}})
  const results=await claimBuilderQueue(requests,async item=>{
    const result=await service.claim({githubRepoId:item.repoId,githubAuthorization:{session:true},review:item.review})
    assert.equal(result.amountBaseUnits.toString(),item.review.amount)
    assert.equal(result.receiverDeltaLamports-result.rentRefundLamports,result.amountBaseUnits)
    return {status:'settled',signature:result.signature,amount:result.amountBaseUnits.toString()}
  },()=>{})
  assert.ok(results.every(r=>r.status==='settled'));assert.equal(new Set(results.map(r=>r.signature)).size,2)
  assert.deepEqual(checked.sort(),[String(repoId),String(secondId)].sort())
  for(const item of requests)await assert.rejects(service.claim({githubRepoId:item.repoId,githubAuthorization:{session:true},review:item.review}),/already used/)
  const {createReconciler}=await import('../src/reconcile.mjs')
  const reconciler=createReconciler({pool,connection,config})
  const first=await reconciler.reconcile(repoId),secondStatus=await reconciler.reconcile(secondId)
  assert.equal(first.status,'MATCH');assert.equal(secondStatus.status,'MATCH');assert.equal(first.onchainCreatorFee.toString(),requests[0].review.amount);assert.equal(secondStatus.onchainCreatorFee,0n)
  console.log(JSON.stringify({builderQueueProof:results,repositories:requests.map(r=>r.repoId),remainingFirst:first.onchainCreatorFee.toString(),reconciliation:[first.status,secondStatus.status]}))
})

test('a pasted payout address is never paid during its hold, then receives the next claim once active', async () => {
  // Real local-validator payouts: the signature-bound wallet keeps receiving claims while a pasted address waits; when
  // the hold passes, the claim activates it under the repository lock, refuses the review of the old recipient without
  // moving funds, and pays the pasted address on a new review.
  const pasted = Keypair.generate().publicKey, holder = 285551516n
  const verifyAuthority = async ({ githubRepoId }) => {
    await db.insert(repoVerifications).values({ githubRepoId, githubUserId: holder, githubLogin: 'local-test-admin', permission: 'admin' })
    return { verified: true, permission: 'admin', githubRepoId, githubUserId: holder, githubLogin: 'local-test-admin', verifiedAt: new Date() }
  }
  // The real finalized account read: a fresh address with no account passes.
  const change = await createPayoutAddresses({ pool, connection }).request({ githubRepoId: String(repoId), address: pasted.toBase58(),
    confirm: pasted.toBase58().slice(-4), verifyAuthority })
  const service = createClaim({ pool, connection, config, creator, githubVerifier: { verifyCurrentAuthority: async ({ githubRepoId }) =>
    ({ verified: true, permission: 'admin', githubRepoId, githubUserId: holder, verifiedAt: new Date() }) } })
  const snapshot = async () => {
    const [bound] = await db.select().from(repoBeneficiaries).where(eq(repoBeneficiaries.githubRepoId, repoId))
    const { rows: [totals] } = await pool.query(`select (select coalesce(sum(amount_base_units),0)::text from builder_fee_credits where github_repo_id=$1) earned,
      (select coalesce(sum(amount_base_units),0)::text from repo_claims where github_repo_id=$1 and status='settled') paid`, [repoId.toString()])
    return { bound, paid: totals.paid, outstanding: BigInt(totals.earned) - BigInt(totals.paid) }
  }
  const review = (current, amount) => ({ purpose: 'builder-claim-review', repoId: repoId.toString(), wallet: current.bound.wallet,
    boundAt: current.bound.boundAt.toISOString(), paid: current.paid, amount: amount.toString(), expiresAt: Date.now() + 600_000 })
  const claimWith = item => service.claim({ githubRepoId: repoId, githubAuthorization: { session: true }, review: item })

  let current = await snapshot()
  assert.equal(current.bound.wallet, beneficiary.publicKey.toBase58())
  assert.ok(current.outstanding > 1n)
  const half = current.outstanding / 2n
  const during = await claimWith(review(current, half))
  assert.equal(during.beneficiaryWallet, beneficiary.publicKey.toBase58(), 'the previous binding keeps receiving claims during the hold')
  assert.equal(during.amountBaseUnits, half)
  assert.equal(await connection.getBalance(pasted, 'confirmed'), 0, 'the waiting address received nothing')

  // The hold passes (both timestamps shift back; the request's terms are otherwise immutable).
  const client = await pool.connect()
  try {
    await client.query('begin'); await client.query('set local session_replication_role = replica')
    await client.query(`update payout_address_requests set requested_at = requested_at - interval '49 hours', active_at = active_at - interval '49 hours'
      where id = $1`, [change.id])
    await client.query('commit')
  } finally { client.release() }
  const stale = await snapshot()
  assert.equal(stale.bound.wallet, beneficiary.publicKey.toBase58())
  const before = await connection.getBalance(beneficiary.publicKey, 'confirmed')
  await assert.rejects(claimWith(review(stale, stale.outstanding)), /Payout details changed/)
  assert.equal(await connection.getBalance(beneficiary.publicKey, 'confirmed'), before)
  assert.equal(await connection.getBalance(pasted, 'confirmed'), 0)

  current = await snapshot()
  assert.deepEqual([current.bound.wallet, current.bound.method, String(current.bound.payoutRequestId)], [pasted.toBase58(), 'pasted', change.id])
  const after = await claimWith(review(current, current.outstanding))
  assert.equal(after.beneficiaryWallet, pasted.toBase58())
  assert.equal(after.amountBaseUnits, current.outstanding)
  assert.equal(after.receiverDeltaLamports - after.rentRefundLamports, after.amountBaseUnits)
  assert.equal(BigInt(await connection.getBalance(pasted, 'finalized')), after.receiverDeltaLamports)
  const [row] = await db.select().from(repoClaims).where(eq(repoClaims.claimSignature, after.signature))
  assert.deepEqual([row.status, row.beneficiaryWallet], ['settled', pasted.toBase58()])
  const { createReconciler } = await import('../src/reconcile.mjs')
  const reconciled = await createReconciler({ pool, connection, config }).reconcile(repoId)
  assert.equal(reconciled.status, 'MATCH'); assert.equal(reconciled.onchainCreatorFee, 0n)
  console.log(JSON.stringify({ pastedPayoutProof: { duringHold: { to: during.beneficiaryWallet, lamports: during.amountBaseUnits.toString(), signature: during.signature },
    afterHold: { to: after.beneficiaryWallet, lamports: after.amountBaseUnits.toString(), signature: after.signature, slot: after.slot.toString() } } }))
})
