// Our own stack (hook-lab's independent build at its placeholder IDs) never traps holders: after the guardian pauses
// creation, the owner toggles open creation off and on with changed menus, and changes the creation fee, the stack bundle
// collected at setup is NOT refreshed, and still: buys and a sale, the creator's fee claim, the graduating buy (the exact
// final fill with graduate) review and settle through the website's resolvers, and the platform's native fee collection
// (the owner driver's collect-native instruction) pays the treasury exactly what the pool owed. Open launches refuse in
// plain words while creation is paused and, after it reopens, until the bundle is refreshed; then they settle again.
// One isolated SBF bank (tests/fixtures/hooklab-own-stack-world.mjs); every address comes from the stack's bundle.
import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { ComputeBudgetProgram, Keypair } from '@solana/web3.js'
import { LAUNCHES_PAUSED, LAUNCH_SETTINGS_CHANGED, governedSetOpenCreation, readOpenCreation } from '../src/hooklab-open-creation.mjs'
import { readHookCoinMarket } from '../src/hooklab-coin-market.mjs'
import { nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { nativeClaimResolver } from '../src/hooklab-native-claim-resolver.mjs'
import { nativeSwapV2Instruction } from '../src/hooklab-native-swap.mjs'
import { hookCoinAddresses } from '../src/hooklab-inclusive-max-wallet-swap.mjs'
import { finalFillLamports } from '../src/hooklab-graduation.mjs'
import { readProductionEvidence } from '../src/hooklab-production-rpc.mjs'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { createHolding, instructionsFor, launchConfigArgs } from '../src/hooklab-owner-driver/instructions.mjs'
import { estimateTrade, maxBuyLamports } from '../app/lib/hooklab-trade-math.mjs'
import { ownStackWorld, openLaunch, OWNER_MENUS } from './fixtures/hooklab-own-stack-world.mjs'
import { INDEPENDENT_SKIP } from './fixtures/hooklab-own-stack.mjs'

const runner = process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && !process.env.HOOKLAB_CANARY_PYTHONPATH && 'the isolated SVM runner (HOOKLAB_CANARY_PYTHONPATH) is not available'
const LIMITS = { nowMs: 1000, maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 0, reviewExpiresAtMs: 0, maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '10000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' }
const NEW_MENUS = Object.freeze({ creatorFeeBps: [50, 100, 200], capBps: [200, 300, 500] })

test('our own stack: a creation pause, an open-creation toggle and a fee and menu change trap no holder and need no bundle refresh for trades; open launches wait for it', { skip: INDEPENDENT_SKIP || runner, timeout: 600000 }, async t => {
  const w = await ownStackWorld({ build: 'independent', rentPerByte: 5080 }); t.after(w.close)
  const P = w.programs, stale = w.bindings, profile = JSON.parse(stale.profile.json), swapIdl = JSON.parse(w.idls.swap)
  const creator = w.runnerKey('outsider')
  const launched = await openLaunch(w, { creatorFeeBps: 200, capBps: 500, name: 'Scope', symbol: 'SCOPE', virtualQuote: '53251917070', creator })
  assert.equal((await (await launched.send()).settle()).status, 'finalized-success')
  const coin = { mint: launched.mint.publicKey.toBase58(), selectedConfig: launched.request.selectedConfig, creatorFeeBps: 200, capBps: 500 }, a = hookCoinAddresses(profile, coin.mint)
  const market = async () => (await readHookCoinMarket({ connection: w.connections()[0].connection, mint: coin.mint, profile })).market
  const held = async owner => { const bytes = await w.data(w.holdingOf(coin.mint, owner)); return bytes.length ? bytes.readBigUInt64LE(74) : 0n }
  // Every review below uses the bundle collected at setup: stale is never refreshed for trades, claims or graduation.
  async function trade(owner, side, amount, { graduate = false } = {}) {
    const resolver = nativeTradeResolver({ ...stale, connections: w.connections(), limits: LIMITS, clock: () => 1000 })
    const minAmountOut = String(estimateTrade(await market(), { side, amount: BigInt(amount), coinBalance: await held(owner), slippageBps: 300 }).minAmountOut)
    const prepared = await resolver.prepare({ owner, stage: `native-${side}`, intent: { side, creatorFeeBps: coin.creatorFeeBps, capBps: coin.capBps, mint: coin.mint,
      selectedConfig: coin.selectedConfig, amountIn: String(amount), minAmountOut, maxInput: String(amount), maxPriceImpactBps: 1000, graduate } })
    const sent = await w.send(prepared.review.messageBase64); assert.equal(sent.error, null, (sent.logs ?? []).slice(-6).join('\n'))
    const settled = await resolver.reconcile({ review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext,
      signedTransactionBase64: sent.wireBase64, signature: sent.signature })
    assert.equal(settled.status, 'finalized-success'); return settled
  }
  await trade(w.roles.buyer, 'buy', 50000000)

  await t.test('the guardian pauses creation, the owner toggles open creation off and on with new menus and changes the creation fee', async () => {
    const run = async (label, payer, instruction) => w.must(label, w.send(await w.message(payer, [instruction])))
    await run('guardian pause', w.roles.guardian, w.ix('launch', 'governance_action', { expected: [...await w.commitment('launch')], action: { Pause: [{ creation: true, trading: false }] } }, { authority: w.roles.guardian }))
    await run('open creation off', w.roles.admin, governedSetOpenCreation({ launchProgram: P.launch, admin: w.roles.admin, expected: await w.commitment('launch'), on: false, ...OWNER_MENUS }))
    await run('open creation on, new menus', w.roles.admin, governedSetOpenCreation({ launchProgram: P.launch, admin: w.roles.admin, expected: await w.commitment('launch'), on: true, ...NEW_MENUS }))
    const config = w.coders.launch.accounts.decode('Config', await w.data(JSON.parse(stale.dossierJson).accounts.find(x => x.role === 'launch-config').address))
    await run('creation fee', w.roles.admin, w.ix('launch', 'governed_set_config', { expected: [...await w.commitment('launch')], args: launchConfigArgs({ ...config, launch_fee_lamports: new BN(15000000) }) }, { authority: w.roles.admin }))
    const chain = await readOpenCreation(w.connections(), P)
    assert.equal(chain.paused, true); assert.equal(chain.open, true); assert.deepEqual([...chain.capBps], NEW_MENUS.capBps); assert.equal(chain.launchFeeLamports, '15000000')
    assert.equal(w.bindings.dossierJson, stale.dossierJson, 'the bundle was not refreshed')
    const whole = await readProductionEvidence({ dossierJson: stale.dossierJson, expectedSha256: stale.config.dossierSha256, providers: w.connections(), idls: stale.profile.idls })
    assert.equal(whole.status, 'mismatch', 'the bundle is stale for the whole dossier (bootstrap, monitoring, launches)')
  })

  await t.test('with the same bundle: a sale and a buy settle', async () => {
    await trade(w.roles.buyer, 'sell', (await held(w.roles.buyer)) / 3n)
    await trade(w.roles.buyer, 'buy', 20000000)
  })

  await t.test('with the same bundle: the creator claims its fees in SOL', async () => {
    const owner = creator.publicKey.toBase58(), resolver = nativeClaimResolver({ ...stale, connections: w.connections(), limits: LIMITS, clock: () => 1000 })
    const prepared = await resolver.prepare({ owner, stage: 'native-claim', intent: { mint: coin.mint } })
    const before = await w.lamports([owner, a.launch]), sent = await w.send(prepared.review.messageBase64)
    assert.equal(sent.error, null, (sent.logs ?? []).slice(-6).join('\n'))
    const settled = await resolver.reconcile({ review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext,
      signedTransactionBase64: sent.wireBase64, signature: sent.signature })
    assert.equal(settled.status, 'finalized-success')
    const after = await w.lamports([owner, a.launch]), claimed = before[a.launch] - after[a.launch]
    assert.ok(claimed > 0n); assert.equal(after[owner] - before[owner], claimed - BigInt(sent.fee), 'the creator received the claim less the network fee')
  })

  await t.test('with the same bundle: capped buys to the curve\'s end, then the graduating buy settles', async () => {
    for (let i = 0; i < 40; i++) {
      const m = await market(), max = maxBuyLamports(m, 0n)
      if (max === finalFillLamports(m)) break
      const filler = Keypair.generate(), F = filler.publicKey.toBase58(); await w.fund(F, String(max * 2n + 1000000000n))
      await w.must('filler buy', w.signAndSubmit(await w.message(F, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1400000 }), createHolding(profile.programs, { payer: F, mint: coin.mint, owner: F }),
        nativeSwapV2Instruction(profile, { side: 'buy', trader: F, mint: coin.mint, amountIn: max * 98n / 100n, minAmountOut: 1 }, swapIdl)]), [filler]))
    }
    const m = await market(), fill = finalFillLamports(m)
    assert.ok(fill && maxBuyLamports(m, 0n) === fill, 'a fresh wallet can finish the curve')
    const graduated = await trade(w.roles.creator, 'buy', fill, { graduate: true })
    assert.equal(graduated.graduated, true); assert.equal((await market()).graduated, true)
  })

  await t.test('the platform\'s native fee collection pays the treasury exactly what the pool owed', async () => {
    const pinned = loadArtifacts(), stack = instructionsFor({ idls: { ...pinned.idls, launch: JSON.parse(w.idls.launch), swap: swapIdl }, coders: { ...pinned.coders, launch: w.coders.launch, swap: w.coders.swap } })
    const owed = BigInt(w.coders.swap.accounts.decode('Pool', await w.data(a.pool)).protocol_fees_quote.toString())
    assert.ok(owed > 0n, 'the trades left platform fees in the pool')
    const before = await w.lamports([w.roles.treasury])
    await w.must('collect-native', w.send(await w.message(w.roles.upgrade, [stack.collectProtocolFeesNative(P, profile.quoteMint, { cranker: w.roles.upgrade, mint: coin.mint, collector: w.roles.treasury })])))
    assert.equal(w.coders.swap.accounts.decode('Pool', await w.data(a.pool)).protocol_fees_quote.toString(), '0')
    assert.equal((await w.lamports([w.roles.treasury]))[w.roles.treasury] - before[w.roles.treasury], owed)
  })

  await t.test('open launches refuse in plain words while creation is paused and, once it reopens, until the bundle is refreshed', async () => {
    const choice = { creatorFeeBps: 100, capBps: 300, virtualQuote: '1000000000' }
    await assert.rejects(openLaunch(w, { ...choice, name: 'Paused', symbol: 'PAUSED' }), { code: 'HOOKLAB_USER_REFUSAL', message: LAUNCHES_PAUSED }, 'paused')
    await w.must('creation reopened', w.send(await w.message(w.roles.admin, [w.ix('launch', 'governance_action',
      { expected: [...await w.commitment('launch')], action: { SetGates: [{ creation: false, trading: false }] } }, { authority: w.roles.admin })])))
    assert.equal((await readOpenCreation(w.connections(), P)).paused, false)
    await assert.rejects(openLaunch(w, { ...choice, name: 'Stale', symbol: 'STALE' }), { code: 'HOOKLAB_USER_REFUSAL', message: LAUNCH_SETTINGS_CHANGED },
      'the bundle still pins the old launch-side state')
    await w.recollect()
    const fresh = await openLaunch(w, { ...choice, name: 'Fresh', symbol: 'FRESH' })
    assert.equal((await (await fresh.send()).settle()).status, 'finalized-success', 'after the refresh, launches settle')
  })
})
