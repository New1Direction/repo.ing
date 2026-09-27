'use client'
import { useRef, useState } from 'react'
import { Copy, Share2 } from 'lucide-react'
import { MenuDetails } from './menu-details'
import { ownerInvitation } from '../lib/owner-invitation.mjs'

export function InviteOwner({ repoId, fullName, available = null }) {
  const [amount, setAmount] = useState(available), [loading, setLoading] = useState(false), [message, setMessage] = useState('')
  const pending = useRef(false)
  const text = ownerInvitation({ repoId, fullName, available: amount })
  async function refresh(event) {
    if (!event.currentTarget.open || pending.current) return
    pending.current = true; setLoading(true); setMessage('')
    try {
      const response = await fetch(`/api/claim/${repoId}/preview`, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw Error()
      setAmount((await response.json()).available)
    } catch { setAmount(null); setMessage('Live fees are unavailable. The invitation links to the current claim page.') }
    finally { pending.current = false; setLoading(false) }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(text); setMessage('Invitation copied') }
    catch { setMessage('Select the invitation below and copy it.') }
  }
  async function share() {
    if (!navigator.share) return copy()
    try { await navigator.share({ title: `${fullName} · builder fees`, text }); setMessage('') }
    catch (error) { if (error.name !== 'AbortError') await copy() }
  }
  return <MenuDetails className="invite-owner" label="Invite repository owner" onToggle={refresh} summary={<><Share2 size={15}/>Invite repository owner</>}>
    <div className="menu-panel invite-panel"><strong>Let the builders know</strong><p>Send the repository owner a direct link to claim their fees.</p>
      <label htmlFor={`invite-${repoId}`}>Invitation</label><textarea id={`invite-${repoId}`} readOnly value={text} onFocus={event => event.target.select()}/>
      <div className="invite-actions"><button className="button outline" type="button" disabled={loading} onClick={copy}><Copy size={14}/>Copy invitation</button><button className="button outline" type="button" disabled={loading} onClick={share}><Share2 size={14}/>Share</button></div>
      {(message || loading) && <small role="status">{loading ? 'Checking available fees…' : message}</small>}
      <p>Nothing is sent automatically. Share it with the owner where appropriate.</p>
    </div>
  </MenuDetails>
}
