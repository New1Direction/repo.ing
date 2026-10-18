// Restricted canary stages. Message bytes for prepare/launch/buy/sell come from the reviewed
// repo compilers; this module only gathers two-provider finalized inputs and verifies outcomes.
import { isDeepStrictEqual } from 'node:util'
import { fileURLToPath } from 'node:url'
import { PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js'
import { planInclusiveMaxWalletPreparation, deriveInclusiveMaxWalletPreparedAccounts } from '../../hooklab-inclusive-max-wallet-preparation.mjs'
import { inclusiveMaxWalletPreparationInventory } from '../../hooklab-inclusive-max-wallet-preparation-collector.mjs'
import { compileCanaryMaxWalletLaunchReview, maxWalletLaunchInventory } from '../../hooklab-max-wallet-launch.mjs'
import { compileCanaryInclusiveMaxWalletSwapReview, inclusiveMaxWalletSwapInventory } from '../../hooklab-inclusive-max-wallet-swap.mjs'
import { value } from '../config.mjs'
import { binding } from '../artifacts.mjs'
import { readAccounts, rentExemption } from '../rpc.mjs'
import { priorityFee, LAMPORTS_PER_SIGNATURE } from '../message.mjs'
import * as ix from '../instructions.mjs'
import { derivedAddresses, canaryAddresses, holdingAddress, sha256 } from '../pins.mjs'
import { sol, plain } from '../preview.mjs'
import { check, decode, owned, blockhashFor, unitsPrice, simpleMessage } from './common.mjs'
import { canaryBlocked, preparationRequest, launchRequest, swapRequest, readLookupTable, altRecord, writeAltRecord } from './canary-common.mjs'

const MAX_AGE_MS = 60000, SLOT_LAG = 20, LAUNCH_UNITS = 1400000, TRADE_UNITS = 1400000, PREPARE_UNITS = 400000
const blockedBy = error => ({ blocked: error.message })
// The reused settlement modules read a pinned ABI relative to the working directory at load time.
async function importAtRepoRoot(specifier) {
  const previous = process.cwd()
  process.chdir(fileURLToPath(new URL('../../../', import.meta.url)))
  try { return await import(new URL(specifier, import.meta.url).href) } finally { process.chdir(previous) }
}
const blockhashInput = (ctx, bh, now, signatures, units) => ({ blockhash: bh.blockhash, genesisHash: ctx.genesis, providers: ctx.envelope.providers, observedAtMs: now,
  currentBlockHeight: bh.currentBlockHeight, blockhashValid: true, lastValidBlockHeight: bh.lastValidBlockHeight, observedSlot: bh.observedSlot,
  networkFeeLamports: String(BigInt(signatures) * LAMPORTS_PER_SIGNATURE + priorityFee(units, unitsPrice(ctx))), lamportsPerSignature: '5000' })
const profileObject = ctx => JSON.parse(ctx.envelope.json)
const holdingAmount = account => account ? Buffer.from(account.dataBase64, 'base64').readBigUInt64LE(74) : null

const prepare = {
  name: 'canary-prepare',
  async build(ctx, pinned) {
    const blocked = canaryBlocked(ctx); if (blocked) return { blocked }
    const request = preparationRequest(ctx), inventory = inclusiveMaxWalletPreparationInventory(profileObject(ctx), request)
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, inventory), rents = await rentExemption(ctx.readers, [90, 81, 176])
    const rentRow = { policy: String(rents[90]), registry: String(rents[81]), selectedConfig: String(rents[176]) }
    const bh = await blockhashFor(ctx, pinned, snapshot.slot), now = Date.now(), fee = BigInt(3) * LAMPORTS_PER_SIGNATURE + priorityFee(PREPARE_UNITS, unitsPrice(ctx))
    const input = { profile: { json: ctx.envelope.json, expectedSha256: ctx.envelope.expectedSha256, idls: { launch: ctx.envelope.idls.launch, gate: ctx.envelope.idls.gate },
      elfLengths: { launch: ctx.envelope.elfLengths.launch, gate: ctx.envelope.elfLengths.gate }, providers: ctx.envelope.providers }, request,
    observations: snapshot.observations.map(o => ({ ...o, rentExemptionLamports: rentRow })), recentBlockhash: blockhashInput(ctx, bh, now, 3, PREPARE_UNITS), lookupTable: null,
    limits: { nowMs: now, maxAgeMs: MAX_AGE_MS, maxSlotLag: SLOT_LAG, validUntilSlot: snapshot.slot + 150, reviewExpiresAtMs: now + MAX_AGE_MS, maxRentLamports: '10000000',
      maxNetworkFeeLamports: String(fee), maxTotalDebitLamports: String(10000000n + fee), computeUnitLimit: PREPARE_UNITS, computeUnitPriceMicroLamports: unitsPrice(ctx) } }
    let plan
    try { plan = planInclusiveMaxWalletPreparation(input) } catch (error) { return { ...blockedBy(error), observedSlot: snapshot.slot } }
    return { observedSlot: snapshot.slot, review: plan.review, pinned: { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
      sections: [{ title: 'max-wallet preparation (gate prepare_v2 + launch create_config)', rows: [`mint ${request.mint} (signer, not yet created)`, `selected config ${request.selectedConfig} (new signer account)`,
        `policy ${plan.addresses.policy}; registry ${plan.addresses.registry}`, `initial supply ${plan.policy.initialSupply}; cap ${request.capBps} bps = ${plan.policy.capRaw} raw per wallet until graduation`,
        `creator fee ${request.creatorFeeBps} bps (fee model 2, platform share 2500 bps = floor(gross/4))`] },
      { title: 'funds', rows: [`creator ${request.creator} pays rent ${sol(plan.rentQuoteLamports)} + fee; balance ${sol(snapshot.accounts.get(request.creator)?.lamports ?? 0)}`] }],
      expect: { request, policy: plan.addresses.policy, registry: plan.addresses.registry, launchConfig: derivedAddresses(ctx.programs).launchConfig } }
  },
  async verify(ctx, expect, receipt) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.policy, expect.registry, expect.request.selectedConfig, expect.launchConfig])
    const selected = decode('launch', 'LaunchConfig', owned(snapshot.accounts, expect.request.selectedConfig, ctx.programs.launch, 'selected config'))
    const derived = deriveInclusiveMaxWalletPreparedAccounts({ profile: { json: ctx.envelope.json, expectedSha256: ctx.envelope.expectedSha256, idls: { launch: ctx.envelope.idls.launch, gate: ctx.envelope.idls.gate } },
      request: expect.request, launchConfig: snapshot.accounts.get(expect.launchConfig), observedCreatedAtUnixSeconds: selected.created_at.toString() })
    for (const [name, want] of Object.entries(derived.accounts)) {
      const actual = snapshot.accounts.get(want.address)
      check(actual && actual.owner === want.owner && actual.dataBase64 === want.dataBase64, `Prepared ${name} bytes differ from the reviewed derivation`)
    }
    return [`policy, registry and selected config bytes match the derivation (created_at ${selected.created_at}); execution slot ${receipt.slot}`]
  },
}

