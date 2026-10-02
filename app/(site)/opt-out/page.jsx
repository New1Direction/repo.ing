import Link from 'next/link'
import { cookies } from 'next/headers'
import { AppHeader, Footer } from '../../components/ui'
import { MaintainerOptOut } from '../../components/maintainer-opt-out'
import { ModelOptOut } from '../../components/hf/model-opt-out'
import { githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { hfSessionCookie, publicHfUser, readHfSession } from '../../lib/hf-auth.mjs'
import { hfMarketsEnabled } from '../../../src/hf-launch.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Maintainers: opt out · repo.ing', alternates: { canonical: '/opt-out' },
  description: 'Maintainers of a public GitHub repository can opt it out of repo.ing so nobody can launch a market for it, or decline a market that already exists.' }

export default async function OptOutPage({ searchParams }) {
  const [cookieStore, query] = await Promise.all([cookies(), searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  // Hugging Face models (HF_MARKETS_ENABLED): their own sign-in and their own error codes (hf-*).
  const models = hfMarketsEnabled()
  const error = typeof query.error === 'string' ? query.error : null
  const hfError = error?.startsWith('hf-') ? error : null
  return <><AppHeader/><main className="section-wrap opt-out-page">
    <header className="opt-out-intro">
      <div className="eyebrow">MAINTAINERS</div>
      <h1>Your repository, your call.</h1>
      <p>Anyone can launch a market for a public GitHub repository on repo.ing. If you maintain one and don’t want that, opt it out: nobody can launch it here, and repo.ing never suggests or promotes it.</p>
    </header>
    <ol className="opt-out-steps">
      <li><strong>Sign in with GitHub</strong><span>Read-only. It only tells repo.ing who you are.</span></li>
      <li><strong>Pick a repository you admin</strong><span>Your admin access is checked with GitHub again before anything changes.</span></li>
      <li><strong>Opt it out</strong><span>Add a public note if you like. Withdraw any time.</span></li>
    </ol>
    <MaintainerOptOut signedIn={Boolean(session)} githubLogin={session?.githubLogin ?? null} errorCode={hfError ? null : error} models={models}/>
    {models && <ModelOptOut signedIn={publicHfUser(readHfSession(cookieStore.get(hfSessionCookie)?.value))}
      initialModel={typeof query.model === 'string' ? query.model.slice(0, 300) : null} errorCode={hfError}/>}
    <section className="opt-out-market-note" aria-labelledby="opt-out-market-title">
      <h2 id="opt-out-market-title">Already has a market?</h2>
      <p>A launched token can’t be taken back off the blockchain, and its holders must always be able to sell. You can decline it instead: repo.ing stops promoting it, its token page says you declined it and that it is not endorsed by the project, and the builder fees it earns stay claimable by you. Decline it here once you sign in, on its claim page, or from the <Link href="/builders">Builder dashboard</Link>.</p>
    </section>
  </main><Footer/></>
}
