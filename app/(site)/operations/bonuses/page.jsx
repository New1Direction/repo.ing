import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { VerificationBonusOperations } from '../../../components/verification-bonus-operations'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Verification bonuses — repo.ing', robots: { index: false, follow: false } }
export default async function VerificationBonusesPage() {
  let access = false
  try { requirePlatformOperator(readGithubSession((await cookies()).get(githubSessionCookie)?.value)); access = true } catch {}
  return <><AppHeader /><main className="section-wrap operations-page"><div className="growth-heading"><div><h1>Verification bonuses</h1><p>Launchers earn a one-time bonus when the maintainer verifies within 30 days. Review each one before it is paid.</p></div><div style={{ display: 'flex', gap: 12 }}><Link href="/operations/health">Health →</Link><Link href="/operations/invites">Invites →</Link></div></div>
    {access ? <VerificationBonusOperations /> : <div className="inner-card"><h2>Operator access required</h2><p>Sign in with the configured operator GitHub account.</p><Link className="button outline" href="/api/github/start?mode=builders">Verify with GitHub</Link><p>Return here after verification.</p></div>}
  </main><Footer /></>
}
