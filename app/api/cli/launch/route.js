import { agentLaunchService } from '../../../lib/agent-launch.mjs'
import { takeAgentQuota } from '../../../../src/agent-launch-http.mjs'
import { CLI_QUOTA, createCliLaunchHandler } from '../../../../src/cli-launch-http.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// `repoing launch` (cli/): the handler and its checks are src/cli-launch-http.mjs. The CLI has its own rate-limit buckets.
export async function POST(request) {
  const setup = agentLaunchService(request.url)
  return createCliLaunchHandler({ setup, quota: client => takeAgentQuota(setup.pool, client, setup.secret, CLI_QUOTA) })(request)
}

export function GET() {
  return new Response('Use POST.', { status: 405, headers: { Allow: 'POST' } })
}
