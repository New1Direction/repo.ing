import { isGithubRepoId } from '../../../src/market-identity.mjs'
import { tokenMetadataResponse } from '../../lib/token-metadata-read.mjs'

export const runtime = 'nodejs'

// The short metadata link of an early access launch (src/early-access-launch.mjs, earlyAccessMetadataUri): the token metadata of
// this GitHub repository's market, as /api/token-metadata/<mint> serves it. On chain for ever: keep this path.
export async function GET(request, { params }) {
  const { id } = await params
  if (!/^[1-9]\d{0,18}$/.test(String(id)) || !isGithubRepoId(id)) return Response.json({ error: 'Invalid repository' }, { status: 400 })
  return tokenMetadataResponse(request, { repoId: String(id) })
}
