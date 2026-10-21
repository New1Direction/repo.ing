// Two independent finalized readers; never initializes a hook, signs, or submits.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { PublicKey, VersionedMessage } from '@solana/web3.js'
import { hookLabReviewSchema, inspectHookLabMessage } from './hooklab-message-boundary.mjs'
import { selectedHookPreparationRequestSchema, planSelectedHookPreparation, selectedAuthorityAccounts } from './hooklab-selected-hook-preparation.mjs'
import { parseInclusiveMaxWalletProfile } from './hooklab-inclusive-max-wallet-profile.mjs'
import { assertLocalExecutionEndpoint } from './hooklab-local-acceptance.mjs'
import { provenLatestBlockhash } from './hooklab-blockhash-proof.mjs'
const fail = () => Object.assign(Error('Selected-hook preparation reads unavailable or changed'), { code: 'SELECTED_HOOK_PREPARATION_READS_UNAVAILABLE' })
const check = v => { if (!v) throw fail() }
const integer = v => { check(Number.isSafeInteger(v) && v >= 0); return v }
const pk = v => new PublicKey(v)
const pda = (p, ...s) => PublicKey.findProgramAddressSync(s.map(v => typeof v === 'string' ? Buffer.from(v) : v), pk(p))[0].toBase58()
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
export function selectedHookPreparationInventory(profile, request, selectedAuthorityEvidence) {
  const p = parseInclusiveMaxWalletProfile(profile), r = selectedHookPreparationRequestSchema.parse(request)
  const L = p.programs.launch, H = r.selectedHook.program, loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
  return [L, H, pda(loader, pk(L).toBuffer()), pda(loader, pk(H).toBuffer()), pda(L, 'config'),
    pda(H, 'bordrless-hook-accounts', pk(r.mint).toBuffer()), r.mint, r.selectedConfig, r.creator, r.feePayer, pda(L, 'launch', pk(r.mint).toBuffer()), ...selectedAuthorityAccounts(selectedAuthorityEvidence).map(a => a.address)]
}

/** Caller supplies server-owned profile/pin/Connections and reviewed limits, not browser observations.
 * Retention revalidates the original message, fee, policy binding and lifetime without renewal.
 */
export async function collectSelectedHookPreparationReview({ profile, hookPin, selectedAuthorityEvidence, request, connections, limits, expectedReview, clock = Date.now }) {
  try {
    const retained = expectedReview === undefined ? null : hookLabReviewSchema.parse(expectedReview)
    if (retained) { inspectHookLabMessage(retained); check(retained.operation === 'selected-hook-preparation') }
    const p = parseInclusiveMaxWalletProfile(JSON.parse(profile.json)), r = selectedHookPreparationRequestSchema.parse(request)
    check(createHash('sha256').update(profile.json).digest('hex') === profile.expectedSha256)
    check(Array.isArray(connections) && connections.length === 2 && equal(connections.map(c => c.provider), profile.providers)
      && new Set(connections.map(c => c.provider)).size === 2 && connections[0].connection !== connections[1].connection)
    const endpoints = connections.map(c => c.connection.rpcEndpoint)
    // Match the inclusive collector's test transport allowance; real Connections expose endpoints.
    if (endpoints.some(v => v !== undefined)) {
      check(endpoints.every(v => typeof v === 'string')); endpoints.forEach(assertLocalExecutionEndpoint)
      const urls = endpoints.map(v => new URL(v))
      check(urls.every(v => v.protocol === 'https:' && !v.username && !v.password && !v.hash) && urls[0].origin !== urls[1].origin)
    }
    const inventory = selectedHookPreparationInventory(p, r, selectedAuthorityEvidence), keys = inventory.map(pk), start = integer(clock())
    const observations = await Promise.all(connections.map(async ({ provider, connection: c }) => {
      const genesisHash = await c.getGenesisHash(); check(genesisHash === p.genesisHash)
      const response = await c.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized' })
      check(response.value.length === keys.length); integer(response.context.slot)
      const rent = integer(await c.getMinimumBalanceForRentExemption(176, 'finalized'))
      return { provider, genesisHash, commitment: 'finalized', slot: response.context.slot, observedAtMs: start,
        accounts: response.value.map((a, i) => ({ address: inventory[i], account: a === null ? null : { address: inventory[i], owner: a.owner.toBase58(),
          executable: a.executable, lamports: String(integer(a.lamports)), dataBase64: Buffer.from(a.data).toString('base64') } })), rentExemptionLamports: { selectedConfig: String(rent) } }
    }))
    const slot = Math.max(...observations.map(o => o.slot))
    const latest = retained ? { context: { slot }, value: { blockhash: VersionedMessage.deserialize(Buffer.from(retained.messageBase64, 'base64')).recentBlockhash,
      lastValidBlockHeight: retained.lastValidBlockHeight } } : await provenLatestBlockhash(connections, { minContextSlot: slot })
    check(integer(latest.context.slot) >= slot)
    const confirmations = await Promise.all(connections.map(async ({ connection: c }) => {
      const valid = await c.isBlockhashValid(latest.value.blockhash, { commitment: 'finalized', minContextSlot: latest.context.slot })
      check(valid.value === true && integer(valid.context.slot) >= latest.context.slot)
      return { slot: valid.context.slot, height: integer(await c.getBlockHeight({ commitment: 'finalized', minContextSlot: valid.context.slot })) }
    }))
    const priority = (BigInt(limits.computeUnitLimit) * BigInt(limits.computeUnitPriceMicroLamports) + 999999n) / 1000000n
    const now = integer(clock()); check(now >= start)
    const recentBlockhash = { ...latest.value, genesisHash: p.genesisHash, providers: profile.providers, observedAtMs: start,
      currentBlockHeight: Math.max(...confirmations.map(c => c.height)), blockhashValid: true, observedSlot: Math.max(...confirmations.map(c => c.slot)),
      networkFeeLamports: String(10000n + priority), lamportsPerSignature: '5000' }
    const input = { profile, hookPin, ...(selectedAuthorityEvidence ? { selectedAuthorityEvidence } : {}), request: r, observations, recentBlockhash, limits: { ...limits, nowMs: now } }
    const computed = planSelectedHookPreparation(input)
    if (retained) {
      const stable = v => { const { observedSlot, observedAtMs, ...rest } = v; return rest }
      check(equal(stable(computed.review), stable(retained)))
    }
    const review = retained ? freeze(retained) : computed.review, plan = retained ? Object.freeze({ ...computed, review }) : computed
    const message = VersionedMessage.deserialize(Buffer.from(review.messageBase64, 'base64'))
    const fees = await Promise.all(connections.map(({ connection: c }) => c.getFeeForMessage(message, 'finalized')))
    for (const fee of fees) check(fee.value !== null && String(integer(fee.value)) === recentBlockhash.networkFeeLamports && integer(fee.context.slot) >= recentBlockhash.observedSlot)
    const finished = integer(clock())
    check(finished >= now && finished - start <= limits.maxAgeMs && finished < review.reviewExpiresAtMs)
    return freeze({ plan, preparationInput: structuredClone(input), collection: { schema: 'repoing/selected-hook-planning-collection/1', providers: [...profile.providers],
      startedAtMs: start, finishedAtMs: finished, feeQuotedByBoth: true, productionApprovalVerified: false, canSign: false, canSubmit: false } })
  } catch (error) {
    if (error?.code === 'SELECTED_HOOK_REGISTRY_REQUIRED') throw error
    throw fail()
  }
}
