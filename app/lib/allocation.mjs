import { createBuilderAllocation } from '../../src/builder-allocation.mjs'
import { database, chain, configAddress } from './server.mjs'
import { seal } from './auth.mjs'

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
