'use client'
import { useState } from 'react'
import { Share2, Copy, Check, Zap } from 'lucide-react'
import { dialToUrl } from '../lib/blink-links.mjs'
import { ReadmeBadge } from './readme-badge'
import { MarketShareCard } from './market-share-card'
import { WatchButton } from './watchlist'

export function ShareMarket({ mint, symbol, fullName, repoId }) {
  const [state, setState] = useState('')
  // The plain market URL is the Blink on X once actions.json is registered; dial.to works in any app.
  const url = () => `${window.location.origin}/token/${encodeURIComponent(mint)}`
  async function copy() {
    try { await navigator.clipboard.writeText(url()); setState('Link copied') }
    catch { setState('Copy failed. Copy the link from your address bar.') }
  }
  async function copyBlink() {
    try { await navigator.clipboard.writeText(dialToUrl(mint, window.location.origin)); setState('Blink link copied') }
    catch { setState('Copy failed. Try the market link instead.') }
  }
  async function share() {
    if (!navigator.share) return copy()
    try { await navigator.share({ title: `$${symbol} — ${fullName}`, text: `${fullName} on repo.ing`, url: url() }); setState('') }
    catch (error) { if (error.name !== 'AbortError') await copy() }
  }
  return <div className="share-market"><div>{repoId && <WatchButton market={{ mint, fullName, repoId }}/>}<button className="button outline" type="button" onClick={share}><Share2 size={15}/>Share</button><button className="button outline" type="button" onClick={copy} aria-label="Copy market link">{state === 'Link copied' ? <Check size={15}/> : <Copy size={15}/>}</button><button className="button outline" type="button" onClick={copyBlink} aria-label="Copy Blink link (buy from any app via dial.to)" title="Copy Blink link">{state === 'Blink link copied' ? <Check size={15}/> : <Zap size={15}/>}</button><MarketShareCard mint={mint}/>{repoId && <ReadmeBadge repoId={repoId} mint={mint}/>}</div>{state && <small role="status">{state}</small>}</div>
}
