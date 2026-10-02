'use client'
import { useId, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { GithubMark } from './github-mark'
import { fundingYml } from '../lib/builder-share.mjs'
import styles from './builder-kit.module.css'

// GitHub Sponsor button: the FUNDING.yml line that lists this repository's repo.ing market.
export function SponsorSnippet({ mint }) {
  const [copied, setCopied] = useState(null), id = useId()
  const snippet = fundingYml(mint)
  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true) } catch { setCopied(false) }
  }
  return <div className={styles.sponsor}>
    <div className={styles.fileHead}><GithubMark size={15}/><code id={`${id}-file`}>.github/FUNDING.yml</code>
      <button type="button" className="button outline" onClick={copy} aria-describedby={`${id}-file`}>{copied ? <Check size={14}/> : <Copy size={14}/>}{copied ? 'Copied' : 'Copy'}</button></div>
    <pre className={styles.snippet}><code>{snippet}</code></pre>
    <p className={styles.note} role="status">{copied === false ? 'Copy did not work here. Select the line above and copy it.' : 'Commit this file to put repo.ing on your repository’s GitHub Sponsor button.'}</p>
  </div>
}
