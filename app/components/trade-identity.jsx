import Link from 'next/link'
import { XHandleLink, hasXHandle } from './x-handle-link'
import { XMark } from './x-mark'

// Under the trade button: who this trade shows as in the market's trades. The connected wallet's linked X account, or,
// with Connect X on and the wallet's link read and absent, the way to link one. Nothing before then.
// x: useXLink(wallet) ({ known, off, link }).
export function TradeIdentity({ wallet, direction, x }) {
  if (!wallet || !x?.known) return null
  if (hasXHandle(x.link)) return <p className="trade-identity">{direction === 'sell' ? 'Selling' : 'Buying'} as <XHandleLink link={x.link} avatar/></p>
  if (x.off) return null
  return <p className="trade-identity is-prompt"><XMark size={11}/><span><Link href="/wallet#x-account">Connect X</Link> to show your @handle on your trades</span></p>
}
