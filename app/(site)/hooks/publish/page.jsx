import { HooksIntro, HooksRisk } from '../../../components/hooks-ui'
import { HookCatalogPublisher } from '../../../components/hooklab-hook-catalog'
import { HookWalletSignIn } from '../../../components/hooklab-wallet-signin'
import { executionGenesis } from '../../../../src/hooklab-local-acceptance.mjs'
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Publish a hook — repo.ing' }
export default function PublishHookPage() {
  return <><HooksIntro title="Publish a hook.">Declare your hook’s behavior, fees, risks and setup template. Publications identify a publisher wallet, not a verified author or an endorsement.</HooksIntro>
    <HookWalletSignIn genesisHash={executionGenesis()}/><HookCatalogPublisher/><HooksRisk/></>
}
