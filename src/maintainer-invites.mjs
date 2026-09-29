import { formatUnits } from '../app/lib/format.mjs'

// Operator-reviewed invitations only. Nothing here posts to GitHub: the server
// builds text and a prefilled issue link; the operator decides whether to use it.
export const INVITE_LIMIT = 10
export const INVITE_SNOOZE_MS = 30 * 86400000
export const ISSUE_URL_LIMIT = 8000
const DEFAULT_THRESHOLD = 500000000n
const fail = message => { throw Object.assign(Error(message), { status: 400 }) }

export function inviteThreshold(env = process.env) {
  const value = String(env.MAINTAINER_INVITE_MIN_SOL ?? '').trim()
  if (!value) return DEFAULT_THRESHOLD
  const match = /^(\d{1,6})(?:\.(\d{1,9}))?$/.exec(value)
  if (!match) return DEFAULT_THRESHOLD
  const lamports = BigInt(match[1]) * 1000000000n + BigInt((match[2] ?? '').padEnd(9, '0'))
  return lamports > 0n ? lamports : DEFAULT_THRESHOLD
}

// rows: { repoId, claimed, available (verified lamports string or null), invitedAt, dismissedAt }
export function selectInviteCandidates(rows, { threshold = DEFAULT_THRESHOLD, now = Date.now(), limit = INVITE_LIMIT } = {}) {
  const lamports = value => typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : null
  return rows.filter(row => !row.claimed && !row.dismissedAt && lamports(row.available) !== null && lamports(row.available) >= threshold &&
      !(row.invitedAt && now - new Date(row.invitedAt).getTime() < INVITE_SNOOZE_MS))
    .sort((a, b) => lamports(b.available) > lamports(a.available) ? 1 : lamports(b.available) < lamports(a.available) ? -1 : 0)
    .slice(0, limit)
}

export const inviteTitle = fullName => `Builder fees are available for ${fullName} on repo.ing`

export function inviteText({ repoId, fullName, available, origin = 'https://repo.ing' }) {
  const claim = `${origin}/claim/${encodeURIComponent(repoId)}`
  return [`Hi! Someone in the community created a market for ${fullName} on repo.ing. Part of each trade fee is set aside for the repository's builders, and ${formatUnits(available)} SOL in builder fees is currently unclaimed (verified on-chain at the time of writing; the amount can change).`,
    `Current repository admins can verify with GitHub (read-only access), set a payout wallet, and claim the SOL here:\n${claim}`,
    'Participation is entirely optional. The market was created by the community, and it is not an endorsement by you or by this project. Nothing is required from you if you prefer not to take part.',
    'If you would rather not be contacted about this again, reply here or close this issue with a short note, and we will not reach out to this repository again.',
    'Thanks for building this project.'].join('\n\n')
}

