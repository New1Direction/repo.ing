'use client'
import { XMark } from './x-mark'
import { useWallet } from './wallet'
import { xShareUrl } from '../lib/share-links.mjs'

// A connected wallet's post links the market with its own ?ref, so trades it brings pay it a referral.
export function ShareOnX({ mint, fullName, symbol, kind, className = 'button outline share-on-x' }) {
  const { wallet } = useWallet() ?? {}
  if (!mint) return null
  return <a className={className} href={xShareUrl({ mint, fullName, symbol, kind, ref: wallet })} target="_blank" rel="noopener noreferrer"
    title={wallet ? 'The post links this market with your referral, so trades it brings pay you' : undefined}>
    <XMark size={14}/>Share on X
  </a>
}
