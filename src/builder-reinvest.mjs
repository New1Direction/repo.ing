import bs58 from 'bs58'
import { PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { verifyClaimReceipt } from './claim-settlement.mjs'
import { verifyLiquidityReceipt } from './liquidity-settlement.mjs'
import { reconcileLiquidity } from './liquidity-deployment.mjs'
import { reconcilePlatformRevenue } from './platform-revenue.mjs'
import { createReconciler } from './reconcile.mjs'
import { REINVEST_RULES, json, digest, agree, assertReinvestNetwork, agreedTransaction,
  canonicalReinvestPool, reinvestQuote, assertFreshReinvestQuote, buildReinvestTransaction, simulateReinvest } from './builder-reinvest-chain.mjs'

const openStatuses=['prepared','cancelling','submitted']
const amount = value => {
  if (!/^[1-9]\d{0,15}$/.test(String(value))) throw Error('Enter a positive amount in lamports')
  return BigInt(value)
}
async function lock(pool, repoId, fn) {
  const db=await pool.connect()
  try { await db.query('select pg_advisory_lock($1::bigint)',[repoId]); return await fn(db) }
  finally { await db.query('select pg_advisory_unlock($1::bigint)',[repoId]); db.release() }
}
function termsFor(row) {
  const terms=JSON.parse(row.terms)
  if(digest(terms)!==row.terms_hash||terms.github_repo_id!==String(row.github_repo_id)||terms.claim_id!==row.claim_id||
    terms.source_wallet!==row.wallet||terms.lp_owner!==row.wallet||terms.source_amount!==String(row.source_amount)) throw Error('Reinvestment intent terms mismatch')
  return terms
}
const receiptIntent = (row, terms=termsFor(row)) => ({...terms,id:row.id,signature:row.signature,signed_transaction:row.signed_transaction})
function publicIntent(row) {
  const terms=termsFor(row)
  return {id:row.id,status:row.status,terms,termsHash:row.terms_hash,expiresAt:new Date(row.expires_at).toISOString(),
    transaction:row.status==='prepared'?row.prepared_transaction:null,signature:row.signature,position:row.position,
    simulation:JSON.parse(row.simulation),settlement:row.settlement?JSON.parse(row.settlement):null}
}

// An env switch alone cannot activate mainnet P4. Reverify the pinned, non-zero P3 proof.
export async function assertBuilderReinvestEnabled({pool,connection,verification,config,env=process.env}) {
  if(env.BUILDER_REINVEST_ENABLED!=='true') throw Error('Builder reinvestment is disabled')
  const network=await assertReinvestNetwork(connection,verification,env)
  if(network==='localnet') return network
  const signature=env.BUILDER_REINVEST_P3_SIGNATURE
  if(!signature) throw Error('P3 live MATCH proof is required')
  const {rows:[intent]}=await pool.query("select * from liquidity_intents where signature=$1 and status='settled' and network='mainnet'",[signature])
  if(!intent||BigInt(intent.settled_debit??0)<=0n||BigInt(intent.source_amount)>50000000n||BigInt(intent.max_network_cost)>12000000n) throw Error('P3 bounded live proof is required')
  if(!await agreedTransaction(connection,verification,signature)) throw Error('P3 finalized receipt unavailable')
  const proof=agree(...await Promise.all([connection,verification].map(c=>verifyLiquidityReceipt(c,intent))))
  if(proof?.status!=='settled'||proof.economicDebit!==String(intent.settled_debit)||proof.position!==intent.position||
    proof.liquidity!==intent.settled_liquidity||proof.networkCost!==String(intent.settled_network_cost)) throw Error('P3 settlement mismatch')
  const results=await Promise.all([reconcileLiquidity(pool),reconcilePlatformRevenue(pool),
    ...[connection,verification].map(c=>createReconciler({pool,connection:c,config}).reconcile(String(intent.github_repo_id)))])
  if(results.some(r=>r.status!=='MATCH')||results[0].summary.open!==0) throw Error('P3 final reconciliation MATCH is required')
  return network
}

export function createBuilderReinvest({pool,connection,verification,config,githubVerifier,env=process.env}) {
  const gate=()=>assertBuilderReinvestEnabled({pool,connection,verification,config,env})
  async function healthy(repoId) {
    const results=await Promise.all([connection,verification].map(c=>createReconciler({pool,connection:c,config}).reconcile(String(repoId))))
    if(results.some(r=>r.status!=='MATCH')) throw Error('Repository reconciliation must MATCH before reinvestment')
  }
  async function authority(db,{repoId,wallet,githubUserId}) {
    if(!/^[1-9]\d*$/.test(String(repoId))) throw Error('Invalid repository')
    if(new PublicKey(wallet).toBase58()!==wallet) throw Error('Wrong builder wallet')
    const github=await githubVerifier.verifyCurrentAuthority({githubRepoId:BigInt(repoId)})
    const age=Date.now()-new Date(github.verifiedAt).getTime()
    if(!github.verified||github.permission!=='admin'||String(github.githubRepoId)!==String(repoId)||String(github.githubUserId)!==String(githubUserId)||!Number.isFinite(age)||age>60000||age< -5000) throw Error('Current GitHub admin authority required')
    const {rows:[binding]}=await db.query('select wallet, bound_at from repo_beneficiaries where github_repo_id=$1',[repoId])
    if(!binding||binding.wallet!==wallet) throw Error('Wrong builder wallet; use the bound payout wallet')
    return new Date(binding.bound_at).toISOString()
  }
  async function market(db,repoId) {
    const {rows:[m]}=await db.query(`select github_repo_id::text as "githubRepoId",mint,pool,creator_wallet as "creatorWallet"
      from markets where github_repo_id=$1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`,[repoId])
    if(!m) throw Error('Repository has no indexed canonical market')
    return m
  }
  async function funding(db,repoId,wallet,signature) {
    const {rows:[claim]}=await db.query('select * from repo_claims where claim_signature=$1',[signature])
    if(!claim||String(claim.github_repo_id)!==String(repoId)||claim.beneficiary_wallet!==wallet||claim.status!=='settled'||claim.asset!==NATIVE_MINT.toBase58()) throw Error('Claim must settle to this repository’s builder wallet first')
    if(!await agreedTransaction(connection,verification,signature)) throw Error('Settled claim receipt unavailable')
    const proof=agree(...await Promise.all([connection,verification].map(c=>verifyClaimReceipt(c,{claimSignature:claim.claim_signature,
      signedTransaction:claim.signed_transaction,beneficiaryWallet:claim.beneficiary_wallet,amountBaseUnits:claim.amount_base_units,dammAmountBaseUnits:claim.damm_amount_base_units}))))
    if(proof?.status!=='settled'||String(proof.amountBaseUnits)!==String(claim.amount_base_units)) throw Error('Claim settlement mismatch')
    const {rows:[used]}=await db.query(`select coalesce(sum(case when status='settled' then settled_debit when status<>'aborted' then source_amount else 0 end),0)::text as amount
      from builder_reinvest_intents where claim_id=$1`,[claim.id])
    return {claim,remaining:BigInt(claim.amount_base_units)-BigInt(used.amount),proof}
  }
  async function status(request) {
    let enabled=false
    try {await gate();enabled=true} catch { /* Receipts remain readable while new execution is paused. */ }
    await assertReinvestNetwork(connection,verification,env)
    return lock(pool,String(request.repoId),async db=>{
      await authority(db,request)
      const snapshot=await canonicalReinvestPool(connection,verification,config,await market(db,request.repoId),pool)
      const funded=await funding(db,request.repoId,request.wallet,request.claimSignature)
      const {rows}=await db.query('select * from builder_reinvest_intents where claim_id=$1 order by id desc',[funded.claim.id])
      return {enabled,pool:snapshot.pool.toBase58(),claimAmount:String(funded.claim.amount_base_units),remaining:String(funded.remaining),
        wallet:request.wallet,intents:rows.map(publicIntent)}
    })
  }
  async function prepare(request) {
    const network=await gate()
    for(const key of ['pool','mint','receiver','lpOwner','tokenAMint','tokenBMint']) if(key in request) throw Error('Repository selects the canonical pool and assets')
    const budget=amount(request.sourceAmount)
    if(!/^[a-zA-Z0-9_-]{8,64}$/.test(request.idempotencyKey??'')) throw Error('Invalid idempotency key')
    await healthy(request.repoId)
    return lock(pool,String(request.repoId),async db=>{
      const boundAt=await authority(db,request)
      if((await db.query('select 1 from builder_reinvest_intents where idempotency_key=$1',[request.idempotencyKey])).rowCount) throw Error('Duplicate reinvestment intent; check its existing receipt')
      const funded=await funding(db,request.repoId,request.wallet,request.claimSignature)
      if(budget>funded.remaining) throw Error('Reinvestment exceeds the remaining claimed wallet amount')
      if((await db.query("select 1 from builder_reinvest_intents where claim_id=$1 and status in ('prepared','cancelling','submitted')",[funded.claim.id])).rowCount) throw Error('An existing reinvestment needs resolution first')
      const snapshot=await canonicalReinvestPool(connection,verification,config,await market(db,request.repoId),pool)
      // Do not nest the repository reconciler while holding its advisory lock on another connection.
      const quote=await reinvestQuote(connection,snapshot,budget)
      const built=await buildReinvestTransaction(connection,snapshot,request.wallet,quote)
      const terms={purpose:'builder-reinvest-v1',github_repo_id:String(request.repoId),claim_id:funded.claim.id,claim_signature:request.claimSignature,
        claimed_amount:String(funded.claim.amount_base_units),bound_at:boundAt,github_user_id:String(request.githubUserId),network,
        pool:snapshot.pool.toBase58(),source_wallet:request.wallet,lp_owner:request.wallet,lock_mode:'builder-authority',
        token_a_mint:snapshot.state.tokenAMint.toBase58(),token_b_mint:NATIVE_MINT.toBase58(),source_amount:String(budget),
        swap_amount:quote.swapAmount,min_swap_output:quote.minA,max_amount_token_a:quote.minA,max_amount_token_b:quote.maxB,
        minimum_liquidity:quote.minimumLiquidity,expected_liquidity:quote.liquidity,position_nft_mint:built.nft,
        max_network_cost:REINVEST_RULES.maxNetworkCostLamports,rules:REINVEST_RULES,
        expires_at:new Date(Date.now()+120000).toISOString(),message_hash:digest(built.tx.serializeMessage().toString('base64'))}
      const simulation=await simulateReinvest(connection,verification,built.tx,terms)
      const {rows:[row]}=await db.query(`insert into builder_reinvest_intents
        (idempotency_key,github_repo_id,claim_id,wallet,github_user_id,source_amount,terms,terms_hash,prepared_transaction,position,last_valid_block_height,expires_at,status,simulation)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13) returning *`,
        [request.idempotencyKey,request.repoId,funded.claim.id,request.wallet,String(request.githubUserId),String(budget),json(terms),digest(terms),
          built.tx.serialize({requireAllSignatures:false}).toString('base64'),built.position,built.latest.lastValidBlockHeight,terms.expires_at,json(simulation)])
      return publicIntent(row)
    })
  }
  async function submit(request) {
    await gate()
    await healthy(request.repoId)
    return lock(pool,String(request.repoId),async db=>{
      const boundAt=await authority(db,request)
      const {rows:[row]}=await db.query('select * from builder_reinvest_intents where id=$1',[request.id])
      if(!row||String(row.github_repo_id)!==String(request.repoId)||row.wallet!==request.wallet||row.github_user_id!==String(request.githubUserId)) throw Error('Wrong repository or builder wallet')
      if(row.status!=='prepared') throw Error('Duplicate or replayed intent; check its receipt')
      const terms=termsFor(row)
      if(terms.bound_at!==boundAt||terms.github_user_id!==String(request.githubUserId)) throw Error('Payout binding changed')
      if(request.termsHash!==row.terms_hash||json(terms.rules)!==json(REINVEST_RULES)) throw Error('Reinvestment review changed')
      if(new Date(row.expires_at).getTime()<=Date.now()) throw Error('Reinvestment intent expired')
      if(typeof request.signedTransaction!=='string'||request.signedTransaction.length>6000) throw Error('Invalid signed transaction')
      const tx=Transaction.from(Buffer.from(request.signedTransaction,'base64'))
      if(!tx.verifySignatures()||digest(tx.serializeMessage().toString('base64'))!==terms.message_hash||!tx.feePayer.equals(new PublicKey(row.wallet))) throw Error('Wallet signature or approved transaction mismatch')
      const funded=await funding(db,request.repoId,request.wallet,terms.claim_signature)
      if(funded.remaining<0n) throw Error('Claim is overcommitted')
      const snapshot=await canonicalReinvestPool(connection,verification,config,await market(db,request.repoId),pool)
      if(snapshot.pool.toBase58()!==terms.pool||snapshot.state.tokenAMint.toBase58()!==terms.token_a_mint||terms.token_b_mint!==NATIVE_MINT.toBase58()) throw Error('Wrong canonical pool or mint')
      const fresh=await reinvestQuote(connection,snapshot,row.source_amount)
      assertFreshReinvestQuote(terms,fresh)
      const heights=await Promise.all([connection,verification].map(c=>c.getBlockHeight('confirmed')))
      if(heights.some(h=>BigInt(h)>BigInt(row.last_valid_block_height))) throw Error('Reinvestment blockhash expired')
      await simulateReinvest(connection,verification,tx,terms,true)
      // Recheck authority after potentially slow RPC work, before accepting/broadcasting signed bytes.
      if(await authority(db,request)!==boundAt||new Date(row.expires_at).getTime()<=Date.now()) throw Error('Reinvestment review expired or binding changed')
      const signature=bs58.encode(tx.signature)
      const {rows:[submitted]}=await db.query("update builder_reinvest_intents set status='submitted',signature=$2,signed_transaction=$3,submitted_at=now() where id=$1 and status='prepared' returning *",
        [row.id,signature,tx.serialize().toString('base64')])
      if(!submitted) throw Error('Reinvestment state changed')
      await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false})
      await connection.confirmTransaction({signature,blockhash:tx.recentBlockhash,lastValidBlockHeight:Number(row.last_valid_block_height)},'finalized')
      await settleReinvest(db,connection,verification,submitted)
      return publicIntent((await db.query('select * from builder_reinvest_intents where id=$1',[row.id])).rows[0])
    })
  }
  async function cancel(request) {
    // Stopping an unsigned offer is permitted even if execution has since been disabled.
    return lock(pool,String(request.repoId),async db=>{
      await authority(db,request)
      const {rows:[row]}=await db.query(`update builder_reinvest_intents set status='cancelling' where id=$1 and github_repo_id=$2 and wallet=$3
        and github_user_id=$4 and status='prepared' returning *`,[request.id,request.repoId,request.wallet,String(request.githubUserId)])
      if(!row) throw Error('Submitted or resolved reinvestments cannot be cancelled')
      // The partial transaction was issued to a wallet. Hold its reservation until expiry proves it cannot land.
      return publicIntent(row)
    })
  }
  return {status,prepare,submit,cancel}
}

