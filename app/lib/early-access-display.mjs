// What the token page says about a contributor early access market (docs/EARLY_ACCESS.md): while its window is open, only the
// wallets on its allow list may receive the token, so only they can buy (the transfer hook refuses anyone else); anyone can sell.
// After the window it trades like any other market and nothing is shown; so after its graduation, even inside the window: the curve's
// filling swap revoked the hook, so anyone can buy its graduated pool (step 7b). migrated: its migration is recorded (graduation_events),
// which stays true; graduated: the page's fresh graduation read.
const LABEL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })

export function earlyAccessNotice(market, now = Date.now()) {
  if (!market?.transferHookProgram || !market.earlyAccessEnd || market.graduated || market.migrated) return null
  const end = new Date(market.earlyAccessEnd)
  if (!Number.isFinite(end.getTime()) || end.getTime() <= now) return null
  return { endsAt: end.toISOString(), endsLabel: `${LABEL.format(end)} UTC` }
}
