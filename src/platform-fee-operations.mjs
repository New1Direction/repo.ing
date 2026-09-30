import { Connection } from '@solana/web3.js'
import { createPlatformFees } from './platform-fees.mjs'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, createDbcPlatformFees } from './platform-dbc-fees.mjs'

// Shared by the operator panel (app/api/operations/platform-fees) and scripts/platform-sweep.mjs:
// one source of truth for which repo/phase has claimable platform fees and what a claim review pins.

export const REVIEW_TTL_MS = 10 * 60_000
export const PLATFORM_FEE_PHASES = Object.freeze(['DBC', 'DAMM'])

export function platformFeeService(phase = 'DBC', { pool, connection, config, partner, env = process.env }) {
  if (phase === 'DBC') return createDbcPlatformFees({ pool, connection, config, partner,
    verification: env.GRADUATION_VERIFICATION_RPC_URL ? new Connection(env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null })
  if (phase === 'DAMM') return createPlatformFees({ pool, connection, config, partner })
  throw Error('Invalid fee phase')
}

// The exact terms a claim may execute: amount is the fresh status read, never an operator-typed number.
export function platformFeeReview({ sessionId, repoId, phase, data, partner, sessionExpiresAt, now = Date.now() }) {
  return { purpose: 'platform-fee-review', sessionId,
    repoId: String(repoId), phase, amount: data.available,
    receiver: data.receiver || partner.toBase58(),
    ...(phase === 'DBC' ? { termsHash: data.termsHash, maxNetworkFeeLamports: String(DBC_MAX_NETWORK_FEE_LAMPORTS) } : {}),
    expiresAt: Math.min(sessionExpiresAt ?? now + REVIEW_TTL_MS, now + REVIEW_TTL_MS) }
}

export function allocationReview({ sessionId, policyVersion, now = Date.now() }) {
  return { purpose: 'platform-revenue-allocate', sessionId, policyVersion, expiresAt: now + REVIEW_TTL_MS }
}

// Every finalized market's uncollected platform fees. On-chain inspection is read-only;
// `review` is only asked for rows with a positive balance.
export async function listPlatformFees({ pool, feeService, review = () => null, concurrency = 4 }) {
  const db = await pool.connect()
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
              review: available > 0n ? review(repo.repoId, phase, data) : null }
          } catch (error) { row[phase.toLowerCase()] = { enrolled: true, error: error.message, available: null, review: null } }
        }
        if (!row.damm) row.damm = { enrolled: false, available: '0', review: null }
        results.push(row)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker))
    const lamports = value => BigInt(value ?? 0)
    return results.sort((a, b) => Number(lamports(b.dbc.available) + lamports(b.damm.available))
      - Number(lamports(a.dbc.available) + lamports(a.damm.available)))
  } finally { db.release() }
}
