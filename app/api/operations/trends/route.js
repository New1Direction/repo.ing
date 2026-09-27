import { database,configAddress,discoveryRewardsEnabled } from '../../../lib/server.mjs'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { readGithubSession,githubSessionCookie,assertSameOrigin } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { growthSurface } from '../../../../src/discoverer-growth.mjs'
import { createTrendIntake,reviewTrend,trendError } from '../../../../src/trend-intake.mjs'
import { resolvePublicRepository } from '../../../../src/github.mjs'
export const runtime='nodejs'
const headers={'Cache-Control':'private, no-store'}
const operator=request=>requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
export async function GET(request){
  try{operator(request)}catch(error){return Response.json({error:error.message},{status:error.status??403,headers})}
  try{return Response.json(await growthSurface(database(),{operator:true}),{headers})}
  catch{return Response.json({error:'Trend operations are temporarily unavailable.'},{status:503,headers})}
}
export async function POST(request){
  try{
    const session=operator(request);assertSameOrigin(request,publicOrigin(request.url))
    const body=await request.json(),pool=database()
    let result
    if(body.action==='manual')result=await createTrendIntake({pool}).addManual(body,session.githubUserId)
    else if(body.action==='review')result=await reviewTrend({pool,repoId:String(body.repoId),to:body.state,revision:body.revision,
      operator:session.githubUserId,config:configAddress(),discoveryEnabled:discoveryRewardsEnabled(),resolve:resolvePublicRepository})
    else throw Error('INVALID_TREND_ACTION')
    return Response.json(result,{headers})
  }catch(error){return Response.json({error:error.status?error.message:trendError(error).replaceAll('_',' ')},{status:error.status??400,headers})}
}
