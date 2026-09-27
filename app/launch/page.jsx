import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { LaunchBenefits } from '../components/launch-benefits'
import { discoveryRewardsEnabled } from '../lib/server.mjs'
import { AppHeader, Footer } from '../components/ui'
import { RepoSearch } from '../components/repo-search'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Launch a repository · repo.ing' }
export default function LaunchStart() {
  return <><AppHeader active="launch"/><main className="section-wrap launch-start">
    <div className="page-intro"><div className="eyebrow">LAUNCH</div><h1>Give open source a market.</h1><p>Paste a public GitHub repository. Review the token and costs, then launch with your wallet.</p></div>
    <RepoSearch/>
    <Link href="/find-repos" className="launch-find-link">Find a repo gaining attention <ArrowRight size={15} aria-hidden="true"/></Link>
    <LaunchBenefits discoveryEnabled={discoveryRewardsEnabled()}/>
    <p className="launch-trust-note">One market per repository. Already launched? We’ll open its existing market. A community launch does not imply the maintainer’s endorsement.</p>
  </main><Footer/></>
}
