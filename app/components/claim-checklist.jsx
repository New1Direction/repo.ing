import { Check } from 'lucide-react'
import { claimStepStates } from '../lib/claim-checklist.mjs'

const stateText = { done: 'done', current: 'current step', upcoming: 'not started' }

export function ClaimChecklist({ current }) {
  return <ol className="claim-checklist" aria-label="Claim progress">{claimStepStates(current).map((step, index) =>
    <li key={step.label} className={step.state} aria-current={step.state === 'current' ? 'step' : undefined}>
      <span className="claim-checklist-mark" aria-hidden="true">{step.state === 'done' ? <Check size={12} strokeWidth={3}/> : index + 1}</span>
      <span>{step.label}<span className="sr-only"> ({stateText[step.state]})</span></span>
    </li>)}</ol>
}

export function WalletExplainer() {
  return <details className="wallet-explainer"><summary>New to Solana wallets?</summary>
    <p>A wallet is a free app that holds SOL, the currency fees are paid in. Phantom, Backpack and MetaMask are free browser extensions; create one, then connect it here.</p>
    <p>Payouts go only to the wallet you set. Setting it takes a signed message, not a payment.</p>
  </details>
}
