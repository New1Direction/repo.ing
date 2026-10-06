import { earlyAccessNotice } from '../lib/early-access-display.mjs'

// The token page's note while a contributor early access window is open (app/lib/early-access-display.mjs).
export function EarlyAccessNote({ market, now }) {
  const notice = earlyAccessNotice(market, now)
  if (!notice) return null
  return <div className="early-access-note" role="note"><span><strong>Contributor early access</strong> · Until <time dateTime={notice.endsAt}>{notice.endsLabel}</time>,
    only this repository&apos;s contributors who linked a wallet can buy. Anyone can sell.</span></div>
}