export async function settleReinvest(db,connection,verification,row) {
  if(!row.signature||!await agreedTransaction(connection,verification,row.signature)) return null
  const proof=agree(...await Promise.all([connection,verification].map(c=>verifyLiquidityReceipt(c,receiptIntent(row)))))
  if(proof?.status==='aborted'){
    await db.query("update builder_reinvest_intents set status='aborted',resolved_at=now(),resolution_reason='Finalized transaction failed' where id=$1 and status='submitted'",[row.id])
  } else if(proof?.status==='settled'){
    if(proof.position!==row.position) throw Error('Builder LP position mismatch')
    await db.query("update builder_reinvest_intents set status='settled',settled_at=now(),settled_debit=$2,settlement=$3 where id=$1 and status='submitted'",[row.id,proof.economicDebit,json(proof)])
  }
  return proof
}

export function createBuilderReinvestRecovery({pool,connection,verification,env=process.env}) {
  return {async runOnce(){
    const {rows}=await pool.query("select id,github_repo_id::text as repo from builder_reinvest_intents where status in ('prepared','cancelling','submitted') order by id")
    const results=[]
    for(const entry of rows){
      try { results.push(await lock(pool,entry.repo,async db=>{
        let row=(await db.query('select * from builder_reinvest_intents where id=$1',[entry.id])).rows[0]
        if(!openStatuses.includes(row.status)) return {id:row.id,status:row.status}
        if(await assertReinvestNetwork(connection,verification,env)!==termsFor(row).network) throw Error('Recovery network mismatch')
        // Wallets may broadcast independently after receiving a partial transaction. Discover only the exact issued message.
        if(!row.signature){
          const pages=await Promise.all([connection,verification].map(c=>c.getSignaturesForAddress(new PublicKey(row.position),{limit:1000},'finalized')))
          agree(...pages.map(p=>p.map(s=>({signature:s.signature,err:s.err,slot:s.slot}))))
          for(const item of pages[0]){
            const receipt=await agreedTransaction(connection,verification,item.signature)
            if(receipt&&digest(receipt.transaction.message.serialize().toString('base64'))===termsFor(row).message_hash){
              const tx=Transaction.populate(receipt.transaction.message,receipt.transaction.signatures)
              if(!tx.verifySignatures()) throw Error('Invalid wallet signatures in recovery')
              row=(await db.query("update builder_reinvest_intents set status='submitted',signature=$2,signed_transaction=$3,submitted_at=coalesce(submitted_at,now()) where id=$1 returning *",[row.id,item.signature,tx.serialize().toString('base64')])).rows[0]
              break
            }
          }
        }
        const proof=row.signature?await settleReinvest(db,connection,verification,row):null
        if(proof) return {id:row.id,status:proof.status}
        const statuses=row.signature?await Promise.all([connection,verification].map(c=>c.getSignatureStatuses([row.signature],{searchTransactionHistory:true}).then(r=>r.value[0]))):[null,null]
        // Either RPC knowing a signature is enough to retain the reservation.
        if(statuses.some(Boolean)) return {id:row.id,status:'submitted'}
        const heights=await Promise.all([connection,verification].map(c=>c.getBlockHeight('finalized')))
        if(heights.every(h=>BigInt(h)>BigInt(row.last_valid_block_height))){
          if(row.signature&&await agreedTransaction(connection,verification,row.signature)) return {id:row.id,status:'submitted'}
          const histories=await Promise.all([connection,verification].map(c=>c.getSignaturesForAddress(new PublicKey(row.position),{limit:1000},'finalized')))
          if(histories.some(p=>p.length)) return {id:row.id,status:'review'}
          const again=row.signature?await Promise.all([connection,verification].map(c=>c.getSignatureStatuses([row.signature],{searchTransactionHistory:true}).then(r=>r.value[0]))):[null,null]
          if(again.some(Boolean)) return {id:row.id,status:'submitted'}
          await db.query("update builder_reinvest_intents set status='aborted',resolved_at=now(),resolution_reason='Expired without chain evidence' where id=$1",[row.id])
          return {id:row.id,status:'aborted'}
        }
        if(row.status==='submitted') await connection.sendRawTransaction(Buffer.from(row.signed_transaction,'base64'),{skipPreflight:false})
        return {id:row.id,status:row.status}
      })) } catch {results.push({id:entry.id,status:'review'})}
    }
    return results
  }}
}

