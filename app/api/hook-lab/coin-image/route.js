import { publicOrigin } from '../../../lib/origin.mjs'
import { publicError } from '../../../lib/public-error.mjs'
import { createRateLimiter } from '../../../lib/csp-report.mjs'
import { clientAddress } from '../../../../src/client-address.mjs'
import { normalizeTokenImage, readLimitedBody } from '../../../../src/token-image.mjs'
import { siteLaunchesEnabled } from '../../../../src/hooklab-open-creation.mjs'

// Prepares a hooks coin image the way /api/repo-images prepares a repository token image: a 512 x 512 PNG
// returned to the launch form. Nothing is stored until the creator queues a launch request with it.
const SAFE = /^(Choose|This image|Image|SVG references)/
const READ_DEADLINE_MS = 15_000
export const runtime = 'nodejs'
const allowed = createRateLimiter({ limit: 12, globalLimit: 300, windowMs: 10 * 60_000 })
let processing = 0

function readWithDeadline(request) {
  let timer
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Image upload took too long. Try again.')), READ_DEADLINE_MS) })
  return Promise.race([readLimitedBody(request), deadline]).finally(() => clearTimeout(timer))
}

export async function POST(request) {
  if (!siteLaunchesEnabled(process.env)) return Response.json({ error: 'Coin images are not open yet.' }, { status: 404 })
  if (request.headers.get('origin') !== publicOrigin(request.url)) return Response.json({ error: 'Open the launch form on repo.ing.' }, { status: 403 })
  if (!allowed(clientAddress(request) ?? 'unknown')) return Response.json({ error: 'Too many uploads. Try again in a few minutes.' }, { status: 429 })
  let bytes
  try { bytes = await readWithDeadline(request) } catch (error) { return Response.json({ error: publicError(error, SAFE, 'Image could not be uploaded.', 'hooks coin image') }, { status: 400 }) }
  // The decode slot is taken only once the whole body is here, so slow uploads cannot hold it.
  if (processing >= 2) return Response.json({ error: 'Image processing is busy. Try again shortly.' }, { status: 429 })
  processing++
  try {
    const result = await normalizeTokenImage(bytes)
    return Response.json({ image: result.image, label: 'Your upload' }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) { return Response.json({ error: publicError(error, SAFE, 'Image could not be processed.', 'hooks coin image') }, { status: 400 }) }
  finally { processing-- }
}
