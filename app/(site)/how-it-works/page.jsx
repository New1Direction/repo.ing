import Link from 'next/link'
import { RepositoryFlow } from '../../components/repository-flow'
import { ArrowRight } from 'lucide-react'
import { AppHeader, Footer } from '../../components/ui'
import { FlywheelVideo } from '../../components/flywheel-video'
import { activeLaunchFeeTerms } from '../../lib/launch-fee.mjs'
import { LAUNCH_FEE_SPLIT, launcherBuySentence, launchFeeSentence } from '../../../src/launch-fee-copy.mjs'
import { bundleLaunchable } from '../../../src/bundle-launch.mjs'
import { hfMarketsEnabled } from '../../../src/hf-launch.mjs'
import { OpenHashDetails } from './open-hash-details'
import './how-it-works.css'

export const metadata = { title: 'How it works — repo.ing', description: 'Find a repo, launch its token, trade, and claim repo earnings.' }
// Regenerated every five minutes so the launch-fee section follows the config new launches use (DBC_CONFIG).
export const revalidate = 300

export default async function HowItWorks() {
  const launchFee = await activeLaunchFeeTerms()
  const models = hfMarketsEnabled(), groups = bundleLaunchable()
  return <><AppHeader active="how-it-works"/><main className="section-wrap info-page">
    <section className="info-intro"><div className="eyebrow">HOW IT WORKS</div><h1>From repository<br/><span>to market.</span></h1><p>Find a public repo{models && ' or Hugging Face model'}, launch its token, trade, and let the repo admin{models && ' or model owner'} claim its share of fees.</p></section>
    <RepositoryFlow/>
    <FlywheelVideo launchFee={launchFee}/>
    {/* Fine print: every policy stays here, folded. Links to an anchor (#launch-fee, #discovery, #builder-collections…) open it. */}
    <section className="inner-card discovery-explainer how-fine-print" aria-labelledby="fine-print-title"><h2 id="fine-print-title">Fine print</h2>
      {launchFee && <details id="launch-fee" className="how-details launch-fee-explainer"><summary>Launch fee on new markets</summary><p>{launchFeeSentence(launchFee)} {LAUNCH_FEE_SPLIT}</p><p>{launcherBuySentence(launchFee)} The launch fee makes buying in a market’s first seconds and selling to later buyers costly. Markets launched before it was introduced keep a flat 1.75% fee; each market’s Launch facts show whether it has one.</p></details>}
      <details id="ways-to-launch" className="how-details"><summary>Ways to launch</summary>
        <p><strong>Launch it yourself.</strong> Review the token and costs, then approve in your wallet. An optional first buy is capped at 3% of supply.</p>
        {groups && <p><strong>Group launch.</strong> A community funds the market together: a raise of 1 to 10 SOL runs for 1, 3 or 7 days. When it fills, the raise less 5% buys the first tokens into a permanent vault that trades only within on-chain limits, and the backers share 80% of the market’s partner fees. A raise that misses its target refunds every deposit.</p>}
        <p><strong>Stock pair.</strong> A repository of facebook, microsoft or nvidia can be paired with the company’s tokenized stock (METAx, MSFTx, NVDAx) instead of SOL. Its 1.75% fee is paid in the stock: 0.30% to the launcher and 1.10% to permanent $REPOING / stock liquidity, plus Meteora’s 0.35%. A stock pair has no owner claim.</p>
        <p>One market per project: a fork of a repository that already has a market, or a copy of an older launched repository under another account, is refused. Other forks launch labeled “Fork of” their parent.</p></details>
      <details id="graduation" className="how-details graduation-guide"><summary>How a market graduates</summary><p>Each market shows the SOL held in its bonding curve and the exact graduation target from its on-chain configuration.</p><div className="graduation-guide-steps"><div><strong>Buys add SOL</strong><span>The amount after trading fees increases the curve’s reserve.</span></div><div><strong>Sells remove SOL</strong><span>Selling tokens back to the curve reduces its reserve and graduation progress.</span></div><div><strong>Target reached</strong><span>Once the move is verified, the same token trades in its graduated Meteora pool.</span></div></div><p>Volume totals buys and sells. Graduation depends on how much SOL stays in the curve. A market can have high volume and still be far from its target. The remaining reserve shown is a moving target; fees and subsequent sells affect the purchases needed.</p><p>Builder fees and platform revenue are accounted for separately from curve reserves. Claiming fees or locking tokens does not add SOL to the curve.</p></details>
      <details id="discovery" className="how-details"><summary>Launcher rewards</summary><p>The wallet that launches a new market earns 50% of repo.ing’s partner trading fees until graduation, 30 days, or 2.5 SOL earned, whichever comes first. Earlier enrolled markets keep their original 1 SOL cap. Markets without discovery rewards are not enrolled retroactively. {groups ? 'Group launches and stock pairs' : 'Stock pairs'} carry no discovery reward.</p><p>Rewards come from repo.ing’s existing share; builder fees stay the same. Earned rewards remain claimable after the earning period ends. Find them under My wallet or on the market page. To claim, you sign a message; repo.ing sends the reward and pays the network fee.</p><Link className="button outline" href="/wallet">My holdings & rewards</Link></details>
      <details id="builder-collections" className="how-details" style={{ overflowWrap: 'anywhere' }}><summary>Manual collection of unclaimed builder fees</summary><p>repo.ing may manually collect 50% of the then-current unclaimed builder SOL fees from individually selected repositories, including fees accrued before this policy. A later approval may collect half the remaining balance again; there is no lifetime 50% cap. A separately approved exact-amount collection may exceed half, including the entire remaining balance.</p><p>Each collection requires a fresh review of the repository, exact SOL amount and destination. Collection is not automatic. This release supports only ordinary SOL markets still on the bonding curve and rejects graduated markets. Settled collections reduce what the owner can claim and are shown separately from owner payouts.</p><p>The initial destination is buyback custody wallet FgzeYRRJLwd3aZQFBgn3a5KnN4mZixSRB9keYzoBm5Jy. The operator reviews the destination each time. These withdrawals are separate from partner fees and their 60/20/20 allocation. Funding custody does not execute a buyback.</p></details>
      <OpenHashDetails/>
    </section>
    <section className="info-closing"><div><h2>Ready to try it?</h2><p>Paste a repo link on the home page, or browse tokens already trading.</p></div><div className="info-actions"><Link href="/" className="button primary">Start with a repo <ArrowRight size={18}/></Link><Link href="/explore" className="button outline">Explore markets</Link></div></section>
  </main><Footer/></>
}
