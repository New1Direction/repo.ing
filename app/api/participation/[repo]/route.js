import { database } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, seal, unseal } from '../../../lib/auth.mjs'
import { sessionVerifier } from '../../../lib/github-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
const headers = { 'Cache-Control': 'private, no-store' }
export const runtime = 'nodejs'
export async function GET(request,{params}) {
  const {repo}=await params
  if(!/^[1-9]\d*$/.test(repo))return Response.json({error:'Invalid repository'},{status:400,headers})
  const session=readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if(!session||!(session.repoId===repo||session.scope==='builders'))return Response.json({signedIn:false},{headers})
  const {rows:[state]}=await database().query('select enabled from repository_participation where github_repo_id=$1',[repo])
  return Response.json({signedIn:true,enabled:state?.enabled??false,review:seal({purpose:'participation-review',repoId:repo,
    sessionId:session.sessionId,githubUserId:session.githubUserId,expiresAt:Math.min(session.expiresAt,Date.now()+600000)})},{headers})
}
export async function POST(request,{params}) {
  try {
    const {repo}=await params
    assertSameOrigin(request,publicOrigin(request.url))
    const session=readGithubSession(request.cookies.get(githubSessionCookie)?.value)
    const body=await request.json(),review=unseal(body.review)
    if(!session||review?.purpose!=='participation-review'||review.repoId!==repo||review.sessionId!==session.sessionId||
      review.githubUserId!==session.githubUserId||typeof body.enabled!=='boolean')throw Error('Review expired')
    const authority=await sessionVerifier(session,request.url,{dashboard:true}).verifyCurrentAuthority({githubRepoId:BigInt(repo)})
    if(String(authority.githubUserId)!==session.githubUserId)throw Error('GitHub identity changed')
    await database().query(`insert into repository_participation(github_repo_id,github_user_id,github_login,enabled,opted_in_at)
      values($1,$2,$3,$4,now()) on conflict(github_repo_id) do update set github_user_id=excluded.github_user_id,
      github_login=excluded.github_login,enabled=excluded.enabled,opted_in_at=excluded.opted_in_at`,[repo,session.githubUserId,authority.githubLogin,body.enabled])
    return Response.json({enabled:body.enabled},{headers})
  } catch { return Response.json({error:'Could not update participation. Refresh and verify current GitHub admin access.'},{status:403,headers}) }
}
