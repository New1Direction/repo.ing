// A coin of our own stack graduates through the site, on hook-lab's independent build: the coin page renders from the
// runtime's market read of the stack, wallets buy up to the curve's end through the site's trade path, and the exact final
// fill goes out with graduate as one transaction (the graduate instruction built from the stack's own launch IDL). Then
// the coin page shows the graduated coin, trading continues on the open pool, and the creator claims in SOL. The marker
// never appears on the page. Isolated SBF bank; synthetic keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { VersionedMessage } from '@solana/web3.js'
import { appModule, html } from './fixtures/render-jsx.mjs'
import { ownStackWorld, openLaunch, siteTrade, siteMarket, coinsHeld, TRADE_LIMITS, TRADERS } from './fixtures/hooklab-own-stack-world.mjs'
import { INDEPENDENT_SKIP } from './fixtures/hooklab-own-stack.mjs'
import { finalFillLamports } from '../src/hooklab-graduation.mjs'
import { maxBuyLamports } from '../app/lib/hooklab-trade-math.mjs'
import { nativeClaimResolver } from '../src/hooklab-native-claim-resolver.mjs'

const skip = INDEPENDENT_SKIP || (process.env.HOOKLAB_CANARY_REQUIRED !== 'true' && !process.env.HOOKLAB_CANARY_PYTHONPATH && 'the isolated SVM runner (HOOKLAB_CANARY_PYTHONPATH) is not available')
const RUNTIME = Symbol.for('repo.ing.hooklab.inclusive-trade-runtime')
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

test('a coin of our stack graduates through the site: coin page, capped buys, the exact final fill with graduate, then open trading and a claim', { skip, timeout: 600000 }, async t => {
  // The owner's menus (at most 5% per wallet), so many capped wallets finish the curve; a 1 SOL opening virtual quote.
  const w = await ownStackWorld({ build: 'independent', rentPerByte: 5080 }); t.after(w.close)
  const profile = JSON.parse(w.bindings.profile.json)
  const launch = await openLaunch(w, { creatorFeeBps: 100, capBps: 500, name: 'Grad Cat', symbol: 'GRAD', virtualQuote: '1000000000', creator: w.runnerKey('creator') })
  const { settle } = await launch.send(); assert.equal((await settle()).status, 'finalized-success')
  const coin = { ...launch, creatorFeeBps: 100, capBps: 500 }, mint = launch.mint.publicKey.toBase58()
  const record = { id: '4f6b1c2a-1e2d-4c3b-9a8f-7e6d5c4b3a21', name: 'Grad Cat', symbol: 'GRAD', creator: w.roles.creator, profile: null, stack: 'own', moderation: { delisted: false } }

  // The coin page through the site's runtime: its market read is the stack's own (the coin record says which stack).
  const { default: Token } = await appModule('app/(site)/hooks/token/[mint]/page.jsx')
  const page = async () => {
    globalThis[RUNTIME] = { market: async (requested, wallet, given) => requested === mint && (given ?? record).stack === 'own' ? siteMarket(w, mint, wallet) : null,
      coinProfile: async requested => requested === mint ? record : null }
    try { return html(await Token({ params: Promise.resolve({ mint }) }), { wallet: true }) } finally { delete globalThis[RUNTIME] }
  }
  const before = await page()
  assert.match(before, /\$GRAD/); assert.doesNotMatch(before, new RegExp(profile.quoteMint)); assert.doesNotMatch(text(before), /Add SOL|Withdraw|quote token|bridged/i)
  assert.doesNotMatch(text(before), /Lifted at graduation/)

  // Capped buys up to the curve's end, each through the site's trade path, until one wallet's largest buy is the exact fill.
  let last = null, fill = null, wallets = 0
  for (const role of TRADERS) {
    const trader = w.roles[role]
    for (;;) {
      const { market } = await siteMarket(w, mint), max = maxBuyLamports(market, await coinsHeld(w, mint, trader)); fill = finalFillLamports(market)
      if (max === null) break   // this wallet sits at its max per wallet: the next one buys
      if (max === fill) { last = trader; break }
      await siteTrade(w, coin, { owner: trader, side: 'buy', amountIn: max * 98n / 100n })
    }
    wallets++
    if (last) break
  }
  assert.ok(last && fill > 0n, 'a wallet can finish the curve'); t.diagnostic(`${wallets} capped wallets reached the curve's end; the final fill is ${fill} lamports`)

  // The exact final fill and graduate, as ONE transaction the trader alone approves.
  const graduation = await siteTrade(w, coin, { owner: last, side: 'buy', amountIn: fill, graduate: true })
  const message = VersionedMessage.deserialize(Buffer.from(graduation.prepared.review.messageBase64, 'base64')), keys = message.staticAccountKeys.map(k => k.toBase58())
  const programs = message.compiledInstructions.map(ix => keys[ix.programIdIndex])
  assert.deepEqual(programs.slice(-2), [profile.programs.swap, profile.programs.launch], 'swap_v2 buy of the exact fill, then graduate, on our stack')
  const { market: after } = await siteMarket(w, mint)
  assert.equal(after.graduated, true)
  const graduated = await page()
  assert.match(text(graduated), /Lifted at graduation/); assert.doesNotMatch(graduated, new RegExp(profile.quoteMint))

  // After graduation: the open pool trades with no max per wallet, and the creator claims its fees in SOL.
  const held = await coinsHeld(w, mint, last)
  await siteTrade(w, coin, { owner: last, side: 'sell', amountIn: held / 10n })
  assert.equal(await coinsHeld(w, mint, last), held - held / 10n)
  const claims = nativeClaimResolver({ ...w.bindings, connections: w.connections(), limits: TRADE_LIMITS, clock: () => 1000 })
  const prepared = await claims.prepare({ owner: w.roles.creator, stage: 'native-claim', intent: { mint } })
  const sent = await w.send(prepared.review.messageBase64); assert.equal(sent.error, null, (sent.logs ?? []).slice(-6).join('\n'))
  assert.equal((await claims.reconcile({ review: prepared.review, configurationSha256: prepared.configurationSha256, settlementContext: prepared.settlementContext,
    signedTransactionBase64: sent.wireBase64, signature: sent.signature })).status, 'finalized-success')
})
