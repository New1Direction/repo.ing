import { nativeLaunchRuntime } from '../../../lib/hooklab-native-launch-runtime.mjs'
import { HookNativeLaunch } from '../../../components/hooklab-native-launch'
import { HookOwnerApprovedLaunch } from '../../../components/hooklab-launch-request'
import { HookOpenLaunch } from '../../../components/hooklab-open-launch'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { executionGenesis, localAcceptanceNetwork } from '../../../../src/hooklab-local-acceptance.mjs'
import { openLaunchesEnabled } from '../../../../src/hooklab-open-creation.mjs'
export const dynamic = 'force-dynamic'
export async function generateMetadata() {
  const description = openLaunchesEnabled(process.env)
    ? 'Launch a coin with a wallet cap and a creator fee. Add an image and links, check the costs, then sign in your wallet.'
    : 'Launch a coin with a wallet cap and a creator fee. Add an image and links, send it for approval, then sign in your wallet.'
  return { title: 'Launch a coin — repo.ing Hooks', description, robots: { index: false, follow: false } }
}
export default function WalletLaunchReview() {
  const open = openLaunchesEnabled(process.env)
  const initialBlockers = process.env.HOOK_NATIVE_LAUNCH_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'NATIVE_LAUNCH_DISABLED', message: 'The native launcher is not enabled.' }]
    : !nativeLaunchRuntime() ? [{ code: 'APPROVED_RUNTIME_UNCONFIGURED', message: open ? 'Launching isn’t available right now.' : 'Owner-approved custody, exact deployment and fee settings are not configured.' }] : []
  // Self-serve launches replace the request-and-invite flow; it stays only while they are off.
  const ownerApproved = !open && process.env.HOOK_OWNER_APPROVED_LAUNCHES === 'true'
  return <>{open
    ? <HooksIntro title="Launch your coin." art="launch-market">Pick a name, image and your rules, check what it costs, then approve it in your wallet. It goes live right away.</HooksIntro>
    : ownerApproved
      ? <HooksIntro title="Launch your coin." art="launch-market">Add a name, image and links, pick your rules, and send it to repo.ing. Once we approve it, you sign the launch in your own wallet.</HooksIntro>
      : <HooksIntro title="Launch a max-wallet coin.">Connect your wallet, review each exact transaction, and follow preparation through to a confirmed launch. Execution is available only when the server verifies its deployment and economics.</HooksIntro>}
    <HooksNav active="launch"/>
    {localAcceptanceNetwork() && <p role="status" className="inner-card"><strong>LOCAL ACCEPTANCE · synthetic funds only.</strong> Real SBF programs on one isolated validator, accessed through two local proxies—not independent production providers. Mainnet submission is blocked. The 100 bps creator fee and wallet cap are test terms, not production approval.</p>}
    {open
      ? <HookOpenLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>
      : ownerApproved
        ? <HookOwnerApprovedLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>
        : <HookNativeLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>}<HooksRisk/>
  </>
}