export async function reconcileBuilderReinvest({pool,connection,verification,repoId}) {
  const {rows}=await pool.query('select * from builder_reinvest_intents where github_repo_id=$1 order by id',[repoId])
  const problems=[],used=new Map(),verifiedClaims=new Set(); let settled=0n
  for(const row of rows){
    try{
      const terms=termsFor(row), {rows:[claim]}=await pool.query('select * from repo_claims where id=$1',[row.claim_id])
      if(!claim||claim.status!=='settled'||String(claim.github_repo_id)!==String(repoId)||claim.beneficiary_wallet!==row.wallet||terms.claim_signature!==claim.claim_signature||terms.claimed_amount!==String(claim.amount_base_units)) throw Error('Claim attribution mismatch')
      if(!verifiedClaims.has(claim.id)){
        if(!await agreedTransaction(connection,verification,claim.claim_signature)) throw Error('Funding claim receipt unavailable')
        const claimProof=agree(...await Promise.all([connection,verification].map(c=>verifyClaimReceipt(c,{claimSignature:claim.claim_signature,
          signedTransaction:claim.signed_transaction,beneficiaryWallet:claim.beneficiary_wallet,amountBaseUnits:claim.amount_base_units,dammAmountBaseUnits:claim.damm_amount_base_units}))))
        if(claimProof?.status!=='settled'||String(claimProof.amountBaseUnits)!==String(claim.amount_base_units)) throw Error('Funding claim settlement mismatch')
        verifiedClaims.add(claim.id)
      }
      used.set(row.claim_id,(used.get(row.claim_id)??0n)+(row.status==='settled'?BigInt(row.settled_debit):row.status==='aborted'?0n:BigInt(row.source_amount)))
      if(used.get(row.claim_id)>BigInt(claim.amount_base_units)) throw Error('Claim reinvestment exceeds settled payout')
      if(row.status==='submitted') throw Error('Submitted reinvestment requires settlement')
      if(row.status==='settled'){
        if(!await agreedTransaction(connection,verification,row.signature)) throw Error('Reinvestment receipt unavailable')
        const proof=agree(...await Promise.all([connection,verification].map(c=>verifyLiquidityReceipt(c,receiptIntent(row)))))
        if(proof?.status!=='settled'||json(proof)!==row.settlement||proof.economicDebit!==String(row.settled_debit)) throw Error('Reinvestment settlement mismatch')
        settled+=BigInt(row.settled_debit)
      }
    }catch(error){problems.push({id:row.id,reason:error.message})}
  }
  return {status:problems.length?'MISMATCH':'MATCH',problems,reinvested:String(settled),open:rows.filter(r=>openStatuses.includes(r.status)).length}
}
