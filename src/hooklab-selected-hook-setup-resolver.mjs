// Server-only setup stage. No custody codec, signer or sender is reachable here.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual as equal } from 'node:util'
import { PublicKey, VersionedTransaction, AddressLookupTableProgram } from '@solana/web3.js'
import bs58 from 'bs58'
import { hookCatalogStore, hookPublicationSelectionSchema, hookPublicationDigest, materializeHookSetup, revalidateHookPublication } from './hooklab-hook-catalog.mjs'
import { selectedHookSetupRequestSchema, planSelectedHookSetup, collectSelectedHookSetup } from './hooklab-selected-hook-setup.mjs'
import { selectedHookAccountPlan } from './hooklab-selected-hook.mjs'
import { selectedAuthorityAccounts, assertSelectedAuthorityObserved } from './hooklab-selected-hook-preparation.mjs'
import { verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { provenLatestBlockhash } from './hooklab-blockhash-proof.mjs'
import { selectedHookLaunchTableAddresses, selectedHookLaunchPacketSize } from './hooklab-max-wallet-launch.mjs'
import { assertFrozenSupplementalTable } from './hooklab-selected-launch-table.mjs'
const check = (v, message = 'Selected-hook setup unavailable or changed') => { if (!v) throw Error(message) }
const hash = hookPublicationDigest
const integer = v => { check(Number.isSafeInteger(v) && v >= 0); return v }
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v) } return v }
function independentReaders(connections) {
  check(connections?.length === 2 && connections[0].connection !== connections[1].connection && new Set(connections.map(c => c.provider)).size === 2)
  const endpoints=connections.map(c=>c.connection.rpcEndpoint)
  if(endpoints.some(v=>v!==undefined)){
    check(endpoints.every(v=>typeof v==='string'))
    const urls=endpoints.map(v=>new URL(v));check(urls.every(v=>v.protocol==='https:'&&!v.username&&!v.password&&!v.hash)&&urls[0].origin!==urls[1].origin)
  }
}

