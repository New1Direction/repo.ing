import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { PlatformFeeOperations } from '../../../components/platform-fee-operations'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Platform fees — repo.ing', robots: { index: false, follow: false } }
export default async function PlatformFeesPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Platform fees</h1><p>Collect the repo.ing share and apply the allocation policy.</p></div><div style={{ display: 'flex', gap: 12 }}><Link href="/operations/health">Health →</Link><Link href="/operations/trends">Trending candidates →</Link></div></div>
    {access ? <PlatformFeeOperations /> : <div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></div>}
  </main><Footer /></>
}
