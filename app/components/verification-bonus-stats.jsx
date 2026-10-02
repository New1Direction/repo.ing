import { database } from '../lib/server.mjs'
import { formatSolDisplay } from '../lib/format.mjs'

// /stats: verification bonuses paid to launchers (settled payouts only, finalized receipts). Hidden until the first one.
export async function VerificationBonusStats() {
  const pool = database()
  if (!pool) return null
  let totals = null
  try {
    totals = (await pool.query(`select count(*)::int as count, coalesce(sum(amount), 0)::text as lamports
      from verification_bonus_payouts where status = 'settled'`)).rows[0]
  } catch (error) { if (error?.code !== '42P01') console.error('verification bonus stats unavailable', { error: error.message }) }
  if (!totals?.count) return null
  return <section className="analytics-token" aria-labelledby="verification-bonus-title"><div>
    <div className="eyebrow">VERIFICATION BONUSES</div><h2 id="verification-bonus-title">Verification bonuses</h2>
    <p>Launchers earn a one-time bonus from platform revenue when the repository’s maintainer verifies within 30 days of launch. Every bonus is reviewed before it is paid.</p>
  </div><div className="analytics-token-state"><span>Paid to launchers</span><strong>{formatSolDisplay(totals.lamports)} SOL</strong>
    <small>{totals.count} {totals.count === 1 ? 'bonus' : 'bonuses'} · finalized receipts</small></div></section>
}
