import { HOOK_LAB_TEMPLATES } from '../../../../src/hook-lab-templates.mjs'
import { HooksIntro, HooksNav } from '../../../components/hooks-ui'
import { HookLabRecipePlanner } from '../../../components/hook-lab-recipe-planner'

export const metadata = { title: 'Create a Hooks draft — repo.ing', robots: { index: false } }

export default async function HooksNewPage({ searchParams }) {
  const { template } = await searchParams ?? {}
  const initialTemplate = HOOK_LAB_TEMPLATES.some(item => item.id === template) ? template : 'plain'
  return <><HooksIntro title="Create your coin draft.">Choose the identity and rules. Review the complete recipe before any future launch.</HooksIntro><HooksNav active="templates"/>
    <HookLabRecipePlanner guided initialTemplate={initialTemplate}/>
  </>
}
