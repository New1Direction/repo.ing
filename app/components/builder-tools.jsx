import { cookies } from 'next/headers'
import { githubSessionCookie, readGithubSession } from '../lib/auth.mjs'
import { database } from '../lib/server.mjs'
import { maintainerDecision } from '../lib/maintainer-opt-outs.mjs'
import { readRepoStream } from '../../src/repo-streams.mjs'
import { SponsorSnippet } from './sponsor-snippet'
import { StreamSettings } from './stream-settings'
import styles from './builder-kit.module.css'

// Claim page: the GitHub Sponsor snippet once the repository is verified on repo.ing, and the stream settings for the
// admin verified in this browser session (the server re-checks GitHub before every change). Both promote the market, so
// neither is shown while a maintainer's decline is active or cannot be read.
export async function ClaimBuilderTools({ market }) {
  const repoId = String(market.repoId)
  const [cookieStore, decision] = await Promise.all([cookies(), maintainerDecision(repoId)])
  const session = readGithubSession(cookieStore.get(githubSessionCookie)?.value)
  const admin = session?.repoId === repoId
  const verified = Boolean(market.wasVerified || market.beneficiaryWallet)
  if (decision !== null || (!verified && !admin)) return null
  const pool = database()
  // undefined: the form reads the link itself (and reports a read failure there).
  const stream = admin && pool ? await readRepoStream(pool, repoId).catch(() => undefined) : undefined
  return <section className={`inner-card ${styles.tools}`} aria-labelledby="builder-tools-title">
    <h2 id="builder-tools-title">Builder tools</h2>
    {verified && <div><h3>GitHub Sponsor button</h3><SponsorSnippet mint={market.mint}/></div>}
    {admin && <StreamSettings repoId={repoId} initial={stream}/>}
  </section>
}
