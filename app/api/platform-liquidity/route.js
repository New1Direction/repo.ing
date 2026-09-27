import { createLiquidityDeployment, liquidityReserveSummary, reconcileLiquidity, liquidityConfig, liquidityTerms } from '../../../src/liquidity-deployment.mjs'
import { database, chain, configAddress, partnerSigner } from '../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, seal, unseal } from '../../lib/auth.mjs'
import { requirePlatformOperator } from '../../lib/platform-operator.mjs'
import { publicOrigin } from '../../lib/origin.mjs'
export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }
const session = request => requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
const deployment = () => createLiquidityDeployment({pool:database(),connection:chain(),config:configAddress(),partner:partnerSigner()})
export async function GET(request) {
  let current
  try { current=session(request) } catch(error) { return Response.json({error:error.message},{status:error.status,headers}) }
  try {
    const db=database(),rules=liquidityConfig()
    const [summary,reconciliation,eligible,{rows}]=await Promise.all([
      liquidityReserveSummary(db),reconcileLiquidity(db),rules?deployment().eligibleMarkets(rules):[],
      db.query('select * from liquidity_intents order by id desc limit 20')])
    const intents=rows.map(i=>{
      const expiresAt=Math.min(new Date(i.expires_at).getTime(),current.expiresAt,Date.now()+10*60000)
      const terms={id:i.id,repoId:String(i.github_repo_id),pool:i.pool,amount:String(i.source_amount),swapAmount:String(i.swap_amount),
        minSwapOutput:String(i.min_swap_output),maxTokenA:i.max_amount_token_a,maxTokenB:i.max_amount_token_b,
        minimumLiquidity:i.minimum_liquidity,maxNetworkCost:String(i.max_network_cost),maxSlippageBps:i.max_slippage_bps,
        maxPriceImpactBps:i.max_price_impact_bps,sourceWallet:i.source_wallet,lpOwner:i.lp_owner,lockMode:i.lock_mode,
        policyVersion:i.policy_version,rulesVersion:i.rules_version,network:i.network,termsHash:liquidityTerms(i)}
      const review=expiresAt>Date.now()&&['prepared','simulated'].includes(i.status)?seal({...terms,
        purpose:i.status==='prepared'?'liquidity-intent-review':'liquidity-execute',sessionId:current.sessionId,githubUserId:current.githubUserId,expiresAt}):null
      return {...terms,status:i.status,review,signature:i.signature,position:i.position,settledDebit:i.settled_debit,
        settledNetworkCost:i.settled_network_cost,simulation:i.simulation?JSON.parse(i.simulation):null,expiresAt}
    })
    return Response.json({...summary,reconciliation,eligible,intents,executionEnabled:Boolean(rules)},{headers})
  }catch{return Response.json({error:'Liquidity state is temporarily unavailable.'},{status:503,headers})}
}
export async function POST(request) {
  try {
    assertSameOrigin(request,publicOrigin(request.url))
    const current=session(request),body=await request.json(),service=deployment(),id=Number(body.id)
    if(body.action!=='intent.create'&&(!Number.isSafeInteger(id)||id<=0))throw Error('Invalid intent ID')
    const reviewed = purpose => {
      const review=unseal(body.review)
      if(!review||review.purpose!==purpose||review.sessionId!==current.sessionId||review.githubUserId!==current.githubUserId||review.id!==id)throw Error('Review expired')
      return review
    }
    let result
    if(body.action==='intent.create')result=await service.createIntent({repoId:body.repoId,sourceAmount:body.sourceAmount,idempotencyKey:body.idempotencyKey,createdBy:current.githubUserId})
    else if(body.action==='intent.review')result=await service.reviewIntent({id,review:reviewed('liquidity-intent-review'),reviewedBy:current.githubUserId})
    else if(body.action==='intent.simulate')result=await service.simulateIntent({id})
    else if(body.action==='intent.cancel')result=await service.cancelIntent({id})
    else if(body.action==='intent.execute'){
      const review=reviewed('liquidity-execute')
      const {rows:[intent]}=await database().query('select * from liquidity_intents where id=$1',[id])
      if(!intent||liquidityTerms(intent)!==review.termsHash)throw Error('Reviewed action changed')
      result=await service.executeIntent({id})
    }else throw Error('Unsupported liquidity action')
    return Response.json({result},{headers})
  }catch(error){return Response.json({error:error.status?error.message:/disabled/.test(error.message)?'Liquidity execution is disabled.':'Action could not complete. Refresh the intent and check its receipt before retrying.'},{status:error.status??409,headers})}
}
