'use client'
import { XMark } from './x-mark'
import { ShareReferralNote, useShareReferral } from './share-referral'
import { payoutShareUrl } from '../lib/builder-share.mjs'
import styles from './builder-kit.module.css'

// After a settled claim: an X post with the exact amount paid, the repository and its token page. The link carries the
// wallet's ?ref under the same rules (and note) as every other share.
export function SharePayout({ amount, fullName, mint, className = 'button outline' }) {
  const referral = useShareReferral()
  const href = payoutShareUrl({ amount, fullName, mint, ref: referral.ref })
  if (!href) return null
  return <><a className={`${className} ${styles.shareLink}`} href={href} target="_blank" rel="noopener noreferrer"><XMark size={14}/>Share your payout</a>
    <ShareReferralNote referral={referral} className={styles.shareNote}/></>
}

// Keeps the receipt's share actions on one wrapping row.
export const ShareRow = ({ children }) => <div className={styles.shareRow}>{children}</div>
