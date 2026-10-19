// An emergency creation pause or a launch policy change must never trap holders. On the reviewed native ELFs in one
// isolated bank (tests/fixtures/hooklab-native-world.mjs): after the guardian pauses creation (launch Config.paused, the
// launch governance gate and revision) and the admin changes the launch fee (launch Config economics and the governance
// digest), the server still reviews, the chain executes and settlement verifies native buys, sales and the graduating
// buy, and bridged buys, with the bindings unchanged (no bundle redeploy). A swap trading pause refuses new trade reviews
// before anything is signed. The swap_v2 hooks, graduate and the creator claim never take the launch Config or launch
// governance as accounts, so trading cannot depend on them on chain either.
import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { nativeTradeResolver } from '../src/hooklab-native-trade-resolver.mjs'
import { inclusiveTradeResolver } from '../src/hooklab-inclusive-trade-resolver.mjs'
import { finalFillLamports } from '../src/hooklab-graduation.mjs'
import { canaryCommitment } from '../src/hooklab-canary-policy.mjs'
import { launchConfigArgs } from '../src/hooklab-owner-driver/instructions.mjs'
import { maxBuyLamports } from '../app/lib/hooklab-trade-math.mjs'
import { nativeWorld, NATIVE_SKIP } from './fixtures/hooklab-native-world.mjs'
import { jsonbRoundTrip } from './fixtures/jsonb-round-trip.mjs'

const LIMITS = { maxAgeMs: 5000, maxSlotLag: 5, validUntilSlot: 0, reviewExpiresAtMs: 0, maxNetworkFeeLamports: '10000', maxTotalDebitLamports: '10000', computeUnitLimit: 1400000, computeUnitPriceMicroLamports: '0' }
const BOOT = 1800000000000, CAP_BPS = 5000, SUPPLY = 1000000000000000n
const store = p => jsonbRoundTrip({ review: p.review, configurationSha256: p.configurationSha256, settlementContext: p.settlementContext })

// The launch-side changes: the guardian's emergency creation pause, then the admin's launch fee change.
async function pauseCreationAndChangeLaunchFee(w) {
  const { roles, addresses: a } = w, commitment = () => [...Buffer.from(canaryCommitment(w.state.bindings.launch, w.decoded('launch', 'Governance', a.launchGovernance).state), 'hex')]
  await w.sync([a.launchConfig, a.launchGovernance])
  const paused = await w.send(await w.compile(roles.guardian, [w.state.instruction('launch', 'governance_action', { expected: commitment(), action: { Pause: [{ creation: true, trading: false }] } }, { authority: roles.guardian })]))
  assert.equal(paused.error, null, `pause: ${paused.logs?.slice(-4).join(' | ')}`)
  await w.sync([a.launchConfig, a.launchGovernance])
  const config = w.decoded('launch', 'Config', a.launchConfig)
  const fee = await w.send(await w.compile(roles.admin, [w.state.instruction('launch', 'governed_set_config',
    { expected: commitment(), args: launchConfigArgs({ ...config, launch_fee_lamports: new BN(12345) }) }, { authority: roles.admin })]))
  assert.equal(fee.error, null, `launch fee: ${fee.logs?.slice(-4).join(' | ')}`)
  await w.sync([a.launchConfig, a.launchGovernance])
  const after = w.decoded('launch', 'Config', a.launchConfig), gov = w.decoded('launch', 'Governance', a.launchGovernance)
  assert.equal(after.paused, true); assert.equal(gov.state.gates.creation, true); assert.equal(after.launch_fee_lamports.toString(), '12345')
}
async function closeTrading(w) {
  const { roles, addresses: a } = w
  await w.sync([a.swapConfig, a.swapGovernance])
  const expected = [...Buffer.from(canaryCommitment(w.state.bindings.swap, w.decoded('swap', 'Governance', a.swapGovernance).state), 'hex')]
  const closed = await w.send(await w.compile(roles.admin, [w.state.instruction('swap', 'governance_action', { expected, action: { SetGates: [{ creation: false, trading: true }] } }, { authority: roles.admin })]))
  assert.equal(closed.error, null, `close trading: ${closed.logs?.slice(-4).join(' | ')}`)
  await w.sync([a.swapConfig]); assert.equal(w.decoded('swap', 'Config', a.swapConfig).paused, true)
}

