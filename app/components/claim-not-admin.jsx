'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import { permissionText } from '../lib/claim-funnel.mjs'

// GitHub confirmed the account, but it is not a current admin of the repository (app/lib/claim-funnel.mjs). Two ways on:
// send this claim page to someone who is an admin, or sign in to GitHub as the admin account and verify again.
export function ClaimNotAdmin({ repoId, repoName, github, permission, verifyHref }) {
  const [copied, setCopied] = useState('')
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    const url = `${window.location.origin}/claim/${encodeURIComponent(repoId)}?src=admin`
    try { await navigator.clipboard.writeText(url); setCopied('copied') } catch { setCopied('failed') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(''), 1800)
  }
  return <div className="claim-not-admin" role="status">
    <p><strong>{github ? `@${github}` : 'This GitHub account'} has {permissionText(permission)} access to {repoName}.</strong> Only a current repository admin can claim builder fees. Nothing was saved.</p>
    <ul>
      <li><span>Not an admin?</span> Send this claim page to someone who is. Fees stay in the pool until an admin claims them.
        <button type="button" className="button outline" onClick={copy}>{copied === 'copied' ? <Check size={15} aria-hidden="true"/> : <Link2 size={15} aria-hidden="true"/>}{copied === 'copied' ? 'Link copied' : copied === 'failed' ? 'Copy failed, try again' : 'Copy claim link for an admin'}</button></li>
      <li><span>Admin on another account?</span> GitHub signs you in with the account already open in this browser. Sign out of GitHub, sign in as the admin, then verify again.
        <span className="claim-not-admin-actions"><a className="button outline" href="https://github.com/logout" target="_blank" rel="noopener noreferrer">Switch GitHub account ↗</a><a className="claim-text-button" href={verifyHref}>Verify again</a></span></li>
    </ul>
  </div>
}
