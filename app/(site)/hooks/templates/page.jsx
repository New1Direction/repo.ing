import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { HOOK_LAB_TEMPLATES } from '../../../../src/hook-lab-templates.mjs'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'

export const metadata = { title: 'Hook templates — repo.ing', description: 'Six guided recipe templates. Max wallet coins launch now with repo.ing approval; the others are drafts for now.' }
// Each preset's icon lives at /hook-icons/<template id>.webp (128 px source, shown at 56 px).

export default function HooksTemplatesPage() {
  return <><HooksIntro title="Choose your coin’s rules.">Six curated recipes. Max wallet launches now; the others are drafts for now.</HooksIntro><HooksNav active="templates"/>
    <div className="hooks-template-grid">{HOOK_LAB_TEMPLATES.map(template => {
      return <article className="hooks-card hooks-template" key={template.id}><div className="hooks-between"><img src={`/hook-icons/${template.id}.webp`} width={56} height={56} alt="" decoding="async"/><span className="badge">{template.id === 'max-wallet' ? 'Launch available' : 'Draft only'}</span></div>
        <h2>{template.title}</h2><p>{template.description}</p><p className="hooks-fine">{template.warnings.join(' ')}</p>
        <Link className="button" href={`/hooks/new?template=${template.id}`}>{template.id === 'max-wallet' ? 'Start a Max wallet coin' : `Start ${template.title} draft`} <ArrowRight size={15} aria-hidden="true"/></Link>
      </article>
    })}</div><HooksRisk/>
  </>
}