// GitHub rejects very long URLs; shrink the body (never the title) until it fits,
// cutting raw text so no percent-escape or surrogate pair is split.
export function issueUrl({ fullName, title, body, limit = ISSUE_URL_LIMIT }) {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(fullName ?? '')) fail('Invalid repository name')
  const [owner, name] = fullName.split('/')
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/new?title=${encodeURIComponent(title)}&body=`
  let text = Array.from(body)
  const build = chars => base + encodeURIComponent(chars.join(''))
  if (build(text).length <= limit) return build(text)
  const suffix = Array.from('\n\n…')
  let low = 0, high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (build([...text.slice(0, mid), ...suffix]).length <= limit) low = mid
    else high = mid - 1
  }
  text = [...text.slice(0, low), ...suffix]
  if (build(text).length > limit) fail('Issue link is too long')
  return build(text)
}

export function createMaintainerInvites({ pool, verifiedFee, repoMeta, env = process.env, now = Date.now, origin = 'https://repo.ing', maxChecks = 30 }) {
  const threshold = inviteThreshold(env)
  const list = async () => {
    // Recorded remaining equals the verified on-chain fee whenever reconciliation
    // matches, so it bounds which markets need the slower chain check.
    const { rows } = await pool.query(`select m.github_repo_id::text as "repoId", r.full_name as "fullName", r.stars,
        coalesce(c.total,0) - coalesce(s.total,0) as recorded
      from markets m join repositories r on r.github_repo_id=m.github_repo_id
      left join (select github_repo_id, sum(amount_base_units) as total from builder_fee_credits group by 1) c on c.github_repo_id=m.github_repo_id
      left join (select github_repo_id, sum(amount_base_units) as total from repo_claims where status='settled' group by 1) s on s.github_repo_id=m.github_repo_id
      left join maintainer_invites i on i.github_repo_id=m.github_repo_id
      where m.status='confirmed' and m.indexed_at is not null and m.launch_finality='finalized' and not r.archived
        and not exists (select 1 from repo_beneficiaries b where b.github_repo_id=m.github_repo_id)
        and not exists (select 1 from repo_claims x where x.github_repo_id=m.github_repo_id and x.status<>'aborted')
        and not exists (select 1 from repository_participation p where p.github_repo_id=m.github_repo_id)
        and i.dismissed_at is null and (i.invited_at is null or i.invited_at < $2)
        and coalesce(c.total,0) - coalesce(s.total,0) >= $1
      order by recorded desc, m.github_repo_id limit $3`, [String(threshold), new Date(now() - INVITE_SNOOZE_MS), maxChecks])
    const verified = []
    for (const row of rows) {
      if (selectInviteCandidates(verified, { threshold, now: now() }).length >= INVITE_LIMIT) break
      let available = null
      try { available = await verifiedFee(row.repoId) } catch {}
      verified.push({ ...row, claimed: false, available })
    }
    const picked = selectInviteCandidates(verified, { threshold, now: now() })
    return { threshold: String(threshold), candidates: await Promise.all(picked.map(async row => {
      let meta = null
      try { meta = await repoMeta(row.repoId) } catch {}
      const fullName = meta?.fullName ?? row.fullName, hasIssues = typeof meta?.hasIssues === 'boolean' ? meta.hasIssues : null
      const title = inviteTitle(fullName), body = inviteText({ repoId: row.repoId, fullName, available: row.available, origin })
      return { repoId: row.repoId, fullName, stars: Number(meta?.stars ?? row.stars), available: row.available, hasIssues,
        title, body, issueUrl: hasIssues ? issueUrl({ fullName, title, body }) : null }
    })) }
  }
  const record = async ({ repoId, action, operator }) => {
    if (!/^[1-9]\d*$/.test(String(repoId ?? ''))) fail('Invalid repository')
    if (!['invited', 'dismissed'].includes(action)) fail('Unsupported invite action')
    const at = new Date(now())
    // Dismissal is permanent; a later "invited" never revives a dismissed repository.
    const { rowCount } = await pool.query(`insert into maintainer_invites(github_repo_id,invited_at,dismissed_at,operator_github_user_id,operator_login,updated_at)
      select $1,$2,$3,$4,$5,$6 where exists (select 1 from markets where github_repo_id=$1)
      on conflict(github_repo_id) do update set invited_at=coalesce(excluded.invited_at,maintainer_invites.invited_at),
        dismissed_at=coalesce(maintainer_invites.dismissed_at,excluded.dismissed_at),operator_github_user_id=excluded.operator_github_user_id,
        operator_login=excluded.operator_login,updated_at=excluded.updated_at where maintainer_invites.dismissed_at is null`,
      [String(repoId), action === 'invited' ? at : null, action === 'dismissed' ? at : null, operator.githubUserId, operator.githubLogin ?? null, at])
    if (!rowCount) fail('Repository has no market or was already dismissed')
    return { repoId: String(repoId), action, at: at.toISOString() }
  }
  return { list, record, threshold }
}
