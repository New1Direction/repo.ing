import '../hooks-ux.css'
import { HOOK_TYPES, coinTags } from '../lib/hooklab-ux.mjs'

// A small colour-coded badge per hook type the coin carries (max wallet, burn, creator fee, holders).
export function HookTypeBadges({ coin, className = '' }) {
  const tags = coinTags(coin)
  if (!tags.length) return null
  return <ul className={`hook-badges ${className}`.trim()} aria-label="Hooks on this coin">
    {HOOK_TYPES.filter(([id]) => tags.includes(id)).map(([id, label]) => <li key={id} className={`hook-badge is-${id}`}>{label}</li>)}
  </ul>
}
