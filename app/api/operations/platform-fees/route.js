import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { createPlatformFees } from '../../../../src/platform-fees.mjs'
import { createDbcPlatformFees, platformTreasuryWallet } from '../../../../src/platform-dbc-fees.mjs'
import { createPlatformRevenue, platformRevenueSummary } from '../../../../src/platform-revenue.mjs'
import { Connection } from '@solana/web3.js'
import { database, chain, configAddress, partnerSigner } from '../../../lib/server.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession, seal, unseal } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

function feeService(phase = 'DBC') {
  const partner = partnerSigner()
  if (!partner) throw Error('Platform fee claiming is not configured')
  if (phase === 'DBC') return createDbcPlatformFees({ pool: database(), connection: chain(), config: configAddress(), partner,
    verification: process.env.GRADUATION_VERIFICATION_RPC_URL ? new Connection(process.env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null })
  if (phase === 'DAMM') return createPlatformFees({ pool: database(), connection: chain(), config: configAddress(), partner })
  throw Error('Invalid fee phase')
}

function session(request) {
  return requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
}

function reviewFor(sessionId, repoId, phase, data) {
  const partner = partnerSigner()
  return seal({ purpose: 'platform-fee-review', sessionId,
    repoId: String(repoId), phase, amount: data.available,
    receiver: data.receiver || partner.publicKey.toBase58(),
    ...(phase === 'DBC' ? { termsHash: data.termsHash, maxNetworkFeeLamports: '20000' } : {}),
    expiresAt: Math.min(session.expiresAt ?? Date.now() + 10 * 60_000, Date.now() + 10 * 60_000) })
}

// Operator view over every finalized market's uncollected platform fees. On-chain
// inspection is read-only; claiming still requires the reviewed POST below.
async function mapAllRepos(operator) {
  const db = await database().connect()
  try {
    const { rows: repos } = await db.query(`select m.github_repo_id::text as "repoId", m.mint,
      coalesce(r.full_name, 'Repo ' || m.github_repo_id) as "fullName",
      exists (select 1 from graduation_events g where g.github_repo_id = m.github_repo_id) as graduated
      from markets m left join repositories r on r.github_repo_id = m.github_repo_id
      where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized'
      order by m.github_repo_id`)
    const queue = [...repos], results = []
    const worker = async () => {
      while (queue.length) {
        const repo = queue.shift()
        const row = { repoId: repo.repoId, mint: repo.mint, fullName: repo.fullName, dbc: null, damm: null }
        for (const phase of ['DBC', ...(repo.graduated ? ['DAMM'] : [])]) {
          try {
            const data = await feeService(phase).status(repo.repoId)
            if (data.enrolled === false) { row[phase.toLowerCase()] = { enrolled: false, available: '0', review: null }; continue }
            const available = BigInt(data.available)
            row[phase.toLowerCase()] = { enrolled: true, available: data.available,
              receiver: data.receiver, state: data.state, latest: data.latest ?? null,
              review: available > 0n ? reviewFor(operator.sessionId, repo.repoId, phase, data) : null }
          } catch (error) { row[phase.toLowerCase()] = { enrolled: true, error: error.message, available: null, review: null } }
        }
        if (!row.damm) row.damm = { enrolled: false, available: '0', review: null }
        results.push(row)
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    const lamports = value => BigInt(value ?? 0)
    return results.sort((a, b) => Number(lamports(b.dbc.available) + lamports(b.damm.available))
      - Number(lamports(a.dbc.available) + lamports(a.damm.available)))
  } finally { db.release() }
}

export async function GET(request) {
  let operator
  try { operator = session(request) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  try {
    const [repos, revenue] = await Promise.all([
      mapAllRepos(operator),
      platformRevenueSummary(database()),
    ])
    return Response.json({ repos, revenue: {
      available: revenue.available, claimed: revenue.claimed, allocated: revenue.allocated,
      buybackReserve: revenue.buybackReserve, buybackAhead: revenue.buybackAhead, publishedSpent: revenue.publishedSpent, activePolicy: revenue.activePolicy,
      reviews: { allocate: revenue.available !== '0' && revenue.activePolicy ? seal({
        purpose: 'platform-revenue-allocate', sessionId: operator.sessionId,
        policyVersion: revenue.activePolicy.version, expiresAt: Date.now() + 10 * 60_000 }) : null } },
      checkedAt: new Date().toISOString() }, { headers })
  } catch { return Response.json({ error: 'Platform fee overview is temporarily unavailable. Try refreshing.' }, { status: 503, headers }) }
}

export async function POST(request) {
  let body
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    body = await request.json()
    const operator = session(request)
    if (body.action === 'claim') {
      const review = unseal(body.review)
      if (!review || review.purpose !== 'platform-fee-review' || review.sessionId !== operator.sessionId) throw Error('Review expired')
      return Response.json({ result: await feeService(review.phase || 'DBC').claim({ review }) }, { headers })
    }
    if (body.action === 'allocate') {
      const review = unseal(body.review)
      if (!review || review.purpose !== 'platform-revenue-allocate' || review.sessionId !== operator.sessionId) throw Error('Review expired')
      const partner = partnerSigner()
      const service = createPlatformRevenue({ pool: database(), partnerWallet: platformTreasuryWallet(partner.publicKey) })
      return Response.json({ result: await service.allocate({ review, createdBy: operator.githubUserId }) }, { headers })
    }
    throw Error('Unsupported platform fee action')
  } catch (error) {
    return Response.json({ error: error.status ? error.message : 'Refresh this page to review platform fees and try again.' },
      { status: error.status ?? 409, headers })
  }
}
