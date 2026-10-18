import { nativeLaunchRuntime } from '../../../lib/hooklab-native-launch-runtime.mjs'
import { HookNativeLaunch } from '../../../components/hooklab-native-launch'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { executionGenesis, localAcceptanceNetwork } from '../../../../src/hooklab-local-acceptance.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Launch a max-wallet coin — repo.ing', robots: { index: false, follow: false } }
export default function WalletLaunchReview() {
  const initialBlockers = process.env.HOOK_NATIVE_LAUNCH_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'NATIVE_LAUNCH_DISABLED', message: 'The native launcher is not enabled.' }]
    : !nativeLaunchRuntime() ? [{ code: 'APPROVED_RUNTIME_UNCONFIGURED', message: 'Owner-approved custody, exact deployment and fee settings are not configured.' }] : []
  return <main><HooksIntro title="Launch a max-wallet coin.">Connect your wallet, review each exact transaction, and follow preparation through to a confirmed launch. Execution is available only when the server verifies its deployment and economics.</HooksIntro><HooksNav/>
    {localAcceptanceNetwork() && <p role="status" className="inner-card"><strong>LOCAL ACCEPTANCE · synthetic funds only.</strong> Real SBF programs on one isolated validator, accessed through two local proxies—not independent production providers. Mainnet submission is blocked. The 100 bps creator fee and wallet cap are test terms, not production approval.</p>}
    <HookNativeLaunch genesisHash={executionGenesis()} initialBlockers={initialBlockers}/><HooksRisk/>
  </main>
}