const alt = {
  name: 'alt',
  async build(ctx, pinned) {
    const blocked = canaryBlocked(ctx); if (blocked) return { blocked }
    const d = derivedAddresses(ctx.programs), base = await readAccounts(ctx.readers, ctx.genesis, [d.launchConfig, ctx.roles.payer])
    const { inventory } = maxWalletLaunchInventory(ctx.envelope, launchRequest(ctx), Buffer.from(base.accounts.get(d.launchConfig).dataBase64, 'base64'))
    const existing = await readLookupTable(ctx), payer = ctx.roles.payer
    if (!existing) {
      check(!altRecord(ctx), 'Recorded lookup table is missing on chain; refusing to create a replacement silently')
      let recentSlot = pinned?.recentSlot
      if (recentSlot === undefined) {
        const hashes = (await ctx.readers[0].connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, 'finalized'))?.data
        check(hashes && hashes.readBigUInt64LE(0) > 0n, 'SlotHashes sysvar unavailable')
        recentSlot = Number(hashes.readBigUInt64LE(8))
      }
      const [create, table] = ix.lookupCreate(payer, payer, recentSlot), first = inventory.slice(0, 20)
      const { review, blockhash } = await simpleMessage(ctx, { stage: 'alt', payer, instructions: [create, ix.lookupExtend(payer, payer, table.toBase58(), first)], pinned, snapshot: base, units: 30000 })
      return { observedSlot: base.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, recentSlot },
        notes: ['step 1 of 2: create + first 20 addresses; run plan/execute alt again for the remainder', `recent slot ${recentSlot} must still be in SlotHashes (~200 s) at execution`],
        sections: [{ title: 'canary launch lookup table', rows: [`table ${table.toBase58()} (authority and payer ${payer})`, `inventory ${inventory.length} addresses, sha256 ${sha256(JSON.stringify(inventory))}`, ...first.map((a, i) => `  [${i}] ${a}`)] }],
        expect: { table: table.toBase58(), recentSlot, inventory, count: first.length } }
    }
    const current = existing.state.addresses.map(a => a.toBase58())
    check(existing.state.authority?.toBase58() === payer && existing.state.deactivationSlot === 0xffffffffffffffffn, 'Lookup table authority or activation differs')
    check(isDeepStrictEqual(current, inventory.slice(0, current.length)), 'Lookup table contents are not a prefix of the canonical launch inventory')
    if (current.length === inventory.length) return { blocked: `lookup table ${existing.pin.address} already holds the complete ${inventory.length}-address inventory (warm after slot ${existing.state.lastExtendedSlot})`, observedSlot: base.slot }
    const next = inventory.slice(current.length, current.length + 20)
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'alt', payer, instructions: [ix.lookupExtend(payer, payer, existing.pin.address, next)], pinned, snapshot: base, units: 30000 })
    return { observedSlot: base.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'extend canary launch lookup table', rows: [`table ${existing.pin.address}: ${current.length} -> ${current.length + next.length} of ${inventory.length}`, ...next.map((a, i) => `  [${current.length + i}] ${a}`)] }],
      expect: { table: existing.pin.address, inventory, count: current.length + next.length } }
  },
  async verify(ctx, expect) {
    if (expect.recentSlot !== undefined) writeAltRecord(ctx, { address: expect.table, recentSlot: expect.recentSlot, authority: ctx.roles.payer, inventorySha256: sha256(JSON.stringify(expect.inventory)) })
    const table = await readLookupTable(ctx)
    check(table && isDeepStrictEqual(table.state.addresses.map(a => a.toBase58()), expect.inventory.slice(0, expect.count)), 'Lookup table contents differ from the reviewed inventory prefix')
    return [`lookup table ${expect.table} holds ${expect.count}/${expect.inventory.length} canonical addresses`]
  },
}

