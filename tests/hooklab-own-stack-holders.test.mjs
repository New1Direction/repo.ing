// Holders are never trapped on our own stack: after launch-side governed changes (a guardian creation pause, the admin
// reopening, open creation off and on, a new creation fee, new menus), buys, sells, the creator's claim and a graduating
// buy keep reviewing and settling under the SAME bundle, with no redeploy. Launch reviews refuse plainly until the bundle
// is collected again; a swap trading pause makes trades refuse. hook-lab's independent build; isolated SBF bank.
import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { ownStackWorld, openLaunch, siteTrade, siteMarket, coinsHeld, TRADE_LIMITS, TRADERS, OWNER_MENUS } from './fixtures/hooklab-own-stack-world.mjs'
import { INDEPENDENT_SKIP } from './fixtures/hooklab-own-stack.mjs'
import { LAUNCH_SETTINGS_CHANGED, governedSetOpenCreation } from '../src/hooklab-open-creation.mjs'
import { finalFillLamports } from '../src/hooklab-graduation.mjs'
import { maxBuyLamports } from '../app/lib/hooklab-trade-math.mjs'
import { nativeClaimResolver } from '../src/hooklab-native-claim-resolver.mjs'
import { derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'

const skip = INDEPENDENT_SKIP || (process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && !process.env.HOOKLAB_CANARY_PYTHONPATH && 'the isolated SVM runner (HOOKLAB_CANARY_PYTHONPATH) is not available')
// Until the trade-scope evidence split (trade reviews check only trade-side pins) is merged, trades refuse after any
// launch-side change (RED with HOOKLAB_TRADE_SCOPE_MERGED=true); the test skips with that reason until then.
const pending = process.env.HOOKLAB_TRADE_SCOPE_MERGED === 'true' ? false : 'needs the trade-scope evidence split (TASK C) merged'

test('holders are never trapped: launch-side governed changes leave buys, sells, claims and graduation working, no redeploy', { skip: skip || pending, timeout: 600000 }, async t => {
  const w = await ownStackWorld({ build: 'independent', rentPerByte: 5080 }); t.after(w.close)
  const launch = await openLaunch(w, { creatorFeeBps: 100, capBps: 500, name: 'Held', symbol: 'HELD', virtualQuote: '1000000000', creator: w.runnerKey('creator') })
  const { settle } = await launch.send(); assert.equal((await settle()).status, 'finalized-success')
  const coin = { ...launch, creatorFeeBps: 100, capBps: 500 }, mint = launch.mint.publicKey.toBase58(), bundle = w.bundle
  await siteTrade(w, coin, { owner: w.roles.buyer, side: 'buy', amountIn: 20000000 })

  // Launch-side governed changes, the bundle NOT collected again after any of them.
  const send = async (label, signer, instruction) => w.must(label, w.send(await w.message(signer, [instruction])))
  const launchGov = async (signer, action) => send(JSON.stringify(Object.keys(action)), signer,
    w.ix('launch', 'governance_action', { expected: [...await w.commitment('launch')], action }, { authority: signer }))
  await launchGov(w.roles.guardian, { Pause: [{ creation: true, trading: false }] })
  await launchGov(w.roles.admin, { SetGates: [{ creation: false, trading: false }] })
  for (const on of [false, true]) await send(`open creation ${on}`, w.roles.admin, governedSetOpenCreation({ launchProgram: w.programs.launch, admin: w.roles.admin,
    expected: await w.commitment('launch'), on, ...OWNER_MENUS }))
  const config = w.coders.launch.accounts.decode('Config', await w.data(derivedAddresses(w.programs).launchConfig))
  const args = { admin: config.admin, treasury: config.treasury, quote_mint: config.quote_mint, launch_fee_lamports: new BN(30000000), lp_fee_bps: config.lp_fee_bps,
    max_creator_fee_bps: config.max_creator_fee_bps, sniper_window_secs: config.sniper_window_secs, sniper_start_bps: config.sniper_start_bps, curve_bps: config.curve_bps,
    supply: config.supply, decimals: config.decimals, min_virtual_quote: config.min_virtual_quote, max_virtual_quote: config.max_virtual_quote, paused: config.paused, rule_bounds: config.rule_bounds }
  await send('launch fee', w.roles.admin, w.ix('launch', 'governed_set_config', { expected: [...await w.commitment('launch')], args }, { authority: w.roles.admin }))
  await send('new menus', w.roles.admin, governedSetOpenCreation({ launchProgram: w.programs.launch, admin: w.roles.admin, expected: await w.commitment('launch'), on: true,
    creatorFeeBps: [50, 100], capBps: [200, 500] }))
  assert.equal(w.bundle, bundle, 'the same bundle throughout')

  // A launch review says plainly that the settings changed; nothing is signed.
  await assert.rejects(openLaunch(w, { creatorFeeBps: 100, capBps: 500, name: 'Later', symbol: 'LATER', virtualQuote: '1000000000' }),
    { code: 'HOOKLAB_USER_REFUSAL', message: LAUNCH_SETTINGS_CHANGED })

  // Holders: buy, sell and the creator's claim, under the same bundle.
  await siteTrade(w, coin, { owner: w.roles.outsider, side: 'buy', amountIn: 20000000 })
  const held = await coinsHeld(w, mint, w.roles.buyer)
  await siteTrade(w, coin, { owner: w.roles.buyer, side: 'sell', amountIn: held / 2n })
  const claims = nativeClaimResolver({ ...w.bindings, connections: w.connections(), limits: TRADE_LIMITS, clock: () => 1000 })
  const claim = await claims.prepare({ owner: w.roles.creator, stage: 'native-claim', intent: { mint } }), claimed = await w.send(claim.review.messageBase64)
  assert.equal(claimed.error, null); assert.equal((await claims.reconcile({ review: claim.review, configurationSha256: claim.configurationSha256, settlementContext: claim.settlementContext,
    signedTransactionBase64: claimed.wireBase64, signature: claimed.signature })).status, 'finalized-success')

  // And the curve still graduates through the site: capped buys to the end, then the exact fill with graduate.
  let last = null, fill = null
  for (const role of TRADERS) {
    const trader = w.roles[role]
    for (;;) {
      const { market } = await siteMarket(w, mint), max = maxBuyLamports(market, await coinsHeld(w, mint, trader)); fill = finalFillLamports(market)
      if (max === null) break
      if (max === fill) { last = trader; break }
      await siteTrade(w, coin, { owner: trader, side: 'buy', amountIn: max * 98n / 100n })
    }
    if (last) break
  }
  assert.ok(last); await siteTrade(w, coin, { owner: last, side: 'buy', amountIn: fill, graduate: true })
  assert.equal((await siteMarket(w, mint)).market.graduated, true)

  // A swap trading pause stops trades cleanly: refused before anything is signed.
  await send('pause trading', w.roles.guardian, w.ix('swap', 'governance_action', { expected: [...await w.commitment('swap')], action: { Pause: [{ creation: false, trading: true }] } },
    { authority: w.roles.guardian }))
  await assert.rejects(siteTrade(w, coin, { owner: last, side: 'sell', amountIn: 1000n }))
})
