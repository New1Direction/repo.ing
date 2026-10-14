import Link from 'next/link'
import { cookies } from 'next/headers'
import { AppHeader, Footer } from '../../../components/ui'
import { LaunchManager } from '../../../components/launch-manager'
import { githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { webhooksEnabled } from '../../../../src/launch-webhooks.mjs'
import { schedulesEnabled, SCHEDULE_RULES } from '../../../../src/launch-schedules.mjs'
import { guideHref } from '../../../lib/launch-guide-funnel.mjs'
import '../../../transparency.css'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Schedule a launch · repo.ing', alternates: { canonical: '/launches/manage' }, robots: { index: false },
  description: 'Maintainers schedule their repository market launch in public; developers manage launch feed webhooks.' }

export default async function LaunchManagePage({ searchParams }) {
  const [cookieStore, query] = await Promise.all([cookies(), searchParams])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  return <><AppHeader active="explore"/><main className="section-wrap launches-page">
    <header className="launches-intro">
      <div className="eyebrow"><Link href="/launches">LAUNCH CALENDAR</Link></div>
      <h1>Schedule a launch in public.</h1>
      <p>Pick the time, the wallet that will sign the launch and the most it will buy in the launch transaction (never more than 3% of supply). The schedule is published at once on the calendar, the feeds and webhooks. Until the time nobody can launch the repository; during the window only that wallet can. You can cancel any time before it launches. New here? The <Link href={guideHref('manage')}>guided launch</Link> runs a preflight and walks through each step with a preview.</p>
    </header>
    <LaunchManager signedIn={Boolean(session)} githubLogin={session?.githubLogin ?? null} errorCode={typeof query.error === 'string' ? query.error : null}
      schedulingEnabled={schedulesEnabled()} webhooks={webhooksEnabled()} rules={{ minNoticeMinutes: SCHEDULE_RULES.minNoticeMs / 60_000,
        maxAheadDays: SCHEDULE_RULES.maxAheadMs / 86_400_000, minWindowMinutes: SCHEDULE_RULES.minWindowMinutes, maxWindowMinutes: SCHEDULE_RULES.maxWindowMinutes,
        defaultWindowMinutes: SCHEDULE_RULES.defaultWindowMinutes }}/>
  </main><Footer/></>
}
