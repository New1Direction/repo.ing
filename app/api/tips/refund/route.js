import { createTipRefunds } from '../../../../src/tip-transfers.mjs'
import { refundChallenge, verifyRefundRequest } from '../../../../src/tip-refund-auth.mjs'
import { TIPS_DISABLED } from '../../../../src/tips.mjs'
import { chain, database } from '../../../lib/server.mjs'
import { tipSigner } from '../../../lib/tips.mjs'
import { assertSameOrigin, seal, unseal } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
export const runtime = 'nodejs'

const SAFE = /^(Tips are not enabled|Choose up to|Refund request expired|Invalid Solana|Only the wallet|Some tips were|Tips can be refunded|Invalid public key|Invalid refund)/
const PER_MINT_SAFE = /^(Tip wallet balance is below|Tip payouts are paused|Tips changed while|Token (has|accounts|transfers|is non|mint)|Recipient must be)/
export async function POST(request) {
  const headers = { 'Cache-Control': 'private, no-store' }
  try {
    const signer = tipSigner(), pool = database()
    if (!signer || !pool) throw Error(TIPS_DISABLED)
    assertSameOrigin(request, publicOrigin(request.url))
    const body = await request.json()
    if (body.action === 'challenge') {
      const { terms, message } = refundChallenge({ wallet: body.wallet, tipIds: body.tipIds })
      // Fail early with the precise reason; the refund itself re-checks everything under the tip-wallet lock.
      const { rows } = await pool.query(`select count(*)::int as ok from repo_tips where id = any($1::uuid[]) and donor_wallet=$2
        and status='confirmed' and transfer_id is null and refund_after <= now()`, [terms.tipIds, terms.wallet])
      if (rows[0].ok !== terms.tipIds.length) throw Error('Tips can be refunded 90 days after they were sent, if still unclaimed')
      return Response.json({ challenge: seal(terms), message }, { headers })
    }
    if (body.action === 'refund') {
      const terms = unseal(body.challenge)
      if (!terms) throw Error('Refund request expired. Try again.')
      const { donorWallet, tipIds } = verifyRefundRequest(terms, body.signature)
      const results = await createTipRefunds({ pool, connection: chain(), signer }).refund({ donorWallet, tipIds })
      return Response.json({ results: results.map(r => r.status === 'failed'
        ? { mint: r.mint, status: 'failed', error: PER_MINT_SAFE.test(r.error) ? r.error : 'This refund could not be sent. Try again later.' }
        : { mint: r.mint, status: r.status, signature: r.signature, amount: r.amount }) }, { headers })
    }
    throw Error('Invalid refund action')
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Refund could not finish. Refresh and try again.', 'tip refund') },
      { status: error?.message === TIPS_DISABLED ? 503 : 400, headers })
  }
}
