import Link from 'next/link'
import { ArrowRight, Blocks, Flame, LockKeyhole, Timer, Users, Coins } from 'lucide-react'
import { HOOK_LAB_TEMPLATES } from '../../../../src/hook-lab-templates.mjs'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'

export const metadata = { title: 'Hook templates — repo.ing', description: 'Six guided recipe templates. Drafts only; no live launch or trading.' }
const icons = [Blocks, Coins, Flame, LockKeyhole, Users, Timer]

export default function HooksTemplatesPage() {
  return <><HooksIntro title="Choose your coin’s rules.">Six curated recipes. Start a draft without connecting a wallet.</HooksIntro><HooksNav active="templates"/>
    <div className="hooks-template-grid">{HOOK_LAB_TEMPLATES.map((template, index) => {
      const Icon = icons[index]
      return <article className="hooks-card hooks-template" key={template.id}><div className="hooks-between"><Icon size={22} aria-hidden="true"/><span className="badge">Draft only</span></div>
        <h2>{template.title}</h2><p>{template.description}</p><p className="hooks-fine">{template.warnings.join(' ')}</p>
        <Link className="button" href={`/hooks/new?template=${template.id}`}>Start {template.title} draft <ArrowRight size={15} aria-hidden="true"/></Link>
      </article>
    })}</div><HooksRisk/>
  </>
}
