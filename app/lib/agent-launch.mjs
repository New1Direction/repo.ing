import { database, configAddress, discoveryRewardsEnabled, builderAllocationEnabled } from './server.mjs'
import { repositoryCandidates } from './repo-discovery.mjs'
import { publicOrigin } from './origin.mjs'
import { createAgentLaunchService } from '../../src/agent-launch.mjs'
import { agentLaunchConfigured, verifyLaunchDraft, AgentLaunchError } from '../../src/agent-launch-draft.mjs'

export function draftContext(repoId) {
  if (!agentLaunchConfigured()) throw new AgentLaunchError('Agent launch reviews are currently unavailable. You can start a normal launch instead.')
  return { repoId, secret: process.env.AGENT_LAUNCH_SECRET, config: configAddress(),
    discovery: discoveryRewardsEnabled(), allocation: builderAllocationEnabled() }
}
export const checkAgentDraft = (token, repoId) => verifyLaunchDraft(token, draftContext(repoId))

export function agentLaunchService(requestUrl) {
  const pool = database()
  if (!pool || !agentLaunchConfigured()) return null
  return { pool, origin: publicOrigin(new URL(requestUrl).origin), secret: process.env.AGENT_LAUNCH_SECRET,
    service: createAgentLaunchService({ pool, origin: publicOrigin(new URL(requestUrl).origin), ...draftContext(), candidates: () => repositoryCandidates(pool) }) }
}
