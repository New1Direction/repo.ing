'use client'
import { useState } from 'react'
import { Check, Copy } from 'lucide-react'

export function CopyAddress({ address, compact = false, label = 'mint address' }) {
  const [feedback, setFeedback] = useState('')
  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setFeedback('copied')
    } catch { setFeedback('failed') }
    window.setTimeout(() => setFeedback(''), 1800)
  }
  return <button type="button" className={`copy-address${compact ? ' compact' : ''}`} onClick={copy}
    aria-label={feedback === 'copied' ? `${label} copied` : feedback === 'failed' ? `Could not copy ${label}; try again` : `Copy full ${label} ${address}`}
    title={`${address} — click to copy full ${label}`}>
    <code>{compact ? `${address.slice(0, 8)}…${address.slice(-6)}` : address}</code>
    <span className="copy-address-action" aria-hidden="true">
      {feedback === 'copied' ? <Check size={16}/> : <Copy size={16}/>}
      <span>{feedback === 'copied' ? 'Copied' : feedback === 'failed' ? 'Try again' : 'Copy'}</span>
    </span>
  </button>
}
