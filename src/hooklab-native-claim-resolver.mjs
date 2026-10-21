// Server-owned two-provider resolver for creator fee claims (signing stage native-claim). Same contract as the trade and
// funding resolvers: prepare -> review, revalidate -> identical review before signing and sending, reconcile -> exact-wire
// finalized receipt with exact lamport movements and the claim event. No request-supplied observations or pins.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { validateMaxWalletOperatorBindings } from './hooklab-max-wallet-launch-collector.mjs'
import { verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { canonicalObservation } from './hooklab-canonical-observation.mjs'
import { refuse } from './hooklab-wallet-funding.mjs'
import { CLAIM_COMPUTE_UNITS, CLAIM_STAGE, compileNativeClaimReview, launchAddress, nativeClaimInventory, nativeClaimRequestSchema, verifyNativeClaimReceipt } from './hooklab-native-claim.mjs'
import { LAUNCH_ACCOUNT_BYTES } from './hooklab-native-launch.mjs'
import { isStackProfile } from './hooklab-stack.mjs'

// About 40 seconds from review to send (the wallet approval happens inside it); the compiler allows up to 150 slots.
export const CLAIM_SIGNING_WINDOW_SLOTS = 100
const check = (ok, message = 'Claim state, intent or pins changed') => { if (!ok) throw Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex'), pk = value => new PublicKey(value)
const integer = value => { check(Number.isSafeInteger(value) && value >= 0); return value }

export function nativeClaimResolver({ config, profile, dossierJson, connections, limits, clock = Date.now }) {
  const retained = structuredClone({ config, profile, dossierJson, limits }), providers = connections.map(x => ({ ...x }))
  const bound = validateMaxWalletOperatorBindings({ ...retained, connections: providers }), p = bound.profile
  // limits.nowMs is the boot time, so it is left out (JSON drops undefined): a restart or deploy must not move this hash.
  const configurationSha256 = sha(JSON.stringify({ claim: 1, ...retained, limits: { ...retained.limits, nowMs: undefined } }))
  // Our own stack pins its launch build in its profile (the trimmed ELF a deployed ProgramData holds).
  const claimProfile = { genesisHash: p.genesisHash, programs: p.programs, profileSha256: bound.config.profileSha256, providers: profile.providers,
    ...(isStackProfile(p) ? { launchElf: { trimmedSha256: p.elfSha256.launch, trimmedLength: profile.elfLengths.launch } } : {}) }

  async function collect({ owner, stage, intent, expectedReview, originalContext }) {
    check(stage === CLAIM_STAGE, 'Unsupported claim stage')
    const request = nativeClaimRequestSchema.parse({ schema: 'repoing/hooklab-native-claim-request/1', creator: owner, mint: intent?.mint, ...(intent?.claimantRole !== undefined ? { claimantRole: intent.claimantRole } : {}) })
    if (originalContext) check(originalContext.configurationSha256 === configurationSha256 && isDeepStrictEqual(originalContext.compilationInput.request, request))
    const started = integer(clock()), launch = launchAddress(p.programs, request.mint)
    const rentFor = async bytes => {
      const values = await Promise.all(providers.map(({ connection }) => connection.getMinimumBalanceForRentExemption(bytes, 'finalized')))
      check(values.every(v => integer(v) === values[0])); return String(values[0])
    }
    const observations = await Promise.all(providers.map(async ({ provider, connection }) => {
      check(await connection.getGenesisHash() === p.genesisHash)
      let inventory = nativeClaimInventory(claimProfile, request), minContextSlot = expectedReview?.observedSlot ?? 0
      // Base -> immutable config/partner state -> their destinations. Re-read the complete
      // inventory at each step; never merge snapshots or use the other provider's discovery.
      for (let step = 0; step < 4; step++) {
        const state = await connection.getMultipleAccountsInfoAndContext(inventory.map(pk), { commitment: 'finalized', minContextSlot })
        check(state.value.length === inventory.length && integer(state.context.slot) >= minContextSlot)
        minContextSlot = state.context.slot
        const observation = canonicalObservation({ provider, genesisHash: p.genesisHash, commitment: 'finalized', slot: minContextSlot, observedAtMs: started,
          accounts: state.value.map((v, i) => ({ address: inventory[i], account: v ? { address: inventory[i], owner: v.owner.toBase58(), executable: v.executable,
            lamports: String(integer(v.lamports)), dataBase64: Buffer.from(v.data).toString('base64') } : null })) })
        const next = nativeClaimInventory(claimProfile, request, new Map(observation.accounts.map(x => [x.address, x.account])))
        if (isDeepStrictEqual(next, inventory)) return observation
        inventory = next
      }
      throw Error('Claim inventory did not stabilize')
    }))
    // Every trade of the coin moves the launch account's lamports, and the creator's wallet can move too, so two providers
    // at different slots differ there. Everything else must agree; the claim then compiles from the first snapshot (the
    // amount is whatever the account holds above rent when it lands, settled from the receipt).
    const steady = o => o.accounts.map(x => x.account && (x.address === launch || x.account.owner === '11111111111111111111111111111111' && !x.account.executable && x.account.dataBase64 === '') ? { ...x, account: { ...x.account, lamports: null } } : x)
    check(isDeepStrictEqual(steady(observations[0]), steady(observations[1])), 'Providers disagree on claim state')
    const first = Object.fromEntries(observations[0].accounts.map(x => [x.address, x.account]))
    for (const o of observations) o.accounts = o.accounts.map(x => ({ ...x, account: first[x.address] }))
    const rent = { launchLamports: await rentFor(LAUNCH_ACCOUNT_BYTES), walletLamports: await rentFor(0) }
    const slot = Math.max(...observations.map(o => o.slot))
    const latest = expectedReview ? { context: { slot }, value: { blockhash: VersionedMessage.deserialize(Buffer.from(expectedReview.messageBase64, 'base64')).recentBlockhash, lastValidBlockHeight: expectedReview.lastValidBlockHeight } }
      : await providers[0].connection.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: slot })
    const confirmations = await Promise.all(providers.map(async ({ connection }) => {
      const valid = await connection.isBlockhashValid(latest.value.blockhash, { commitment: 'finalized', minContextSlot: latest.context.slot })
      refuse(valid.value === true && integer(valid.context.slot) >= latest.context.slot, 'This claim expired before it was signed. Start again.')
      return { slot: valid.context.slot, height: integer(await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: valid.context.slot })) }
    }))
    const liveSlots = originalContext ? null : await Promise.all(providers.map(async ({ connection }) => integer(await connection.getSlot('confirmed'))))
    if (liveSlots) check(Math.max(...liveSlots) - Math.min(...liveSlots) <= retained.limits.maxSlotLag)
    const l = originalContext ? { ...originalContext.compilationInput.limits, nowMs: integer(clock()) }
      : { ...retained.limits, nowMs: integer(clock()), validUntilSlot: Math.min(Math.min(...liveSlots) + CLAIM_SIGNING_WINDOW_SLOTS, slot + 150), reviewExpiresAtMs: started + retained.limits.maxAgeMs }
    const recentBlockhash = { ...latest.value, genesisHash: p.genesisHash, providers: profile.providers, observedAtMs: started, currentBlockHeight: Math.max(...confirmations.map(x => x.height)),
      blockhashValid: true, observedSlot: Math.max(...confirmations.map(x => x.slot)), lamportsPerSignature: bound.config.lamportsPerSignature,
      networkFeeLamports: String(BigInt(bound.config.lamportsPerSignature) + (BigInt(CLAIM_COMPUTE_UNITS) * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n) }
    const compilationInput = { profile: claimProfile, request, observations, rent, recentBlockhash, limits: l }
    const plan = compileNativeClaimReview(compilationInput)
    if (expectedReview) {
      const stable = r => { const { observedSlot, observedAtMs, policySha256, ...rest } = r; return rest }
      check(isDeepStrictEqual(stable(plan.review), stable(expectedReview)), 'This claim changed since its review. Start again.')
    }
    const message = VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64'))
    await Promise.all(providers.map(async ({ connection }) => {
      const quoted = await connection.getFeeForMessage(message, 'finalized')
      check(quoted.value !== null && String(integer(quoted.value)) === recentBlockhash.networkFeeLamports)
      const simulation = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed' })
      refuse(simulation.value.err === null, 'This claim would fail on Solana right now, so nothing was sent. Try again in a moment.')
    }))
    check(clock() < plan.review.reviewExpiresAtMs)
    return { status: 'operator-pins-and-state-verified', owner, stage, profileSha256: bound.config.profileSha256, messageSha256: plan.review.messageSha256, configurationSha256,
      review: expectedReview ?? plan.review, request, settlementContext: { schema: 'repoing/hooklab-native-claim-settlement-context/1', configurationSha256, compilationInput }, canSign: false, canSubmit: false }
  }

  // Finalized on both providers with identical evidence: the exact signed bytes, one inclusion within the blockhash lifetime,
  // then verifyNativeClaimReceipt (exact lamport deltas and the claim event).
  async function reconcile({ review, configurationSha256: hash, settlementContext, signedTransactionBase64, signature }) {
    const identity = { signature, messageSha256: review?.messageSha256, profileSha256: review?.profileSha256 }
    try {
      const ci = settlementContext?.compilationInput
      // A row stored before a bundle change (the dossier is re-collected after every governed change) keeps its own hash:
      // it settles only bound to its own context and today's profile, and only if its full review still recompiles.
      check(settlementContext?.schema === 'repoing/hooklab-native-claim-settlement-context/1' && settlementContext.configurationSha256 === hash
        && (hash === configurationSha256 || isDeepStrictEqual(ci?.profile, claimProfile)))
      // A jsonb column hands the context back with its keys reordered: rebuild the observations in their one construction order.
      const plan = compileNativeClaimReview({ ...ci, observations: ci.observations.map(canonicalObservation) })
      check(isDeepStrictEqual(plan.review, review) && verifyHookLabSignedMessage(review, signedTransactionBase64).signature === signature)
      const rows = await Promise.all(providers.map(async ({ connection }) => {
        check(await connection.getGenesisHash() === p.genesisHash)
        const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }); if (!tx) return null
        const meta = tx.meta; check(meta && meta.err !== undefined && Array.isArray(meta.innerInstructions))
        const wire = new VersionedTransaction(tx.transaction.message); wire.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
        check(Buffer.from(wire.serialize()).toString('base64') === signedTransactionBase64)
        const slot = integer(tx.slot), block = await connection.getBlockSignatures(slot, 'finalized')
        check(block && block.signatures.filter(s => s === signature).length === 1 && integer(block.blockHeight) <= review.lastValidBlockHeight && slot >= review.observedSlot)
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? { writable: [], readonly: [] } })
        const addresses = Array.from({ length: keys.length }, (_, i) => keys.get(i).toBase58())
        check(isDeepStrictEqual(addresses, review.accounts.map(x => x.address)))
        return { slot, blockHeight: block.blockHeight, blockhash: block.blockhash, previousBlockhash: block.previousBlockhash, error: meta.err, fee: integer(meta.fee),
          pre: meta.preBalances.map(integer), post: meta.postBalances.map(integer), keys: addresses,
          innerInstructions: meta.innerInstructions.map(g => ({ index: g.index, instructions: g.instructions.map(ix => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accounts], data: ix.data, stackHeight: ix.stackHeight })) })) }
      }))
      if (rows.some(x => x === null)) return { ...identity, status: 'unresolved' }
      if (!isDeepStrictEqual(rows[0], rows[1])) return { ...identity, status: 'conflict' }
      const tx = rows[0], inclusion = { slot: tx.slot, blockHeight: tx.blockHeight, blockhash: tx.blockhash, previousBlockhash: tx.previousBlockhash }
      const fee = String(tx.fee), outcome = verifyNativeClaimReceipt({ plan, rent: ci.rent, programs: p.programs, tx })
      if (!outcome.executed) return { ...identity, status: 'finalized-failure', inclusion, feeLamports: fee }
      // delivered: the lamports the creator received from the launch account (before the network fee), for the receipt.
      return { ...identity, status: 'finalized-success', executionStatus: 'finalized-executed', inclusion, feeLamports: fee, quote: { delivered: outcome.claimedLamports },
        claimedLamports: outcome.claimedLamports, reviewSlotBoundExceeded: tx.slot > review.validUntilSlot, policyReviewRequired: false, reviewBoundsSatisfied: true }
    } catch { return { ...identity, status: 'unresolved' } }
  }

  return Object.freeze({
    configurationSha256,
    prepare: collect,
    async revalidate({ owner, stage, review, configurationSha256: hash, settlementContext }) {
      check(hash === configurationSha256)
      return collect({ owner, stage, intent: settlementContext.compilationInput.request, expectedReview: review, originalContext: settlementContext })
    },
    reconcile,
  })
}
