import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { AppHeader, Footer } from '../../components/ui'
import { BackedRepoCapture } from '../../components/backed-repo-capture'
import { CreditPacks } from '../../components/credit-packs/credit-packs'
import { builderSharesSettings } from '../../../src/builder-pack-shares.mjs'
import { creditsPacksSettings } from '../../../src/credits-packs.mjs'
import { displayFont, monoFont } from '../../home-fonts'
import { githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { creditPacksAvailable } from '../../lib/credit-packs.mjs'
import '../../credits.css'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'AI credit packs · repo.ing', description: 'Open a pack of repo.ing AI credits, paid in SOL. Every pack pays at least its price in credits.' }

// AI credit packs (src/credits-packs.mjs): the shelf, the odds and one-click buying for anyone signed in with GitHub. Dark: not
// found unless the packs are switched on.
export default async function CreditsPage({ searchParams }) {
  if (!creditPacksAvailable()) notFound()
  const [cookieStore, query] = await Promise.all([cookies(), searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  const shares = builderSharesSettings()
  return <><AppHeader/><main className={`section-wrap credits-page ${displayFont.variable} ${monoFont.variable}`}>
    <header className="credits-intro">
      <div className="eyebrow">AI CREDITS</div>
      <h1>Open a pack. <span>Every pull pays in full.</span></h1>
      <p>repo.ing AI credits pay for AI models in your coding tools. A pack costs $10, $25, $50 or $100 in SOL and holds at least that much in credits. Each pack spins once, and a win adds bonus credits: up to 5× the pack in all.</p>
      {query?.error === 'verification-failed' && <p className="inline-error" role="alert">GitHub sign-in did not finish. Try again.</p>}
    </header>
    {/* Before the packs: a token page's "Open a pack for owner/name" link (?repo=) is stored before the packs ask for it. */}
    {shares && <BackedRepoCapture/>}
    <CreditPacks signedIn={Boolean(session)} login={session?.githubLogin ?? null} network={creditsPacksSettings().network}
      builderShares={shares ? { shareBps: shares.shareBps } : null}
      fonts={{ display: displayFont.style.fontFamily, mono: monoFont.style.fontFamily }}/>
  </main><Footer/></>
}
