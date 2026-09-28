import { createHmac, timingSafeEqual } from 'node:crypto'
import * as z from 'zod/v4'
import { DISCOVERY_VERSION } from './discovery-rewards.mjs'

export const DRAFT_LIFETIME_MS = 60 * 60 * 1000
export class AgentLaunchError extends Error {}
const draftSchema = z.object({
  version: z.literal(1), purpose: z.literal('launch-review'),
  repoId: z.string().regex(/^[1-9]\d{0,18}$/), fullName: z.string().min(3).max(200),
  config: z.string().min(32).max(44), discovery: z.boolean(), allocation: z.boolean(),
  discoveryVersion: z.number().int().nullable(),
  tokenName: z.string().trim().min(1).max(32).regex(/^[^\x00-\x1f\x7f]+$/),
  tokenSymbol: z.string().regex(/^[A-Z0-9]{1,10}$/),
  initialBuy: z.enum(['none', '100', '200', '300']), issuedAt: z.number().int(), expiresAt: z.number().int(),
}).strict()

function mac(payload, secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new AgentLaunchError('Agent launch reviews are not configured.')
  return createHmac('sha256', secret).update(`repo.ing:launch-review:v1:${payload}`).digest()
}
export function signLaunchDraft(input, { secret, now = Date.now() }) {
  const draft = draftSchema.parse({ ...input, discoveryVersion: input.discovery ? DISCOVERY_VERSION : null, version: 1, purpose: 'launch-review', issuedAt: now, expiresAt: now + DRAFT_LIFETIME_MS })
  const payload = Buffer.from(JSON.stringify(draft)).toString('base64url')
  return { draft, token: `${payload}.${mac(payload, secret).toString('base64url')}` }
}
export function verifyLaunchDraft(token, { secret, repoId, config, discovery, allocation, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > 2048 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new AgentLaunchError('Invalid launch review link.')
  const [payload, signature] = token.split('.')
  const expected = mac(payload, secret), supplied = Buffer.from(signature, 'base64url')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new AgentLaunchError('Invalid launch review link.')
  let draft
  try { draft = draftSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))) }
  catch { throw new AgentLaunchError('Invalid launch review link.') }
  if (draft.issuedAt > now || draft.expiresAt <= now || draft.expiresAt - draft.issuedAt !== DRAFT_LIFETIME_MS) throw new AgentLaunchError('This launch review expired. Create a fresh review link.')
  if (draft.repoId !== String(repoId)) throw new AgentLaunchError('This review belongs to a different repository.')
  if (draft.config !== config || draft.discovery !== discovery || draft.allocation !== allocation || draft.discoveryVersion !== (discovery ? DISCOVERY_VERSION : null)) throw new AgentLaunchError('Launch rules changed. Create a fresh review link.')
  return draft
}

export function agentLaunchConfigured(env = process.env) {
  return env.AGENT_LAUNCH_ENABLED === 'true' && Buffer.byteLength(env.AGENT_LAUNCH_SECRET || '') >= 32
}
