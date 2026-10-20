// Our own stack end to end in one isolated SBF bank: set up from nothing by the owner's first-time setup, its production
// bundle collected by the real collector, then the website's self-serve flow for fresh wallets with no owner agent and no
// admin key: the preparation collector, the open launch collector and its settlement, each signed only by the creator's
// own keys (and the sealed mint key). Then native-SOL buys and sells through the website's trade resolver, the refusals
// (off, off-menu, paused by the guardian) and their plain words. Program IDs are the relocated stack's (fresh IDs, our
// own marker), so nothing on these paths can be a legacy address.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { LAUNCHES_PAUSED, LAUNCH_RENT_MARGIN_LAMPORTS, LAUNCH_SETTINGS_CHANGED, governedSetOpenCreation, readOpenCreation, openLaunchErrorText } from '../src/hooklab-open-creation.mjs'
import { openLaunchCosts, openLaunchNetworkFee } from '../app/lib/hooklab-open-launch.mjs'
import { readHookCoinMarket } from '../src/hooklab-coin-market.mjs'
import { nativeClaimResolver } from '../src/hooklab-native-claim-resolver.mjs'
import { LEGACY_STACK } from '../src/hooklab-stack.mjs'
import { ownStackWorld, openLaunch, launchLimitsFor, siteTrade, coinsHeld as heldBy, TRADE_LIMITS, CREATION_FEE_LAMPORTS, OWNER_MENUS } from './fixtures/hooklab-own-stack-world.mjs'
import { INDEPENDENT_SKIP, OWN_STACK_SKIP } from './fixtures/hooklab-own-stack.mjs'

const runner = process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && !process.env.HOOKLAB_CANARY_PYTHONPATH && 'the isolated SVM runner (HOOKLAB_CANARY_PYTHONPATH) is not available'
// hook-lab's own independent-stack build at its placeholder IDs, and the reviewed ELFs relocated to fresh IDs: the same
// website code serves both, with every address from the stack's bundle.
const BUILDS = Object.freeze({ independent: INDEPENDENT_SKIP || runner, relocated: OWN_STACK_SKIP || runner })
const sha = value => createHash('sha256').update(value).digest('hex')
const pda = (program, ...seeds) => PublicKey.findProgramAddressSync(seeds.map(s => typeof s === 'string' ? Buffer.from(s) : s), new PublicKey(program))[0].toBase58()

