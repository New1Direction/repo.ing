import { AppHeader, Footer } from '../components/ui'
import { RepoSearch } from '../components/repo-search'
export const metadata = { title: 'Launch a repository · repo.ing' }
export default function LaunchStart() {
  return <><AppHeader active="launch"/><main className="section-wrap launch-start">
    <div className="page-intro"><div className="eyebrow">LAUNCH</div><h1>Give open source a market.</h1><p>Paste a public GitHub repository. Review the token and costs, then launch with your wallet.</p></div>
    <RepoSearch/>
    <p className="subtle-notice">Already tokenized? We’ll take you to its existing market. You don’t need to own the repository to launch it.</p>
  </main><Footer/></>
}
