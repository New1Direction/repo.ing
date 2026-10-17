import Link from 'next/link'
import { Info, LockKeyhole } from 'lucide-react'

export function HooksIntro({ title, children, art = 'launch-market', action }) {
  return <header className="hooks-intro"><div><p className="eyebrow">HOOKS</p><h1>{title}</h1><p>{children}</p></div>
    <div className="hooks-intro-action"><img src={`/launch-icons/${art}.webp`} width={72} height={72} alt=""/>{action}</div>
  </header>
}

export function HooksNav({ active }) {
  return <nav className="hooks-nav" aria-label="Hooks navigation">{[['markets', '/hooks', 'Markets'], ['templates', '/hooks/templates', 'Templates'], ['mine', '/hooks/mine', 'My coins']].map(([key, href, label]) =>
    <Link key={key} href={href} aria-current={active === key ? 'page' : undefined}>{label}</Link>)}</nav>
}

export function HooksUnavailable({ title = 'Execution unavailable', children }) {
  return <div className="hooks-notice"><LockKeyhole size={20} aria-hidden="true"/><div><strong>{title}</strong><p>{children || 'Create and keep a recipe draft. Launching, signing and public trading are not enabled.'}</p></div></div>
}

export function HooksRisk() {
  return <div className="hooks-notice"><Info size={20} aria-hidden="true"/><p>Hook Lab holdings are native assets, not SPL or Token-2022. Native bridged SOL is separate from wallet SOL. Virtual reserves are pricing inputs, not deposited SOL. Custody and program upgrades remain risks.</p></div>
}
