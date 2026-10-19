import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { HooksIntro, HooksNav, HooksUnavailable, HooksRisk } from '../../components/hooks-ui'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Hooks — repo.ing', description: 'Launch a coin with its own rules: a cap on how much one wallet can hold and a creator fee on every trade. repo.ing approves each launch.' }

const StepArt = ({ src }) => <img className="launch-benefit-art" src={src} alt="" width={64} height={64} decoding="async" fetchPriority="low"/>

export default function HooksPage() {
  if (process.env.HOOK_OWNER_APPROVED_LAUNCHES !== 'true') return <DraftsOnly/>
  return <><HooksIntro title="Coins with their own rules." art="find-repo" action={<Link className="button primary" href="/hooks/launch-review">Launch a coin <ArrowRight size={16} aria-hidden="true"/></Link>}>
    Launch a coin that caps how much one wallet can hold and pays you a fee on every trade. repo.ing approves each launch, then anyone can buy and sell here.
  </HooksIntro><HooksNav active="markets"/>
    <section className="launch-benefits hooks-benefits" aria-label="How a hooks coin works">
      <ol>
        <li><StepArt src="/hook-icons/plain.webp"/><div><strong>Make it yours</strong><p>A name, ticker, image and your links. No repository needed.</p></div></li>
        <li><StepArt src="/hook-icons/max-wallet.webp"/><div><strong>Snap on blocks</strong><p>Max wallet caps any wallet at 1–5% of the supply until the coin graduates.</p></div></li>
        <li><StepArt src="/hook-icons/creator-rewards.webp"/><div><strong>Earn on every trade</strong><p>The Creator fee block takes 0.5–2%. You keep 75% of it, in SOL.</p></div></li>
      </ol>
      <div className="launch-reward-terms"><span><strong>Free to request.</strong> repo.ing checks each coin and invites you. Then you sign the launch in your wallet, with about 0.05 SOL for deposits and fees.</span>
        <Link href="/hooks/launch-review">Start your coin <ArrowRight size={14} aria-hidden="true"/></Link></div>
    </section>
    <div className="hooks-explain"><div><h2>Already holding a hooks coin?</h2><p>Buy and sell hooks coins on repo.ing. Most wallets don’t list them yet, so trade them here.</p></div><Link href="/hooks/trade">Buy &amp; sell <ArrowRight size={16} aria-hidden="true"/></Link></div>
    <div className="hooks-explain"><div><h2>More blocks are on the way</h2><p>Trade burns, wallet locks, half-life and holder rewards are coming next. See what each one does.</p></div><Link href="/hooks/blocks">See all blocks <ArrowRight size={16} aria-hidden="true"/></Link></div>
    <HooksRisk/>
  </>
}

// Before owner-approved launches open: discovery and drafts only.
function DraftsOnly() {
  return <><HooksIntro title="Coins with their own rules." art="find-repo" action={<Link className="button primary" href="/hooks/templates">Create a coin draft <ArrowRight size={16}/></Link>}>
    Explore the rules. Build a recipe. Know what happens before you sign.
  </HooksIntro><HooksNav active="markets"/><HooksUnavailable/>
    <section className="hooks-card hooks-empty" aria-labelledby="hooks-market-title">
      <img src="/launch-icons/find-repo.webp" width={88} height={88} alt=""/>
      <h2 id="hooks-market-title">Live markets are not available yet</h2>
      <p>There is no verified public Hook Lab market feed here. Prices, charts and trades will appear only when supported data is available.</p>
      <Link className="button" href="/hooks/templates">Explore six recipe templates <ArrowRight size={16}/></Link>
      <p className="hooks-fine">No wallet or funds needed. Drafting does not create a token.</p>
    </section>
    <div className="hooks-explain"><div><h2>Read the rules first</h2><p>Burns, wallet restrictions and creator fees affect different parts of a trade. A template is not a quote or a safety guarantee.</p></div><Link href="/programmable-coins">Understand Hook Lab <ArrowRight size={16}/></Link></div><HooksRisk/>
  </>
}
