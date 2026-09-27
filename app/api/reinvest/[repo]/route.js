import { Connection } from '@solana/web3.js'
import { createBuilderReinvest } from '../../../../src/builder-reinvest.mjs'
import { database, chain, configAddress } from '../../../lib/server.mjs'
import { githubSessionCookie, readGithubSession, assertSameOrigin } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
const headers = {'Cache-Control':'private, no-store'}
function access(request, repoId) {
  const session=readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if(!session||!(/^[1-9]\d*$/.test(repoId))||session.scope!=='builders'&&session.repoId!==repoId) throw Error('Verify GitHub for this repository first')
  return session
}
function service(session, url) {
  if(!process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL) throw Error('Builder reinvestment verification is unavailable')
  return createBuilderReinvest({pool:database(),connection:chain(),verification:new Connection(process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL,'finalized'),
    config:configAddress(),githubVerifier:sessionVerifier(session,url,{dashboard:session.scope==='builders'})})
}
export async function GET(request,{params}) {
  const {repo}=await params
  let session
  try {session=access(request,repo)} catch {return Response.json({error:'Verify GitHub for this repository first'},{status:403,headers})}
  if(process.env.BUILDER_REINVEST_ENABLED!=='true'&&!process.env.BUILDER_REINVEST_VERIFICATION_RPC_URL) return Response.json({enabled:false,error:'Builder reinvestment is not enabled yet.'},{headers})
  try {
    const url=new URL(request.url)
    return Response.json(await service(session,request.url).status({repoId:repo,wallet:url.searchParams.get('wallet'),
      claimSignature:url.searchParams.get('claim'),githubUserId:session.githubUserId}),{headers})
  } catch {return Response.json({error:'Reinvestment status could not be verified. Check the existing transaction before another attempt.'},{status:409,headers})}
}
export async function POST(request,{params}) {
  const {repo}=await params
  let session,body
  try {
    assertSameOrigin(request,publicOrigin(request.url));session=access(request,repo)
    if(Number(request.headers.get('content-length')??0)>10000) throw Error('Request too large')
    body=await request.json()
    const allowed=['action','wallet','claimSignature','sourceAmount','idempotencyKey','id','termsHash','signedTransaction']
    if(Object.keys(body).some(k=>!allowed.includes(k))) throw Error('Unexpected reinvestment fields')
  } catch {return Response.json({error:'Invalid or expired reinvestment request.'},{status:403,headers})}
  if(process.env.BUILDER_REINVEST_ENABLED!=='true'&&body.action!=='cancel') return Response.json({error:'Builder reinvestment is not enabled yet.'},{status:403,headers})
  try {
    const action=service(session,request.url)[body.action]
    if(!['prepare','submit','cancel'].includes(body.action)) throw Error('Unsupported reinvestment action')
    if(body.action!=='prepare'&&(!Number.isSafeInteger(body.id)||body.id<=0)) throw Error('Invalid intent')
    const result=await action({...body,repoId:repo,githubUserId:session.githubUserId})
    return Response.json({result},{headers})
  } catch(error) {
    // Never expose RPC URLs/credentials or signed bytes from provider exceptions.
    const safe=/^(Claim must settle|Reinvestment exceeds|Duplicate|Wrong repository|Wrong builder|Payout binding changed|Reinvestment review changed|Reinvestment intent expired|Wallet signature|Wrong canonical|Stale quote|Reinvestment blockhash expired|Reinvestment price impact|Reinvestment simulation|Reinvestment amount|RPC disagreement|An existing reinvestment|Repository has not graduated|Builder reinvestment is disabled|P3 )/.test(error.message)
    return Response.json({error:safe?error.message:'Reinvestment could not be confirmed. Refresh its status before trying again.'},{status:409,headers})
  }
}
