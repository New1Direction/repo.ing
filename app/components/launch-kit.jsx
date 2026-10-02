'use client'
import { useState } from 'react'
import { Check, Code2, Link2 } from 'lucide-react'
import { XMark } from './x-mark'
import { InviteOwner } from './invite-owner'
import { ShareReferralNote, useShareReferral } from './share-referral'
import { badgeMarkdown } from '../lib/readme-badge.mjs'
import { launchPostUrl } from '../lib/builder-share.mjs'
import { tokenPageUrl } from '../lib/share-links.mjs'
import styles from './builder-kit.module.css'

// Next steps after a confirmed launch: announce the ticker on X, the README badge, the market link, and an invitation
// for the maintainer while nobody has verified the repository on repo.ing. The X post and the copied link carry the
// wallet's ?ref under the same rules (and note) as every other share; the README badge never does.
export function LaunchKit({ repoId, fullName, mint, symbol, verified = false }) {
  const [copied, setCopied] = useState(''), [fallback, setFallback] = useState(null)
  const referral = useShareReferral()
  const post = launchPostUrl({ mint, symbol, fullName, ref: referral.ref })
  let badge = null
  try { badge = badgeMarkdown(repoId, mint) } catch { /* no badge for a malformed market */ }
  async function copy(kind, value) {
    setFallback(null)
    try { await navigator.clipboard.writeText(value); setCopied(kind) }
    catch { setCopied(''); setFallback({ kind, value }) }
  }
  return <section className={styles.kit} aria-labelledby="launch-kit-title">
    <span className={styles.eyebrow}>Launch kit</span>
    <h3 id="launch-kit-title">Tell people ${symbol} is live</h3>
    <p>Announce it, put the badge in the README and bring in the maintainer. Builders earn from every trade.</p>
    <div className={styles.kitActions}>
      {post && <a className="button outline" href={post} target="_blank" rel="noopener noreferrer"><XMark size={15}/>Post on X</a>}
      {badge && <button type="button" className="button outline" onClick={() => copy('badge', badge)}>
        {copied === 'badge' ? <Check size={15} aria-hidden="true"/> : <Code2 size={15} aria-hidden="true"/>}{copied === 'badge' ? 'Badge copied' : 'Copy README badge'}</button>}
      <button type="button" className="button outline" onClick={() => copy('link', tokenPageUrl(mint, window.location.origin, referral.ref))}>
        {copied === 'link' ? <Check size={15} aria-hidden="true"/> : <Link2 size={15} aria-hidden="true"/>}{copied === 'link' ? 'Link copied' : 'Copy link'}</button>
      {!verified && <InviteOwner repoId={repoId} fullName={fullName} label="Invite the maintainer"/>}
    </div>
    <ShareReferralNote referral={referral} className={styles.kitNote}/>
    {badge && <div className={styles.badgeStrip}><img src={`/api/badge/${repoId}`} height={24} alt="README badge preview: builder fees earned on repo.ing"/>
      <span>Shows the builder fees earned and links to the market.</span></div>}
    {fallback ? <><p className={styles.status} role="status">Copy did not work here. Select the text below and copy it.</p>
      <input className={styles.fallback} readOnly value={fallback.value} onFocus={event => event.target.select()}
        aria-label={fallback.kind === 'badge' ? 'README badge Markdown' : 'Market link'}/></>
      : <p className={styles.status} role="status">{copied === 'badge' ? 'Paste the Markdown into your README.' : copied === 'link' ? `Market link copied${referral.ref ? ' · includes your referral (your wallet address)' : ''}.` : ''}</p>}
  </section>
}
