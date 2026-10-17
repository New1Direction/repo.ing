import { nativeLaunchRuntime } from '../../../lib/hooklab-native-launch-runtime.mjs'
import { HookNativeLaunch } from '../../../components/hooklab-native-launch'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'
import { HOOK_MAINNET_GENESIS } from '../../../../src/hooklab-execution-contract.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Launch a max-wallet coin — repo.ing', robots: { index: false, follow: false } }
export default function WalletLaunchReview() {
  const initialBlockers = process.env.HOOK_NATIVE_LAUNCH_ENABLED !== 'true' || process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true'
    ? [{ code: 'NATIVE_LAUNCH_DISABLED', message: 'The native launcher is not enabled.' }]
    : !nativeLaunchRuntime() ? [{ code: 'APPROVED_RUNTIME_UNCONFIGURED', message: 'Owner-approved custody, exact deployment and fee settings are not configured.' }] : []
  return <main><HooksIntro title="Launch a max-wallet coin.">Connect your wallet, review each exact transaction, and follow preparation through to a confirmed launch. Execution is available only when the server verifies its deployment and economics.</HooksIntro><HooksNav/>
    <HookNativeLaunch genesisHash={HOOK_MAINNET_GENESIS} initialBlockers={initialBlockers}/><HooksRisk/>
  </main>
}
