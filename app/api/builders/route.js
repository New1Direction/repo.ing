import { githubSessionCookie, readGithubSession } from '../../lib/auth.mjs'
import { builderOverview } from '../../lib/builders.mjs'
export const runtime = 'nodejs'
export async function GET(request) {
  const headers = { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' }
  const session = readGithubSession(request.cookies.get(githubSessionCookie)?.value)
  if (!session) return Response.json({ error: 'Connect GitHub to see your repositories.' }, { status: 401, headers })
  try { return Response.json(await builderOverview(session), { headers }) }
  catch { return Response.json({ error: 'Could not check your GitHub repositories. Refresh or reconnect GitHub to try again.' }, { status: 503, headers }) }
}