for (const [build, skip] of Object.entries(BUILDS)) test(`our own stack (${build}) from nothing: owner setup, its bundle, then open launches by fresh wallets, trades and refusals`, { skip, timeout: 600000 }, async t => {
  // At mainnet's rent rate (5,080 lamports per byte), so the creator's outlay is the economics review's exact figure.
  const w = await ownStackWorld({ build, rentPerByte: 5080 }); t.after(w.close)
  const profile = JSON.parse(w.bindings.profile.json), P = w.programs
  assert.ok(Object.values(P).every(id => !Object.values(LEGACY_STACK.programs).includes(id)) && profile.quoteMint !== LEGACY_STACK.quoteMint, 'a stack of its own')
  assert.equal(profile.programs.bridge, undefined)
  let rentLamports = null

  await t.test('the chain says open creation is on with the owner\'s menus and the confirmed creation fee', async () => {
    const chain = await readOpenCreation(w.connections(), P)
    assert.deepEqual({ native: chain.native, open: chain.open, paused: chain.paused, creatorFeeBps: [...chain.creatorFeeBps], capBps: [...chain.capBps], fee: chain.launchFeeLamports, pool: chain.poolCreationFeeLamports },
      { native: true, open: true, paused: false, ...OWNER_MENUS, fee: String(CREATION_FEE_LAMPORTS), pool: '0' })
    rentLamports = BigInt(chain.rentLamports)
  })

  const coins = []
  await t.test('four consecutive open launches by fresh wallets, each signed only by its creator and its mint, settle', async () => {
    const choices = [[50, 100, '1000000000'], [100, 200, '53251917070'], [200, 300, '5625000000'], [100, 500, '112500000000']]
    for (const [i, [creatorFeeBps, capBps, virtualQuote]] of choices.entries()) {
      const treasuryBefore = (await w.lamports([w.roles.treasury]))[w.roles.treasury]
      const launch = await openLaunch(w, { creatorFeeBps, capBps, name: `Own stack ${i + 1}`, symbol: `OWN${i + 1}`, virtualQuote })
      const review = launch.collected.plan.review
      assert.equal(review.operation, 'open-launch'); assert.deepEqual(review.requiredSigners, [launch.creator.publicKey.toBase58(), launch.mint.publicKey.toBase58()])
      assert.equal(review.requiredSigners.includes(w.roles.admin), false, 'no admin co-signature')
      const creatorBefore = (await w.lamports([launch.creator.publicKey.toBase58()]))[launch.creator.publicKey.toBase58()]
      const { sent, settle } = await launch.send()
      // What the creator paid: the creation fee, the rent the launch locks, and two signatures; within the reviewed bounds.
      const paid = creatorBefore - (await w.lamports([launch.creator.publicKey.toBase58()]))[launch.creator.publicKey.toBase58()], rent = paid - CREATION_FEE_LAMPORTS - 10000n
      assert.ok(rent > 0n && rent <= BigInt((await launchLimitsFor(w)).maxRentLamports), String(rent))
      t.diagnostic(`launch ${i + 1}: ${sent.units} CU, ${sent.wireBytes} bytes, creator paid ${paid} lamports (fee ${CREATION_FEE_LAMPORTS}, rent ${rent}, network 10000)`)
      assert.equal(sent.error, null, (sent.logs ?? []).slice(-8).join('\n')); assert.ok(sent.wireBytes <= 1232)
      const settled = await settle()
      assert.equal(settled.status, 'finalized-success', JSON.stringify(settled).slice(0, 400))
      // The creation fee went to the treasury; the coin is a native coin of our stack with the creator's choices.
      assert.equal((await w.lamports([w.roles.treasury]))[w.roles.treasury] - treasuryBefore, CREATION_FEE_LAMPORTS)
      const { market } = await readHookCoinMarket({ connection: w.connections()[0].connection, mint: launch.mint.publicKey.toBase58(), profile })
      assert.equal(market.native, true); assert.equal(market.creatorFeeBps, creatorFeeBps); assert.equal(market.capBps, capBps)
      assert.equal(market.creator, launch.creator.publicKey.toBase58())
      // Everything the creator spent, from the funded wallet: the creation fee, the rent the review screen shows
      // (readOpenCreation's rentLamports), and the two transactions' network fees.
      const spent = 2000000000n - (await w.lamports([launch.creator.publicKey.toBase58()]))[launch.creator.publicKey.toBase58()]
      assert.equal(spent, CREATION_FEE_LAMPORTS + rentLamports + BigInt(launch.preparationFeeLamports) + 10000n)
      // 47,604,720 lamports plus 25,000 of signature fees: 3,713,480 setup rent, the 20,000,000 creation fee, 23,891,240
      // creation rent (the economics review, measured on mainnet's rates).
      assert.equal(rentLamports, 27604720n); assert.equal(spent, 47629720n)
      coins.push({ ...launch, creatorFeeBps, capBps })
    }
    assert.equal(coins.length, 4)
  })

  await t.test('a wallet holding exactly what the review screen asks for launches; one lamport less is refused before anything is signed', async () => {
    const chain = await readOpenCreation(w.connections(), P), { needLamports, need, total } = openLaunchCosts(chain, { networkFeeLamports: openLaunchNetworkFee('0') })
    t.diagnostic(`review screen: you'll spend about ${total}; you need at least ${need} in your wallet (${needLamports} lamports)`)
    // The launch's rent bound is exact: the launch's rent, the launch account's again (the guard counts it twice), the margin.
    assert.equal(BigInt(chain.guardRentLamports), BigInt(chain.launchRentLamports) + 3520440n + LAUNCH_RENT_MARGIN_LAMPORTS)
    const exact = await openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Exact', symbol: 'EXACT', virtualQuote: '53251917070', funds: needLamports })
    const { sent, settle } = await exact.send()
    assert.equal(sent.error, null, (sent.logs ?? []).slice(-6).join('\n')); assert.equal((await settle()).status, 'finalized-success')
    await assert.rejects(openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Short', symbol: 'SHORT', virtualQuote: '53251917070', funds: needLamports - 1n }), /unavailable/)
  })

  // Trades as the site runs them (tests/fixtures/hooklab-own-stack-world.mjs siteTrade), by a runner wallet.
  const owner = w.roles.buyer
  const coinsHeld = coin => heldBy(w, coin.mint.publicKey.toBase58(), owner)
  const trade = (coin, side, amountIn, { hold = false } = {}) => siteTrade(w, coin, { owner, side, amountIn, hold })
  await t.test('a wallet buys and sells a new coin with ordinary SOL through the website\'s trade resolver', async () => {
    await trade(coins[1], 'buy', 10000000)
    const held = await coinsHeld(coins[1]); assert.ok(held > 0n)
    await trade(coins[1], 'sell', held / 2n)
    assert.equal(await coinsHeld(coins[1]), held - held / 2n)
  })

  await t.test('the creator claims its coin\'s creator fees in SOL, and only the creator can', async () => {
    const creator = w.runnerKey('outsider'), owner = creator.publicKey.toBase58()
    const launch = await openLaunch(w, { creatorFeeBps: 200, capBps: 500, name: 'Claims', symbol: 'CLAIM', virtualQuote: '53251917070', creator })
    const { settle } = await launch.send(); assert.equal((await settle()).status, 'finalized-success')
    const coin = { ...launch, creatorFeeBps: 200, capBps: 500 }, mint = launch.mint.publicKey.toBase58()
    await trade(coin, 'buy', 200000000)
    const resolver = nativeClaimResolver({ ...w.bindings, connections: w.connections(), limits: TRADE_LIMITS, clock: () => 1000 })
    await assert.rejects(resolver.prepare({ owner: w.roles.buyer, stage: 'native-claim', intent: { mint } }), /Only the wallet that launched this coin/)
    const prepared = await resolver.prepare({ owner, stage: 'native-claim', intent: { mint } })
    assert.deepEqual(prepared.review.requiredSigners, [owner])
    const before = (await w.lamports([owner]))[owner], sent = await w.send(prepared.review.messageBase64)
    assert.equal(sent.error, null, (sent.logs ?? []).slice(-6).join('\n'))
    const settled = await resolver.reconcile({ review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext,
      signedTransactionBase64: sent.wireBase64, signature: sent.signature })
    assert.equal(settled.status, 'finalized-success')
    assert.ok((await w.lamports([owner]))[owner] > before, 'the creator received SOL')
  })

  // The program's error code from a failed send, and the customer's words for it.
  const failure = sent => { const code = Number(/InstructionErrorCustom\((\d+)\)/.exec(sent.error ?? '')?.[1]); return { code, text: openLaunchErrorText(code) } }
  await t.test('refused, in plain words: a choice off the menu, a launch signed before open creation turned off, then before the guardian paused creation', async () => {
    // Off the menu: the compiler refuses before anything is signed.
    await assert.rejects(openLaunch(w, { creatorFeeBps: 150, capBps: 200, name: 'Off menu', symbol: 'OFF', virtualQuote: '1000000000' }), /unavailable|menu/i)
    // Each governed change is followed by the owner collecting the bundle again (it pins both governances exactly).
    const admin = async (label, instruction, { recollect = true } = {}) => { await w.must(label, w.send(await w.message(w.roles.admin, [instruction]))); if (recollect) await w.recollect() }
    // Reviewed while open, signed, then the owner turns open creation off: the program refuses it and only the network fee is spent.
    const early = await openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Too late', symbol: 'LATE', virtualQuote: '1000000000' })
    await admin('open creation off', governedSetOpenCreation({ launchProgram: P.launch, admin: w.roles.admin, expected: await w.commitment('launch'), on: false, ...OWNER_MENUS }), { recollect: false })
    // The chain says open launches are off, in plain words, even before the owner collects the bundle again.
    await assert.rejects(openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Stale', symbol: 'STALE', virtualQuote: '1000000000' }),
      { code: 'HOOKLAB_USER_REFUSAL', message: openLaunchErrorText(6120) })
    await w.recollect()
    const creator = early.creator.publicKey.toBase58(), before = (await w.lamports([creator]))[creator]
    const off = (await early.send()).sent, refusedOff = failure(off)
    assert.ok([6120, 6056].includes(refusedOff.code), off.error); assert.ok(refusedOff.text, 'plain words for the customer')
    assert.equal(before - (await w.lamports([creator]))[creator], 10000n, 'only the network fee')
    assert.equal((await readOpenCreation(w.connections(), P)).open, false)
    await assert.rejects(openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Off', symbol: 'OFF2', virtualQuote: '1000000000' }),
      { code: 'HOOKLAB_USER_REFUSAL', message: openLaunchErrorText(6120) }, 'no review while off, in plain words')
    await admin('open creation on', governedSetOpenCreation({ launchProgram: P.launch, admin: w.roles.admin, expected: await w.commitment('launch'), on: true, ...OWNER_MENUS }), { recollect: false })
    // Open again on chain, but the bundle still pins the old launch settings: the review says so plainly until it is collected.
    await assert.rejects(openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Stale', symbol: 'STALE2', virtualQuote: '1000000000' }),
      { code: 'HOOKLAB_USER_REFUSAL', message: LAUNCH_SETTINGS_CHANGED })
    await w.recollect()
    // Reviewed and signed, then the guardian pauses creation (governance Pause, the guardian alone): refused on chain.
    const signed = await openLaunch(w, { creatorFeeBps: 50, capBps: 100, name: 'Paused', symbol: 'PAUSED', virtualQuote: '1000000000' })
    const heldTrade = await trade(coins[1], 'buy', 5000000, { hold: true })
    await w.must('guardian pause', w.send(await w.message(w.roles.guardian, [w.ix('launch', 'governance_action',
      { expected: [...await w.commitment('launch')], action: { Pause: [{ creation: true, trading: false }] } }, { authority: w.roles.guardian })])))
    await w.recollect()
    assert.equal((await readOpenCreation(w.connections(), P)).paused, true)
    const paused = (await signed.send()).sent, refusedPaused = failure(paused)
    assert.ok([6055, 6056].includes(refusedPaused.code), paused.error); assert.ok(refusedPaused.text)
    await assert.rejects(openLaunch(w, { creatorFeeBps: 100, capBps: 200, name: 'Paused 2', symbol: 'PAUSED2', virtualQuote: '1000000000' }),
      { code: 'HOOKLAB_USER_REFUSAL', message: LAUNCHES_PAUSED }, 'no review while paused, in plain words')
    assert.equal(openLaunchErrorText(6055), 'Launches are paused right now. Your SOL was not spent; try again later.')
    // Creation is paused, trading is not: a trade signed before the pause lands on chain, and the website still reviews new ones.
    const traded = await w.send(heldTrade.prepared.review.messageBase64)
    assert.equal(traded.error, null, (traded.logs ?? []).slice(-6).join('\n'))
    await trade(coins[1], 'buy', 5000000)
    // The guardian pauses trading too (the swap governance): a trade signed before is refused on chain and the website
    // reviews none.
    const heldBuy = await trade(coins[1], 'buy', 5000000, { hold: true })
    await w.must('guardian pause trading', w.send(await w.message(w.roles.guardian, [w.ix('swap', 'governance_action',
      { expected: [...await w.commitment('swap')], action: { Pause: [{ creation: false, trading: true }] } }, { authority: w.roles.guardian })])))
    await w.recollect()
    const refusedTrade = await w.send(heldBuy.prepared.review.messageBase64)
    assert.ok(refusedTrade.error, 'refused on chain while trading is paused')
    await assert.rejects(trade(coins[1], 'sell', 1000), 'no review while trading is paused')
  })
})
