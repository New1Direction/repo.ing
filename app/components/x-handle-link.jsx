import { XMark } from './x-mark'

const USERNAME = /^[A-Za-z0-9_]{1,15}$/
const IMAGE = /^https:\/\/pbs\.twimg\.com\//

// "@handle" linking to x.com for a wallet that linked X with a wallet signature. Safe in server and client components.
// trust: adds a subtle ✓ (the maintainer's payout wallet signed the link). avatar: the X profile image, fixed 18×18.
export function XHandleLink({ link, trust = false, avatar = false, className = '' }) {
  if (!link || !USERNAME.test(link.username ?? '')) return null
  const image = avatar && IMAGE.test(link.image ?? '') ? link.image : null
  return <a className={`x-handle${trust ? ' is-trusted' : ''}${className ? ` ${className}` : ''}`} href={`https://x.com/${link.username}`}
    target="_blank" rel="noopener nofollow" title={`X account linked by this wallet's signature${link.name ? ` · ${link.name}` : ''}`}>
    {image ? <img src={image} alt="" width={18} height={18} loading="lazy" decoding="async" referrerPolicy="no-referrer"/> : <XMark size={11}/>}
    <span>@{link.username}</span>{trust && <span className="x-handle-check" aria-label="verified maintainer">✓</span>}
  </a>
}
