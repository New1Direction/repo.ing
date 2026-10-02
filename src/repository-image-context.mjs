import { resolvePublicRepositoryById } from './github.mjs'
import { persistLaunchRepository } from './repository-store.mjs'
import { hfMarketsEnabled, isHfMarketId } from './hf-launch.mjs'

// A model market (src/hf-launch.mjs) has no GitHub identity to look up: only its row, written when the model was resolved.
async function modelImageContext(pool, id) {
  if (!hfMarketsEnabled()) throw Error('Invalid repository')
  const { rows } = await pool.query(`select owner, name, avatar_url, archived, source from repositories
    where github_repo_id=$1 and source='huggingface'`, [id])
  if (!rows[0]) throw Error('Invalid repository')
  return { id, record: rows[0] }
}

export async function repositoryImageContext(pool, id, resolve = resolvePublicRepositoryById) {
  if (!/^[1-9]\d{0,18}$/.test(String(id))) throw Error('Invalid repository')
  if (!pool) throw Error('Image service is temporarily unavailable')
  if (isHfMarketId(id)) return modelImageContext(pool, String(id))
  const { rows } = await pool.query('select owner, name, avatar_url, archived from repositories where github_repo_id=$1', [id])
  if (rows[0]) {
    if (rows[0].archived) throw Error('Archived repositories are unsupported')
    return { id, record: rows[0] }
  }
  // Find Repos and shared /launch/:id links may not have visited /api/resolve.
  // Verify and persist their public identity before either suggestions or upload.
  const repo = await resolve(id)
  if (repo.githubRepoId.toString() !== String(id)) throw Error('Repository identity mismatch')
  await persistLaunchRepository(pool, repo)
  return { id, record: { owner: repo.owner, name: repo.name, avatar_url: repo.avatarUrl } }
}
