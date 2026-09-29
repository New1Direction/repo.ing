import { XMark } from './x-mark'
import { xShareUrl } from '../lib/share-links.mjs'

export function ShareOnX({ mint, fullName, symbol, kind, className = 'button outline share-on-x' }) {
  if (!mint) return null
  return <a className={className} href={xShareUrl({ mint, fullName, symbol, kind })} target="_blank" rel="noopener noreferrer">
    <XMark size={14}/>Share on X
  </a>
}
