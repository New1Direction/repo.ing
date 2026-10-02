import Link from 'next/link'
import { AppHeader, Footer } from '../../components/ui'
import { ExploreNavigation } from '../../components/explore-navigation'
import { FindRepos } from '../../components/find-repos'
import { TrendingLaunches } from '../../components/trending-launches'
import { repositoryCandidates } from '../../lib/repo-discovery.mjs'
import { trendingLaunches } from '../../lib/trending-launches.mjs'
import { database, discoveryRewardsEnabled } from '../../lib/server.mjs'
import { promotionExcluded } from '../../lib/maintainer-opt-outs.mjs'
import { searchListCandidates } from '../../../src/trend-launchable.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Find repos · repo.ing', description: 'Find open source repositories gaining attention, launch a market for one that has none yet, or discover existing markets.' }

export default async function FindRepositories() {
  const [candidates, trending, excluded] = await Promise.all([repositoryCandidates(database()).catch(() => null), trendingLaunches(), promotionExcluded()])
  const smartSearch = process.env.REPO_SMART_SEARCH_ENABLED === 'true' && Boolean(process.env.TYPESAFE_API_KEY)
  return <><AppHeader active="explore"/><main className="section-wrap explore-page">
    <div className="page-intro"><div className="eyebrow">EXPLORE</div><h1>Find your next repository.</h1><p>{smartSearch ? 'Describe what you’re looking for, or explore projects gaining attention.' : 'Search open source projects and find repositories gaining attention.'}</p><Link href="/launch" className="button primary">Launch a repository</Link></div>
    <ExploreNavigation active="repos"/>
    <TrendingLaunches result={trending} discoveryEnabled={discoveryRewardsEnabled()} now={Date.now()}/>
    <h2 className="finder-heading">Search all tracked repos</h2>
    <FindRepos initial={candidates && excluded && searchListCandidates(candidates, trending.repos, excluded)} smartSearch={smartSearch}/>
  </main><Footer/></>
}
