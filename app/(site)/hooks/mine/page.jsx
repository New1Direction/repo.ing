import Link from 'next/link'
import { HooksIntro, HooksNav, HooksRisk, HooksUnavailable } from '../../../components/hooks-ui'
import { HookMyCoins } from '../../../components/hooklab-my-coins'
import { executionGenesis } from '../../../../src/hooklab-local-acceptance.mjs'
import { HookLabProductionAccount } from '../../../components/hooklab-plain-preparation'

export const dynamic = 'force-dynamic'
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

// While owner-approved launches are open: the creator's SOL in Hook Lab (with withdraw) and their launch or coin.
function LaunchedCoins() {
  return <><HooksIntro title="My coins" art="receipts-ui">Your coins, your launch and your SOL in Hook Lab.</HooksIntro><HooksNav active="mine"/>
    <HookMyCoins genesisHash={executionGenesis()} nativeClaims={process.env.HOOK_NATIVE_LAUNCHES_ENABLED === 'true'}/>
    <HooksRisk/>
  </>
}
