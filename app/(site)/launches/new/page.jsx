import { cookies } from 'next/headers'
import Link from 'next/link'
import { AppHeader, Footer } from '../../../components/ui'
import { LaunchGuide } from '../../../components/launch-guide'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { guideSource } from '../../../lib/launch-guide-funnel.mjs'
import { schedulesEnabled, SCHEDULE_RULES } from '../../../../src/launch-schedules.mjs'
import '../../../transparency.css'
import '../../../launch-guide.css'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Guided launch for maintainers · repo.ing', alternates: { canonical: '/launches/new' },
  description: 'Run a free launch preflight on any public GitHub repository, then schedule your repository\'s market launch in public: Launch Quality facts, exact requirements, seeded liquidity and lock states, and a preview before you publish.' }

const ERRORS = { 'github-cancelled': 'GitHub sign-in was cancelled, so nothing was shared. Sign in when you\'re ready.',
  'verification-failed': 'GitHub could not confirm your sign-in just now. This is usually temporary: try again.',
  'github-unavailable': 'GitHub sign-in is unavailable right now. The preflight still works without it.' }

// /launches/new: the guided launch (docs/LAUNCH_GUIDE.md). Server part: who is signed in and the scheduling rules; the steps run in
// the browser against /api/launch-guide and /api/launch-preflight.
export default async function LaunchGuidePage({ searchParams }) {
  const [cookieStore, query] = await Promise.all([cookies(), searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  const text = value => (typeof value === 'string' && value.length <= 256 ? value : null)
  const draftId = /^[0-9a-f-]{36}$/.test(text(query.draft) ?? '') ? query.draft : null
  return <><AppHeader active="launch"/><main className="section-wrap launches-page launch-guide-page">
    <header className="launches-intro">
      <div className="eyebrow"><Link href="/launches">LAUNCH CALENDAR</Link> · GUIDED LAUNCH</div>
      <h1>Launch your repository&apos;s market, with the facts first.</h1>
      <p>Run a free preflight on any public repository: the Launch Quality facts we can know before launch, what is still unknown, and exactly what a launch needs. Maintainers then plan a public launch time, disclose what is seeded and how it is locked, preview the public page and publish. Nothing is published until the last step, and nothing anyone pays changes a score.</p>
    </header>
    <LaunchGuide signedIn={Boolean(session)} githubLogin={session?.githubLogin ?? null} initialRepo={text(query.repo)} initialDraftId={draftId}
      source={guideSource(query.src)} errorMessage={ERRORS[text(query.error)] ?? null} schedulingEnabled={schedulesEnabled()}
      rules={{ minNoticeMinutes: SCHEDULE_RULES.minNoticeMs / 60_000, maxAheadDays: SCHEDULE_RULES.maxAheadMs / 86_400_000,
        minWindowMinutes: SCHEDULE_RULES.minWindowMinutes, maxWindowMinutes: SCHEDULE_RULES.maxWindowMinutes, defaultWindowMinutes: SCHEDULE_RULES.defaultWindowMinutes }}/>
  </main><Footer/></>
}
