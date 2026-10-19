// Server-owned two-provider resolver for customer wallet funding (wallet-fund / wallet-withdraw). Same contract as
// the inclusive trade resolver: prepare -> review, revalidate -> identical review before signing and sending,
// reconcile -> exact-wire finalized receipt with exact lamport movements. No request-supplied observations or pins.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { validateMaxWalletOperatorBindings } from './hooklab-max-wallet-launch-collector.mjs'
import { inspectHookLabMessage, verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { BRIDGE_PIN, compileWalletFundingReview, refuse, verifyBridgeAccounts, walletFundingInventory, walletFundingRequestSchema, HOLDING_BYTES } from './hooklab-wallet-funding.mjs'
import { LOADER, derivedAddresses, kb, pda } from './hooklab-owner-driver/pins.mjs'
import { loadArtifacts } from './hooklab-owner-driver/artifacts.mjs'
import { canonicalObservation } from './hooklab-canonical-observation.mjs'
import { provenLatestBlockhash } from './hooklab-blockhash-proof.mjs'
import { REVIEWED_PROFILE_SHA256, reviewedFundingProfile } from './hooklab-reviewed-profiles.mjs'

// About 40 seconds from review to send (the wallet approval happens inside it); the compiler allows up to 150 slots.
export const SIGNING_WINDOW_SLOTS = 100
const asAccount = (address, v) => v ? { address, owner: v.owner.toBase58(), executable: v.executable, lamports: String(v.lamports), dataBase64: Buffer.from(v.data).toString('base64') } : null

const check = (ok, message = 'Wallet funding state, intent or pins changed') => { if (!ok) throw Error(message) }
const sha = value => createHash('sha256').update(value).digest('hex'), pk = value => new PublicKey(value)
const integer = value => { check(Number.isSafeInteger(value) && value >= 0); return value }
export const FUNDING_STAGES = Object.freeze({ 'wallet-fund': 'fund', 'wallet-withdraw': 'withdraw' })
const zeroed = (base64, offset, length) => { const b = Buffer.from(base64, 'base64'); if (b.length >= offset + length) b.fill(0, offset, offset + length); return b.toString('base64') }
// Byte offset of Wrapper.total_wrapped, from the pinned bridge IDL layout (discriminator, then the fields before it).
function wrapperTotalOffset() {
  const { idls } = loadArtifacts(), fields = idls.bridge.types.find(t => t.name === 'Wrapper').type.fields, size = { u8: 1, bool: 1, u16: 2, u32: 4, u64: 8, i64: 8, pubkey: 32 }
  let offset = 8
  for (const field of fields) { if (field.name === 'total_wrapped') return offset; check(size[field.type], 'Wrapper layout differs'); offset += size[field.type] }
  throw Error('Wrapper layout differs')
}

// bridgePin is server configuration for synthetic tests; production always uses BRIDGE_PIN.
// bridgePin and tokenProgramDataSha256 are server configuration for synthetic tests; production uses BRIDGE_PIN and the dossier.
// reviewedProfiles: the reconcile allowlist (src/hooklab-reviewed-profiles.mjs).
export function walletFundingResolver({ config, profile, dossierJson, connections, limits, clock = Date.now, bridgePin = BRIDGE_PIN, tokenProgramDataSha256 = null, reviewedProfiles = REVIEWED_PROFILE_SHA256 }) {
  const retained = structuredClone({ config, profile, dossierJson, limits }), providers = connections.map(x => ({ ...x }))
  const bound = validateMaxWalletOperatorBindings({ ...retained, connections: providers })
  // limits.nowMs is the boot time, so it is left out (JSON drops undefined): a restart or deploy must not move this hash.
  const p = bound.profile, configurationSha256 = sha(JSON.stringify({ funding: 1, ...retained, limits: { ...retained.limits, nowMs: undefined } }))
  const volatile = () => ({ wrapperAddress: derivedAddresses(p.programs, p.quoteMint).bridgeNativeWrapper, totalOffset: wrapperTotalOffset() })
  const fundingProfile = { genesisHash: p.genesisHash, programs: p.programs, quoteMint: p.quoteMint, profileSha256: bound.config.profileSha256, providers: profile.providers }

  async function collect({ owner, stage, intent, expectedReview, originalContext }) {
    const { quote: ignored, ...raw } = intent ?? {}
    const request = walletFundingRequestSchema.parse({ ...raw, schema: 'repoing/hooklab-wallet-funding-request/1', owner })
    check(FUNDING_STAGES[stage] === request.action, 'Funding stage and action differ')
    if (originalContext) check(originalContext.configurationSha256 === configurationSha256 && isDeepStrictEqual(originalContext.compilationInput.request, request))
    const started = integer(clock()), inventory = walletFundingInventory(fundingProfile, request, bridgePin)
    const rentFor = async bytes => {
      const values = await Promise.all(providers.map(({ connection }) => connection.getMinimumBalanceForRentExemption(bytes, 'finalized')))
      check(values.every(v => integer(v) === values[0])); return String(values[0])
    }
    const vaultAddress = derivedAddresses(p.programs, p.quoteMint).bridgeSolVault
    const observations = await Promise.all(providers.map(async ({ provider, connection }) => {
      check(await connection.getGenesisHash() === p.genesisHash)
      const state = await connection.getMultipleAccountsInfoAndContext(inventory.map(pk), { commitment: 'finalized', minContextSlot: expectedReview?.observedSlot ?? 0 })
      check(state.value.length === inventory.length)
      return canonicalObservation({ provider, genesisHash: p.genesisHash, commitment: 'finalized', slot: integer(state.context.slot), observedAtMs: started,
        accounts: state.value.map((v, i) => ({ address: inventory[i], account: v ? { address: inventory[i], owner: v.owner.toBase58(), executable: v.executable,
          lamports: String(integer(v.lamports)), dataBase64: Buffer.from(v.data).toString('base64') } : null })) })
    }))
    // Every wrap and unwrap by anyone moves the vault's lamports, the wrapper's running total and the bridged-SOL supply
    // together, so two providers answering at different slots differ there. Compare everything else, check the bridge is
    // fully backed in each provider's own (consistent) snapshot, then compile from the first provider's snapshot.
    const { wrapperAddress, totalOffset } = volatile()
    const steady = o => o.accounts.map(x => !x.account ? x : x.address === vaultAddress ? { ...x, account: { ...x.account, lamports: null } }
      : x.address === wrapperAddress ? { ...x, account: { ...x.account, dataBase64: zeroed(x.account.dataBase64, totalOffset, 8) } }
      : x.address === p.quoteMint ? { ...x, account: { ...x.account, dataBase64: zeroed(x.account.dataBase64, 10, 8) } } : x)
    check(isDeepStrictEqual(steady(observations[0]), steady(observations[1])), 'Providers disagree on funding state')
    const snapshot = o => Object.fromEntries([vaultAddress, wrapperAddress, p.quoteMint].map(a => [a, o.accounts.find(x => x.address === a).account]))
    const vaultBytes = Buffer.from(snapshot(observations[0])[vaultAddress].dataBase64, 'base64').length, vaultRent = BigInt(await rentFor(vaultBytes))
    if (request.action === 'fund') for (const o of observations) {
      const view = snapshot(o), total = Buffer.from(view[wrapperAddress].dataBase64, 'base64').readBigUInt64LE(totalOffset)
      refuse(BigInt(view[vaultAddress].lamports) - vaultRent >= total, 'Adding SOL to Hook Lab is unavailable right now. Withdrawals still work.')
    }
    const first = snapshot(observations[0])
    for (const o of observations) o.accounts = o.accounts.map(x => Object.hasOwn(first, x.address) ? { ...x, account: first[x.address] } : x)
    // The Hook Lab token program (it creates the holdings the customer pays rent for) must be the dossier's.
    const tokenSha = tokenProgramDataSha256 ?? bound.dossier.programs.find(x => x.role === 'token')?.programDataSha256
    const tokenData = observations[0].accounts.find(x => x.address === pda(LOADER, kb(p.programs.token))).account
    check(tokenSha && tokenData && sha(Buffer.from(tokenData.dataBase64, 'base64')) === tokenSha, 'Token program differs from the production dossier')
    const rent = { holdingLamports: await rentFor(HOLDING_BYTES), walletLamports: await rentFor(0), vaultLamports: String(vaultRent) }
    const slot = Math.max(...observations.map(o => o.slot))
    const latest = expectedReview ? { context: { slot }, value: { blockhash: VersionedMessage.deserialize(Buffer.from(expectedReview.messageBase64, 'base64')).recentBlockhash, lastValidBlockHeight: expectedReview.lastValidBlockHeight } }
      : await provenLatestBlockhash(providers, { minContextSlot: slot })
    const confirmations = await Promise.all(providers.map(async ({ connection }) => {
      const valid = await connection.isBlockhashValid(latest.value.blockhash, { commitment: 'finalized', minContextSlot: latest.context.slot })
      check(valid.value === true && integer(valid.context.slot) >= latest.context.slot, 'This review expired before it was used. Start again.')
      return { slot: valid.context.slot, height: integer(await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: valid.context.slot })) }
    }))
    const liveSlots = originalContext ? null : await Promise.all(providers.map(async ({ connection }) => integer(await connection.getSlot('confirmed'))))
    if (liveSlots) check(Math.max(...liveSlots) - Math.min(...liveSlots) <= retained.limits.maxSlotLag)
    const l = originalContext ? { ...originalContext.compilationInput.limits, nowMs: integer(clock()) }
      : { ...retained.limits, nowMs: integer(clock()), validUntilSlot: Math.min(Math.min(...liveSlots) + SIGNING_WINDOW_SLOTS, slot + 150), reviewExpiresAtMs: started + retained.limits.maxAgeMs }
    const priority = (200000n * BigInt(l.computeUnitPriceMicroLamports) + 999999n) / 1000000n
    const recentBlockhash = { ...latest.value, genesisHash: p.genesisHash, providers: profile.providers, observedAtMs: started, currentBlockHeight: Math.max(...confirmations.map(x => x.height)),
      blockhashValid: true, observedSlot: Math.max(...confirmations.map(x => x.slot)), lamportsPerSignature: bound.config.lamportsPerSignature,
      networkFeeLamports: String(BigInt(bound.config.lamportsPerSignature) + priority) }
    const compilationInput = { profile: fundingProfile, request, observations, rent, recentBlockhash, limits: l }
    const plan = compileWalletFundingReview({ ...compilationInput, bridgePin })
    if (expectedReview) {
      const stable = r => { const { observedSlot, observedAtMs, policySha256, ...rest } = r; return rest }
      check(isDeepStrictEqual(stable(plan.review), stable(expectedReview)), 'Your balances changed since this review. Start again.')
    }
    const message = VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64'))
    const q = plan.quote, fee = BigInt(recentBlockhash.networkFeeLamports), amount = BigInt(q.lamports), created = q.createdHoldings
    const bridgeKeys = [p.programs.bridge, bridgePin.programData, derivedAddresses(p.programs, p.quoteMint).bridgeConfig, wrapperAddress, vaultAddress, p.quoteMint]
    await Promise.all(providers.map(async ({ connection }) => {
      const quoted = await connection.getFeeForMessage(message, 'finalized')
      check(quoted.value !== null && String(integer(quoted.value)) === recentBlockhash.networkFeeLamports)
      const simulation = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'finalized', minContextSlot: recentBlockhash.observedSlot })
      refuse(simulation.value.err === null, 'This transaction would fail on Solana right now, so nothing was sent. Try again in a moment.')
      // Finalized pins can trail a just-confirmed bridge upgrade: check the bridge again at confirmed, and require the
      // simulated movement of the customer's own lamports to be exactly the reviewed fee, deposits and wrap or unwrap.
      const live = await connection.getMultipleAccountsInfoAndContext([...bridgeKeys, owner].map(pk), { commitment: 'confirmed' })
      const map = new Map(live.value.map((v, i) => [[...bridgeKeys, owner][i], asAccount([...bridgeKeys, owner][i], v)]))
      verifyBridgeAccounts(map, fundingProfile, { requireUnpaused: request.action === 'fund', pin: bridgePin })
      const confirmed = await connection.simulateTransaction(new VersionedTransaction(message), { sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed',
        accounts: { encoding: 'base64', addresses: [owner, ...created] } })
      refuse(confirmed.value.err === null, 'This transaction would fail on Solana right now, so nothing was sent. Try again in a moment.')
      const before = BigInt(map.get(owner)?.lamports ?? 0), [after, ...holdings] = confirmed.value.accounts.map(a => BigInt(a?.lamports ?? -1))
      const expected = request.action === 'fund' ? before - fee - BigInt(q.rentLamports) - amount : before - fee + amount
      check(after === expected && holdings.every(v => v === BigInt(q.holdingRentLamports)), 'Simulated movements differ from the review')
    }))
    check(clock() < plan.review.reviewExpiresAtMs)
    return { status: 'operator-pins-and-state-verified', owner, stage, profileSha256: bound.config.profileSha256, messageSha256: plan.review.messageSha256, configurationSha256,
      review: expectedReview ?? plan.review, request: { ...request, quote: plan.quote },
      settlementContext: { schema: 'repoing/hooklab-wallet-funding-settlement-context/1', configurationSha256, compilationInput }, canSign: false, canSubmit: false }
  }

  // Finalized on both providers with identical evidence: the exact signed bytes, one inclusion within the blockhash
  // lifetime, and lamport movements that are exactly the reviewed fee, rent, wrap or unwrap.
  async function reconcile({ review, configurationSha256: hash, settlementContext, signedTransactionBase64, signature }) {
    const identity = { signature, messageSha256: review?.messageSha256, profileSha256: review?.profileSha256 }
    try {
      const ci = settlementContext?.compilationInput
      // Rows stored under another hash (the boot clock it once held, other settings, a new bundle) settle only bound to
      // their own context, under the profile they were reviewed under: today's, or a reviewed one on today's chain,
      // programs and providers (the full review below must still recompile).
      check(settlementContext?.schema === 'repoing/hooklab-wallet-funding-settlement-context/1' && settlementContext.configurationSha256 === hash
        && (hash === configurationSha256 || isDeepStrictEqual(ci?.profile, fundingProfile) || reviewedFundingProfile(ci?.profile, fundingProfile, reviewedProfiles)))
      const plan = compileWalletFundingReview({ ...ci, observations: ci.observations.map(canonicalObservation), bridgePin })
      check(isDeepStrictEqual(plan.review, review) && verifyHookLabSignedMessage(review, signedTransactionBase64).signature === signature)
      const rows = await Promise.all(providers.map(async ({ connection }) => {
        check(await connection.getGenesisHash() === p.genesisHash)
        const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }); if (!tx) return null
        const meta = tx.meta; check(meta && meta.err !== undefined)
        const wire = new VersionedTransaction(tx.transaction.message); wire.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
        check(Buffer.from(wire.serialize()).toString('base64') === signedTransactionBase64)
        const slot = integer(tx.slot), block = await connection.getBlockSignatures(slot, 'finalized')
        check(block && block.signatures.filter(s => s === signature).length === 1 && integer(block.blockHeight) <= review.lastValidBlockHeight && slot >= review.observedSlot)
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? { writable: [], readonly: [] } })
        const addresses = Array.from({ length: keys.length }, (_, i) => keys.get(i).toBase58())
        check(isDeepStrictEqual(addresses, review.accounts.map(x => x.address)))
        return { slot, blockHeight: block.blockHeight, blockhash: block.blockhash, previousBlockhash: block.previousBlockhash, error: meta.err, fee: integer(meta.fee), pre: meta.preBalances, post: meta.postBalances, keys: addresses }
      }))
      if (rows.some(x => x === null)) return { ...identity, status: 'unresolved' }
      if (!isDeepStrictEqual(rows[0], rows[1])) return { ...identity, status: 'conflict' }
      const tx = rows[0], fee = inspectHookLabMessage(review).totalFeeLamports, q = plan.quote, vault = derivedAddresses(p.programs, p.quoteMint).bridgeSolVault
      check(String(tx.fee) === fee && tx.pre.length === tx.keys.length && tx.post.length === tx.keys.length)
      const inclusion = { slot: tx.slot, blockHeight: tx.blockHeight, blockhash: tx.blockhash, previousBlockhash: tx.previousBlockhash }
      const delta = address => { const i = tx.keys.indexOf(address); return i < 0 ? 0n : BigInt(integer(tx.post[i])) - BigInt(integer(tx.pre[i])) }
      if (tx.error !== null) {
        // A failed transaction only pays its fee.
        check(tx.keys.every(k => delta(k) === (k === review.payer ? -BigInt(fee) : 0n)))
        return { ...identity, status: 'finalized-failure', inclusion, feeLamports: fee }
      }
      const amount = BigInt(q.lamports), rent = BigInt(q.holdingRentLamports), fund = q.action === 'fund', created = new Set(q.createdHoldings)
      const expected = address => address === review.payer ? (fund ? -BigInt(fee) - rent * BigInt(created.size) - amount : amount - BigInt(fee))
        : address === vault ? (fund ? amount : -amount) : created.has(address) ? rent : 0n
      check(tx.keys.every(k => delta(k) === expected(k)), 'Receipt lamport movements differ from the review')
      return { ...identity, status: 'finalized-success', executionStatus: 'finalized-executed', inclusion, feeLamports: fee,
        reviewSlotBoundExceeded: tx.slot > review.validUntilSlot, policyReviewRequired: false, reviewBoundsSatisfied: true }
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

// One lifecycle resolver for trades and funding, chosen by stage.
export function stagedResolver(byStage) {
  const pick = stage => { const resolver = byStage[stage]; check(resolver, 'Unsupported stage'); return resolver }
  return Object.freeze({
    prepare: args => pick(args.stage).prepare(args),
    revalidate: args => pick(args.stage).revalidate(args),
    reconcile: args => pick(args.stage).reconcile(args),
  })
}
