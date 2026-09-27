import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { createPlatformFees } from '../../../../src/platform-fees.mjs'
import { createDbcPlatformFees } from '../../../../src/platform-dbc-fees.mjs'
import { Connection } from '@solana/web3.js'
import { database, chain, configAddress, partnerSigner } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, seal, unseal } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

function service(phase = 'DAMM') {
  const partner = partnerSigner()
  if (!partner) throw Error('Platform fee claiming is not configured')
  if (phase === 'DBC') return createDbcPlatformFees({ pool: database(), connection: chain(), config: configAddress(), partner,
    verification: process.env.GRADUATION_VERIFICATION_RPC_URL ? new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null })
  if (phase !== 'DAMM') throw Error('Invalid fee phase')
  return createPlatformFees({ pool: database(), connection: chain(), config: configAddress(), partner })
}

export async function GET(request, { params }) {
  try {
    const { repo } = await params
    if (!/^[1-9]\d*$/.test(repo)) return Response.json({ error: 'Invalid repository' }, { status: 400, headers })
    const session = requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
    const phase = new URL(request.url).searchParams.get('phase') || 'DAMM'
    const data = await service(phase).status(repo)
    if (data.enrolled === false) return Response.json(data, { headers })
    const review = BigInt(data.available) > 0n ? seal({ purpose: 'platform-fee-review', sessionId: session.sessionId,
      repoId: repo, phase, amount: data.available, receiver: data.receiver || partnerSigner().publicKey.toBase58(),
      ...(phase === 'DBC' ? { termsHash: data.termsHash, maxNetworkFeeLamports: '20000' } : {}),
      expiresAt: Math.min(session.expiresAt, Date.now() + 10 * 60_000) }) : null
    return Response.json({ ...data, review }, { headers })
  } catch (error) { return Response.json({ error: error.status ? error.message : 'Platform fees are temporarily unavailable. Try refreshing.' }, { status: error.status ?? 503, headers }) }
}

export async function POST(request, { params }) {
  let review, repo
  try {
    ({ repo } = await params)
    assertSameOrigin(request, publicOrigin(request.url))
    const session = requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
    review = unseal((await request.json()).review)
    if (!session || review?.purpose !== 'platform-fee-review' || review.sessionId !== session.sessionId ||
        review.repoId !== repo || session.scope !== 'builders') throw Error('Review expired')
    const result = await service(review.phase || 'DAMM').claim({ review })
    return Response.json(result, { headers })
  } catch (error) {
    if (error.status) return Response.json({ error: error.message }, { status: error.status, headers })
    if (review?.repoId === repo && review?.purpose === 'platform-fee-review') {
      const { rows: [row] } = await database().query(`select status, signature, wallet, amount::text
        from platform_fee_claims where github_repo_id=$1 and phase=$2 order by id desc limit 1`, [repo, review.phase || 'DAMM']).catch(() => ({ rows: [] }))
      if (row && ['pending', 'settled'].includes(row.status)) return Response.json(row, { headers })
    }
    const message = /in flight/.test(error.message) ? 'A platform fee claim is already in flight.' :
      /differ/.test(error.message) ? 'Indexed platform fees changed; refresh and review again.' :
      /No platform fees/.test(error.message) ? 'No platform fees remain to claim.' :
      'Refresh this page to review platform fees and try again.'
    return Response.json({ status: 'failed', error: message }, { status: 409, headers })
  }
}
