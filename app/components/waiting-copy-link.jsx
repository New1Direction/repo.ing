'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Link2 } from 'lucide-react'

const FEEDBACK_MS = 1800

// Copies this row's /waiting#repo-… link. The origin is the page's own, so previews copy preview links.
export function WaitingCopyLink({ anchor, fullName }) {
  const [state, setState] = useState('')
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  async function copy() {
    const url = `${window.location.origin}/waiting#${anchor}`
    try { await navigator.clipboard.writeText(url); setState('copied') } catch { setState('failed') }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(''), FEEDBACK_MS)
  }
  const label = state === 'copied' ? `Copied link to ${fullName}` : state === 'failed' ? `Copy link to ${fullName} failed; try again` : `Copy link to ${fullName}`
  return <button type="button" className="button outline waiting-copy" onClick={copy} aria-label={label} title={label}>
    {state === 'copied' ? <Check size={15} aria-hidden="true"/> : <Link2 size={15} aria-hidden="true"/>}
    <span aria-hidden="true">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Try again' : 'Copy link'}</span>
    <span className="sr-only" role="status">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}</span>
  </button>
}
