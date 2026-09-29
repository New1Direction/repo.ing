import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader,Footer } from '../../../components/ui'
import { GraduationOperations } from '../../../components/graduation-operations'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie,readGithubSession } from '../../../lib/auth.mjs'
export const dynamic='force-dynamic'
export const metadata={title:'Graduation operations — repo.ing',robots:{index:false,follow:false}}
export default async function GraduationPage(){
  let access=false
  try{requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value));access=true}catch{}
  return <><AppHeader/><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Graduation readiness</h1></div><Link href="/operations/health">Health →</Link></div>
    {access?<GraduationOperations/>:<div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return to this page after verification.</p></div>}
  </main><Footer/></>
}
