'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { Share2, Zap, ChevronDown, Image as ImageIcon, Code2, Link2, Ellipsis } from 'lucide-react'
import { dialToUrl } from '../lib/blink-links.mjs'
import { tokenPageUrl } from '../lib/share-links.mjs'
import { ReferLink } from './refer-link'
import { ReadmeBadgePanel } from './readme-badge'
import { MarketShareCard } from './market-share-card'
import { WatchButton } from './watchlist'
import { MenuDetails } from './menu-details'
import { useShareReferral } from './share-referral'

// Watch stays a button; every share action (referral status included) lives in one disclosure menu (Escape closes, focus
// returns to "Share"). `more` holds secondary links for the "⋯" menu.
export function ShareMarket({ mint, symbol, fullName, repoId, more }) {
  const [state, setState] = useState('')
  const [open, setOpen] = useState(false), [badge, setBadge] = useState(false), [card, setCard] = useState(false)
  const root = useRef(null), trigger = useRef(null), panel = useRef(null), refocus = useRef(false)
  const id = useId(), panelId = `${id}-share`, badgeId = `${id}-badge`
  // The plain market URL is the Blink on X once actions.json is registered; dial.to works in any app. The links carry
  // the wallet's ?ref only when its referral payouts are set up and it has not chosen to share without it.
  const referral = useShareReferral(open || card)
  const url = () => tokenPageUrl(mint, window.location.origin, referral.ref)
  const copied = what => `${what} copied${referral.ref ? ' · includes your referral (your wallet address)' : ''}`

  useEffect(() => {
    if (!open) { setBadge(false); if (refocus.current) trigger.current?.focus(); refocus.current = false; return }
    panel.current?.querySelector('button')?.focus()
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside) }
  }, [open])

  const close = () => { refocus.current = true; setOpen(false) }
  const act = fn => async () => { close(); await fn() }
  async function copy() {
    try { await navigator.clipboard.writeText(url()); setState(copied('Link')) }
    catch { setState('Copy failed. Copy the link from your address bar.') }
  }
  async function copyBlink() {
    try { await navigator.clipboard.writeText(dialToUrl(mint, window.location.origin, referral.ref)); setState(copied('Blink link')) }
    catch { setState('Copy failed. Try the market link instead.') }
  }
  async function share() {
    if (!navigator.share) return copy()
    try { await navigator.share({ title: `$${symbol} — ${fullName}`, text: `${fullName} on repo.ing`, url: url() }); setState('') }
    catch (error) { if (error.name !== 'AbortError') await copy() }
  }
  function onKeyDown(event) {
    if (event.key === 'Escape' && open) { event.stopPropagation(); close(); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !panel.current) return
    const items = [...panel.current.querySelectorAll(':scope > button')]
    const at = items.indexOf(document.activeElement)
    if (at < 0 && event.key !== 'ArrowDown') return
    event.preventDefault()
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (at + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
    items[next]?.focus()
  }

  return <div className="share-market" ref={root} onKeyDown={onKeyDown}>
    <div className="share-market-actions">{repoId && <WatchButton market={{ mint, fullName, repoId }}/>}
      <div className="share-menu"><button ref={trigger} className="button outline" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => open ? close() : setOpen(true)}>
        <Share2 size={15} aria-hidden="true"/>Share<ChevronDown size={14} aria-hidden="true" className="share-menu-caret"/></button>
        {open && <div id={panelId} ref={panel} className="share-menu-panel" aria-label="Share this market" role="group">
          <button type="button" onClick={act(share)}><Share2 size={15} aria-hidden="true"/>Share…</button>
          <button type="button" onClick={act(copy)}><Link2 size={15} aria-hidden="true"/>Copy link</button>
          <button type="button" onClick={act(copyBlink)} title="Buy from any app via dial.to"><Zap size={15} aria-hidden="true"/>Copy Blink link</button>
          <button type="button" onClick={() => { setOpen(false); setCard(true) }}><ImageIcon size={15} aria-hidden="true"/>Share card</button>
          {repoId && <button type="button" aria-expanded={badge} aria-controls={badgeId} onClick={() => setBadge(value => !value)}><Code2 size={15} aria-hidden="true"/>README badge<ChevronDown size={14} aria-hidden="true" className="share-menu-caret"/></button>}
          {repoId && badge && <ReadmeBadgePanel id={badgeId} repoId={repoId} mint={mint}/>}
          <ReferLink referral={referral}/>
        </div>}
      </div>
      {more && <MenuDetails className="share-more" label="More actions" summary={<Ellipsis size={16} aria-hidden="true"/>}><div className="menu-panel share-more-panel">{more}</div></MenuDetails>}
    </div>
    {state && <small role="status">{state}</small>}
    <MarketShareCard mint={mint} open={card} onOpenChange={value => { setCard(value); if (!value) trigger.current?.focus() }}/>
  </div>
}
