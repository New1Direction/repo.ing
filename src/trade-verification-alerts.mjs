export const TRADE_VERIFICATION_FAILED = 'TRADE_VERIFICATION_FAILED'

// A confirmed trade whose finalized receipt check or fee indexing fails becomes a durable operator alert on the
// same graduation_alerts feed as the health and graduation panels. One row per signature: status polls, retries
// and other replicas cannot duplicate it. Details stay operator-only; the trader only ever sees the chain result.
export async function recordTradeVerificationFailure(db, { signature, prepared, stage, error }) {
  const detail = { code: stage, signature, phase: prepared.phase ?? 'curve', mint: prepared.mint ?? null,
    pool: prepared.pool?.toString?.() ?? null, reason: error?.message ?? String(error) }
  const { rowCount } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing`, [`trade-verification:${signature}`, String(prepared.githubRepoId), TRADE_VERIFICATION_FAILED, JSON.stringify(detail)])
  return rowCount === 1
}
