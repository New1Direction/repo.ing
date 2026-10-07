import { createHash } from 'node:crypto'
import bs58 from 'bs58'
import BN from 'bn.js'
import { Keypair, PublicKey, Transaction, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode, getCurrentPoint, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk'
import { createGraduatedFees } from './graduated-fees.mjs'
import { createReconciler } from './reconcile.mjs'
import { EARLY_ACCESS_NO_P3, isEarlyAccessMarket } from './early-access.mjs'
import { activePolicy, assertPlatformReserveCustody } from './platform-revenue.mjs'
import { settleLiquidityIntent } from './liquidity-settlement.mjs'
export { settleLiquidityIntent, createLiquidityRecovery } from './liquidity-settlement.mjs'

const LOCK_MODE = 'platform-authority'
const LOCK = 'liquidity-reserve'
const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const integer = (value, name, max = BigInt(Number.MAX_SAFE_INTEGER)) => {
  if (!/^[1-9]\d*$/.test(String(value)) || BigInt(value) > max) throw Error(`Invalid ${name}`)
  return String(value)
}
export function liquidityConfig(env = process.env) {
  if (env.REPO_LIQUIDITY_EXECUTION_ENABLED !== 'true') return null
  const names = { minVolumeLamports:'MIN_VOLUME_LAMPORTS', targetSolLamports:'TARGET_SOL_LAMPORTS',
    rulesVersion:'RULES_VERSION', maxSlippageBps:'MAX_SLIPPAGE_BPS', maxPriceImpactBps:'MAX_PRICE_IMPACT_BPS',
    minDeployLamports:'MIN_DEPLOY_LAMPORTS', maxDeployLamports:'MAX_DEPLOY_LAMPORTS', maxNetworkCostLamports:'MAX_NETWORK_COST_LAMPORTS' }
  const missing = Object.values(names).filter(name => !env[`REPO_LIQUIDITY_${name}`])
  if (missing.length) throw Error(`Liquidity execution configuration incomplete: ${missing.map(n=>`REPO_LIQUIDITY_${n}`).join(', ')}`)
  const rules = Object.fromEntries(Object.entries(names).map(([key,name])=>[key,integer(env[`REPO_LIQUIDITY_${name}`],`liquidity ${key}`)]))
  for (const key of ['rulesVersion','maxSlippageBps','maxPriceImpactBps']) rules[key] = Number(rules[key])
  if (rules.maxSlippageBps >= 10000 || rules.maxPriceImpactBps > 10000 || BigInt(rules.maxDeployLamports) < BigInt(rules.minDeployLamports)) throw Error('Invalid liquidity bounds')
  return rules
}
export async function liquidityReserveSummary(db) {
  const { rows:[allocated] } = await db.query('select coalesce(sum(liquidity_amount),0)::text as amount from platform_revenue_allocations')
  const { rows:[intents] } = await db.query(`select
    coalesce(sum(case when status='settled' then settled_debit when status<>'aborted' then source_amount else 0 end),0)::text as committed,
    coalesce(sum(case when status='settled' then settled_debit else 0 end),0)::text as settled,
    coalesce(sum(case when status='aborted' then source_amount else 0 end),0)::text as failed,
    count(*) filter(where status in ('prepared','reviewed','simulated','submitted'))::int as open from liquidity_intents`)
  return { allocated:allocated.amount, ...intents, remaining:String(BigInt(allocated.amount)-BigInt(intents.committed)), lockMode:LOCK_MODE }
}
export function liquidityTerms(intent) {
  const keys = ['id','github_repo_id','pool','network','source_amount','swap_amount','min_swap_output','source_wallet',
    'token_a_mint','token_b_mint','max_amount_token_a','max_amount_token_b','minimum_liquidity','max_slippage_bps',
    'max_price_impact_bps','max_network_cost','lp_owner','lock_mode','policy_version','rules_version','rules_json']
  return createHash('sha256').update(JSON.stringify(keys.map(key=>[key,String(intent[key])]))).digest('hex')
}
export async function withLiquidityLock(pool, fn) {
  const client = await pool.connect()
  try {
    // Same order as policy activation/allocation. A policy cannot rotate while an action is signed.
    await client.query('select pg_advisory_lock(hashtextextended($1,0))',['platform-revenue-allocation'])
    try {
      await client.query('select pg_advisory_lock(hashtextextended($1,0))',[LOCK])
      try { return await fn(client) }
      finally { await client.query('select pg_advisory_unlock(hashtextextended($1,0))',[LOCK]) }
    } finally { await client.query('select pg_advisory_unlock(hashtextextended($1,0))',['platform-revenue-allocation']) }
  } finally { client.release() }
}
export function createLiquidityDeployment({ pool, connection, config, partner }) {
  if (!partner) throw Error('Protected partner signer is required')
  const graduated = createGraduatedFees({connection,config,db:pool}), reconciler = createReconciler({pool,connection,config}), amm = new CpAmm(connection)
  async function network() {
    if (/^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(connection.rpcEndpoint)) return 'localnet'
    if (await connection.getGenesisHash() !== MAINNET) throw Error('Liquidity execution requires the mainnet genesis')
    return 'mainnet'
  }
  // A contributor early access market is refused by name (owner decision, docs/EARLY_ACCESS.md), not only by its config.
  async function marketRecord(db,repoId) {
    const {rows:[market]} = await db.query(`select github_repo_id::text as "githubRepoId",mint,pool,creator_wallet as "creatorWallet",
      early_access_end as "earlyAccessEnd",transfer_hook_program as "transferHookProgram"
      from markets where github_repo_id=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`,[String(repoId)])
    return market
  }
  async function qualification(db,repoId,rules) {
    if(!rules)throw Error('Liquidity qualification rules are not configured')
    try { await assertPlatformReserveCustody(db, partner.publicKey) }
    catch { return {eligible:false,reason:'Liquidity reserve is held in a different treasury wallet; review its spending authority'} }
    const market = await marketRecord(db,repoId)
    if(!market)return {eligible:false,reason:'Market is not indexed'}
    if(isEarlyAccessMarket(market))return {eligible:false,reason:EARLY_ACCESS_NO_P3}
    const snapshot = await graduated.read(market)
    if(!snapshot)return {eligible:false,reason:'Market has not graduated to DAMM'}
    const check = await reconciler.reconcile(repoId)
    if(check.status!=='MATCH')return {eligible:false,reason:`Market reconciliation is ${check.status}`}
    const {rows:[volume]} = await db.query(`select coalesce(sum((case when direction='buy' then input_base_units else output_base_units end)::numeric),0)::text as lamports from trade_events where pool=$1`,[market.pool])
    if(BigInt(volume.lamports)<BigInt(rules.minVolumeLamports))return {eligible:false,reason:'Volume below the configured threshold'}
    const state = snapshot.poolState
    if(!state.tokenBMint.equals(NATIVE_MINT)||state.tokenAMint.toBase58()!==market.mint||state.collectFeeMode!==1)throw Error('Unsupported canonical pool assets')
    if(state.tokenBAmount.gte(new BN(rules.targetSolLamports)))return {eligible:false,reason:'Liquidity already at or above the configured target'}
    return {eligible:true,repoId:String(repoId),pool:snapshot.pool.toBase58(),mint:market.mint,
      tokenAMint:state.tokenAMint.toBase58(),tokenBMint:state.tokenBMint.toBase58(),volumeLamports:volume.lamports,poolSolLamports:state.tokenBAmount.toString()}
  }
  async function quoteBudget(db,repoId,amount,rules) {
    const market = await marketRecord(db,repoId)
    if(isEarlyAccessMarket(market))throw Error(EARLY_ACCESS_NO_P3)
    const snapshot = await graduated.read(market)
    if(!snapshot)throw Error('Canonical graduation required')
    const state = await amm.fetchPoolState(snapshot.pool), swapAmount = amount/2n
    const quote = amm.getQuote2({inputTokenMint:NATIVE_MINT,poolState:state,currentPoint:await getCurrentPoint(connection,state.activationType),
      amountIn:new BN(String(swapAmount)),slippage:rules.maxSlippageBps,swapMode:SwapMode.ExactIn,tokenADecimal:6,tokenBDecimal:9,hasReferral:false})
    const before = BigInt(state.sqrtPrice.toString())**2n, after = BigInt(quote.nextSqrtPrice.toString())**2n
    const impactBps = ((after-before)*10000n+before-1n)/before
    if(impactBps<0n||impactBps>BigInt(rules.maxPriceImpactBps))throw Error('Balancing swap price impact exceeds the reviewed bound')
    const minA = BigInt(quote.minimumAmountOut.toString()), maxB = amount-swapAmount
    if(minA<=0n)throw Error('No executable balancing quote')
    const liquidity = amm.getLiquidityDelta({maxAmountTokenA:new BN(String(minA)),maxAmountTokenB:new BN(String(maxB)),
      sqrtPrice:quote.nextSqrtPrice,sqrtMinPrice:state.sqrtMinPrice,sqrtMaxPrice:state.sqrtMaxPrice,collectFeeMode:state.collectFeeMode})
      .muln(9999).divn(10000) // round safely below the maximum deposit amounts
    if(liquidity.lten(0))throw Error('No deployable liquidity')
    return {snapshot,state,quote,swapAmount,minA,maxB,liquidity}
  }
  async function createIntent({repoId,sourceAmount,idempotencyKey,createdBy}) {
    const rules=liquidityConfig();if(!rules)throw Error('Liquidity deployment is disabled')
    if(!/^[1-9]\d*$/.test(String(repoId))||!/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(idempotencyKey??''))throw Error('Invalid intent identifiers')
    const amount=BigInt(integer(sourceAmount,'deployment size'))
    if(amount<BigInt(rules.minDeployLamports)||amount>BigInt(rules.maxDeployLamports))throw Error('Deployment size outside approved bounds')
    return withLiquidityLock(pool,async db=>{
      if((await db.query('select 1 from liquidity_intents where idempotency_key=$1',[idempotencyKey])).rowCount)throw Error('A liquidity intent with this idempotency key already exists')
      if((await db.query("select 1 from liquidity_intents where github_repo_id=$1 and status in ('prepared','reviewed','simulated','submitted')",[String(repoId)])).rowCount)throw Error('An open liquidity intent already exists for this market')
      const check=await qualification(db,repoId,rules);if(!check.eligible)throw Error(`Market is not eligible: ${check.reason}`)
      const policy=await activePolicy(db);if(!policy)throw Error('No active platform revenue policy')
      if(amount>BigInt((await liquidityReserveSummary(db)).remaining))throw Error('Deployment exceeds the remaining liquidity reserve')
      const b=await quoteBudget(db,repoId,amount,rules)
      const {rows:[intent]}=await db.query(`insert into liquidity_intents
        (idempotency_key,github_repo_id,pool,network,source_amount,swap_amount,min_swap_output,source_wallet,token_a_mint,token_b_mint,
         max_amount_token_a,max_amount_token_b,max_slippage_bps,max_price_impact_bps,lp_owner,lock_mode,policy_version,rules_version,
         rules_json,minimum_liquidity,max_network_cost,status,expires_at,created_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$8,$15,$16,$17,$18,$19,$20,'prepared',now()+interval '30 minutes',$21) returning *`,
        [idempotencyKey,String(repoId),check.pool,await network(),String(amount),String(b.swapAmount),String(b.minA),partner.publicKey.toBase58(),check.tokenAMint,check.tokenBMint,
         String(b.minA),String(b.maxB),rules.maxSlippageBps,rules.maxPriceImpactBps,LOCK_MODE,policy.version,rules.rulesVersion,JSON.stringify(rules),b.liquidity.muln(10000-rules.maxSlippageBps).divn(10000).toString(),rules.maxNetworkCostLamports,createdBy])
      return {...publicIntent(intent),termsHash:liquidityTerms(intent)}
    })
  }
  async function reviewIntent({id,review,reviewedBy}) {
    if(!review||review.purpose!=='liquidity-intent-review'||!Number.isFinite(review.expiresAt)||review.expiresAt<=Date.now())throw Error('Liquidity review expired')
    return withLiquidityLock(pool,async db=>{
      const {rows:[intent]}=await db.query('select * from liquidity_intents where id=$1',[id])
      if(intent?.status!=='prepared')throw Error('Intent is not awaiting review')
      if(String(review.amount)!==String(intent.source_amount)||Number(review.id)!==id||review.termsHash!==liquidityTerms(intent))throw Error('Reviewed action differs from the prepared intent')
      if(Number(review.policyVersion)!==intent.policy_version)throw Error('Policy version mismatch')
      if(Number(review.rulesVersion)!==intent.rules_version)throw Error('Qualification rules version mismatch')
      if(new Date(intent.expires_at).getTime()<=Date.now())throw Error('Intent expired')
      await db.query("update liquidity_intents set status='reviewed',reviewed_by=$2,reviewed_at=now(),review=$3,quote_identifier=$4 where id=$1 and status='prepared'",[id,reviewedBy,JSON.stringify(review),review.termsHash])
      return {id,status:'reviewed'}
    })
  }
  async function validate(db,intent,expected) {
    const rules=liquidityConfig();if(!rules)throw Error('Liquidity deployment is disabled')
    if(!intent)throw Error('Unknown liquidity intent')
    if(intent.status!==expected)throw Error(`Only ${expected} intents can ${expected==='reviewed'?'be simulated':'execute'}`)
    const review=JSON.parse(intent.review??'null')
    if(new Date(intent.expires_at).getTime()<=Date.now()||!review||review.expiresAt<=Date.now())throw Error('Intent review expired')
    if(review.termsHash!==liquidityTerms(intent)||review.id!==intent.id)throw Error('Intent differs from the reviewed terms')
    if(intent.network!==await network()||intent.source_wallet!==partner.publicKey.toBase58()||intent.lp_owner!==intent.source_wallet||intent.lock_mode!==LOCK_MODE)throw Error('Intent authority or network changed')
    const policy=await activePolicy(db)
    if(!policy||policy.version!==intent.policy_version)throw Error('Policy version drift; re-review')
    if(JSON.stringify(rules)!==intent.rules_json)throw Error('Qualification rules drift; re-prepare')
    if(BigInt((await liquidityReserveSummary(db)).remaining)<0n)throw Error('Liquidity reserve is overcommitted')
    const check=await qualification(db,intent.github_repo_id,rules)
    if(!check.eligible)throw Error(`Market no longer eligible: ${check.reason}`)
    return rules
  }
  async function buildAction(db,intent,rules) {
    const b=await quoteBudget(db,intent.github_repo_id,BigInt(intent.source_amount),rules)
    if(b.snapshot.pool.toBase58()!==intent.pool||b.state.tokenAMint.toBase58()!==intent.token_a_mint||b.state.tokenBMint.toBase58()!==intent.token_b_mint)throw Error('Intent differs from the canonical market')
    if(BigInt(b.quote.outputAmount.toString())<BigInt(intent.min_swap_output))throw Error('Stale quote: output below reviewed minimum')
    const maxA=new BN(intent.max_amount_token_a),maxB=new BN(intent.max_amount_token_b)
    const delta=amm.getLiquidityDelta({maxAmountTokenA:maxA,maxAmountTokenB:maxB,sqrtPrice:b.quote.nextSqrtPrice,
      sqrtMinPrice:b.state.sqrtMinPrice,sqrtMaxPrice:b.state.sqrtMaxPrice,collectFeeMode:b.state.collectFeeMode}).muln(9999).divn(10000)
    if(delta.lt(new BN(intent.minimum_liquidity)))throw Error('Stale quote: liquidity below reviewed minimum')
    const tx=new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}))
    tx.add(await amm.swap2({payer:partner.publicKey,pool:b.snapshot.pool,inputTokenMint:NATIVE_MINT,outputTokenMint:b.state.tokenAMint,
      tokenAMint:b.state.tokenAMint,tokenBMint:b.state.tokenBMint,tokenAVault:b.state.tokenAVault,tokenBVault:b.state.tokenBVault,
      tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID,referralTokenAccount:null,swapMode:SwapMode.ExactIn,
      amountIn:new BN(intent.swap_amount),minimumAmountOut:new BN(intent.min_swap_output)}))
    const positionNft=Keypair.generate()
    tx.add(await amm.createPositionAndAddLiquidity({owner:partner.publicKey,pool:b.snapshot.pool,positionNft:positionNft.publicKey,
      liquidityDelta:delta,maxAmountTokenA:maxA,maxAmountTokenB:maxB,tokenAAmountThreshold:maxA,tokenBAmountThreshold:maxB,
      tokenAMint:b.state.tokenAMint,tokenBMint:b.state.tokenBMint,tokenAProgram:TOKEN_PROGRAM_ID,tokenBProgram:TOKEN_PROGRAM_ID}))
    return {tx,positionNft,liquidity:delta.toString()}
  }
  async function preflight(action,intent) {
    const latest=await connection.getLatestBlockhash('confirmed')
    action.tx.feePayer=partner.publicKey;action.tx.recentBlockhash=latest.blockhash;action.tx.sign(partner,action.positionNft)
    const wsol=getAssociatedTokenAddressSync(NATIVE_MINT,partner.publicKey)
    const accounts=[partner.publicKey,wsol,deriveTokenVaultAddress(NATIVE_MINT,new PublicKey(intent.pool))]
    const before=await connection.getMultipleAccountsInfo(accounts,'confirmed')
    const signed=new VersionedTransaction(action.tx.compileMessage());signed.sign([partner,action.positionNft])
    const sim=await connection.simulateTransaction(signed,{sigVerify:true,commitment:'confirmed',accounts:{encoding:'base64',addresses:accounts.map(key=>key.toBase58())}})
    if(sim.value.err)throw Error(`Liquidity preflight failed: ${JSON.stringify(sim.value.err)}`)
    if(!sim.value.accounts?.[0]||!sim.value.accounts[2]||!before[2])throw Error('Simulation account balances unavailable')
    const debit=before.slice(0,2).reduce((s,a)=>s+BigInt(a?.lamports??0),0n)-sim.value.accounts.slice(0,2).reduce((s,a)=>s+BigInt(a?.lamports??0),0n)
    const economicDebit=BigInt(sim.value.accounts[2].lamports)-BigInt(before[2].lamports),networkCost=debit-economicDebit
    if(economicDebit<=0n||economicDebit>BigInt(intent.source_amount)||networkCost<0n||networkCost>BigInt(intent.max_network_cost))throw Error('Simulated cost exceeds the reviewed budget')
    return {latest,simulation:{broadcast:false,debit:String(debit),economicDebit:String(economicDebit),networkCost:String(networkCost),units:sim.value.unitsConsumed}}
  }
  async function simulateIntent({id}) {
    return withLiquidityLock(pool,async db=>{
      const {rows:[intent]}=await db.query('select * from liquidity_intents where id=$1',[id])
      const rules=await validate(db,intent,'reviewed'), action=await buildAction(db,intent,rules)
      const {simulation}=await preflight(action,intent)
      await db.query("update liquidity_intents set status='simulated',simulated_at=now(),simulation=$2 where id=$1 and status='reviewed'",[id,JSON.stringify(simulation)])
      return {id,status:'simulated',expectedLiquidity:action.liquidity,simulation}
    })
  }
  async function executeIntent({id}) {
    return withLiquidityLock(pool,async db=>{
      const {rows:[intent]}=await db.query('select * from liquidity_intents where id=$1',[id])
      const rules=await validate(db,intent,'simulated'), action=await buildAction(db,intent,rules)
      const {latest}=await preflight(action,intent)
      if(JSON.parse(intent.review).expiresAt<=Date.now())throw Error('Review expired before signing')
      const signature=bs58.encode(action.tx.signature),bytes=action.tx.serialize().toString('base64')
      const {rows:[submitted]}=await db.query(`update liquidity_intents set status='submitted',submitted_at=now(),signature=$2,
        signed_transaction=$3,last_valid_block_height=$4,position_nft_mint=$5,expected_liquidity=$6 where id=$1 and status='simulated' returning *`,
        [id,signature,bytes,latest.lastValidBlockHeight,action.positionNft.publicKey.toBase58(),action.liquidity])
      if(!submitted)throw Error('Intent state changed')
      await connection.sendRawTransaction(action.tx.serialize(),{skipPreflight:false})
      await connection.confirmTransaction({signature,...latest},'finalized')
      return await settleLiquidityIntent(db,connection,submitted)??{id,status:'submitted',signature}
    })
  }
  async function cancelIntent({id}) {
    return withLiquidityLock(pool,async db=>{
      const {rows:[row]}=await db.query(`update liquidity_intents set status='aborted',resolved_at=now(),resolution_reason='Operator cancelled before submission'
        where id=$1 and status in ('prepared','reviewed','simulated') returning id,status`,[id])
      if(!row)throw Error('Submitted or settled intents cannot be cancelled')
      return row
    })
  }
  async function eligibleMarkets(rules) {
    const {rows}=await pool.query("select github_repo_id::text as id from markets where status='confirmed' and indexed_at is not null and launch_finality='finalized'")
    const result=[];for(const row of rows)result.push(await qualification(pool,row.id,rules).catch(()=>({eligible:false,repoId:row.id,reason:'Canonical state needs review'})))
    return result
  }
  return {qualification,eligibleMarkets,createIntent,reviewIntent,simulateIntent,executeIntent,cancelIntent}
}
function publicIntent(i) {
  return {id:i.id,repoId:String(i.github_repo_id),pool:i.pool,status:i.status,sourceAmount:String(i.source_amount),swapAmount:String(i.swap_amount),
    minSwapOutput:String(i.min_swap_output),maxTokenA:i.max_amount_token_a,maxTokenB:i.max_amount_token_b,minimumLiquidity:i.minimum_liquidity,
    maxNetworkCost:String(i.max_network_cost),lpOwner:i.lp_owner,lockMode:i.lock_mode,policyVersion:i.policy_version,rulesVersion:i.rules_version,network:i.network}
}
export async function reconcileLiquidity(db) {
  const summary=await liquidityReserveSummary(db),problems=[]
  if(BigInt(summary.remaining)<0n)problems.push('Liquidity reserve is negative')
  const {rows:[invalid]}=await db.query(`select count(*)::int as n from liquidity_intents where status='settled' and
    (position is null or settled_liquidity is null or settled_debit is null or settled_debit<=0 or settled_debit>source_amount or settled_network_cost is null or settled_network_cost<0 or settled_network_cost>max_network_cost or settled_token_a is null or settled_token_b is null)`)
  if(invalid.n)problems.push('Settled intent is missing bounded position evidence')
  return {status:problems.length?'MISMATCH':'MATCH',problems,summary}
}