async function launchInput(ctx, pinned, prepSlot) {
  const request = launchRequest(ctx), d = derivedAddresses(ctx.programs)
  const config = await readAccounts(ctx.readers, ctx.genesis, [d.launchConfig])
  const { addresses: a, inventory } = maxWalletLaunchInventory(ctx.envelope, request, Buffer.from(config.accounts.get(d.launchConfig).dataBase64, 'base64'))
  const table = await readLookupTable(ctx); check(table, 'Canary lookup table is missing; run the alt stage first')
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, inventory)
  const hashOf = address => sha256(Buffer.from(snapshot.accounts.get(address)?.dataBase64 ?? '', 'base64'))
  const lc = decode('launch', 'Config', snapshot.accounts.get(a.launchConfig)), sc = decode('swap', 'Config', snapshot.accounts.get(a.swapConfig))
  const bh = await blockhashFor(ctx, pinned, snapshot.slot), now = Date.now(), fee = 3n * LAMPORTS_PER_SIGNATURE + priorityFee(LAUNCH_UNITS, unitsPrice(ctx))
  const maxRent = value(ctx.config, 'canaryLaunch').maxRentLamports, fees = BigInt(lc.launch_fee_lamports.toString()) + BigInt(sc.pool_creation_fee_lamports.toString())
  const validUntilSlot = pinned?.validUntilSlot ?? snapshot.slot + 150
  return { a, input: { profile: ctx.envelope, request,
    preparationEvidence: { schema: 'repoing/max-wallet-durable-prepared-state/1', profileSha256: ctx.envelope.expectedSha256, preparationIntentSha256: sha256(JSON.stringify(preparationRequest(ctx))),
      executionSlot: prepSlot, preparedAccountHashes: { policy: hashOf(a.policy), registry: hashOf(a.registry), selectedConfig: hashOf(request.selectedConfig) } },
    reviewedStateHashes: Object.fromEntries(['launchConfig', 'swapConfig', 'launchGovernance', 'swapGovernance', 'authorization', 'quoteMint'].map(k => [k, hashOf(k === 'quoteMint' ? ctx.quoteMint : a[k])])),
    observations: snapshot.observations, recentBlockhash: blockhashInput(ctx, bh, now, 3, LAUNCH_UNITS), lookupTable: table.pin,
    limits: { nowMs: now, maxAgeMs: MAX_AGE_MS, maxSlotLag: SLOT_LAG, validUntilSlot, reviewExpiresAtMs: now + MAX_AGE_MS, maxLaunchFeeLamports: lc.launch_fee_lamports.toString(),
      maxPoolCreationFeeLamports: sc.pool_creation_fee_lamports.toString(), maxRentLamports: maxRent, maxInstructionDebitLamports: String(BigInt(maxRent) + fees),
      maxNetworkFeeLamports: String(fee), maxTotalDebitLamports: String(BigInt(maxRent) + fees + fee), computeUnitLimit: LAUNCH_UNITS, computeUnitPriceMicroLamports: unitsPrice(ctx) } },
  snapshot, bh, validUntilSlot }
}
const launch = {
  name: 'canary-launch',
  async build(ctx, pinned) {
    const blocked = canaryBlocked(ctx); if (blocked) return { blocked }
    const prepSlot = pinned?.prepSlot ?? ctx.journal.lastSuccess('canary-prepare')?.slot ?? ctx.options.prepSlot
    if (prepSlot === undefined) return { blocked: 'no finalized canary-prepare receipt in the journal; pass --prep-slot N to bind the preparation execution slot' }
    let built, review
    try { built = await launchInput(ctx, pinned, Number(prepSlot)); review = compileCanaryMaxWalletLaunchReview(built.input) } catch (error) { return { ...blockedBy(error), observedSlot: built?.snapshot.slot } }
    const r = built.input.request
    return { observedSlot: built.snapshot.slot, review: review.review, lookupTable: built.input.lookupTable, deadlineSlot: built.validUntilSlot,
      pinned: { blockhash: built.bh.blockhash, lastValidBlockHeight: built.bh.lastValidBlockHeight, validUntilSlot: built.validUntilSlot, prepSlot: Number(prepSlot) },
      sections: [{ title: 'canary launch (create_launch_custom_v3, creation gate must already be open; trading stays paused)', rows: [`mint ${r.mint} name "${r.name}" symbol "${r.symbol}" uri "${r.uri}"`,
        `virtual quote ${r.virtualQuote}; creator fee ${r.creatorFeeBps} bps; platform share 2500 bps; cap ${review.policy.capBps} bps = ${review.policy.capRaw} raw`,
        `launch ${review.addresses.launch}; pool ${review.addresses.pool}; inclusive fee policy ${review.addresses.inclusiveFeePolicy}`,
        `guard deadline slot ${built.validUntilSlot}; max rent ${sol(built.input.limits.maxRentLamports)} (enforced on chain); launch+pool fees ${built.input.limits.maxLaunchFeeLamports}+${built.input.limits.maxPoolCreationFeeLamports}`,
        `consumes one creator-authorization launch (allow-list) and requires the admin co-signature`, ...Object.entries(review.commitments).map(([k, v]) => `commitment ${k} ${v}`)] }],
      expect: { mint: r.mint, launch: review.addresses.launch, pool: review.addresses.pool, authorization: review.addresses.authorization }, memo: { input: built.input } }
  },
  async verify(ctx, expect, receipt, memo) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.launch])
    const state = decode('launch', 'Launch', owned(snapshot.accounts, expect.launch, ctx.programs.launch, 'launch'))
    const { deriveCanaryMaxWalletLaunchPostconditions } = await importAtRepoRoot('../../hooklab-max-wallet-launch-settlement.mjs')
    const expected = deriveCanaryMaxWalletLaunchPostconditions({ schema: 'repoing/canary-max-wallet-launch-settlement-context/1', compilationInput: memo.input }, { slot: receipt.slot, timestamp: Number(state.created_at.toString()) })
    const after = await readAccounts(ctx.readers, ctx.genesis, expected.accounts.map(x => x.address))
    for (const want of expected.accounts) {
      const actual = after.accounts.get(want.address)
      check(actual && actual.owner === want.owner && actual.dataBase64 === want.dataBase64, `Launch post-state differs at ${want.address}`)
    }
    return [`${expected.accounts.length} launch accounts match the derived post-state (created_at ${state.created_at})`]
  },
}

