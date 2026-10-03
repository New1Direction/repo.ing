import { createBuilderAllocation } from '../../src/builder-allocation.mjs'
import { activateDuePayoutAddresses } from '../../src/payout-address.mjs'
import { modelBeneficiary } from '../../src/wallet-binding.mjs'
import { database, chain, configAddress } from './server.mjs'
import { seal } from './auth.mjs'
import { sealHfAllocationReview } from './hf-auth.mjs'

export async function allocationView(repoId, session) {
  const pool = database(), config = configAddress()
  if (!pool || !config) throw Error('Allocation status unavailable')
  const data = await createBuilderAllocation({ pool, connection: chain(), config }).status(repoId)
  if (!data.enrolled) return data
  const { rows: [beneficiary] } = await pool.query('select wallet, bound_at, github_user_id::text as user from repo_beneficiaries where github_repo_id=$1', [repoId])
  const expiresAt = Math.min(session?.expiresAt ?? 0, Date.now() + 10 * 60_000)
  const authorized = session && (session.scope === 'builders' || session.repoId === repoId)
  const review = data.state === 'available' && authorized && beneficiary?.user === session.githubUserId ? seal({
    purpose: 'builder-allocation-review', sessionId: session.sessionId, githubUserId: session.githubUserId,
    repoId, wallet: beneficiary.wallet, boundAt: beneficiary.bound_at.toISOString(), amount: data.amount, expiresAt,
  }) : null
  return { ...data, wallet: beneficiary?.wallet ?? null, review, expiresAt }
}

// A Hugging Face model market's allocation (app/components/hf/model-allocation.jsx and the claim page's allocation step).
// session: the Hugging Face session (app/lib/hf-auth.mjs), or null. As for GitHub, a review is sealed only while the grant
// is claimable and the market's binding was made by this session's user; nothing here asks Hugging Face, because the
// claim checks the model's current owner again. boundBy, for this market's session only: whether the saved payout wallet
// was set by this user ('you') or by someone else ('another').
export async function modelAllocationView(repoId, session) {
  const pool = database(), config = configAddress()
  if (!pool || !config) throw Error('Allocation status unavailable')
  const data = await createBuilderAllocation({ pool, connection: chain(), config }).status(repoId)
  if (!data.enrolled) return data
  // A pasted address whose hold has passed becomes the binding first (database only), so no review names a recipient that
  // is no longer current (app/lib/payout-destination.mjs does the same for the claim page).
  try { await activateDuePayoutAddresses(pool, { repoIds: [String(repoId)] }) }
  catch (error) { console.error('payout address activation unavailable', { error: error?.code ?? error?.name ?? 'error' }) }
  const binding = await modelBeneficiary(pool, repoId)
  const signedIn = session?.mode === 'claim' && session.marketId === String(repoId)
  const own = Boolean(signedIn && binding && binding.subject === session.subject)
  const review = data.state === 'available' && own ? sealHfAllocationReview(session, { repoId, wallet: binding.wallet, boundAt: binding.boundAt,
    ownerSubject: binding.ownerSubject, amount: data.amount }) : null
  return { ...data, wallet: binding?.wallet ?? null, boundBy: signedIn && binding ? (own ? 'you' : 'another') : null, review,
    expiresAt: Math.min(session?.expiresAt ?? 0, Date.now() + 10 * 60_000) }
}
