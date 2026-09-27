'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { GithubMark } from './github-mark'

export function RepoSearch() {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  async function submit(event) {
    event.preventDefault(); setError(''); setBusy(true)
    try {
      const response = await fetch('/api/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Repository could not be resolved')
      router.push(data.mint ? `/token/${data.mint}` : `/launch/${data.repoId}`)
    } catch (cause) { setError(cause.message) } finally { setBusy(false) }
  }
  return <div className="repo-search-wrap"><form className="repo-search" onSubmit={submit} aria-busy={busy}><GithubMark size={27}/><input aria-label="GitHub repository URL" type="text" placeholder="github.com/owner/repository" value={url} onChange={event => setUrl(event.target.value)} required/><button type="submit" aria-label={busy ? 'Finding repository…' : 'Open repository'} disabled={busy}>{busy ? <span className="claim-spinner" aria-hidden="true"/> : <ArrowRight size={27}/>}</button></form><p className="search-helper">{busy ? 'Finding your repository…' : 'Paste a GitHub repository URL to create a market.'}</p>{error && <p className="inline-error" role="alert">{error}</p>}</div>
}
