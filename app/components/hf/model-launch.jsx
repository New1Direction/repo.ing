import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, ArrowUpRight, Ban, Boxes, Info } from 'lucide-react'
import { AppHeader, Footer } from '../ui'
import { LaunchForm } from '../launch-form'
import { marketByRepo, launchAvailable, discoveryRewardsEnabled, builderAllocationEnabled } from '../../lib/server.mjs'
import { checkAgentDraft } from '../../lib/agent-launch.mjs'
import { activeLaunchFeeTerms } from '../../lib/launch-fee.mjs'
import { maintainerDecision } from '../../lib/maintainer-opt-outs.mjs'
import { modelForLaunch } from '../../lib/hf-launch.mjs'
import { HF_MARKETS_UNAVAILABLE, HF_OPT_OUT_ERROR, hfMarketsEnabled } from '../../../src/hf-launch.mjs'
import { HF_DISCLAIMER } from '../../../src/hf-copy.mjs'
import { hfModelUrl } from '../../../src/hf-url.mjs'
import '../../maintainer-opt-out.css'
import '../../hf-launch.css'

const dayLabel = value => new Date(value).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })

function Page({ children }) {
  return <><AppHeader active="launch"/><main className="section-wrap launch-page">{children}</main><Footer/></>
}

function Notice({ title, children, action }) {
  return <Page><section className="launch-blocked inner-card" aria-labelledby="model-launch-notice">
    <h1 id="model-launch-notice">{title}</h1><p className="launch-blocked-lead">{children}</p>
    <div className="launch-blocked-actions">{action}</div>
  </section></Page>
}

// The model, as resolved from Hugging Face (src/hf-launch.mjs): its path, what the Hub says it is, and the disclaimer.
function ModelHero({ model }) {
  const [base, ...more] = Array.isArray(model.baseModels) ? model.baseModels : []
  const slash = model.fullName.indexOf('/')
  return <section className="repo-hero-card model-launch-hero" aria-labelledby="model-launch-title">
    <div>
      <div className="repo-identity">
        <div className="repo-avatar large"><Boxes size={56} aria-hidden="true"/></div>
        <div className="repo-identity-copy">
          <div className="repo-name-line"><h1 id="model-launch-title" className="repo-name-heading"><strong>{model.fullName.slice(0, slash + 1)}<wbr/>{model.fullName.slice(slash + 1)}</strong></h1></div>
          <p>{model.description || 'Public Hugging Face model'}</p>
          <div className="model-launch-badges">
            <span className="badge">Hugging Face model</span>
            <span className="badge">{`${model.ownerKind === 'org' ? 'Organization' : 'User'}: ${model.owner}`}</span>
            {model.gated && <span className="badge">Gated access</span>}
            {base && <span className="badge" title={base.relation ? `Relation to its base model: ${base.relation}` : undefined}>Derivative of {base.path}{more.length ? ` +${more.length}` : ''}</span>}
          </div>
        </div>
      </div>
      <p className="community-launch-note" role="note"><Info size={18} aria-hidden="true"/><span><strong>{HF_DISCLAIMER}</strong> Trading fees accrue for the model&apos;s current owner, who can claim them after verifying on repo.ing.</span></p>
    </div>
    <div className="repo-hero-right">
      <a className="button outline github-link" href={hfModelUrl(model.fullName)} target="_blank" rel="noopener noreferrer">View model page<ArrowUpRight size={16} aria-hidden="true"/></a>
      <div className="repo-details">
        <span>{model.createdAt ? `Created ${dayLabel(model.createdAt)}` : 'Creation date unavailable'}</span>
        <span>{model.updatedAt ? `Updated ${dayLabel(model.updatedAt)}` : 'Update date unavailable'}</span>
      </div>
    </div>
  </section>
}

// /launch/[id] for a Hugging Face model market (app/(site)/launch/[repo]/page.jsx returns this early for the model id
// range). Dormant until HF_MARKETS_ENABLED; the model is the one /api/resolve (or an agent's resolve_model) registered.
// A launched market is opened even with the flag off (a database read only), so holders can always reach it.
export async function ModelLaunch({ repoId, searchParams }) {
  const { market } = await marketByRepo(repoId)
  if (market) redirect(`/token/${market.mint}`)
  if (!hfMarketsEnabled()) return <Notice title="Not available yet" action={<Link href="/launch" className="button outline">Launch a repository</Link>}>{HF_MARKETS_UNAVAILABLE}</Notice>
  const model = await modelForLaunch(repoId)
  if (model === null) notFound()
  const decision = model === undefined ? undefined : await maintainerDecision(repoId)
  if (decision === undefined) return <Notice title="Launch review unavailable" action={<Link href={`/launch/${repoId}`} className="button outline">Try again</Link>}>Launch checks are temporarily unavailable. Try again shortly.</Notice>
  if (decision !== null) return <Page><section className="launch-blocked inner-card" aria-labelledby="launch-blocked-title">
    <span className="declined-banner-icon" aria-hidden="true"><Ban size={20}/></span>
    <h1 id="launch-blocked-title">Launch unavailable</h1>
    <p className="launch-blocked-lead">{HF_OPT_OUT_ERROR}.</p>
    <p className="declined-meta">The owner of {model.fullName} opted it out on <time dateTime={decision.createdAt}>{dayLabel(decision.createdAt)}</time>. repo.ing will not launch, suggest or promote it.</p>
    <div className="launch-blocked-actions"><Link href="/launch" className="button outline">Launch something else</Link></div>
  </section></Page>
  const query = await searchParams
  let draft
  if (query.draft !== undefined) {
    try { draft = checkAgentDraft(query.draft, repoId) }
    catch (error) { return <Notice title="Launch review unavailable" action={<Link href={`/launch/${repoId}`} className="button outline">Start a fresh review</Link>}>{error.message}</Notice> }
  }
  // Explained only when the config new launches use has a launch fee (read once per config, then cached).
  const launchFee = await activeLaunchFeeTerms()
  // A config that reserves the builder allocation stamps it on the model market too (for the model's verified owner); the
  // verification bonus never applies to a model.
  return <Page>
    <Link href="/launch" className="back-link"><ArrowLeft size={18}/>Back to launch</Link>
    <ModelHero model={model}/>
    <LaunchForm key={`${repoId}:${query.draft || 'manual'}`} repo={model} available={launchAvailable()} discoveryEnabled={discoveryRewardsEnabled()}
      draft={draft ? { token: query.draft, tokenName: draft.tokenName, tokenSymbol: draft.tokenSymbol, initialBuy: draft.initialBuy } : undefined}
      allocationEnabled={builderAllocationEnabled()} verificationBonus={null} launchFee={launchFee}/>
  </Page>
}
