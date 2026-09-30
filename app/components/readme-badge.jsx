'use client'
import { useState } from 'react'
import { Check, Code2, Copy } from 'lucide-react'
import { badgeMarkdown } from '../lib/readme-badge.mjs'
import { MenuDetails } from './menu-details'

export function ReadmeBadge({ repoId, mint }) {
  return <MenuDetails className="readme-badge" label="Get README badge" summary={<><Code2 size={15}/>README badge</>}>
    <ReadmeBadgePanel className="menu-panel badge-panel" repoId={repoId} mint={mint}/>
  </MenuDetails>
}

// Badge preview + Markdown; also shown inline in the token page's Share menu.
export function ReadmeBadgePanel({ repoId, mint, id, className = 'badge-panel' }) {
  const [message, setMessage] = useState('')
  const markdown = badgeMarkdown(repoId, mint)
  async function copy() {
    try { await navigator.clipboard.writeText(markdown); setMessage('Markdown copied') }
    catch { setMessage('Select the Markdown below and copy it.') }
  }
  return <div id={id} className={className}><div className="menu-heading"><strong>Add to your README</strong></div>
      <p>Show the builder fees this repository has earned. The badge links to this market.</p>
      <div className="badge-preview"><img src={`/api/badge/${repoId}`} alt="Repository builder fees earned on repo.ing"/></div>
      <label htmlFor={`badge-${repoId}`}>Markdown</label><textarea id={`badge-${repoId}`} readOnly value={markdown} onFocus={event => event.target.select()} spellCheck={false}/>
      <button type="button" className="button outline" onClick={copy}>{message === 'Markdown copied' ? <Check size={15}/> : <Copy size={15}/>}Copy Markdown</button>
      {message && <small role="status">{message}</small>}
      <p className="badge-footnote">Includes paid and unpaid indexed fees in SOL. Refreshes periodically; GitHub may cache the image longer.</p>
    </div>
}
