import { SITE_ORIGIN, X_HANDLE, tokenPageUrl } from './share-links.mjs'
import { formatUnits } from './format.mjs'

// Posts a builder chooses to share: the launch kit's announcement and "Share your payout". Each names only the repo, the
// ticker or the exact paid amount, and links the public token page; never a signature, and a wallet only as the sharer's
// own ?ref under the referral rules every share follows (app/components/share-referral.jsx).
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/
const intent = (text, url) => `https://x.com/intent/post?${new URLSearchParams({ text, url })}`

export function launchPostText({ symbol, fullName }) {
  const ticker = /^[A-Z0-9]{1,10}$/.test(String(symbol ?? '')) ? `$${symbol} is live: ` : ''
  return `${ticker}I just launched a market for ${fullName} on repo.ing (@${X_HANDLE}). Every trade pays the repo's builders in SOL.`
}

export function launchPostUrl({ mint, symbol, fullName, origin = SITE_ORIGIN, ref = null }) {
  if (!MINT.test(String(mint ?? '')) || !REPO.test(String(fullName ?? ''))) return null
  return intent(launchPostText({ symbol, fullName }), tokenPageUrl(mint, origin, ref))
}

// amount: the exact claimed lamports, shown in full (formatUnits never rounds).
export function payoutShareText({ amount, fullName }) {
  return `I just got paid ${formatUnits(amount)} SOL for building ${fullName} on repo.ing (@${X_HANDLE})`
}

export function payoutShareUrl({ amount, fullName, mint, origin = SITE_ORIGIN, ref = null }) {
  if (!/^[1-9]\d{0,19}$/.test(String(amount ?? '')) || !MINT.test(String(mint ?? '')) || !REPO.test(String(fullName ?? ''))) return null
  return intent(payoutShareText({ amount, fullName }), tokenPageUrl(mint, origin, ref))
}

// .github/FUNDING.yml: GitHub shows each `custom` URL on the repository's Sponsor button.
export function fundingYml(mint, origin = SITE_ORIGIN) {
  if (!MINT.test(String(mint ?? ''))) throw Error('Invalid market')
  return `custom: ["${tokenPageUrl(mint, origin)}"]`
}
