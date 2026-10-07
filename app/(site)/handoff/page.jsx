import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { AppHeader, Footer } from '../../components/ui'
import { HANDOFF_AUDIENCE_LABEL, handoffCheckCode } from '../../../src/repo-inference-handoff.mjs'
import { githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { sessionVerifier } from '../../lib/github-session.mjs'
import { HANDOFF_COOKIE, handoffAvailable, readHandoffCookie, sealConsent } from '../../lib/handoff.mjs'
import { marketByRepo, repositoryById } from '../../lib/server.mjs'
import '../../handoff.css'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Confirm it is you · repo.ing', robots: { index: false, follow: false } }

// The consent page of the repo.ing AI credits sign-in handoff (src/repo-inference-handoff.mjs, step 2). The CLI's request
// comes only from the sealed cookie /api/handoff/start set, never from this URL; the form carries a sealed copy of what
// this page showed (approval refuses anything else) and the check code the terminal shows too. The admin check here
// writes nothing; approval runs the recorded one. Dark: not found unless the handoff is configured.
export default async function HandoffPage() {
  if (!handoffAvailable()) notFound()
  const cookieStore = await cookies()
  const request = readHandoffCookie(cookieStore.get(HANDOFF_COOKIE)?.value)
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  const repo = request ? await repositoryById(request.repoId).catch(() => null) : null
  const name = repo?.fullName ?? (request ? `repository ${request.repoId}` : null)
  let admin = false
  if (request && session?.scope === 'builders') {
    try {
      const { market } = await marketByRepo(request.repoId)
      admin = Boolean(market) && (await sessionVerifier(session, process.env.APP_ORIGIN || 'http://localhost:3000', { dashboard: true })
        .verifyRepositoryAdmin({ githubRepoId: request.repoId })).admin === true
    } catch { admin = false }
  }
  return <><AppHeader/><main className="section-wrap handoff-page">
    <header className="handoff-intro">
      <div className="eyebrow">{HANDOFF_AUDIENCE_LABEL.toUpperCase()}</div>
      <h1>Confirm it is you</h1>
      <p>{request ? <><code>repoing claim</code> on your computer asks repo.ing to confirm that you are an admin of <strong>{name}</strong>, so you can convert its fees into AI credits.</>
        : <>This sign-in request expired or was already used. Run <code>repoing claim</code> again.</>}</p>
    </header>
    {request && <section className="handoff-card" aria-labelledby="handoff-heading">
      {session?.scope !== 'builders' ? <>
        <h2 id="handoff-heading">Sign in with GitHub</h2>
        <p>Read-only. It only tells repo.ing who you are; the next step checks that you are an admin of {name}.</p>
        <div className="handoff-actions"><a className="button primary" href="/api/github/start?mode=handoff">Sign in with GitHub</a></div>
      </> : !admin ? <>
        <h2 id="handoff-heading">Not an admin of {name}</h2>
        <p className="inline-error" role="alert">GitHub does not list <strong>@{session.githubLogin}</strong> as an admin of {name}, or the repository has no market on repo.ing.</p>
        <form className="handoff-actions" method="post" action="/api/handoff/approve">
          <a className="button" href="/api/github/start?mode=handoff">Sign in with another account</a>
          <button className="button" type="submit" name="decision" value="deny">Cancel</button>
        </form>
      </> : <>
        <h2 id="handoff-heading">Signed in as @{session.githubLogin}</h2>
        <p><strong>{HANDOFF_AUDIENCE_LABEL}</strong> will get:</p>
        <ul className="handoff-shared">
          <li>your GitHub user ID and login</li>
          <li>that you are an admin of {name}</li>
          <li className="handoff-not">not your GitHub token, and nothing that can move your funds</li>
        </ul>
        <p className="handoff-check">Check code <strong>{handoffCheckCode(request.challenge)}</strong>: approve only if your terminal shows the same code.</p>
        <form className="handoff-actions" method="post" action="/api/handoff/approve">
          <input type="hidden" name="consent" value={sealConsent(request, session)}/>
          <button className="button primary" type="submit" name="decision" value="approve">Approve</button>
          <button className="button" type="submit" name="decision" value="deny">Cancel</button>
        </form>
        <p className="handoff-note">Your browser then returns to the CLI on this computer (127.0.0.1:{request.port}).</p>
      </>}
    </section>}
  </main><Footer/></>
}