// Default live planning adapter. Profile and limits are operator-owned; simulation below
// independently verifies this exact message's fee, lifetime, identities and all deltas.
export async function collectSelectedHookSetupPlanInput({ request, launchRequest, hookPin, selectedAuthorityEvidence, limits, connections, profile, clock = Date.now }) {
  independentReaders(connections)
  const r = selectedHookSetupRequestSchema.parse(request), start = integer(clock())
  const programData = PublicKey.findProgramAddressSync([new PublicKey(r.selectedHook.program).toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58()
  const inventory = [...new Set([r.creator, r.selectedHook.program, 'ComputeBudget111111111111111111111111111111', ...r.instructions.flatMap(i => i.accounts.map(a => a.address)), programData,
    ...selectedAuthorityAccounts(selectedAuthorityEvidence).map(a => a.address)])]
  const observed = await Promise.all(connections.map(async ({ connection: c }) => {
    check(await c.getGenesisHash() === profile.genesisHash)
    const s = await c.getMultipleAccountsInfoAndContext(inventory.map(a => new PublicKey(a)), { commitment: 'finalized', minContextSlot: selectedAuthorityEvidence?.observedSlot ?? 0 })
    check(s.value.length === inventory.length)
    return { slot: integer(s.context.slot), snapshots: s.value.map((a,i) => ({ address: inventory[i], account: a === null ? null : { address: inventory[i], owner: a.owner.toBase58(), executable: a.executable, lamports: String(integer(a.lamports)), dataBase64: Buffer.from(a.data).toString('base64') } })) }
  }))
  check(equal(observed[0].snapshots, observed[1].snapshots) && Math.abs(observed[0].slot - observed[1].slot) <= 150)
  const block = await provenLatestBlockhash(connections, { minContextSlot: Math.max(...observed.map(o => o.slot)) })
  const now = integer(clock()); check(now >= start && now - start <= 60000 && now < limits.reviewExpiresAtMs)
  const input = { request: r, programs: profile.programs, hookPin, ...(selectedAuthorityEvidence ? { selectedAuthorityEvidence } : {}), snapshots: observed[0].snapshots,
    context: { genesisHash: profile.genesisHash, profileSha256: profile.profileSha256, recentBlockhash: block.value.blockhash, observedSlot: block.context.slot,
      validUntilSlot: limits.validUntilSlot, observedAtMs: start, reviewExpiresAtMs: limits.reviewExpiresAtMs, lastValidBlockHeight: block.value.lastValidBlockHeight, baseFeeLamports: '5000' },
    limits: { computeUnits: limits.computeUnits ?? limits.computeUnitLimit, maxRentLamports: limits.maxRentLamports, maxNetworkFeeLamports: limits.maxNetworkFeeLamports, maxTotalDebitLamports: limits.maxTotalDebitLamports } }
  if (profile.envelope) {
    check(launchRequest?.creator === r.creator && launchRequest.mint === r.mint && equal(launchRequest.selectedHook, r.selectedHook), 'Retained launch intent required for supplemental table')
    // Discover the registry through read-only exact hook simulation before any
    // creator spend. Only the final compound setup becomes an issued review.
    const preflight = await collectSelectedHookSetup({ plan: planSelectedHookSetup(input), connections, clock })
    const configAddress = PublicKey.findProgramAddressSync([Buffer.from('config')], new PublicKey(profile.programs.launch))[0]
    const configs = await Promise.all(connections.map(({ connection }) => connection.getMultipleAccountsInfoAndContext([configAddress], { commitment: 'finalized', minContextSlot: block.context.slot })))
    check(configs.every(c => c.value.length === 1 && c.value[0] && c.value[0].owner.toBase58() === profile.programs.launch)
      && Buffer.from(configs[0].value[0].data).equals(Buffer.from(configs[1].value[0].data)), 'Launch config observations disagree')
    const accounts = new Map(input.snapshots.map(x => [x.address, x.account])); accounts.set(preflight.registry.address, preflight.registry)
    const options = { accounts, hookPin, selectedAuthorityEvidence }, configBytes = Buffer.from(configs[0].value[0].data)
    const addresses = selectedHookLaunchTableAddresses(profile.envelope, launchRequest, configBytes, options)
    // SlotHashes contains ancestors, not the current bank; skipped slots are not
    // valid seeds either. Both readers must report the chosen finalized block.
    const firstSlot = Math.max(0, block.context.slot - 150)
    const ancestors = await Promise.all(connections.map(({ connection }) => connection.getBlocks(firstSlot, block.context.slot - 1, 'finalized')))
    check(ancestors.every(slots => Array.isArray(slots) && slots.every(slot => Number.isSafeInteger(slot) && slot >= firstSlot && slot < block.context.slot)), 'Invalid supplemental table ancestor observations')
    const common = ancestors[0].filter(slot => ancestors[1].includes(slot))
    check(common.length > 0, 'No agreed recent ancestor for supplemental table')
    const recentSlot = Math.max(...common), authority = new PublicKey(r.creator)
    const [, tableAddress] = AddressLookupTableProgram.createLookupTable({ authority, payer: authority, recentSlot })
    check(selectedHookLaunchPacketSize(profile.envelope, launchRequest, configBytes, options, tableAddress.toBase58()) <= 1232, 'Complete launch exceeds 1232 bytes; configuration is unsupported')
    const rents = await Promise.all(connections.map(({ connection }) => connection.getMinimumBalanceForRentExemption(56 + 32 * addresses.length, 'finalized')))
    check(integer(rents[0]) > 0 && rents[0] === integer(rents[1]), 'Supplemental table rent observations disagree')
    input.supplementalTable = { address: tableAddress.toBase58(), recentSlot, addresses, rentLamports: String(rents[0]) }
    const keys = [tableAddress, AddressLookupTableProgram.programId]
    const added = await Promise.all(connections.map(({ connection }) => connection.getMultipleAccountsInfoAndContext(keys, { commitment: 'finalized', minContextSlot: block.context.slot })))
    const normalize = a => a === null ? null : { owner: a.owner.toBase58(), executable: a.executable, lamports: String(integer(a.lamports)), dataBase64: Buffer.from(a.data).toString('base64') }
    check(added.every(a => a.value.length === 2 && a.value[0] === null) && equal(added[0].value.map(normalize), added[1].value.map(normalize)), 'Supplemental table prestate differs')
    input.snapshots.push(...keys.map((k,i) => { const account = normalize(added[0].value[i]); return { address: k.toBase58(), account: account && { address: k.toBase58(), ...account } } }))
  }
  return input
}

// Browser manifest is checked for tampering, but ONLY the server-loaded publication is retained.
// Validation uses a placeholder mint before reservation; materialize again with the reserved mint.
export async function resolveHookPublicationSelection({ pool, store = hookCatalogStore(pool), selection, selectedHook, creator, mint = new PublicKey(createHash('sha256').update(`setup-validation:${creator}`).digest()).toBase58() }) {
  const s = hookPublicationSelectionSchema.parse(selection), publication = await store.get(s.digest)
  check(publication.digest === s.digest && equal(publication.selectedHook, selectedHook), 'Published hook differs')
  check(hookPublicationDigest(publication.manifest) === hookPublicationDigest(s.manifest), 'Published manifest differs')
  materializeHookSetup(publication.manifest, s.configuration, { creator, mint })
  return freeze({ digest: s.digest, manifest: publication.manifest, configuration: structuredClone(s.configuration) })
}

/** Called by reserve in its custody/principal transaction. Never replaces an original mint/config.
 * publication must have come from resolveHookPublicationSelection, not HTTP JSON.
 * Call on EVERY reserve, including retries. The database trigger also makes this append-only.
 */
export async function bindSelectedHookSetupIntent(db, { custodyOperationId, owner, profileSha256, mint, selectedConfig, selectedHook, hookPublication }) {
  const publication = await resolveHookPublicationSelection({ pool: db, selection: hookPublication, selectedHook, creator: owner, mint })
  const { rows: [coin] } = await db.query('select creator_wallet,selected_hook,hook_publication,status from hook_lab_launch_requests where custody_operation_id=$1', [custodyOperationId])
  check(coin?.creator_wallet === owner && coin.status === 'launching' && equal(coin.selected_hook, selectedHook) && equal(coin.hook_publication, publication), 'Original creator hook configuration differs')
  const request = selectedHookSetupRequestSchema.parse(materializeHookSetup(publication.manifest, publication.configuration, { creator: owner, mint }))
  await db.query(`insert into hook_lab_selected_hook_setup_intents(custody_operation_id,owner_wallet,profile_sha256,mint,selected_config,hook_publication,setup_request)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(custody_operation_id) do nothing`, [custodyOperationId, owner, profileSha256, mint, selectedConfig, publication, request])
  const { rows: [row] } = await db.query('select * from hook_lab_selected_hook_setup_intents where custody_operation_id=$1', [custodyOperationId])
  check(row && row.owner_wallet === owner && row.profile_sha256 === profileSha256 && row.mint === mint && row.selected_config === selectedConfig && equal(row.hook_publication, publication) && equal(row.setup_request, request))
  return freeze({ request, hookPublication: publication })
}

/** Finality is transaction inclusion, never simulation. Both independent finalized providers
 * must return the exact signed wire, fee/debit/balance facts and the committed registry layout.
 */
export async function collectSelectedHookSetupSettlement({ plan, expected, signedTransactionBase64, signature, connections }) {
  const p = planSelectedHookSetup(plan); check(equal(p, plan))
  const signed = verifyHookLabSignedMessage(p.review, signedTransactionBase64); check(signed.signature === signature)
  independentReaders(connections)
  const identity = { signature, messageSha256: p.review.messageSha256, profileSha256: p.review.profileSha256 }
  const facts = await Promise.all(connections.map(async ({ connection: c }) => {
    check(await c.getGenesisHash() === p.review.genesisHash)
    const tx = await c.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (!tx) return null
    const slot = integer(tx.slot), meta = tx.meta; check(meta && tx.transaction && !meta.loadedAddresses?.writable?.length && !meta.loadedAddresses?.readonly?.length)
    const exact = new VersionedTransaction(tx.transaction.message)
    exact.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
    check(Buffer.from(exact.serialize()).toString('base64') === signedTransactionBase64, 'Finalized setup wire differs')
    const block = await c.getBlockSignatures(slot, 'finalized')
    check(block && block.signatures.filter(s => s === signature).length === 1)
    integer(block.blockHeight); check(block.blockHeight <= p.review.lastValidBlockHeight)
    check(tx.transaction.message.recentBlockhash === p.context.recentBlockhash)
    const fee = BigInt(integer(meta.fee)); check(fee === BigInt(p.review.baseFeeLamports) && fee <= BigInt(p.review.maxFeeLamports))
    const accounts = p.review.accounts, pre = meta.preBalances, post = meta.postBalances
    check(pre?.length === accounts.length && post?.length === accounts.length)
    pre.forEach(integer); post.forEach(integer)
    check(pre.reduce((a,b) => a + BigInt(b), 0n) - post.reduce((a,b) => a + BigInt(b), 0n) === fee)
    let growth = 0n
    accounts.forEach((a,i) => {
      const delta = BigInt(post[i]) - BigInt(pre[i])
      if (!a.writable || (meta.err && a.address !== p.request.creator)) check(delta === 0n)
      if (a.address !== p.request.creator && a.writable) { check(delta >= 0n); growth += delta }
    })
    const payer = accounts.findIndex(a => a.address === p.request.creator), debit = BigInt(pre[payer]) - BigInt(post[payer])
    check(debit >= fee && debit <= BigInt(p.review.maxNativeDebitLamports) && growth <= BigInt(p.limits.maxRentLamports))
    if (meta.err) { check(debit === fee); return { status: 'finalized-failure', slot, blockHeight: block.blockHeight, blockhash: block.blockhash, feeLamports: String(fee) } }
    check(expected?.registryCommitment && expected.flags === p.request.selectedHook.flags)
    const addresses = [p.registry, p.request.selectedHook.program, p.programData, ...selectedAuthorityAccounts(p.selectedAuthorityEvidence).map(a => a.address)]
    const state = await c.getMultipleAccountsInfoAndContext(addresses.map(a => new PublicKey(a)), { commitment: 'finalized', minContextSlot: slot })
    check(integer(state.context.slot) >= slot && state.value.length === addresses.length)
    const normalized = state.value.map((a,i) => { check(a); return { address: addresses[i], owner: a.owner.toBase58(), executable: a.executable, dataBase64: Buffer.from(a.data).toString('base64') } })
    for (const i of [1,2]) { const before = p.snapshots.find(a => a.address === addresses[i]).account; check(before && ['owner','executable','dataBase64'].every(k => equal(before[k], normalized[i][k]))) }
    assertSelectedAuthorityObserved(p.selectedAuthorityEvidence, new Map(normalized.map(a => [a.address, a])), p.review.genesisHash)
    const selected = selectedHookAccountPlan({ programs: p.programs, selectedHook: p.request.selectedHook, mint: p.request.mint, registry: normalized[0], programAccount: normalized[1], programData: normalized[2], elfSha256: p.hookPin.elfSha256, mintStable: true, selectedAuthorityEvidence: p.selectedAuthorityEvidence })
    check(selected.commitment === expected.registryCommitment && selected.flags === expected.flags, 'Finalized registry postcondition differs')
    if (p.supplementalTable) {
      const t = p.supplementalTable, result = await c.getMultipleAccountsInfoAndContext([new PublicKey(t.address)], { commitment: 'finalized', minContextSlot: slot })
      check(result.context.slot >= slot && result.value.length === 1 && result.value[0])
      const a = result.value[0], dataBase64 = Buffer.from(a.data).toString('base64')
      const tableState = assertFrozenSupplementalTable({ address: t.address, owner: a.owner.toBase58(), executable: a.executable, lamports: String(integer(a.lamports)), dataBase64 }, t, result.context.slot)
      check(tableState.lastExtendedSlot === slot && post[accounts.findIndex(a => a.address === t.address)] === Number(t.rentLamports), 'Finalized supplemental table creation/rent differs')
    }
    return { status: 'finalized-success', slot, blockHeight: block.blockHeight, blockhash: block.blockhash, feeLamports: String(fee), registryCommitment: selected.commitment }
  }))
  if (facts.some(f => f === null)) return { status: 'unresolved', ...identity }
  if (!equal(facts[0], facts[1])) return { status: 'conflict', ...identity }
  return { ...facts[0], ...identity, policyReviewRequired: facts[0].slot > p.review.validUntilSlot }
}

/** collectPlan({request,hookPin,limits,expectedReview}) is an operator-owned live snapshot /
 * blockhash / fee collector returning planSelectedHookSetup's INPUT. No HTTP evidence allowed.
 * observe must revalidate the catalog executable/authority against its original evidence.
 * authorize is the runtime's custody + principal accessor, returning owner/profile/mint/config.
 */
export function selectedHookSetupResolver(pool, { enabled = false, releaseVerified = false, connections, profile, collectPlan, observe, authorize, clock = Date.now } = {}) {
  const collect = collectPlan ?? (input => collectSelectedHookSetupPlanInput({ ...input, connections, profile, clock }))
  async function bound(input) {
    check(enabled && releaseVerified && typeof authorize === 'function')
    const custody = await authorize(input.sessionToken, input.custodyOperationId)
    const { rows: [row] } = await pool.query('select * from hook_lab_selected_hook_setup_intents where custody_operation_id=$1', [input.custodyOperationId])
    check(row && custody.owner === row.owner_wallet && (!input.owner || input.owner === row.owner_wallet) && custody.mint === row.mint && custody.selectedConfig === row.selected_config && custody.profileSha256 === row.profile_sha256)
    return { ...row, ...(custody.selectedAuthorityEvidence ? { selectedAuthorityEvidence: custody.selectedAuthorityEvidence } : {}) }
  }
  return Object.freeze({
    async resolve(input) {
      independentReaders(connections)
      const row = await bound(input)
      const publication = await revalidateHookPublication({ store: hookCatalogStore(pool), digest: row.hook_publication.digest,
        observe: args => observe({ ...args, expectedEvidence: row.selectedAuthorityEvidence ?? args.expectedEvidence }) })
      const request = selectedHookSetupRequestSchema.parse(materializeHookSetup(publication.manifest, row.hook_publication.configuration, { creator: row.owner_wallet, mint: row.mint }))
      check(equal(request, row.setup_request) && (!input.intent || equal(input.intent, request)))
      if(input.expectedReview)check(input.expectedSimulation && input.settlementContext?.planJson)
      // Preserve compiler byte ordering through JSONB and server restarts; never renew a
      // signed message's blockhash or policy when collecting fresh live prestate evidence.
      const plan = planSelectedHookSetup(input.expectedReview ? JSON.parse(input.settlementContext.planJson) : await collect({ request, launchRequest: input.launchRequest, hookPin: publication.evidence.hookPin, selectedAuthorityEvidence: row.selectedAuthorityEvidence, limits: input.limits }))
      check(equal(plan.request, request) && plan.review.profileSha256 === row.profile_sha256 && equal(plan.hookPin, publication.evidence.hookPin)
        && equal(plan.selectedAuthorityEvidence, row.selectedAuthorityEvidence))
      if (input.expectedReview) check(equal(plan.review, input.expectedReview))
      const simulation = await collectSelectedHookSetup({ plan, connections, clock })
      if(input.expectedSimulation){
        // The finalized bank advances; identity, pre/poststate, deltas and providers must not.
        const stable = value => { const v=structuredClone(value);delete v.simulation.simulationSlot;return v }
        check(equal(stable(simulation),stable(input.expectedSimulation)))
      }
      check(equal(row, await bound(input)))
      return { status: 'operator-pins-and-state-verified', owner: row.owner_wallet, stage: 'hook-setup', request,
        profileSha256: row.profile_sha256, messageSha256: plan.review.messageSha256, review: plan.review,
        configurationSha256: hash(row.hook_publication), settlementContext: { schema: 'repoing/selected-hook-setup-settlement/1', planJson: JSON.stringify(plan), simulation }, canSign: false, canSubmit: false }
    },
    async reconcile(input) {
      const row = await bound(input), s = input.settlementContext
      check(s?.schema === 'repoing/selected-hook-setup-settlement/1' && input.configurationSha256 === hash(row.hook_publication))
      const plan=JSON.parse(s.planJson)
      check(equal(plan.request, row.setup_request) && equal(plan.review, input.review) && equal(plan.selectedAuthorityEvidence, row.selectedAuthorityEvidence))
      return collectSelectedHookSetupSettlement({ plan, expected: s.simulation, signedTransactionBase64: input.signedTransactionBase64, signature: input.signature, connections })
    },
  })
}
