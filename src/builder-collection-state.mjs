// Caller holds the repository advisory lock when using this to authorize a payout.
export async function builderCollectionState(db, repoId) {
  const { rows: [row] } = await db.query(`select
    coalesce(sum(amount) filter (where status='settled'),0)::text as collected,
    count(*) filter (where status='pending')::int as pending
    from builder_fee_collections where github_repo_id=$1`, [String(repoId)])
  return { collected: BigInt(row.collected), pending: row.pending }
}
