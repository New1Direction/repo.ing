import { cookies } from 'next/headers'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from '../../components/ui'
import { BuilderDashboard } from '../../components/builder-dashboard'
import { OwnerLookup } from '../../components/owner-lookup'
import { FunnelBeacon } from '../../components/funnel-beacon'
import { githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { database, listMarkets } from '../../lib/server.mjs'
import { ownerQuery } from '../../lib/claim-funnel.mjs'
import { ownerRepositories } from '../../lib/owner-lookup.mjs'
import { recordFunnelEvent } from '../../../src/funnel-store.mjs'
import '../../claim-funnel.css'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Builder dashboard · repo.ing', robots: { index: false, follow: false } }
export default async function BuildersPage({ searchParams }) {
  const [cookieStore, query] = await Promise.all([cookies(),searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  const lookup = await ownerLookup(query.owner)
  return <><AppHeader active="builders"/><main className="section-wrap builders-page">
    <FunnelBeacon event="builders_view"/>
    <div className="builders-intro"><h1>Builder dashboard</h1><p>Your repositories. Your earnings. One place to claim.</p><Link href="/waiting" className="launch-find-link">See repositories with builder fees waiting for maintainers <ArrowRight size={15} aria-hidden="true"/></Link></div>
    <OwnerLookup owner={lookup.owner} defaultOwner={session?.githubLogin ?? ''} rows={lookup.rows} unavailable={lookup.unavailable}/>
    <BuilderDashboard signedIn={Boolean(session)} githubLogin={session?.githubLogin ?? null} errorCode={query.error}/>
  </main><Footer/></>
}

async function ownerLookup(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { owner: null, rows: null, unavailable: null }
  const owner = ownerQuery(raw)
  if (!owner) return { owner: null, rows: null, unavailable: 'Enter a GitHub user or organization name, like octocat.' }
  const { markets, unavailable } = await listMarkets()
  if (unavailable) return { owner, rows: null, unavailable: 'Builder fees are temporarily unavailable. Try again shortly.' }
  const rows = ownerRepositories(markets, owner)
  await recordFunnelEvent(database(), { event: 'owner_lookup', outcome: rows.length ? 'found' : 'none' })
  return { owner, rows, unavailable: null }
}
