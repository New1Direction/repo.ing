'use client'
import Link from 'next/link'
import { useRef, useState } from 'react'
import { ArrowRight, BookOpen, ChartNoAxesCombined, CircleCheck, GitCommitHorizontal } from 'lucide-react'
import { ArtTile } from './art-tile'

const steps = [
  { label: 'Repository', icon: BookOpen, title: 'Start with something people build.', body: 'Paste a public GitHub repository. We check its identity and open its existing market, or help you launch one with your chosen artwork, name, and ticker.', href: '/launch', action: 'Find a repository', code: '01 / resolve repository', art: 'repository-search' },
  { label: 'Market', icon: ChartNoAxesCombined, title: 'One repository. One canonical market.', body: 'Review the costs and approve the launch in your Solana wallet. Every buy or sell needs your approval. Trading fees accrue to the repository while the market progresses toward graduation.', href: '/explore', action: 'Explore real markets', code: '02 / launch & trade', art: 'repository-launch' },
  { label: 'Builder paid', icon: CircleCheck, title: 'The people building it can get paid.', body: 'A current repository admin verifies access with GitHub, connects a payout wallet, and claims earned fees. Completed payouts have public transaction receipts you can check.', href: '/stats#builder-payouts', action: 'See real payout receipts', code: '03 / verify & claim', art: 'earnings-wallet' },
]
export function RepositoryFlow() {
  const [selected, setSelected] = useState(0)
  const tabs = useRef([])
  const current = steps[selected]
  function navigate(event, index) {
    const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : null
    if (next === null) return
    event.preventDefault(); setSelected(next); tabs.current[next]?.focus()
  }
  return <section className="repository-flow" aria-label="From repository to builder payout">
    <div className="flow-file"><GitCommitHorizontal size={18}/><span>How it works</span><span className="flow-file-note">Three steps. On chain.</span></div>
    <div className="flow-steps" role="tablist" aria-label="Choose a step">
      {steps.map(({ label, icon: Icon }, index) => <button key={label} type="button" role="tab" id={`flow-tab-${index}`} aria-controls="flow-panel" aria-selected={selected === index} tabIndex={selected === index ? 0 : -1} ref={node => { tabs.current[index] = node }} onClick={() => setSelected(index)} onKeyDown={event => navigate(event, index)}>
        <span className="flow-node"><Icon size={22}/></span><span>{label}</span><small>0{index + 1}</small>
      </button>)}
    </div>
    <div className="flow-panel" id="flow-panel" role="tabpanel" aria-labelledby={`flow-tab-${selected}`} tabIndex={0}>
      <div key={selected} className="flow-description"><code>{current.code}</code><h2>{current.title}</h2><p>{current.body}</p><Link href={current.href} className="button outline">{current.action}<ArrowRight size={16}/></Link></div>
      <div className="flow-commit" aria-hidden="true"><span/><ArtTile key={current.art} name={current.art} size={184}/><span/></div>
    </div>
  </section>
}
