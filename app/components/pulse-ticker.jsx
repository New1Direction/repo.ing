import Link from 'next/link'
import { PulseIcon } from './pulse-icon'
import { pulseAgo } from '../lib/pulse-format.mjs'

// Home page band: the newest things builders shipped across live markets. The list is rendered twice so the CSS
// marquee loops seamlessly; the copy is hidden from assistive technology and keyboard focus.
export function PulseTicker({ items, now = Date.now() }) {
  if (!items || items.length < 3) return null
  return <section className="pulse-ticker" aria-label="Live from GitHub: what builders are shipping">
    <span className="pulse-ticker-label"><i aria-hidden="true"/>Live from GitHub</span>
    <div className="pulse-ticker-viewport">
      <ul className="pulse-ticker-track" style={{ '--pulse-duration': `${Math.max(30, items.length * 6)}s` }}>
        {[...items, ...items].map((item, index) => {
          const copy = index >= items.length
          return <li key={`${item.id}:${copy ? 'copy' : 'main'}`} aria-hidden={copy || undefined}>
            <Link href={item.href} prefetch={false} tabIndex={copy ? -1 : undefined} className={`pulse-kind-${item.kind}`}>
              <span className="pulse-dot"><PulseIcon kind={item.kind} size={13}/></span><b>{item.fullName}</b><span>{item.text}</span>
              <em>${item.symbol}</em><time dateTime={item.at}>{pulseAgo(item.at, now)}</time></Link></li>
        })}
      </ul>
    </div>
  </section>
}
