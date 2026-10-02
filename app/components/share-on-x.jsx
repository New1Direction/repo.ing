'use client'
import { XMark } from './x-mark'
import { ShareReferralNote, useShareReferral } from './share-referral'
import { xShareUrl } from '../lib/share-links.mjs'

// The post links the market with the wallet's ?ref only once its referral payouts are set up and it has not chosen to
// share without it; the note beside the button says so whenever it does.
export function ShareOnX({ mint, fullName, symbol, kind, source, className = 'button outline share-on-x' }) {
  const referral = useShareReferral(Boolean(mint))
  if (!mint) return null
  return <>
    <a className={className} href={xShareUrl({ mint, fullName, symbol, kind, source, ref: referral.ref })} target="_blank" rel="noopener noreferrer">
      <XMark size={14}/>Share on X
    </a>
    <ShareReferralNote referral={referral}/>
  </>
}
