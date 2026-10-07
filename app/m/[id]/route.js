import { isGithubRepoId } from '../../../src/market-identity.mjs'
import { tokenMetadataResponse } from '../../lib/token-metadata-read.mjs'

export const runtime = 'nodejs'

// The short metadata link of an early access launch (src/early-access-launch.mjs, earlyAccessMetadataUri): the token metadata of
// this GitHub repository's market, as /api/token-metadata/<mint> serves it. On chain for ever: keep this path. It names the right
// token only because an attempt released as failed can never land (the server holds the mint key, a definitive failure is
// decided before sending, and an expired attempt is proven expired before release): keep that true, or a landed mint would
// show the next attempt's metadata.
export async function GET(request, { params }) {
  const { id } = await params
  if (!/^[1-9]\d{0,18}$/.test(String(id)) || !isGithubRepoId(id)) return Response.json({ error: 'Invalid repository' }, { status: 400 })
  return tokenMetadataResponse(request, { repoId: String(id) })
}
