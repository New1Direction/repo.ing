'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { launchBookmarklet, launchReadmeMarkdown } from '../../src/launch-links.mjs'

function CopyBlock({ label, value }) {
  const [message, setMessage] = useState('')
  useEffect(() => { setMessage('') }, [value])
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage('Copied') }
    catch { setMessage('Select the text above and copy it.') }
  }
  return <div className="launch-copy-block"><textarea aria-label={label} readOnly value={value} spellCheck={false} onFocus={event => event.target.select()}/>
    <button type="button" className="button outline" onClick={copy} disabled={!value}>{message === 'Copied' ? <Check size={15}/> : <Copy size={15}/>}Copy {label}</button><span role="status">{message}</span></div>
}

export function LaunchTools({ enabled }) {
  const [repo, setRepo] = useState('')
  let markdown = '', invalid = false
  if (repo.trim()) { try { markdown = launchReadmeMarkdown(repo) } catch { invalid = true } }
  const bookmark = useRef(null)
  // A deliberate, fixed bookmarklet (no user input). React rejects javascript:
  // hrefs; set this drag-only bookmark after mount rather than execute page code.
  useEffect(() => { bookmark.current?.setAttribute('href', launchBookmarklet) }, [])
  return <div className="launch-tools">
    <section className="inner-card" aria-labelledby="agent-launch-title"><h2 id="agent-launch-title">Launch with your agent</h2>
      <p>Ask your agent to find a repo and prepare a launch. Open the review link, choose an image, and approve the costs in your wallet.</p>
      <p className="muted">{enabled ? 'Connect an MCP client using Streamable HTTP. No API key required.' : 'MCP access is prepared and awaiting activation. The README button and browser shortcut below work independently.'}</p>
      {enabled && <CopyBlock label="endpoint" value="https://repo.ing/api/mcp"/>}
      <CopyBlock label="prompt" value="Find a public GitHub repo gaining attention. Check if it already has a repo.ing market. If it does not, prepare a launch review with no initial buy and give me the link. I will review and approve in my wallet."/>
      <details><summary>What the agent can do</summary><ul><li>Find repos and show the source evidence.</li><li>Check for an existing market.</li><li>Prepare a review link, valid for one hour.</li><li>Check finalized market and discoverer details.</li></ul><p>The agent cannot sign, buy, claim fees, or move funds. Your signing wallet is the discoverer. Standard discovery rules apply.</p></details>
    </section>
    <section className="inner-card" aria-labelledby="cli-launch-title"><h2 id="cli-launch-title">Launch from your terminal</h2>
      <p>In the repository you are working in, <code>launch</code> opens its repo.ing review, and <code>claim</code> shows what its next claim pays and opens the claim page. Nothing to install.</p>
      <CopyBlock label="Bun command" value="bunx @repoing/cli launch"/>
      <CopyBlock label="npm command" value="npx @repoing/cli launch"/>
      <p className="muted">The CLI never receives wallet keys. Costs and the transaction are approved in your browser and wallet.</p>
    </section>
    <section className="inner-card" aria-labelledby="readonly-mcp-title"><h2 id="readonly-mcp-title">Look up markets from your coding assistant</h2>
      <p>A read-only MCP server answers whether a repository or model has a market, what it has earned its builders, and what is trending. It never launches, trades or claims.</p>
      <CopyBlock label="read-only endpoint" value="https://repo.ing/api/mcp/readonly"/>
      <p className="muted"><a href="https://github.com/New1Direction/repo.ing/tree/main/plugins/repo-ing" target="_blank" rel="noopener noreferrer">Claude Code and Cursor plugin ↗</a></p>
    </section>
    <section className="inner-card" aria-labelledby="readme-launch-title"><h2 id="readme-launch-title">Add a README button</h2><p>Give your GitHub visitors a direct path to review a launch. If a market already exists, repo.ing opens it.</p>
      <img src="/launch-on-repoing.svg" width="180" height="32" alt="Launch on repo.ing"/>
      <label className="field-label" htmlFor="launch-badge-repo">GitHub repository</label>
      <input id="launch-badge-repo" className="field-input" value={repo} placeholder="github.com/owner/repository" onChange={event => setRepo(event.target.value)} maxLength={256} autoCapitalize="none" autoCorrect="off" spellCheck={false}/>
      {invalid && <p className="inline-error" role="status">Enter the repository’s home URL, without an issue or file path.</p>}
      {markdown && <CopyBlock label="Markdown" value={markdown}/>}
    </section>
    <section className="inner-card" aria-labelledby="shortcut-launch-title"><h2 id="shortcut-launch-title">Launch from GitHub</h2><p>Drag this shortcut to your bookmarks bar. On a GitHub repository’s home page, click it to open a repo.ing review.</p>
      <a ref={bookmark} className="button outline" onClick={event => event.preventDefault()} href="#shortcut-launch-title" draggable>Launch on repo.ing</a>
      <p className="muted shortcut-note">Desktop browsers only. Nothing launches until you approve in your wallet.</p>
    </section>
  </div>
}
