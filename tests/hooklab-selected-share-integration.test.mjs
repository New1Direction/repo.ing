import test from 'node:test'
import assert from 'node:assert/strict'
import { selectedNativeMeasuredQuote } from '../src/hooklab-native-swap.mjs'
import { compileNativeSwapReview } from '../src/hooklab-native-swap.mjs'
import { compileSelectedHookLaunchReview } from '../src/hooklab-max-wallet-launch.mjs'
import { deriveOpenLaunchPostconditions } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { selectedLaunchFixture } from './fixtures/selected-hook-launch.mjs'
import { selectedNativeTradeFixture } from './fixtures/selected-native-trade.mjs'
import { key, pk } from './fixtures/selected-hook-preparation.mjs'

// Expected amounts were independently checked against the pinned Bordrless Rust core.
// A model-2 implementation deducts protocol from creator fees and fails these values.
test('selected model-1 buy retains the full creator fee and accrues additional share on real token deductions', () => {
  const request = { side: 'buy', amountIn: '10003', maxInput: '10003', minAmountOut: '28998', creatorFeeBps: 137, feeModel: 1, protocolShareBps: 3333 }
  const pool = { baseReserve: 50003n, quoteReserve: 7001n, virtualBase: 211n, virtualQuote: 101n, protocolFeesQuote: 9n }
  const q = selectedNativeMeasuredQuote(request, pool, { vault: '-29026', trader: '28998' }, { baseVault: 'vault', traderBase: 'trader' }, { lpFeeBps: 31, quoteCutBps: 43, burnOut: 11n })
  assert.equal(q.fees.creatorQuote, 138n)
  assert.equal(q.fees.platformQuote, 94n)
  assert.equal(q.delivered, 28998n)
  assert.deepEqual(q.after, { baseReserve: 20977n, quoteReserve: 16729n, protocolFeesQuote: 103n })
})

test('selected model-1 sale prices measured vault credit and accounts separately for burn, tax, creator and protocol', () => {
  const request = { side: 'sell', amountIn: '1237', maxInput: '1237', minAmountOut: '158', creatorFeeBps: 137, feeModel: 1, protocolShareBps: 3333 }
  const pool = { baseReserve: 50003n, quoteReserve: 7001n, virtualBase: 211n, virtualQuote: 101n, protocolFeesQuote: 9n }
  const q = selectedNativeMeasuredQuote(request, pool, { vault: '1195', trader: '-1237' }, { baseVault: 'vault', traderBase: 'trader' }, { lpFeeBps: 31, quoteCutBps: 43, burnIn: 19n })
  assert.equal(q.fees.creatorQuote, 3n)
  assert.equal(q.fees.platformQuote, 4n)
  assert.equal(q.delivered, 158n)
  assert.deepEqual(q.after, { baseReserve: 51198n, quoteReserve: 6836n, protocolFeesQuote: 13n })
  assert.throws(() => selectedNativeMeasuredQuote(request, pool, { vault: '1219', trader: '-1237' }, { baseVault: 'vault', traderBase: 'trader' }, { burnIn: 19n }), /input|deduction|tax/i)
})

test('selected launch binds share model 1 in the message, account commitment and settlement, without an inclusive fee policy', () => {
  const { input, coders } = selectedLaunchFixture({ feeModel: 1 })
  const plan = compileSelectedHookLaunchReview(input)
  const instruction = coders.launch.instruction.decode(Buffer.from(plan.canonicalInstruction.dataHex, 'hex'))
  assert.equal(instruction.data.fee_model, 1)
  assert.equal(plan.feeModel, 1)
  const post = deriveOpenLaunchPostconditions({ schema: 'repoing/open-launch-settlement-context/1', compilationInput: input }, { slot: 110, timestamp: 1000 })
  const pool = coders.swap.accounts.decode('Pool', Buffer.from(post.accounts.find(a => a.address === plan.addresses.pool).dataBase64, 'base64'))
  assert.equal(pool.fee_model, 1)
  assert.ok(!post.created.includes(plan.addresses.inclusiveFeePolicy))
})

for (const side of ['buy', 'sell']) test(`selected model-1 ${side} compiles without an inclusive policy and retains the full creator cut`, () => {
  const { input, a } = selectedNativeTradeFixture(side, { feeModel: 1 })
  const plan = compileNativeSwapReview(input)
  assert.equal(plan.quote.feeModel, 1)
  assert.equal(plan.quote.grossCreatorFee, plan.quote.netCreatorFee)
  assert.ok(BigInt(plan.quote.protocolFee) > 0n)
  assert.ok(!plan.review.accounts.some(x => x.address === a.inclusiveFeePolicy))
  assert.equal(plan.lamportDeltas[a.launch], plan.quote.netCreatorFee)
  assert.equal(BigInt(plan.lamportDeltas[a.pool]) + BigInt(plan.lamportDeltas[a.launch]) + BigInt(plan.lamportDeltas[input.request.trader]), -5000n)
})

test('a listed selected config preserves author economics and pool burn separately from transfer tax', () => {
  const f = selectedNativeTradeFixture('buy', { feeModel: 1 })
  for (const [name, address] of [['LaunchConfig', f.request.selectedConfig], ['Launch', f.a.launch]]) {
    const row = f.accounts.get(address), bytes = Buffer.from(row.dataBase64, 'base64'), state = f.coders.launch.accounts.decode(name, bytes)
    state.rules.burn_buy_bps = 317; state.author_share_bps = 1733
    if (name === 'LaunchConfig') state.creator = pk(key(97))
    f.coders.launch.types.encode(name, state).copy(bytes, 8); row.dataBase64 = bytes.toString('base64')
  }
  f.input.request.minAmountOut = '17104'
  const plan = compileNativeSwapReview({ ...f.input, selectedTokenDeltas: { [f.a.baseVault]: '-17716', [f.a.traderBase]: '17104', [f.taxHolding]: '51' } })
  assert.equal(plan.quote.delivered, '17104')
  assert.equal(plan.quote.burnedToken, '561')
  assert.equal(plan.quote.hookTokenFee, '51')
  assert.equal(plan.quote.netCreatorFee, '1')
  assert.equal(plan.quote.protocolFee, '2')
  assert.equal(plan.quote.authorShareBps, 1733)
  assert.ok(plan.review.accounts.find(x => x.address === f.request.mint).writable)
})