test('native coin: after a creation pause and a launch fee change, buys, sales and the graduating buy still review and settle; a swap pause refuses', { skip: NATIVE_SKIP, timeout: 600000 }, async t => {
  const w = await nativeWorld({ capBps: CAP_BPS }); t.after(w.close)
  const { roles, addresses: a } = w
  const resolver = () => nativeTradeResolver({ ...w.bindings, connections: w.connections(), limits: { ...LIMITS, nowMs: BOOT }, clock: () => 1000 })
  const intent = async (owner, side, amount, extra = {}) => ({ side, creatorFeeBps: 100, capBps: CAP_BPS, mint: roles.mint, selectedConfig: roles.config, amountIn: String(amount),
    minAmountOut: await w.minimumOut(side, amount, owner), maxInput: String(amount), maxPriceImpactBps: 1000, graduate: false, ...extra })
  const coins = async owner => { const h = w.holdingOf(roles.mint, owner); await w.sync([h]); const v = w.state.accounts.get(h); return v ? Buffer.from(v.dataBase64, 'base64').readBigUInt64LE(74) : 0n }
  const market = async () => { await w.sync([a.pool, a.launch]); const p = w.decoded('swap', 'Pool', a.pool), l = w.decoded('launch', 'Launch', a.launch)
    return { graduated: l.status === 1, graduationQuote: l.graduation_quote.toString(), creatorFeeBps: 100, capBps: CAP_BPS, initialSupply: String(SUPPLY),
      pool: { baseReserve: p.base_reserve.toString(), quoteReserve: p.quote_reserve.toString(), virtualBase: p.virtual_base.toString(), virtualQuote: p.virtual_quote.toString(), protocolFeesQuote: p.protocol_fees_quote.toString() } } }
  async function trade(owner, side, amount, extra = {}) {
    const prepared = await resolver().prepare({ owner, stage: `native-${side}`, intent: await intent(owner, side, amount, extra) }), stored = store(prepared)
    const sent = await w.send(prepared.review.messageBase64); assert.equal(sent.error, null, JSON.stringify(sent.logs?.slice(-6)))
    const settled = await resolver().reconcile({ ...stored, signedTransactionBase64: sent.wireBase64, signature: sent.signature })
    assert.equal(settled.status, 'finalized-success'); return settled
  }

  await trade(roles.creator, 'buy', 1000003)
  await pauseCreationAndChangeLaunchFee(w)
  await t.test('a sale and a buy still review, execute and settle exactly', async () => {
    const sale = await trade(roles.creator, 'sell', (await coins(roles.creator)) / 3n)
    assert.equal(sale.quote.netCreatorFee, String(BigInt(sale.quote.grossCreatorFee) - BigInt(sale.quote.grossCreatorFee) / 4n))
    await trade(roles.buyer, 'buy', 3000003)
  })
  await t.test('capped buys to the curve’s end, then the graduating buy, still settle', async () => {
    let fill, last
    for (let trader = roles.creator, i = 0; i < 40; i++) {
      const m = await market(), max = maxBuyLamports(m, await coins(trader)); fill = finalFillLamports(m)
      if (max === null) { assert.equal(trader, roles.creator); trader = roles.buyer; continue }
      if (max === fill) { last = trader; break }
      await trade(trader, 'buy', max * 98n / 100n)
    }
    assert.ok(fill && last, 'a wallet can finish the curve')
    const graduated = await trade(last, 'buy', fill, { graduate: true })
    assert.equal(graduated.graduated, true)
    await trade(roles.outsider, 'buy', 5000003)
  })
  await t.test('a swap trading pause refuses a new trade review before anything is signed', async () => {
    await closeTrading(w)
    await assert.rejects(resolver().prepare({ owner: roles.buyer, stage: 'native-sell', intent: await intent(roles.buyer, 'sell', 1000) }))
  })
})

test('bridged coin: after a creation pause and a launch fee change, a bridged buy still reviews, executes and settles', { skip: NATIVE_SKIP, timeout: 600000 }, async t => {
  const w = await nativeWorld({ coin: 'bridged' }); t.after(w.close)
  const { roles, state, svm } = w, profile = JSON.parse(state.profile.json)
  const holdings = [state.holding(roles.mint, roles.creator, 0), state.holding(profile.quoteMint, roles.creator, 10000000)]
  await svm.call('set', { accounts: holdings.map(address => ({ address, account: state.accounts.get(address) })) }); await w.sync()
  await pauseCreationAndChangeLaunchFee(w)
  const resolver = () => inclusiveTradeResolver({ ...w.bindings, connections: w.connections(), limits: { ...LIMITS, nowMs: BOOT }, clock: () => 1000 })
  const prepared = await resolver().prepare({ owner: roles.creator, stage: 'inclusive-buy', intent: { side: 'buy', creatorFeeBps: 100, capBps: 5000, mint: roles.mint,
    selectedConfig: roles.config, amountIn: '1000200', minAmountOut: '1', maxInput: '1000200', maxPriceImpactBps: 1000 } })
  const sent = await w.send(prepared.review.messageBase64); assert.equal(sent.error, null, JSON.stringify(sent.logs?.slice(-6)))
  const settled = await resolver().reconcile({ ...store(prepared), signedTransactionBase64: sent.wireBase64, signature: sent.signature })
  assert.equal(settled.status, 'finalized-success')
})
