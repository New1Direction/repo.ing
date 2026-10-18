import { notFound } from 'next/navigation'
import { HookWalletSignIn } from '../../../components/hooklab-wallet-signin'
import { executionGenesis } from '../../../../src/hooklab-local-acceptance.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Wallet identity review', robots: { index: false, follow: false } }
export default function WalletIdentityReviewPage() {
  if (process.env.HOOK_WALLET_IDENTITY_ENABLED !== 'true') notFound()
  return <main><HookWalletSignIn genesisHash={executionGenesis()}/></main>
}