const holdings = {
  name: 'canary-holdings',
  async build(ctx, pinned) {
    const creator = ctx.roles.creator, mint = ctx.roles.mint, base = holdingAddress(mint, creator, ctx.programs.token), quote = holdingAddress(ctx.quoteMint, creator, ctx.programs.token)
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [mint, base, quote, creator])
    if (!snapshot.accounts.get(mint)) return { blocked: 'canary mint does not exist yet; run canary-launch first', observedSlot: snapshot.slot }
    const instructions = [], rows = [], rent = BigInt((await rentExemption(ctx.readers, [204]))[204]), buy = value(ctx.config, 'canaryBuy')
    let debit = 0n
    if (!snapshot.accounts.get(base)) { instructions.push(ix.createHolding(ctx.programs, { payer: creator, mint, owner: creator })); rows.push(`create base holding ${base} (rent ${sol(rent)})`); debit += rent }
    if (!snapshot.accounts.get(quote)) { instructions.push(ix.createHolding(ctx.programs, { payer: creator, mint: ctx.quoteMint, owner: creator })); rows.push(`create quote holding ${quote} (rent ${sol(rent)})`); debit += rent }
    const have = holdingAmount(snapshot.accounts.get(quote)) ?? 0n, wrap = BigInt(value(ctx.config, 'canaryWrapLamports'))
    if (have < BigInt(buy.amountInRaw) && wrap > 0n) {
      if (ctx.localTest) return { blocked: 'quote holding underfunded and the bridge is not present on the local validator', observedSlot: snapshot.slot }
      instructions.push(ix.wrapSol(ctx.programs, ctx.quoteMint, { user: creator, lamports: wrap })); rows.push(`wrap ${sol(wrap)} -> ${wrap} raw bridged-SOL quote into ${quote} (bridge ${ctx.programs.bridge})`); debit += wrap
    }
    if (!instructions.length) return { blocked: `holdings ready: base ${base} exists, quote balance ${have} raw`, observedSlot: snapshot.slot }
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'canary-holdings', payer: creator, instructions, pinned, snapshot, units: 120000, instructionDebitLamports: String(debit) })
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'creator holdings', rows: [...rows, `creator balance ${sol(snapshot.accounts.get(creator)?.lamports ?? 0)}; quote balance before ${have} raw`] }],
      expect: { base, quote, quoteBefore: String(have), wrap: String(instructions.length && rows.some(r => r.startsWith('wrap')) ? wrap : 0n) } }
  },
  async verify(ctx, expect) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.base, expect.quote])
    check(holdingAmount(snapshot.accounts.get(expect.base)) === 0n, 'Base holding missing or not empty')
    const quote = holdingAmount(snapshot.accounts.get(expect.quote))
    check(quote === BigInt(expect.quoteBefore) + BigInt(expect.wrap), 'Quote holding balance differs from the reviewed post-state')
    return [`base holding ${expect.base} ready; quote balance ${quote} raw`]
  },
}

