import { database } from '../../../lib/server.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { repositoryImageSuggestions } from '../../../lib/repo-images.mjs'
import { normalizeTokenImage, readLimitedBody } from '../../../../src/token-image.mjs'

export const runtime = 'nodejs'
let uploads = 0
async function repository(params) {
  const { repo } = await params
  if (!/^[1-9]\d{0,18}$/.test(repo)) throw Error('Invalid repository')
  const pool = database()
  if (!pool) throw Error('Image service is temporarily unavailable')
  const { rows } = await pool.query('select owner, name, avatar_url from repositories where github_repo_id=$1', [repo])
  if (!rows[0]) throw Error('Resolve this repository before choosing an image')
  return { id: repo, record: rows[0] }
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
