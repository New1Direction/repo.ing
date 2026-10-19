// Creator fee claims for native-SOL launches over HTTP, the trade API's pattern: the creator's wallet session, one signing
// ID per claim, the reviewed message signed by the wallet alone, sent once, settled from its finalized receipt. 'status'
// is the public display read (is this coin's fee in SOL, whose, and how much is claimable now). Behind
// HOOK_NATIVE_LAUNCHES_ENABLED.
import { z } from 'zod'
import { PublicKey } from '@solana/web3.js'
import { publicNativeOperation } from './hooklab-native-operation-public.mjs'
import { createHookLabDatabasePool } from '../../src/hooklab-database.mjs'
import { assertSameOrigin } from './auth.mjs'
import { walletIdentityConfiguration, walletIdentitySessionToken, walletIdentityQuota } from './hooklab-wallet-identity.mjs'
import { walletPrincipalStore } from '../../src/hooklab-wallet-principal.mjs'
import { readLimitedBody } from '../../src/token-image.mjs'
import { clientAddress } from '../../src/client-address.mjs'
import { servedFromConfiguredOrigin } from './hooklab-origin.mjs'
import { nativeClaimRuntime } from './hooklab-native-claim-runtime.mjs'
import { cached } from './hooklab-market.mjs'
import { CLAIM_STAGE } from '../../src/hooklab-native-claim.mjs'

const mint = z.string().max(44).refine(v => { try { return new PublicKey(v).toBase58() === v } catch { return false } })
const body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status'), mint }).strict(),
  z.object({ action: z.literal('claim'), signingId: z.uuid(), mint }).strict(),
  z.object({ action: z.enum(['get', 'wallet-request', 'submit', 'reconcile']), signingId: z.uuid() }).strict(),
  z.object({ action: z.literal('retain-wallet'), signingId: z.uuid(), signedTransactionBase64: z.string().max(1644) }).strict(),
])
const reply = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', Vary: 'Cookie', 'X-Content-Type-Options': 'nosniff' } })

export function createNativeClaimHandler({ env = process.env, configuration = walletIdentityConfiguration, runtime = nativeClaimRuntime,
  database = createHookLabDatabasePool, principalStore = walletPrincipalStore, quota = walletIdentityQuota } = {}) {
  return async request => {
    if (env.HOOK_NATIVE_LAUNCHES_ENABLED !== 'true' || env.HOOK_WALLET_IDENTITY_ENABLED !== 'true')
      return reply({ status: 'blocked', blockers: [{ code: 'NATIVE_CLAIMS_DISABLED', message: 'Claiming creator fees in SOL isn’t open yet.' }] })
    let pool
    try {
      const config = configuration(env)
      if (request.method !== 'POST') return reply({ error: 'Method unavailable.' }, 405)
      try { assertSameOrigin(request, config.origin); if (!servedFromConfiguredOrigin(request, config.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw Error() } catch { return reply({ error: 'Open the configured repo.ing origin.' }, 403) }
      if (new URL(request.url).search) return reply({ error: 'Query parameters unavailable.' }, 400)
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return reply({ error: 'JSON required.' }, 415)
      let input; try { input = body.parse(JSON.parse((await readLimitedBody(request, 8192)).toString('utf8'))) } catch { return reply({ error: 'Invalid claim request.' }, 400) }
      pool = database(config)
      const observing = ['status', 'get', 'reconcile'].includes(input.action)
      if (!await quota(pool, [[`native-claim:${observing ? 'observe' : 'action'}:${clientAddress(request) ?? 'unknown'}`, observing ? 120 : 30]])) return reply({ error: 'Too many requests. Try again shortly.' }, 429)
      const service = runtime()
      if (!service) return reply({ status: 'blocked', blockers: [{ code: 'NATIVE_CLAIM_RUNTIME_UNCONFIGURED', message: 'Claims are unavailable right now.' }] })
      if (service.origin !== config.origin) throw Error()
      // Public chain data: shown only to the coin's creator by the page, re-verified on two providers by any claim.
      if (input.action === 'status') return reply({ status: 'available', claim: await cached(`native-claim:${input.mint}`, 3000, () => service.status(input.mint)) })
      const token = walletIdentitySessionToken(request); if (!token) return reply({ error: 'Sign in with your wallet first.' }, 401)
      const principal = principalStore(pool, { enabled: true, origin: config.origin, audience: config.audience, genesisHash: config.genesisHash }), owner = await principal.resolve(token)
      const lifecycle = service.lifecycle
      let result
      if (input.action === 'wallet-request') result = await lifecycle.walletRequest(token, input.signingId)
      else {
        let operation
        if (input.action === 'claim') operation = await lifecycle.createReview(token, input.signingId, { custodyOperationId: input.signingId, stage: CLAIM_STAGE, intent: { mint: input.mint } })
        else if (input.action === 'get') operation = await lifecycle.get(token, input.signingId)
        else if (input.action === 'retain-wallet') operation = await lifecycle.retainWalletSignature(token, input.signingId, input.signedTransactionBase64)
        else if (input.action === 'submit') operation = await lifecycle.submitOnce(token, input.signingId)
        else operation = await lifecycle.reconcile(token, input.signingId)
        if (operation.owner !== owner.wallet || operation.stage !== CLAIM_STAGE) throw Error()
        result = { operation: publicNativeOperation(operation) }
      }
      if ((await principal.resolve(token)).wallet !== owner.wallet) throw Error()
      return reply({ status: 'available', ...result })
    } catch (error) {
      if (error.status === 401) return reply({ error: 'Wallet session expired. Sign in again.' }, 401)
      // Refusals written for creators (nothing to claim, not your coin, fee money) are shown as they are; nothing else is.
      return reply({ error: error?.code === 'HOOKLAB_USER_REFUSAL' ? error.message : 'Claim unavailable or changed. If you signed it, it is saved; check its status before starting another.' }, 409)
    } finally { await pool?.end().catch(() => {}) }
  }
}