async function tradeInput(ctx, side, amountIn, minAmountOut, maxImpact, pinned) {
  const request = swapRequest(ctx, side, amountIn, minAmountOut, maxImpact), inventory = inclusiveMaxWalletSwapInventory(profileObject(ctx), request)
  const table = await readLookupTable(ctx); check(table, 'Canary lookup table is missing; run the alt stage first')
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, inventory), bh = await blockhashFor(ctx, pinned, snapshot.slot), now = Date.now()
  const fee = 2n * LAMPORTS_PER_SIGNATURE + priorityFee(TRADE_UNITS, unitsPrice(ctx))
  return { snapshot, bh, input: { profile: ctx.envelope, request, provenance: 'server-collected-finalized-state-not-execution-authorization', observations: snapshot.observations,
    recentBlockhash: blockhashInput(ctx, bh, now, 2, TRADE_UNITS), lookupTable: table.pin,
    limits: { nowMs: now, maxAgeMs: MAX_AGE_MS, maxSlotLag: SLOT_LAG, validUntilSlot: snapshot.slot + 150, reviewExpiresAtMs: now + MAX_AGE_MS,
      maxNetworkFeeLamports: String(fee), maxTotalDebitLamports: String(fee), computeUnitLimit: TRADE_UNITS, computeUnitPriceMicroLamports: unitsPrice(ctx) } } }
}
function tradeStage(side) {
  const stage = `canary-${side}`
  return {
    name: stage,
    async build(ctx, pinned) {
      const blocked = canaryBlocked(ctx); if (blocked) return { blocked }
      const decision = value(ctx.config, side === 'buy' ? 'canaryBuy' : 'canarySell')
      let amountIn = pinned?.amountIn ?? decision.amountInRaw
      if (amountIn === 'all') {
        const holding = holdingAddress(ctx.roles.mint, ctx.roles.creator, ctx.programs.token), snap = await readAccounts(ctx.readers, ctx.genesis, [holding])
        amountIn = String(holdingAmount(snap.accounts.get(holding)) ?? 0n)
        if (amountIn === '0') return { blocked: 'creator holds no canary tokens to sell', observedSlot: snap.slot }
      }
      let built, compiled, minAmountOut = pinned?.minAmountOut
      try {
        if (minAmountOut === undefined) {
          const probe = await tradeInput(ctx, side, amountIn, '1', decision.maxPriceImpactBps, pinned)
          const delivered = BigInt(compileCanaryInclusiveMaxWalletSwapReview(probe.input).quote.delivered)
          minAmountOut = String(delivered * BigInt(10000 - decision.slippageBps) / 10000n)
          if (minAmountOut === '0') minAmountOut = '1'
        }
        built = await tradeInput(ctx, side, amountIn, minAmountOut, decision.maxPriceImpactBps, pinned)
        compiled = compileCanaryInclusiveMaxWalletSwapReview(built.input)
      } catch (error) { return { ...blockedBy(error), observedSlot: built?.snapshot.slot } }
      const q = compiled.quote, unit = side === 'buy' ? ['raw quote', 'raw tokens'] : ['raw tokens', 'raw quote']
      return { observedSlot: built.snapshot.slot, review: compiled.review, lookupTable: built.input.lookupTable,
        pinned: { blockhash: built.bh.blockhash, lastValidBlockHeight: built.bh.lastValidBlockHeight, amountIn, minAmountOut },
        sections: [{ title: `atomic canary ${side}: [2] open trading gate -> [3] swap -> [4] close trading gate (one transaction)`, rows: [
          `trader = recipient = fee payer = creator ${ctx.roles.creator}; admin ${ctx.roles.admin} co-signs both gate changes`,
          `in ${amountIn} ${unit[0]}; expected out ${q.delivered} ${unit[1]}; minimum out ${minAmountOut} (${decision.slippageBps} bps slippage); price impact ${q.priceImpactBps} bps (max ${decision.maxPriceImpactBps})`,
          `gross creator fee ${q.grossCreatorFee} raw quote = platform ${q.protocolFee} (floor(gross/4), to collector ${q.platformCollector}) + creator ${q.netCreatorFee}`,
          `cap ${q.capRaw} raw per wallet; swap governance revision ${compiled.canary.initialRevision} -> ${compiled.canary.finalRevision}; final commitment ${compiled.canary.finalCommitment}`,
          `trading pause restored inside the same transaction; a failure anywhere rolls back the opening`] }],
        expect: { side, quote: plain(q), pool: compiled.addresses.pool, launch: compiled.addresses.launch, swapGovernance: compiled.addresses.swapGovernance, finalRevision: compiled.canary.finalRevision },
        memo: { input: built.input, compiled } }
    },
    async verify(ctx, expect, receipt, memo) {
      const events = receipt.events.filter(e => e.name === 'InclusiveCreatorFeeAccrued' && e.index === 3)
      check(events.length === 1, 'Expected exactly one InclusiveCreatorFeeAccrued event from instruction 3')
      const e = events[0].data, gross = BigInt(e.gross_quote.toString()), platform = BigInt(e.platform_quote.toString()), creator = BigInt(e.creator_quote.toString())
      check(platform === gross / 4n && creator === gross - platform, 'Fee split is not platform=floor(gross/4), creator=remainder')
      check(String(gross) === expect.quote.grossCreatorFee && String(platform) === expect.quote.protocolFee && String(creator) === expect.quote.netCreatorFee, 'Fee event differs from the reviewed quote')
      const { verifyCanaryGovernanceLogs, canarySwapTransition } = await import('../../hooklab-canary-policy.mjs')
      const { deriveCanaryInclusiveTradePostconditions } = await importAtRepoRoot('../../hooklab-inclusive-trade-settlement.mjs')
      const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.pool])
      const pool = decode('swap', 'Pool', snapshot.accounts.get(expect.pool)), timestamp = Number(pool.last_swap_at.toString())
      const swapBinding = binding('swap')
      const gov = decode('swap', 'Governance', memo.input.observations[0].accounts.find(x => x.address === expect.swapGovernance).account)
      verifyCanaryGovernanceLogs({ logs: receipt.logs, binding: swapBinding, transition: canarySwapTransition(swapBinding, gov, memo.compiled.addresses), instructions: memo.compiled.instructions, timestamp })
      const expected = deriveCanaryInclusiveTradePostconditions(memo.input, timestamp)
      const after = await readAccounts(ctx.readers, ctx.genesis, expected.filter(x => x.account).map(x => x.address))
      for (const row of expected) if (row.account) check(after.accounts.get(row.address)?.dataBase64 === row.account.dataBase64, `Trade post-state differs at ${row.address}`)
      const finalGov = decode('swap', 'Governance', (await readAccounts(ctx.readers, ctx.genesis, [expect.swapGovernance])).accounts.get(expect.swapGovernance))
      check(finalGov.state.gates.trading === true, 'Trading gate is not closed after the canary')
      return [`fee split gross ${gross} = platform ${platform} + creator ${creator}`, 'governance open/close events verified at instructions 2 and 4; trading closed', `${expected.filter(x => x.account).length} post-state accounts match`]
    },
  }
}

