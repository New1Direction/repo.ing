import { database, configAddress, discoveryRewardsEnabled, builderAllocationEnabled } from './server.mjs'
import { repositoryCandidates } from './repo-discovery.mjs'
import { publicOrigin } from './origin.mjs'
import { promotionExclusions } from './promotion-exclusions.mjs'
import { createAgentLaunchService } from '../../src/agent-launch.mjs'
import { createModelLaunchService } from '../../src/agent-launch-models.mjs'
import { agentLaunchConfigured, verifyLaunchDraft, AgentLaunchError } from '../../src/agent-launch-draft.mjs'
import { hfMarketsEnabled } from '../../src/hf-launch.mjs'
import { hfClient } from './hf-client.mjs'
import { takeModelLookup } from './hf-launch.mjs'

export function draftContext(repoId) {
  if (!agentLaunchConfigured()) throw new AgentLaunchError('Agent launch reviews are currently unavailable. You can start a normal launch instead.')
  return { repoId, secret: process.env.AGENT_LAUNCH_SECRET, config: configAddress(),
    discovery: discoveryRewardsEnabled(), allocation: builderAllocationEnabled() }
}
export const checkAgentDraft = (token, repoId) => verifyLaunchDraft(token, draftContext(repoId))

export function agentLaunchService(requestUrl) {
  const pool = database()
  if (!pool || !agentLaunchConfigured()) return null
  const service = createAgentLaunchService({ pool, origin: publicOrigin(new URL(requestUrl).origin), ...draftContext(), candidates: () => suggestable(pool) })
  // The model tools exist only while Hugging Face model markets are enabled (src/hf-launch.mjs). Agents are already limited
  // per client by the agent quota, so their model lookups share only the global Hugging Face budget.
  const models = hfMarketsEnabled() ? createModelLaunchService({ pool, origin: publicOrigin(new URL(requestUrl).origin), ...draftContext(), hf: hfClient(),
    lookupQuota: () => takeModelLookup(pool, null) }) : {}
  return { pool, origin: publicOrigin(new URL(requestUrl).origin), secret: process.env.AGENT_LAUNCH_SECRET, service: { ...service, ...models } }
}

// Like /find-repos, find_repos never suggests a do-not-promote repository or one whose maintainer opted out.
async function suggestable(pool) {
  const [candidates, excluded] = await Promise.all([repositoryCandidates(pool), promotionExclusions(pool)])
  return candidates.filter(candidate => !excluded.has(String(candidate.repoId)))
}
