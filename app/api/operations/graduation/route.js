import { database } from '../../../lib/server.mjs'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { readGithubSession,githubSessionCookie,assertSameOrigin } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { graduationOperatorView } from '../../../../src/graduation-readiness.mjs'
export const runtime='nodejs'
const headers={'Cache-Control':'private, no-store'}
const operator=request=>requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
export async function GET(request){
  try{operator(request)}catch(error){return Response.json({error:error.message},{status:error.status??403,headers})}
  try{return Response.json(await graduationOperatorView(database()),{headers})}
  catch{return Response.json({error:'Graduation readiness is temporarily unavailable.'},{status:503,headers})}
}
export async function POST(request){
  try{
    const session=operator(request);assertSameOrigin(request,publicOrigin(request.url))
    const body=await request.json()
    if(body.action!=='acknowledge'||!Number.isSafeInteger(body.id)||body.id<=0)throw Error('Invalid alert')
    const {rowCount}=await database().query('update graduation_alerts set acknowledged_at=coalesce(acknowledged_at,now()),acknowledged_by=coalesce(acknowledged_by,$2) where id=$1',[body.id,session.githubUserId])
    return Response.json({acknowledged:rowCount===1},{headers})
  }catch(error){return Response.json({error:error.status?error.message:'Alert acknowledgement could not complete.'},{status:error.status??400,headers})}
}