const collect = {
  name: 'collect',
  async build(ctx, pinned) {
    const a = canaryAddresses(ctx.programs, ctx.quoteMint, ctx.roles.mint), route = value(ctx.config, 'collectRoute'), creator = ctx.roles.creator
    const collectorQuote = holdingAddress(ctx.quoteMint, ctx.roles.treasury, ctx.programs.token)
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [a.launch, a.pool, a.inclusiveFeePolicy, a.launchQuote, creator, ctx.roles.treasury, collectorQuote, holdingAddress(ctx.quoteMint, creator, ctx.programs.token)])
    if (!snapshot.accounts.get(a.launch)) return { blocked: 'canary launch does not exist yet', observedSlot: snapshot.slot }
    const launchState = decode('launch', 'Launch', snapshot.accounts.get(a.launch)), pool = decode('swap', 'Pool', snapshot.accounts.get(a.pool))
    const policy = Buffer.from(owned(snapshot.accounts, a.inclusiveFeePolicy, ctx.programs.swap, 'inclusive fee policy').dataBase64, 'base64')
    const policyCollector = new PublicKey(policy.subarray(41, 73)).toBase58()
    check(policyCollector === ctx.roles.treasury, 'Inclusive fee policy collector is not the treasury')
    const creatorDue = BigInt(launchState.creator_fees_accrued.toString()) - BigInt(launchState.creator_fees_claimed.toString()), platformDue = BigInt(pool.protocol_fees_quote.toString())
    check(holdingAmount(snapshot.accounts.get(a.launchQuote)) === creatorDue, 'Launch quote holding differs from accrued-minus-claimed creator fees')
    if (creatorDue === 0n && platformDue === 0n) return { blocked: 'nothing to collect', observedSlot: snapshot.slot }
    const instructions = [], rows = [], notes = []
    if (creatorDue > 0n) { instructions.push(ix.claimCreatorFees(ctx.programs, ctx.quoteMint, { creator, launch: a.launch })); rows.push(`creator fees ${creatorDue} raw quote: launch quote ${a.launchQuote} -> creator quote holding (claim_creator_fees, creator signs)`) }
    if (platformDue > 0n) {
      if (route === 'sol') {
        instructions.push(ix.collectProtocolFeesSol(ctx.programs, ctx.quoteMint, { cranker: creator, pool: a.pool, collector: ctx.roles.treasury, inclusiveFeePolicy: a.inclusiveFeePolicy }))
        rows.push(`platform fees ${platformDue} raw bridged SOL: pool quote vault -> unwrapped by the bridge -> ${sol(platformDue)} to treasury ${ctx.roles.treasury} (collect_protocol_fees_sol, permissionless)`)
        const treasury = BigInt(snapshot.accounts.get(ctx.roles.treasury)?.lamports ?? 0), rent0 = BigInt((await rentExemption(ctx.readers, [0]))[0])
        if (treasury + platformDue < rent0) notes.push(`treasury would hold ${sol(treasury + platformDue)} < rent-exempt minimum ${sol(rent0)}; this collection would FAIL until the treasury is funded (fund stage)`)
      } else {
        check(snapshot.accounts.get(collectorQuote), 'Treasury quote holding is missing for the quote route')
        instructions.push(ix.collectProtocolFeesQuote(ctx.programs, ctx.quoteMint, { admin: ctx.roles.admin, pool: a.pool, collector: ctx.roles.treasury, inclusiveFeePolicy: a.inclusiveFeePolicy }))
        rows.push(`platform fees ${platformDue} raw quote: pool quote vault -> treasury quote holding ${collectorQuote} (collect_protocol_fees, admin signs)`)
      }
    }
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'collect', payer: creator, instructions, pinned, snapshot, units: 300000 })
    return { observedSlot: snapshot.slot, review, notes, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: `fee collection (route ${route})`, rows }],
      expect: { creatorDue: String(creatorDue), platformDue: String(platformDue), route, treasury: ctx.roles.treasury, creator } }
  },
  async verify(ctx, expect, receipt) {
    const claimed = receipt.events.filter(e => e.name === 'CreatorFeesClaimed'), collected = receipt.events.filter(e => e.name === 'ProtocolFeesCollected')
    if (BigInt(expect.creatorDue) > 0n) check(claimed.length === 1 && claimed[0].data.amount.toString() === expect.creatorDue && claimed[0].data.creator.toBase58() === expect.creator, 'CreatorFeesClaimed differs')
    if (BigInt(expect.platformDue) > 0n) check(collected.length === 1 && collected[0].data.quote_amount.toString() === expect.platformDue && collected[0].data.collector.toBase58() === expect.treasury, 'ProtocolFeesCollected differs')
    return [`creator claimed ${expect.creatorDue} raw quote`, `platform collected ${expect.platformDue} via ${expect.route} to ${expect.treasury}`]
  },
}

export const canaryStages = { alt, 'canary-prepare': prepare, 'canary-launch': launch, 'canary-holdings': holdings, 'canary-buy': tradeStage('buy'), 'canary-sell': tradeStage('sell'), collect }
