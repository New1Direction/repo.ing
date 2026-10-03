import { ArrowUpRight } from 'lucide-react'
import { CopyAddress } from './copy-address'
import { XHandleLink, hasXHandle } from './x-handle-link'

// A wallet the way people know it: the X account it linked with a wallet signature (avatar and @handle) when it has
// one, otherwise its short copyable address. The full address stays one hover or click away on Solscan either way.
// Server and client safe. link: the wallet's public X link (xHandlesFor / xHandleFor) or null. trust: the maintainer ✓.
export function WalletIdentity({ wallet, link = null, trust = false, label = 'wallet address', className = '' }) {
  const linked = hasXHandle(link)
  return <span className={`wallet-identity${linked ? ' has-x' : ''}${className ? ` ${className}` : ''}`}>
    {linked ? <XHandleLink link={link} trust={trust} avatar/> : <CopyAddress address={wallet} compact label={label}/>}
    <a className="wallet-identity-solscan" href={`https://solscan.io/account/${wallet}`} target="_blank" rel="noreferrer"
      title={wallet} aria-label={`View wallet ${wallet} on Solscan`}><ArrowUpRight size={14} aria-hidden="true"/></a>
  </span>
}
