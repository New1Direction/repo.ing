import { earlyAccessNotice, fairRampNotice } from '../lib/early-access-display.mjs'

// The token page's notes (app/lib/early-access-display.mjs): while a contributor early access window is open, and while the fair
// ramp limits buys. A contributor who links a wallet during the window is added to the list within about a minute
// (src/early-access-oracle.mjs).
export function EarlyAccessNote({ market, now }) {
  const notice = earlyAccessNotice(market, now), fair = fairRampNotice(market)
  if (!notice && !fair) return null
  return <>{notice && <div className="early-access-note" role="note"><span><strong>Contributor early access</strong> · Until <time dateTime={notice.endsAt}>{notice.endsLabel}</time>,
    only this repository&apos;s contributors who linked a wallet can buy. Anyone can sell. Contributor? <a href="/contributors/link">Link your
    wallet</a>.</span></div>}
    {fair && <div className="early-access-note" role="note"><span><strong>Fair ramp</strong> · One wallet can hold at most {fair.ramp.startPercent}% of
      the supply at first, rising to {fair.ramp.endPercent}% as the curve sells. No limit from {fair.ramp.progressPercent}% curve progress.
      {fair.stars && <> Star unlocks: every {fair.stars.step} new GitHub stars since the launch add {fair.stars.bonusPercent}%, up
      to {fair.stars.maxPercent}%.</>}</span></div>}</>
}
