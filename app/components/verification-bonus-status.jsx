import Link from 'next/link'
import { BadgeCheck } from 'lucide-react'
import { verificationBonusCopy } from '../lib/verification-bonus-copy.mjs'
import '../verification-bonus.css'

// One-time verification bonus inside the launcher-rewards card on the token page.
export function VerificationBonusStatus({ bonus, repoId }) {
  const copy = verificationBonusCopy(bonus)
  if (!copy) return null
  return <div className={`verification-bonus is-${copy.tone}`} role="status">
    <BadgeCheck size={18} aria-hidden="true"/>
    <div>
      <p className="verification-bonus-line"><strong>Verification bonus: {copy.amount}</strong> — <span>{copy.phrase}</span>
        {copy.receipt && <> · <a href={copy.receipt} target="_blank" rel="noopener noreferrer">{bonus.status === 'paid' ? 'Receipt' : 'View transaction'} ↗</a></>}</p>
      {copy.detail && <p className="verification-bonus-detail">{copy.detail}
        {bonus.status === 'offered' && repoId && <> <Link href={`/claim/${repoId}`}>Maintainer verification page →</Link></>}</p>}
    </div>
  </div>
}

// The same status as one value in a wallet market row (/wallet).
export function VerificationBonusWalletValue({ bonus }) {
  const copy = verificationBonusCopy(bonus)
  if (!copy) return null
  return <span className={`wallet-verification-bonus is-${copy.tone}`}>Verification bonus<strong>{copy.amount}</strong>
    <small>{copy.phrase}{copy.receipt && <> · <a href={copy.receipt} target="_blank" rel="noopener noreferrer">{bonus.status === 'paid' ? 'Receipt' : 'Transaction'} ↗</a></>}</small></span>
}
