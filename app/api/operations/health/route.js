import { requirePlatformOperator } from '../../../lib/platform-operator.mjs'
import { readGithubSession, githubSessionCookie } from '../../../lib/auth.mjs'
import { operationsHealth } from '../../../lib/operations-health.mjs'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'private, no-store' }

// Read-only. Each section carries its own {ok,data|error}, so one failing section still returns 200.
export async function GET(request) {
  try { requirePlatformOperator(readGithubSession(request.cookies.get(githubSessionCookie)?.value)) }
  catch (error) { return Response.json({ error: error.message }, { status: error.status ?? 403, headers }) }
  return Response.json(await operationsHealth(), { headers })
}
