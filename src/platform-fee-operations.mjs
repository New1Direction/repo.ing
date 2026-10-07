import { Connection } from '@solana/web3.js'
import { createPlatformFees } from './platform-fees.mjs'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, createDbcPlatformFees } from './platform-dbc-fees.mjs'
import { retryRpcRead } from './rpc-usage.mjs'
import { tradingEarlyAccessConfig } from './early-access.mjs'

// Shared by the operator panel (app/api/operations/platform-fees) and scripts/platform-sweep.mjs:
// one source of truth for which repo/phase has claimable platform fees and what a claim review pins.

export const REVIEW_TTL_MS = 10 * 60_000
export const PLATFORM_FEE_PHASES = Object.freeze(['DBC', 'DAMM'])

// `verification` overrides the DBC verification connection otherwise made from GRADUATION_VERIFICATION_RPC_URL
// (the sweep passes one that goes through its RPC meter).
// Contributor early access markets' curve fees (docs/EARLY_ACCESS.md, step 6f) and, after their graduation, their DAMM v2 partner
// fees (step 7d) are collected where EARLY_ACCESS_DBC_CONFIG is set.
export function platformFeeService(phase = 'DBC', { pool, connection, config, partner, env = process.env, verification }) {
  if (phase === 'DBC') return createDbcPlatformFees({ pool, connection, config, partner, earlyAccess: tradingEarlyAccessConfig(env),
    verification: verification ?? (env.GRADUATION_VERIFICATION_RPC_URL ? new Connection(env.GRADUATION_VERIFICATION_RPC_URL, 'finalized') : null) })
  if (phase === 'DAMM') return createPlatformFees({ pool, connection, config, partner, earlyAccess: tradingEarlyAccessConfig(env) })
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

// Every finalized SOL market's uncollected platform fees. Stock-paired markets (quote_asset_id set) are never listed, so the
// SOL sweep and panel cannot touch one: their fees go through src/stock-collections.mjs, whose listStockMarkets is exactly
// the other half of the indexed markets. On-chain inspection is read-only;
// `review` is only asked for rows with a positive balance. The panel reads four markets at once without retries.
// The sweep reads one market at a time, `paceMs` apart, and passes `retry` (retryRpcRead options) so a transient RPC
// error is retried; an entry then carries the `retries` it spent, also when it still failed.
// earlyAccess: whether the fee service takes contributor early access markets (EARLY_ACCESS_DBC_CONFIG); only then are they listed.
export async function listPlatformFees({ pool, feeService, review = () => null, concurrency = 4, paceMs = 0, retry = null,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), earlyAccess = Boolean(tradingEarlyAccessConfig()) }) {
  const db = await pool.connect()
  try {
    const { rows: repos } = await db.query(`select m.github_repo_id::text as "repoId", m.mint,
      coalesce(r.full_name, 'Repo ' || m.github_repo_id) as "fullName",
      exists (select 1 from graduation_events g where g.github_repo_id = m.github_repo_id) as graduated
      from markets m left join repositories r on r.github_repo_id = m.github_repo_id
      where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and m.quote_asset_id is null
      and (m.early_access_end is null or $1::boolean) and m.bundle_id is null
      order by m.github_repo_id`, [Boolean(earlyAccess)])
    const queue = [...repos], results = []
    const worker = async () => {
      let started = false
      while (queue.length) {
        const repo = queue.shift()
        if (started && paceMs > 0) await sleep(paceMs)
        started = true
        const row = { repoId: repo.repoId, mint: repo.mint, fullName: repo.fullName, dbc: null, damm: null }
        for (const phase of ['DBC', ...(repo.graduated ? ['DAMM'] : [])]) {
          let retries = 0
          const read = () => feeService(phase).status(repo.repoId)
          const spent = entry => (retries ? { ...entry, retries } : entry)
          try {
            const data = await (retry ? retryRpcRead(read, { ...retry, onRetry: info => {
              retries++
              retry.onRetry?.({ ...info, repoId: repo.repoId, fullName: repo.fullName, phase })
            } }) : read())
            if (data.enrolled === false) { row[phase.toLowerCase()] = spent({ enrolled: false, available: '0', review: null }); continue }
            const available = BigInt(data.available)
            row[phase.toLowerCase()] = spent({ enrolled: true, available: data.available,
              receiver: data.receiver, state: data.state, latest: data.latest ?? null,
              review: available > 0n ? review(repo.repoId, phase, data) : null })
          } catch (error) { row[phase.toLowerCase()] = spent({ enrolled: true, error: error.message, available: null, review: null }) }
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
