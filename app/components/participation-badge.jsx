import { database } from '../lib/server.mjs'
export async function ParticipationBadge({repoId}) {
  try {
    const {rows:[entry]}=await database().query('select github_login as login,opted_in_at as at from repository_participation where github_repo_id=$1 and enabled=true',[repoId])
    if(!entry)return null
    return <span className="badge verified" title={`@${entry.login} opted in with GitHub admin access on ${entry.at.toISOString().slice(0,10)}. Participation is not an endorsement of the token.`}>Maintainer joined · @{entry.login}</span>
  } catch { return null }
}
