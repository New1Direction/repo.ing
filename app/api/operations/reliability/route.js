import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { readGithubSession, githubSessionCookie } from '../../../lib/auth.mjs'
import { operatorReliability } from '../../../lib/operator-reliability.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' }

export async function GET(request) {
  try { requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value)) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  // Partial failure is data, not a successful health check: consumers must examine status and sections.
  return Response.json(await operatorReliability(), { headers })
}
