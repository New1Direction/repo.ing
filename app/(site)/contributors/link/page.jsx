import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { AppHeader, Footer } from '../../../components/ui'
import { ContributorWallet } from '../../../components/contributor-wallet'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { contributorWalletAvailable } from '../../../lib/contributor-wallet.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Contributor wallet · repo.ing', robots: { index: false, follow: false } }

// Contributor early access (docs/EARLY_ACCESS.md): a contributor links the wallet they buy with to their GitHub account.
// Dark: not found unless EARLY_ACCESS_ENABLED is "true".
export default async function ContributorLinkPage({ searchParams }) {
  if (!contributorWalletAvailable()) notFound()
  const [cookieStore, query] = await Promise.all([cookies(), searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  return <><AppHeader/><main className="section-wrap contributor-page">
    <header className="contributor-intro">
      <div className="eyebrow">CONTRIBUTORS</div>
      <h1>Link your wallet to GitHub</h1>
      <p>Some launches open with early access: for a short time, only the repository’s contributors can buy. Link the wallet you buy with to your GitHub account.</p>
    </header>
    <ol className="contributor-steps">
      <li><strong>Sign in with GitHub</strong><span>Read-only. It only tells repo.ing who you are.</span></li>
      <li><strong>Connect your wallet</strong><span>The wallet you will buy with.</span></li>
      <li><strong>Sign a message</strong><span>Free. It proves the wallet is yours and sends no transaction.</span></li>
    </ol>
    <ContributorWallet signedIn={Boolean(session)} githubLogin={session?.githubLogin ?? null} errorCode={typeof query.error === 'string' ? query.error : null}/>
  </main><Footer/></>
}
