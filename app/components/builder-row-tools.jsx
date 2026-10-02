'use client'
import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { SharePayout } from './payout-share'
import { SponsorSnippet } from './sponsor-snippet'
import { StreamSettings } from './stream-settings'
import styles from './builder-kit.module.css'

// Builders dashboard row: "Share your payout" once this run paid the repository, and on demand the Sponsor snippet
// (after a payout wallet verifies the repository) and the stream settings (GitHub admin is re-checked on every change).
// Both promote the market, so neither is offered while a maintainer's decline is active or cannot be read (decision !== null).
export function BuilderRowTools({ repo, result }) {
  const [open, setOpen] = useState(false), id = useId()
  const paid = result?.status === 'settled', promotable = repo.decision === null
  if (!paid && !promotable) return null
  return <div className={styles.rowTools}>
    {paid && <SharePayout amount={result.amount} fullName={repo.fullName} mint={repo.mint} className="button primary"/>}
    {promotable && <button type="button" className="button outline" aria-expanded={open} aria-controls={open ? `${id}-tools` : undefined} onClick={() => setOpen(value => !value)}>
      Sponsor button & live stream<ChevronDown size={14} aria-hidden="true" className={open ? styles.flipped : undefined}/></button>}
    {promotable && open && <div id={`${id}-tools`} className={styles.rowPanel}>
      {repo.wallet ? <div><h3>GitHub Sponsor button</h3><SponsorSnippet mint={repo.mint}/></div>
        : <p>Set a payout wallet to verify this repository, then add repo.ing to its GitHub Sponsor button.</p>}
      <StreamSettings repoId={repo.repoId}/>
    </div>}
  </div>
}
