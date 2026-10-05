import { parseRepositoryUrl, resolvePublicRepository, RepositoryResolutionError } from '../../../src/github.mjs'
import { persistLaunchRepository } from '../../../src/repository-store.mjs'
import { publicError } from '../../lib/public-error.mjs'
import { database } from '../../lib/server.mjs'
import { activeDecision, OPT_OUT_ERROR } from '../../../src/maintainer-opt-outs.mjs'
import { checkLaunchLineage, LineageError } from '../../../src/repo-lineage.mjs'
import { namesHuggingFace } from '../../../src/hf-launch.mjs'
import { resolveModelRequest } from '../../lib/hf-launch.mjs'
import { refuseOverLimit } from '../../lib/request-limits.mjs'
export const runtime = 'nodejs'
export async function POST(request) {
  try {
    const { url } = await request.json()
    // huggingface.co / hf.co: a model market (dormant until HF_MARKETS_ENABLED). Every other value is a GitHub repository.
    if (namesHuggingFace(url)) return await resolveModelRequest(url, request)
    const normalizedUrl = typeof url === 'string' && url.trim().startsWith('github.com/') ? `https://${url.trim()}` : url
    const { owner, name } = parseRepositoryUrl(normalizedUrl)
    const pool = database()
    if (!pool) return Response.json({ error: 'Database is not configured' }, { status: 503 })
    // Existing finalized markets can be opened without consuming GitHub's shared IP limit. GitHub rows only: a Hugging Face
    // model may share this owner/name.
    const known = await pool.query(`select r.github_repo_id::text as "repoId", m.mint
      from repositories r join markets m on m.github_repo_id = r.github_repo_id
      where lower(r.full_name) = lower($1) and r.source = 'github' and r.archived = false
        and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'
        and r.synced_at > now() - interval '24 hours'`, [`${owner}/${name}`])
    if (known.rows[0]) return Response.json(known.rows[0])
    // Counted only when GitHub must be asked (app/lib/request-limits.mjs).
    const refused = refuseOverLimit(request, 'resolve')
    if (refused) return refused
    const repo = await resolvePublicRepository(normalizedUrl)
    await persistLaunchRepository(pool, repo)
    const { rows } = await pool.query(`select mint from markets where github_repo_id = $1 and status='confirmed' and indexed_at is not null and launch_finality='finalized'`, [repo.githubRepoId.toString()])
    // Without a market the next step is a launch: refuse it when the maintainer opted the repository out.
    if (!rows[0]?.mint && await activeDecision(pool, repo.githubRepoId.toString())) {
      return Response.json({ error: OPT_OUT_ERROR, code: 'MAINTAINER_OPTED_OUT' }, { status: 403 })
    }
    // The fork guard (src/repo-lineage.mjs), said here before anyone fills in a launch review. Advisory: launch prepare checks again.
    if (!rows[0]?.mint) {
      try { await checkLaunchLineage({ pool, repo, advisory: true }) }
      catch (error) {
        if (!(error instanceof LineageError)) throw error
        return Response.json({ error: error.message, code: error.code, original: error.original }, { status: 409 })
      }
    }
    return Response.json({ repoId: repo.githubRepoId.toString(), mint: rows[0]?.mint ?? null })
  } catch (error) {
    const known = error instanceof RepositoryResolutionError
    return Response.json({ error: publicError(error, () => known, 'Repository lookup is temporarily unavailable. Try again shortly.', 'resolve') },
      { status: known ? 400 : 503 })
  }
}
