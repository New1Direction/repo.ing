// Owner moderation endpoint: delist a coin launched through the site with one of the owner's reasons, or list it again.
// The owner authenticates with the same bearer token as the owner tools (its SHA-256 is configured on the server). A
// delisting never touches the chain: the coin leaves discovery and the site stops offering BUY; selling and the creator's
// fee claim keep working.
import { z } from 'zod'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { ownerApprovalStore } from '../../src/hooklab-owner-approval.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { openLaunchesEnabled } from '../../src/hooklab-open-creation.mjs'
import { walletIdentityConfiguration } from './hooklab-wallet-identity.mjs'
import { ownerTokenMatches } from './hooklab-owner-approvals.mjs'

const mint = z.string().min(32).max(44)
const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('delist'), mint, reason: z.string().max(64) }).strict(),
  z.object({ action: z.literal('relist'), mint }).strict(),
])
const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
export function createCoinModerationHandler({ env = process.env, configuration = walletIdentityConfiguration, database = createHookLabDatabasePool, store = ownerApprovalStore } = {}) {
  return async request => {
    if (!openLaunchesEnabled(env)) return reply({ status: 'blocked', error: 'Coin moderation is not enabled.' }, 503)
    if (request.method !== 'POST') return reply({ error: 'Method unavailable.' }, 405)
    if (!ownerTokenMatches(request.headers.get('authorization'), env.HOOK_OWNER_APPROVAL_TOKEN_SHA256)) return reply({ error: 'Owner authentication required.' }, 401)
    if (new URL(request.url).search) return reply({ error: 'Query parameters unavailable.' }, 400)
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply({ error: 'JSON required.' }, 415)
    let input; try { input = inputSchema.parse(JSON.parse((await readLimitedBody(request, 2048)).toString('utf8'))) } catch { return reply({ error: 'Invalid moderation request.' }, 400) }
    let pool
    try {
      pool = database(configuration(env))
      const state = await store(pool, { adminAddress: env.HOOK_LAUNCH_ADMIN_ADDRESS, openLaunches: true })
        .moderate({ mint: input.mint, action: input.action, reason: input.action === 'delist' ? input.reason : null, actor: 'owner' })
      return reply({ status: 'ok', mint: input.mint, moderation: state })
    } catch (error) {
      return reply({ error: error?.code === 'OWNER_APPROVAL_UNAVAILABLE' ? error.message : 'Moderation unavailable.' }, 409)
    } finally { await pool?.end().catch(() => {}) }
  }
}
