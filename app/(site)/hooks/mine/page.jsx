import Link from 'next/link'
import { HooksIntro, HooksNav, HooksUnavailable } from '../../../components/hooks-ui'
import { HookLabProductionAccount } from '../../../components/hooklab-plain-preparation'

export const metadata = { title: 'My Hooks coins — repo.ing', robots: { index: false } }

export default function HooksMinePage() {
  if (process.env.HOOK_OWNER_APPROVED_LAUNCHES === 'true') return <LaunchedCoins/>
  return <><HooksIntro title="My coins" art="receipts-ui">Your drafts and retained operations. Recovery never means relaunch.</HooksIntro><HooksNav active="mine"/>
    <HooksUnavailable title="Read-only preparation and recovery">No verified live coin inventory is available here. Reading retained operations cannot enable execution or prove a launch succeeded.</HooksUnavailable>
    <div className="hooks-creator-grid"><div><section className="hooks-card"><h2>Your recipe draft</h2><p>Resume the complete recipe on this device, or open your optional account drafts in the builder. Existing rules stay intact.</p><Link className="button primary" href="/hooks/new">Resume draft</Link></section><HookLabProductionAccount/></div>
      <aside className="hooks-card"><h2>Safe creator actions</h2><p>Inspect retained receipts and export drafts. Creator ownership is not protocol administration.</p><Link className="button" href="/coins/production">Production verification</Link><Link className="button" href="/coins/hltest">Devnet evidence</Link><hr/><h3>Not available</h3><p>No rule editing, reserve withdrawals or automatic fee claims. A missing receipt is not proof that nothing was submitted.</p><p className="hooks-fine">Keep the original mint, exact message and signature. Do not retry a pending operation.</p></aside>
    </div>
  </>
}

// While owner-approved launches are open: the creator's request and coin live on the launch page.
function LaunchedCoins() {
  return <><HooksIntro title="My coins" art="receipts-ui">Your launch request, your coin and its receipts.</HooksIntro><HooksNav active="mine"/>
    <div className="hooks-creator-grid"><div><section className="hooks-card"><h2>Your launch</h2><p>Your request, your invite and your launch receipt are all on the launch page. Sign in with the wallet you launched from.</p><Link className="button primary" href="/hooks/launch-review">Open your launch</Link></section><HookLabProductionAccount/></div>
      <aside className="hooks-card"><h2>Trading your coin</h2><p>Buy and sell hooks coins on repo.ing. Most wallets don’t list them yet.</p><Link className="button" href="/hooks/trade">Buy &amp; sell</Link><hr/><h3>If something went wrong</h3><p>Keep your recovery IDs and the transaction receipt. Never start a second launch to get around an unclear result.</p></aside>
    </div>
  </>
}
