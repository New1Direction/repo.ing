import { database } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { repositoryImageSuggestions } from '../../../lib/repo-images.mjs'
import { normalizeTokenImage, readLimitedBody } from '../../../../src/token-image.mjs'

import { repositoryImageContext } from '../../../../src/repository-image-context.mjs'

export const runtime = 'nodejs'
let uploads = 0
async function repository(params) {
  const { repo } = await params
  return repositoryImageContext(database(), repo)
}

export async function GET(_request, { params }) {
  try {
    const { id, record } = await repository(params)
    return Response.json({ images: await repositoryImageSuggestions(id, record) }, { headers: { 'Cache-Control': 'private, max-age=60' } })
  } catch { return Response.json({ error: 'Suggestions are unavailable. You can still upload an image.' }, { status: 503 }) }
}

export async function POST(request, { params }) {
  if (request.headers.get('origin') !== publicOrigin(request.url)) return Response.json({ error: 'Open the image picker on repo.ing.' }, { status: 403 })
  if (uploads >= 2) return Response.json({ error: 'Image processing is busy. Try again shortly.' }, { status: 429 })
  uploads++
  try {
    await repository(params)
    const result = await normalizeTokenImage(await readLimitedBody(request))
    return Response.json({ image: result.image, label: 'Your upload' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return Response.json({ error: error.message || 'Image could not be processed.' }, { status: 400 }) }
  finally { uploads-- }
}
