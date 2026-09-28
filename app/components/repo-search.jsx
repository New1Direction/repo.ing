'use client'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { GithubMark } from './github-mark'

export function RepoSearch({ initialUrl = '' }) {
  const [url, setUrl] = useState(initialUrl)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const submitting = useRef(false)
  async function submit(event) {
    event.preventDefault(); if (submitting.current) return
    submitting.current = true; setError(''); setBusy(true)
    try {
      const response = await fetch('/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.trim() }), signal: AbortSignal.timeout(15000) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Repository could not be resolved')
      router.push(data.mint ? `/token/${data.mint}` : `/launch/${data.repoId}`)
    } catch (cause) { setError(cause.name === 'TimeoutError' ? 'Repository lookup took too long. Please try again.' : cause.message); submitting.current = false; setBusy(false) }
  }
  return <div className="repo-search-wrap"><form className="repo-search launch-search" onSubmit={submit} aria-busy={busy}><GithubMark size={27}/><input aria-label="GitHub repository URL" type="text" placeholder="github.com/owner/repository" value={url} disabled={busy} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={event => setUrl(event.target.value)} required/><button type="submit" aria-label={busy ? 'Finding repository…' : 'Review repository'} disabled={busy}>{busy ? <span className="claim-spinner" aria-hidden="true"/> : <><span>Review repo</span><ArrowRight size={20} aria-hidden="true"/></>}</button></form><p className="search-helper">{busy ? 'Finding your repository…' : 'Review first. Your wallet approves the launch.'}</p>{error && <p className="inline-error" role="alert">{error}</p>}</div>
}
