import Link from 'next/link'
import { AppHeader, Footer } from '../../components/ui'
import { ExploreNavigation } from '../../components/explore-navigation'
import { FindRepos } from '../../components/find-repos'
import { repositoryCandidates } from '../../lib/repo-discovery.mjs'
import { database } from '../../lib/server.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Find repos · repo.ing', description: 'Find open source repositories gaining attention and discover their markets.' }

export default async function FindRepositories() {
  let candidates = null
  try { candidates = await repositoryCandidates(database()) } catch {}
  const smartSearch = process.env.REPO_SMART_SEARCH_ENABLED === 'true' && Boolean(process.env.TYPESAFE_API_KEY)
  return <><AppHeader active="explore"/><main className="section-wrap explore-page">
    <div className="page-intro"><div className="eyebrow">EXPLORE</div><h1>Find your next repository.</h1><p>{smartSearch ? 'Describe what you’re looking for, or explore projects gaining attention.' : 'Search open source projects and find repositories gaining attention.'}</p><Link href="/launch" className="button primary">Launch a repository</Link></div>
    <ExploreNavigation active="repos"/>
    <FindRepos initial={candidates} smartSearch={smartSearch}/>
  </main><Footer/></>
}
