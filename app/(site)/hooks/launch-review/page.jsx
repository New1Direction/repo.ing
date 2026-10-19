import { nativeLaunchRuntime } from '../../../lib/hooklab-native-launch-runtime.mjs'
import { HookNativeLaunch } from '../../../components/hooklab-native-launch'
import { HookOwnerApprovedLaunch } from '../../../components/hooklab-launch-request'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { executionGenesis, localAcceptanceNetwork } from '../../../../src/hooklab-local-acceptance.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Launch a coin — repo.ing Hooks', description: 'Launch a coin with a wallet cap and a creator fee. Add an image and links, send it for approval, then sign in your wallet.', robots: { index: false, follow: false } }
export default function WalletLaunchReview() {
  const initialBlockers = process.env.HOOK_NATIVE_LAUNCH_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'NATIVE_LAUNCH_DISABLED', message: 'The native launcher is not enabled.' }]
    : !nativeLaunchRuntime() ? [{ code: 'APPROVED_RUNTIME_UNCONFIGURED', message: 'Owner-approved custody, exact deployment and fee settings are not configured.' }] : []
  const ownerApproved = process.env.HOOK_OWNER_APPROVED_LAUNCHES === 'true'
  return <>{ownerApproved
    ? <HooksIntro title="Launch your coin." art="launch-market">Add a name, image and links, pick your rules, and send it to repo.ing. Once we approve it, you sign the launch in your own wallet.</HooksIntro>
    : <HooksIntro title="Launch a max-wallet coin.">Connect your wallet, review each exact transaction, and follow preparation through to a confirmed launch. Execution is available only when the server verifies its deployment and economics.</HooksIntro>}
    <HooksNav active="launch"/>
    {localAcceptanceNetwork() && <p role="status" className="inner-card"><strong>LOCAL ACCEPTANCE · synthetic funds only.</strong> Real SBF programs on one isolated validator, accessed through two local proxies—not independent production providers. Mainnet submission is blocked. The 100 bps creator fee and wallet cap are test terms, not production approval.</p>}
    {ownerApproved
      ? <HookOwnerApprovedLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>
      : <HookNativeLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/>}<HooksRisk/>
  </>
}
