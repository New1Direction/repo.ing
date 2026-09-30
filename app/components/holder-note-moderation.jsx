'use client'
import { useState } from 'react'

// Operator health page: hide a holder note from every public list (or restore it).
export function HideNoteButton({ id, hidden: initiallyHidden }) {
  const [hidden, setHidden] = useState(initiallyHidden), [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function toggle() {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/operations/holder-notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, hidden: !hidden }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || 'Could not update the note.')
      setHidden(result.result.hidden)
    } catch (cause) { setError(cause.message) } finally { setBusy(false) }
  }
  return <>{hidden && <span className="badge warn">Hidden</span>} <button type="button" className="button outline" disabled={busy} onClick={() => { void toggle() }}>{busy ? 'Saving…' : hidden ? 'Unhide' : 'Hide note'}</button>
    {error && <small className="inline-error" role="alert">{error}</small>}</>
}
