import { formatSolDisplay } from './format.mjs'
import { BONUS_WINDOW_MS, MIN_OTHER_VOLUME_LAMPORTS, MIN_REPO_AGE_MS, MIN_REPO_STARS } from '../../src/verification-bonus.mjs'

const DAY_MS = 86_400_000
// The launch page's one-line rules, from the same constants the accrual pass enforces.
export const verificationBonusTerms = lamports => `A one-time ${formatSolDisplay(lamports)} SOL from repo.ing if this repo’s ` +
  `maintainer verifies on repo.ing within ${BONUS_WINDOW_MS / DAY_MS} days of launch: the repo must be ${MIN_REPO_AGE_MS / DAY_MS}+ days old ` +
  `with ${MIN_REPO_STARS}+ stars, other wallets must trade ${formatSolDisplay(MIN_OTHER_VOLUME_LAMPORTS)}+ SOL on the curve first, ` +
  'self-launches don’t qualify, and every bonus is reviewed before payout.'

// Launcher-facing wording for the one-time verification bonus (src/verification-bonus.mjs verificationBonusView).
// { amount, phrase, detail, tone, receipt }: "Verification bonus: 0.25 SOL — earned, in review", or "— ineligible: <reason>".
// Ineligible reasons are the rules' own wording; an operator's rejection reason is never public.
// The window ends at an exact instant (activation + 30 days), so the time is shown too: "Oct 31, 2026, 04:09 UTC".
const date = iso => `${new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit',
  minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' })} UTC`

export function verificationBonusCopy(bonus) {
  if (!bonus?.amount || !bonus.status) return null
  const amount = `${formatSolDisplay(bonus.amount)} SOL`
  const copy = {
    offered: { phrase: 'not earned yet', tone: 'open',
      detail: `Paid once if this repo’s maintainer verifies on repo.ing before ${date(bonus.deadline)}. Invite them to verify.` },
    checking: { phrase: 'maintainer verified, checking eligibility', tone: 'open',
      detail: 'repo.ing checks the bonus rules shortly after the maintainer verifies.' },
    in_review: { phrase: 'earned, in review', tone: 'good', detail: 'An operator reviews every bonus before it is paid.' },
    approved: { phrase: 'approved', tone: 'good', detail: 'repo.ing sends it to the launcher wallet. You don’t need to claim it.' },
    sending: { phrase: 'approved, payment sending', tone: 'good', detail: 'Waiting for Solana finality.' },
    paid: { phrase: 'paid', tone: 'good', detail: 'Sent to the launcher wallet.' },
    ineligible: { phrase: `ineligible: ${bonus.reason}`, tone: 'muted', detail: null },
    rejected: { phrase: 'not approved after review', tone: 'muted', detail: null },
    expired: { phrase: 'not earned', tone: 'muted', detail: 'The maintainer did not verify within 30 days of launch.' },
  }[bonus.status]
  if (!copy) return null
  const receipt = bonus.signature && ['sending', 'paid'].includes(bonus.status) ? `https://explorer.solana.com/tx/${bonus.signature}` : null
  return { amount, ...copy, receipt }
}
