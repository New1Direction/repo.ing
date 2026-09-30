import { database } from '../../../../../lib/server.mjs'
import { validUuid } from '../../../../../../src/parts-fund.mjs'
import { updateImage } from '../../../../../../src/parts-images.mjs'
import { githubImageVariantResponse } from '../../../../../../src/token-image.mjs'
export const runtime = 'nodejs'

// Serves image N of a posted build update, re-encoded (src/parts-images.mjs). Only links stored on an update resolve.
export async function GET(_request, { params }) {
  const { update, index } = await params
  const n = Number(index)
  if (!validUuid(update) || !/^[0-3]$/.test(String(index))) return new Response(null, { status: 404 })
  const pool = database()
  if (!pool) return new Response(null, { status: 503 })
  try {
    const { rows: [row] } = await pool.query('select images from parts_updates where id=$1', [update])
    const url = Array.isArray(row?.images) ? row.images[n] : null
    if (typeof url !== 'string') return new Response(null, { status: 404 })
    return githubImageVariantResponse(await updateImage(url))
  } catch (error) {
    console.error('parts update image failed', { update, error: error.message })
    return new Response(null, { status: 502, headers: { 'Cache-Control': 'no-store' } })
  }
}
