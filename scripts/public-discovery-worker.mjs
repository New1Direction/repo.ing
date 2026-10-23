import { runPublicDiscovery } from './run-public-discovery.mjs'

// Separate from the application and financial worker: no public trigger, wallet,
// broad database binding, alert delivery, launch synchronization or replay.
export default {
  fetch() {
    return new Response('Not found', { status: 404 })
  },
  async scheduled(controller, env) {
    controller.noRetry()
    try {
      const result = await runPublicDiscovery({ env: {
        PUBLIC_DISCOVERY_DATABASE_URL: env.PUBLIC_DISCOVERY_DATABASE_URL,
        PROMOTION_EXCLUDED_REPO_IDS: env.PROMOTION_EXCLUDED_REPO_IDS,
      } })
      console.log(JSON.stringify({ publicDiscovery: result }))
    } catch {
      throw Error('PUBLIC_DISCOVERY_UNAVAILABLE')
    }
  },
}
