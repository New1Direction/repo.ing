import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { AppHeader, Footer, RepoIdentity } from '../../../components/ui'
import { BundleRaise } from '../../../components/bundle-raise'
import { BUNDLE_DEFAULTS, bundleLaunchable } from '../../../../src/bundle-launch.mjs'
import { bundleTokenImage } from '../../../../src/bundle-raise-store.mjs'
import { readBundleState } from '../../../lib/bundle-state.mjs'
import { chain, database } from '../../../lib/server.mjs'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Bundle raise · repo.ing', robots: { index: false, follow: false } }

// A Bundle raise (docs/BUNDLE_LAUNCH.md): the repository, the token the launch will create, the raise's progress and deadline,
// and the connected wallet's deposit, share, refund or claim. Shown whatever Bundle launches' switch says, so backers can always
// take a refund or claim; while it is off the page takes no deposit.
export default async function BundlePage({ params }) {
  const { id } = await params
  if (!/^[1-9]\d{0,18}$/.test(String(id))) notFound()
  const pool = database()
  if (!pool) notFound()
  let state, image = null
  try {
    state = await readBundleState({ pool, connection: chain(), id: BigInt(id) })
    if (state) image = await bundleTokenImage(pool, id).catch(() => null)
  } catch (error) {
    console.warn('bundle_page_unavailable', { code: error?.code ?? error?.name ?? 'error' })
    return <><AppHeader/><main className="section-wrap bundle-page"><h1>Bundle unavailable</h1><p>This bundle cannot be read right now. Try again shortly.</p></main><Footer/></>
  }
  if (!state) notFound()
  const repo = { repoId: state.repoId, fullName: state.fullName, owner: state.owner, name: state.name, description: state.description }
  // The bundle's own terms (copied from the platform when it was opened), else the site's defaults while it is not on chain.
  const percent = bps => `${bps / 100}%`
  const terms = { ops: percent(state.chain?.opsBps ?? BUNDLE_DEFAULTS.opsBps), backers: percent(state.chain?.backerBps ?? BUNDLE_DEFAULTS.backerBps) }
  return <><AppHeader/><main className="section-wrap bundle-page">
    <Link href={state.marketMint ? `/token/${state.marketMint}` : '/explore'} className="back-link"><ArrowLeft size={18}/>{state.marketMint ? 'Back to the market' : 'Back to explore'}</Link>
    <header className="bundle-hero">
      <div className="eyebrow">BUNDLE · COMMUNITY-FUNDED LAUNCH</div>
      <RepoIdentity repo={repo} heading/>
      <div className="bundle-token" role="group" aria-label="Token the launch creates">
        <div className="preview-avatar">{image ? <img src={image} alt={`$${state.tokenSymbol} token artwork`} width={56} height={56}/> : null}</div>
        <div><strong>${state.tokenSymbol}</strong><span>{state.tokenName}</span><small>{state.marketMint ? 'Trading now.' : 'Created when the raise is full and the market launches.'}</small></div>
      </div>
    </header>
    <BundleRaise initial={state} depositsOpen={bundleLaunchable()}/>
    <section className="inner-card bundle-terms" aria-labelledby="bundle-terms-title">
      <h2 id="bundle-terms-title">What backers get</h2>
      <ul>
        <li>At launch the raise, less {terms.ops} for operations, buys the market&apos;s first tokens into a permanent vault. The vault is traded only within fixed on-chain limits.</li>
        <li>Backers share {terms.backers} of the market&apos;s partner trading fees, after the vault&apos;s own trading fees are paid back to it, in proportion to what they deposited.</li>
        <li>The vault&apos;s SOL is never paid out. Builders keep their 0.994% of every trade.</li>
        <li>Most bundles earn little at today&apos;s volume: in our simulation the median bundle earned about 0.017 SOL of fees over its first days; one market in 52 earned 3.8 SOL.</li>
        <li>If the target is not reached by the deadline, every backer takes back exactly what they deposited.</li>
      </ul>
    </section>
  </main><Footer/></>
}
