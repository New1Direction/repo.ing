import { PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { database, chain, configAddress, launchAvailable, builderAllocationEnabled } from './server.mjs'
import { configState } from './launch-fee.mjs'
import { sessionVerifier } from './github-session.mjs'
import { createLaunchGuide, createPreflightService, launchTerms } from '../../src/launch-guide.mjs'
import { recordGuideEvent } from '../../src/launch-guide-events.mjs'
import { createLaunchSchedules, schedulesEnabled } from '../../src/launch-schedules.mjs'
import { persistLaunchRepository } from '../../src/repository-store.mjs'
import { resolvePublicRepositoryById } from '../../src/github.mjs'
import { trackingRefused } from './launch-guide-funnel.mjs'
import { takeQuota } from '../../src/request-quota.mjs'

// Web wiring for the guided launch (src/launch-guide.mjs): one preflight service per process, so its GitHub cache and the launch
// config (read once, it cannot change) are shared by every request this process serves.

const terms = async ({ meter }) => {
  const config = configAddress()
  if (!config) return null
  const fixed = await configState(config, { onRead: () => { meter.rpc += 1 } })
  return launchTerms({ config, fixed, client: new DynamicBondingCurveClient(chain(), 'confirmed'), allocation: builderAllocationEnabled() })
}
const balance = async (wallet, { meter }) => {
  meter.rpc += 1
  return chain().getBalance(new PublicKey(wallet), 'confirmed')
}

export function preflightService() {
  const pool = database()
  if (!pool) return null
  if (!globalThis.__repoingPreflight || globalThis.__repoingPreflight.pool !== pool) {
    globalThis.__repoingPreflight = { pool, service: createPreflightService({ pool, readTerms: terms, readBalance: balance,
      platform: () => ({ launchAvailable: launchAvailable(), schedulesEnabled: schedulesEnabled() }),
      log: (event, detail) => console.warn(event, detail) }) }
  }
  return globalThis.__repoingPreflight.service
}

// The guide for one signed-in GitHub session (identity sign-in; every admin decision is checked with GitHub again).
export function launchGuideFor(session, request) {
  const pool = database(), preflight = preflightService()
  if (!pool || !preflight) return null
  const verifier = sessionVerifier(session, request.url, { dashboard: true })
  const refused = trackingRefused(request.headers)
  return createLaunchGuide({ pool, preflight,
    verifyAdmin: async repoId => {
      const result = await verifier.repositoryPermission({ githubRepoId: repoId })
      return { admin: result.admin === true, githubLogin: result.githubLogin, permission: result.permission }
    },
    schedules: createLaunchSchedules({ pool, verifyAdmin: ({ githubRepoId }) => verifier.verifyRepositoryAdmin({ githubRepoId }) }),
    // The repository row the schedule references, from the facts the preflight just read (no second GitHub read when fresh).
    persistRepository: async repoId => {
      const cached = preflight.cachedRepository(repoId)
      const repo = cached ? { githubRepoId: BigInt(cached.repoId), owner: cached.owner, name: cached.name, fullName: cached.fullName, description: cached.description,
        avatarUrl: cached.avatarUrl, stars: cached.stars ?? 0, forks: cached.forks ?? 0, archived: cached.archived, githubUpdatedAt: new Date(cached.updatedAt ?? Date.now()),
        githubCreatedAt: cached.createdAt ? new Date(cached.createdAt) : null } : await resolvePublicRepositoryById(repoId)
      await persistLaunchRepository(pool, repo)
    },
    record: event => recordGuideEvent(pool, event, { refused }) })
}

// Anonymous preflights (the public route and read-only MCP) share one budget of uncached GitHub reads across every replica, so
// visitors walking many repositories cannot spend the GitHub App's hourly allowance the worker and claims need. A cached repository
// is always answered. Returns the run, or { busy: true } when the budget is spent.
export const PUBLIC_PREFLIGHT_GITHUB_PER_HOUR = 150
export async function publicPreflight(input) {
  const service = preflightService()
  if (!service) return null
  if (!service.isCached(input) && !await takeQuota(database(), [['launch-preflight:github', PUBLIC_PREFLIGHT_GITHUB_PER_HOUR, 3600]])) return { busy: true }
  return service.run(input, { plan: null, maintainer: null })
}

