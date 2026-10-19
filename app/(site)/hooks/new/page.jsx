import Link from 'next/link'
import { redirect } from 'next/navigation'
import { HOOK_LAB_TEMPLATES } from '../../../../src/hook-lab-templates.mjs'
import { HooksIntro, HooksNav } from '../../../components/hooks-ui'
import { HookLabRecipePlanner } from '../../../components/hook-lab-recipe-planner'

export const metadata = { title: 'Create a Hooks draft — repo.ing', robots: { index: false } }

export default async function HooksNewPage({ searchParams }) {
  // While owner-approved launches are open, coins are built from blocks on the launch page.
  if (process.env.HOOK_OWNER_APPROVED_LAUNCHES === 'true') redirect('/hooks/launch-review')
  const { template } = await searchParams ?? {}
  const initialTemplate = HOOK_LAB_TEMPLATES.some(item => item.id === template) ? template : 'plain'
  return <><HooksIntro title="Create your coin draft.">Choose the identity and rules. Review the complete recipe before any future launch.</HooksIntro><HooksNav active="templates"/>
    <p><Link href="/hooks/launch-review">Open the wallet launch flow</Link> to check availability, review exact fees and caps, or resume an existing max-wallet launch. Signing stays blocked until the server verifies the required deployment and custody settings. <Link href="/hooks/trade">Open buy / sell</Link> to review a trade or resume its original transaction.</p>
    <HookLabRecipePlanner guided initialTemplate={initialTemplate}/>
  </>
}
