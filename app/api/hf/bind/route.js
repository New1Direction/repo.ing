import { createWalletBinding } from '../../../../src/wallet-binding.mjs'
import { createPayoutAddresses, PayoutAddressError } from '../../../../src/payout-address.mjs'
import { hfMarketsEnabled } from '../../../../src/hf-verification.mjs'
import { takeQuota } from '../../../../src/request-quota.mjs'
import { chain, database } from '../../../lib/server.mjs'
import { backerLabels } from '../../../lib/backers.mjs'
import { assertSameOrigin } from '../../../lib/auth.mjs'
import { hfSessionCookie, readHfSession } from '../../../lib/hf-auth.mjs'
import { hfRouteError, hfSessionAuthority } from '../../../lib/hf-session.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// A model market's payout wallet, behind a Hugging Face session for that market: an exact same-origin POST, a per-user
// rate limit, and a fresh check of the model's current owner (src/hf-verification.mjs) before every change.
//   challenge { wallet }                    → the model binding message to sign (its own domain, never GitHub's)
//   bind { wallet, nonce, signature }       → binds at once; replaces a waiting pasted address
//   paste { address, confirm }              → a pasted address, active after the 48-hour hold (src/payout-address.mjs)
//   cancel { requestId }                    → cancels a waiting pasted address
//   repoint { url }                         → "Model moved?": the registry follows the model only to a URL with the same _id
// marketId (or repoId, as the shared payout-address form sends it) must be the session's market.
const headers = { 'Cache-Control': 'private, no-store' }
const ACTIONS = new Set(['challenge', 'bind', 'paste', 'cancel', 'repoint'])
const CHANGES_PER_HOUR = 60
const BINDING_ERRORS = /^(Fresh Hugging Face|Recent Hugging Face|Model verification mismatch|Invalid wallet|Invalid Solana|Invalid public key|Wallet challenge|Non-base58|Invalid public key input)/
class BindError extends Error { constructor(message, status = 400) { super(message); this.status = status } }
const reply = (body, status = 200) => Response.json(body, { status, headers })

export async function POST(request) {
  if (!hfMarketsEnabled()) return new Response('Not found', { status: 404, headers })
  try { assertSameOrigin(request, publicOrigin(request.url)) }
  catch { return reply({ error: 'Open the claim page on repo.ing and try again.' }, 403) }
  const session = readHfSession(request.cookies.get(hfSessionCookie)?.value)
  if (!session || session.mode !== 'claim') return reply({ error: 'Sign in with Hugging Face again to continue.' }, 401)
  try {
    const body = await request.json().catch(() => null)
    if (!body || !ACTIONS.has(body.action)) throw new BindError('Unsupported action.')
    if (String(body.marketId ?? body.repoId) !== session.marketId) throw new BindError('This Hugging Face session is for another model market. Sign in again here.', 403)
    const pool = database()
    if (!await takeQuota(pool, [[`hf-bind:${session.subject}`, CHANGES_PER_HOUR, 3600]])) throw new BindError('Too many changes. Try again later.', 429)
    const authority = hfSessionAuthority(session, request.url)
    const marketId = session.marketId
    if (body.action === 'repoint') {
      const moved = await authority.verifier.repoint({ marketId, url: body.url })
      return reply({ path: moved.path, previousPath: moved.previousPath })
    }
    if (body.action === 'paste' || body.action === 'cancel') {
      const service = createPayoutAddresses({ pool, connection: chain(), reserved: [...backerLabels().keys()] })
      if (body.action === 'cancel') {
        const result = await service.cancel({ githubRepoId: marketId, requestId: body.requestId, verifyAuthority: authority.verifyAuthority })
        return reply({ cancelled: true, requestId: result.requestId })
      }
      const result = await service.request({ githubRepoId: marketId, address: body.address, confirm: body.confirm, verifyAuthority: authority.verifyAuthority })
      return reply({ pending: { id: result.id, wallet: result.wallet, requestedAt: result.requestedAt, activeAt: result.activeAt }, previousWallet: result.previousWallet })
    }
    const verified = await authority.verifyCurrentAuthority({ githubRepoId: marketId })
    const binder = createWalletBinding({ pool })
    if (body.action === 'challenge') {
      const challenge = await binder.requestChallenge({ githubRepoId: marketId, wallet: body.wallet, authority: verified })
      return reply({ nonce: challenge.nonce, message: challenge.message, expiresAt: challenge.expiresAt })
    }
    if (typeof body.signature !== 'string' || body.signature.length > 200) throw new BindError('Invalid Solana wallet signature.')
    const bound = await binder.bindWallet({ githubRepoId: marketId, wallet: body.wallet, nonce: body.nonce,
      signature: Buffer.from(body.signature, 'base64'), authority: verified })
    return reply({ wallet: bound.wallet, boundAt: bound.boundAt })
  } catch (error) {
    if (error instanceof BindError) return reply({ error: error.message }, error.status)
    if (BINDING_ERRORS.test(error?.message ?? '')) return reply({ error: error.message }, 400)
    const { status, body } = hfRouteError(error, { known: [PayoutAddressError], fallback: 'The payout wallet could not be saved. Refresh and try again.', context: 'model binding' })
    return reply(body, status)
  }
}
