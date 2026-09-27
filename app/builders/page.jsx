import { cookies } from 'next/headers'
import { AppHeader, Footer } from '../components/ui'
import { BuilderDashboard } from '../components/builder-dashboard'
import { githubSessionCookie, readGithubSession } from '../lib/auth.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Builder dashboard · repo.ing', robots: { index: false, follow: false } }
export default async function BuildersPage({ searchParams }) {
  const [cookieStore, query] = await Promise.all([cookies(),searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  return <><AppHeader active="builders"/><main className="section-wrap builders-page">
    <div className="builders-intro"><h1>Builder dashboard</h1><p>Your repositories. Your earnings. One place to claim.</p></div>
    <BuilderDashboard signedIn={Boolean(session)} githubLogin={session?.githubLogin ?? null} errorCode={query.error}/>
  </main><Footer/></>
}
