import { notFound } from 'next/navigation'
import { hookExecutionContract } from '../../../../src/hooklab-execution-contract.mjs'
import { HooksIntro, HooksRisk } from '../../../components/hooks-ui'
import { HookCustomPolicyPreview } from '../../../components/hooklab-custom-policy-preview'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Custom policy review — repo.ing', robots: { index: false, follow: false } }

export default function CustomHookReviewPage() {
  // Review UI only; no navigation link, public default, wallet or execution activation.
  if (process.env.HOOK_CUSTOM_POLICY_PREVIEW !== 'local-review') notFound()
  return <><HooksIntro title="Custom policy review.">A source-pinned preview of one rejection rule. This candidate is unavailable for creation or trading.</HooksIntro>
    <HookCustomPolicyPreview contract={hookExecutionContract()}/><HooksRisk/>
  </>
}
