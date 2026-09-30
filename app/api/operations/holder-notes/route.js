import { NoteError } from '../../../../src/holder-notes.mjs'
import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { assertSameOrigin, githubSessionCookie, readGithubSession } from '../../../lib/auth.mjs'
import { publicOrigin } from '../../../lib/origin.mjs'
import { holderNotesService } from '../../../lib/holder-notes.mjs'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

// Operator moderation: hide (or restore) a holder note. Hidden notes are excluded from every public read.
export async function POST(request) {
  try {
    assertSameOrigin(request, publicOrigin(request.url))
    const operator = requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value))
    const service = holderNotesService()
    if (!service) throw new NoteError('Notes are temporarily unavailable', 503)
    const body = await request.json()
    return Response.json({ result: await service.store.setHidden(body.id, body.hidden, `github:${operator.githubUserId}`) }, { headers })
  } catch (error) {
    return Response.json({ error: error.status ? error.message : 'Could not update the note. Refresh and try again.' }, { status: error.status ?? 409, headers })
  }
}
