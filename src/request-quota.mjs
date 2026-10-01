// Fixed-window request quotas in agent_request_limits, shared by every web replica and surviving restarts (the same
// table and semantics as the agent, holder-note and X-link quotas). scopes: [[scope, limit, windowSeconds], ...];
// every scope must have room, checked in order, and a refused scope stops counting the rest.
export async function takeQuota(pool, scopes) {
  for (const [scope, limit, seconds] of scopes) {
    const { rows } = await pool.query(`insert into agent_request_limits(scope,hits,expires_at) values($1,1,now()+make_interval(secs=>$3))
      on conflict(scope) do update set hits=case when agent_request_limits.expires_at<=now() then 1 else agent_request_limits.hits+1 end,
      expires_at=case when agent_request_limits.expires_at<=now() then now()+make_interval(secs=>$3) else agent_request_limits.expires_at end
      where agent_request_limits.expires_at<=now() or agent_request_limits.hits<$2 returning hits`, [scope, limit, seconds])
    if (!rows.length) return false
  }
  return true
}
