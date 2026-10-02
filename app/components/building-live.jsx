import { database } from '../lib/server.mjs'
import { readRepoStream } from '../../src/repo-streams.mjs'
import { BuildingLiveCard } from './building-live-card'

// Read with the page (one primary-key lookup), not streamed in: the card sits above other side cards and must not
// push them down after the first paint. Unavailable reads show no card.
export async function readPageStream(repoId) {
  const pool = database()
  if (!pool) return null
  return readRepoStream(pool, repoId).catch(error => {
    console.error('stream read failed', { repoId: String(repoId), error: error?.code ?? error?.name ?? 'error' })
    return null
  })
}

export const BuildingLive = ({ stream }) => stream ? <BuildingLiveCard stream={stream}/> : null
