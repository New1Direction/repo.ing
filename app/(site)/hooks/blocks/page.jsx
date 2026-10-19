import Link from 'next/link'
import { ArrowRight, Check } from 'lucide-react'
import { HOOK_BLOCKS } from '../../../../src/hooklab-blocks.mjs'
import { HooksIntro, HooksNav, HooksRisk } from '../../../components/hooks-ui'

export const metadata = { title: 'Blocks — repo.ing Hooks', description: 'Snap blocks onto your coin to decide what it does. Max wallet and Creator fee are live today; burns, locks, half-life and holder rewards are coming.' }

export default function HooksBlocksPage() {
  return <><HooksIntro title="Blocks for your coin." action={<Link className="button primary" href="/hooks/launch-review">Launch a coin <ArrowRight size={16} aria-hidden="true"/></Link>}>
    Each block is one rule your coin follows. Snap them on when you launch. Max wallet and Creator fee are live today; more are on the way.
  </HooksIntro><HooksNav active="blocks"/>
    <ul className="hooks-block-grid">{HOOK_BLOCKS.map(block => <li key={block.id} className={`hooks-block ${block.live ? 'is-on' : 'is-soon'}`}>
      <header><img src={block.icon} width={48} height={48} alt="" decoding="async"/><div><strong>{block.title}</strong><span>{block.summary}</span></div>
        {block.live ? <span className="hooks-block-state"><Check size={13} aria-hidden="true"/>Live</span> : <span className="hooks-block-state is-soon">Soon</span>}</header>
    </li>)}</ul>
    <div className="hooks-explain"><div><h2>Ready to build?</h2><p>Every coin launched today snaps on Max wallet and Creator fee. Pick your settings on the launch page.</p></div><Link href="/hooks/launch-review">Launch a coin <ArrowRight size={16} aria-hidden="true"/></Link></div>
    <HooksRisk/>
  </>
}
