import { agentLaunchService } from '../../lib/agent-launch.mjs'
import { createAgentMcpHandler, takeAgentQuota } from '../../../src/agent-launch-http.mjs'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const setup = agentLaunchService(request.url)
  if (!setup) return Response.json({ error: 'Agent launch reviews are not enabled.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  return createAgentMcpHandler({ ...setup, quota: client => takeAgentQuota(setup.pool, client, setup.secret) })(request)
}
export function GET() { return new Response('Use Streamable HTTP POST.', { status: 405, headers: { Allow: 'POST' } }) }
