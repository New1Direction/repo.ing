import Link from 'next/link'
import { nativeLaunchRuntime } from '../lib/hooklab-native-launch-runtime.mjs'
import { HookNativeLaunch } from './hooklab-native-launch'
import { HookOwnerApprovedLaunch } from './hooklab-launch-request'
import { HookOpenLaunch } from './hooklab-open-launch'
import { HooksIntro, HooksNav, HooksRisk } from './hooks-ui'
import { executionGenesis, localAcceptanceNetwork } from '../../src/hooklab-local-acceptance.mjs'
import { openLaunchesEnabled } from '../../src/hooklab-open-creation.mjs'

// The Hooks launch page (owner redesign 2026-10-27): with self-serve launches on, the form itself, under a short header
// and two small links to trading and claims. The owner-approved and guided launchers keep their own introductions.
export function HooksLaunchPage() {
  const open = openLaunchesEnabled(process.env)
  const initialBlockers = process.env.HOOK_NATIVE_LAUNCH_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'NATIVE_LAUNCH_DISABLED', message: 'The native launcher is not enabled.' }]
    : !nativeLaunchRuntime() ? [{ code: 'APPROVED_RUNTIME_UNCONFIGURED', message: open ? 'Launching isn’t available right now.' : 'Owner-approved custody, exact deployment and fee settings are not configured.' }] : []
  // Self-serve launches replace the request-and-invite flow; it stays only while they are off.
  const ownerApproved = !open && process.env.HOOK_OWNER_APPROVED_LAUNCHES === 'true'
  const local = localAcceptanceNetwork() && <p role="status" className="inner-card"><strong>LOCAL ACCEPTANCE · synthetic funds only.</strong> Real SBF programs on one isolated validator, accessed through two local proxies—not independent production providers. Mainnet submission is blocked. The 100 bps creator fee and wallet cap are test terms, not production approval.</p>
  if (open) return <>
    <header className="hlf-head">
      <div><h1>Launch a coin <span className="hlf-tag">HOOKS</span></h1><p>Make it yours. Set the rules. Go live.</p></div>
      <nav className="hlf-links-row" aria-label="Hooks coins"><Link href="/hooks/trade">Buy &amp; sell</Link><Link href="/hooks/mine">My coins &amp; claims</Link></nav>
    </header>
    {local}
    <HookOpenLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>
  </>
  return <>{ownerApproved
      ? <HooksIntro title="Launch your coin." art="launch-market">Add a name, image and links, pick your rules, and send it to repo.ing. Once we approve it, you sign the launch in your own wallet.</HooksIntro>
      : <HooksIntro title="Launch a max-wallet coin.">Connect your wallet, review each exact transaction, and follow preparation through to a confirmed launch. Execution is available only when the server verifies its deployment and economics.</HooksIntro>}
    <HooksNav active="launch"/>{local}
    {ownerApproved
      ? <HookOwnerApprovedLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>
      : <HookNativeLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>}<HooksRisk/>
  </>
}
