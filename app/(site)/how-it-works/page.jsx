import Link from 'next/link'
import { RepositoryFlow } from '../../components/repository-flow'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from '../../components/ui'
import { FlywheelVideo } from '../../components/flywheel-video'
import { activeLaunchFeeTerms } from '../../lib/launch-fee.mjs'
import { LAUNCH_FEE_SPLIT, launcherBuySentence, launchFeeSentence } from '../../../src/launch-fee-copy.mjs'

export const metadata = { title: 'How it works — repo.ing', description: 'Find a repo, launch its token, trade, and claim repo earnings.' }
// Regenerated every five minutes so the launch-fee section follows the config new launches use (DBC_CONFIG).
export const revalidate = 300

export default async function HowItWorks() {
  const launchFee = await activeLaunchFeeTerms()
  return <><AppHeader active="how-it-works"/><main className="section-wrap info-page">
    <section className="info-intro"><div className="eyebrow">HOW IT WORKS</div><h1>From repository<br/><span>to market.</span></h1><p>Find a public repo, launch its token, trade, and let the repo admin claim its share of fees.</p></section>
    <RepositoryFlow/>
    <FlywheelVideo launchFee={launchFee}/>
    {launchFee && <section id="launch-fee" className="inner-card discovery-explainer launch-fee-explainer" aria-labelledby="launch-fee-title"><h2 id="launch-fee-title">Launch fee on new markets</h2><p>{launchFeeSentence(launchFee)} {LAUNCH_FEE_SPLIT}</p><p>{launcherBuySentence(launchFee)} The launch fee makes buying in a market’s first seconds and selling to later buyers costly. Markets launched before it was introduced keep a flat 1.75% fee; each market’s Launch facts show whether it has one.</p></section>}
    <section id="graduation" className="inner-card graduation-guide" aria-labelledby="graduation-title"><h2 id="graduation-title">How a market graduates</h2><p>Each market shows the SOL held in its bonding curve and the exact graduation target from its on-chain configuration.</p><div className="graduation-guide-steps"><div><strong>Buys add SOL</strong><span>The amount after trading fees increases the curve’s reserve.</span></div><div><strong>Sells remove SOL</strong><span>Selling tokens back to the curve reduces its reserve and graduation progress.</span></div><div><strong>Target reached</strong><span>After verified migration, the same token trades in its Meteora DAMM pool.</span></div></div><p>Volume totals buys and sells. Graduation depends on how much SOL stays in the curve. A market can have high volume and still be far from its target. The remaining reserve shown is a moving target; fees and subsequent sells affect the purchases needed.</p><p>Builder fees and platform revenue are accounted for separately from curve reserves. Claiming fees or locking tokens does not add SOL to the curve.</p></section>
    <section id="discovery" className="inner-card discovery-explainer" aria-labelledby="discovery-title"><h2 id="discovery-title">Discover a repo. Earn a share.</h2><p>The wallet that launches a new market earns 50% of repo.ing’s partner trading fees until graduation, 30 days, or 2.5 SOL earned—whichever comes first. Earlier enrolled markets keep their original 1 SOL cap. Markets without discovery rewards are not enrolled retroactively.</p><p>Rewards come from repo.ing’s existing share; builder fees stay the same. Earned rewards remain claimable after the earning period ends. Find them under My wallet or on the market page. To claim, you sign a message; repo.ing sends the reward and pays the network fee.</p><Link className="button outline" href="/wallet">My holdings & rewards</Link></section>
    <section className="info-closing"><div><h2>Ready to try it?</h2><p>Paste a repo link on the home page, or browse tokens already trading.</p></div><div className="info-actions"><Link href="/" className="button primary">Start with a repo <ArrowRight size={18}/></Link><Link href="/explore" className="button outline">Explore markets</Link></div></section>
  </main><Footer/></>
}
