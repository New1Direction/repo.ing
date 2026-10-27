import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { inclusiveCreatorFee, modelInclusiveCreatorQuote } from '../src/hooklab-inclusive-fee-quote.mjs'
import { inclusiveEconomicsHash, inclusiveHookAccountsHash, inclusiveFeePolicyAddress, inclusiveMaxWalletPolicyAddress, inclusivePolicyMeta, readInclusiveFeePolicy } from '../src/hooklab-inclusive-fee-abi.mjs'
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const sha = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest()
function input() { return { side: 'buy', amountIn: 10000n, minAmountOut: 1n, maxInput: 10000n, creatorFeeBps: 100,
  feeModel: 2, protocolShareBps: 2500, lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0,
  quoteHook: 'none', modules: 0, authorShareBps: 0, rules: 'none', rewards: false, recipientBaseBalance: 0n,
  pool: { baseReserve: 1000000n, quoteReserve: 1000000n, virtualBase: 0n, virtualQuote: 0n, protocolFeesQuote: 7n },
  policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps: 100, lpFeeBps: 0, initialSupply: 10000000n, capBps: 100 } } }
test('ceil gross, floor platform, residual creator, including tiny fee suppression', () => {
  assert.deepEqual(inclusiveCreatorFee(10001n, 100), { grossQuote: 101n, platformQuote: 25n, creatorQuote: 76n })
  for (let basis = 0n; basis < 10n; basis++) for (const rate of [0, 1, 2500, 9999]) {
    const f = inclusiveCreatorFee(basis, rate)
    assert.equal(f.platformQuote + f.creatorQuote, f.grossQuote)
    assert.equal(f.platformQuote, f.grossQuote / 4n)
    assert.ok(f.grossQuote === 0n || f.grossQuote < basis)
  }
  assert.deepEqual(inclusiveCreatorFee(1n, 9999), { grossQuote: 0n, platformQuote: 0n, creatorQuote: 0n })
  assert.throws(() => inclusiveCreatorFee(1n, 10000))
})
test('buy gross budget is inclusive and vault reserve/accrual conserved', () => {
  const q = modelInclusiveCreatorQuote(input())
  assert.equal(q.curveInput, 9900n); assert.equal(q.delivered, 9802n)
  assert.equal(q.fees.grossQuote, 100n); assert.equal(q.fees.platformQuote, 25n); assert.equal(q.fees.creatorQuote, 75n)
  assert.equal(q.quoteVaultDelta, 9925n)
  assert.equal(q.after.quoteReserve, 1009900n); assert.equal(q.after.protocolFeesQuote, 32n)
  assert.equal(q.after.quoteReserve + q.after.protocolFeesQuote, 1000007n + q.quoteVaultDelta)
  assert.equal(q.canSign, false); assert.equal(q.sbfValidated, false)
})
test('sell takes gross fee from gross curve output exactly once', () => {
  const i = input(); i.side = 'sell'; const q = modelInclusiveCreatorQuote(i)
  assert.equal(q.grossOutput, 9900n); assert.equal(q.fees.grossQuote, 99n)
  assert.equal(q.fees.platformQuote, 24n); assert.equal(q.fees.creatorQuote, 75n); assert.equal(q.delivered, 9801n)
  assert.equal(q.quoteVaultDelta, -9876n)
  assert.equal(q.after.quoteReserve + q.after.protocolFeesQuote, 1000007n + q.quoteVaultDelta)
})
test('exact fee binding, unsupported modes, min-output, cap and overflow fail closed', () => {
  for (const [k, v] of [['feeModel', 1], ['protocolShareBps', 0], ['lpFeeBps', 1], ['flatProtocolFeeBps', 1], ['sniperWindowSecs', 1], ['quoteHook', 'custom'], ['modules', 1], ['rules', 'kit'], ['rewards', true]]) {
    assert.throws(() => modelInclusiveCreatorQuote({ ...input(), [k]: v }))
  }
  for (const [k, v] of [['version', 1], ['creatorFeeBps', 101], ['feeModel', 1], ['protocolShareBps', 2501]]) {
    const i = input(); i.policy[k] = v; assert.throws(() => modelInclusiveCreatorQuote(i), /POLICY_FEE_MISMATCH/)
  }
  assert.throws(() => modelInclusiveCreatorQuote({ ...input(), minAmountOut: 9803n }), /MIN_OUTPUT/)
  assert.throws(() => modelInclusiveCreatorQuote({ ...input(), recipientBaseBalance: 99999n }), /MAX_WALLET/)
  const i = input(); i.pool.protocolFeesQuote = (1n << 64n) - 1n; assert.throws(() => modelInclusiveCreatorQuote(i), /INVALID_U64/)
})
test('separate V3 domains commit exact model/share and Borsh bytes', () => {
  const v2 = Buffer.alloc(32, 4)
  const expected = sha(Buffer.from('hook-lab:create-pool-economics:v3'), v2, Buffer.from([2, 196, 9]))
  assert.deepEqual(inclusiveEconomicsHash('pool', v2), expected)
  assert.notDeepEqual(inclusiveEconomicsHash('launch', v2), expected)
  const row = { program: key(1), registry: { address: key(2), owner: key(3), data: Buffer.from([10, 11]) },
    policy: { address: key(4), owner: key(5), data: Buffer.alloc(90, 12) }, launch: { address: key(6), owner: key(7) } }
  const expectedHook = sha(Buffer.from('hook-lab:inclusive-hook-accounts:v3'), ...[1, 2, 3].map(n => Buffer.alloc(32, n)),
    Buffer.from([2, 0, 0, 0, 10, 11]), Buffer.alloc(32, 4), Buffer.alloc(32, 5), Buffer.from([90, 0, 0, 0]), Buffer.alloc(90, 12),
    Buffer.alloc(32, 6), Buffer.alloc(32, 7), Buffer.from([2, 196, 9]))
  assert.deepEqual(inclusiveHookAccountsHash(row), expectedHook)
  row.policy.data[89] ^= 1; assert.notDeepEqual(inclusiveHookAccountsHash(row), expectedHook)
})
test('immutable collector exact layout/PDA and final account privilege helper', () => {
  const swap = key(1), pool = key(2), collector = key(3), data = Buffer.concat([
    sha(Buffer.from('account:InclusiveFeePolicy')).subarray(0, 8), Buffer.from([1]), Buffer.alloc(32, 2), Buffer.alloc(32, 3), Buffer.from([196, 9])])
  const a = { address: inclusiveFeePolicyAddress(swap, pool), owner: swap, executable: false, signer: false, writable: false, data }
  assert.equal(data.length, 75); assert.equal(readInclusiveFeePolicy(a, swap, pool).collector, collector)
  assert.throws(() => readInclusiveFeePolicy({ ...a, writable: true }, swap, pool))
  assert.throws(() => readInclusiveFeePolicy({ ...a, data: data.subarray(0, 74) }, swap, pool))
  assert.throws(() => readInclusiveFeePolicy({ ...a, address: pool }, swap, pool))
  assert.equal(inclusivePolicyMeta(swap, pool, 'create').writable, true)
  assert.equal(inclusivePolicyMeta(swap, pool, 'swap').writable, false)
  assert.equal(inclusivePolicyMeta(swap, pool, 'collect').writable, false)
  assert.notEqual(inclusiveMaxWalletPolicyAddress(swap, pool), PublicKey.findProgramAddressSync([Buffer.from('policy'), Buffer.alloc(32, 2)], new PublicKey(swap))[0].toBase58())
})

// Token burn (owner 2026-10-27): mirrors bordrless-core trade_burn (rounded down, none unless below the amount) at the
// DEX's order: a buy burns from the curve's output before delivery; a sell burns from its input before the curve.
const burn = bps => ({ burnBuyBps: bps, burnSellBps: bps })
test('a buy burns its share of the coins the curve gives out, before delivery; max wallet counts what is delivered', () => {
  const q = modelInclusiveCreatorQuote({ ...input(), rules: burn(500) })
  assert.deepEqual([q.curveInput, q.grossOutput, q.burned, q.delivered], [9900n, 9802n, 490n, 9312n])
  assert.equal(q.fees.grossQuote, 100n)
  assert.equal(q.after.baseReserve, 1000000n - 9802n, 'the burned coins leave the vault and are destroyed')
  assert.equal(q.recipientBaseAfter, 9312n)
  // The cap applies to what the buyer receives: 100,000 cap, so a buyer already at 90,700 can take 9,300 more but not 9,312.
  assert.throws(() => modelInclusiveCreatorQuote({ ...input(), rules: burn(500), recipientBaseBalance: 90700n }), /MAX_WALLET/)
  assert.equal(modelInclusiveCreatorQuote({ ...input(), rules: burn(500), recipientBaseBalance: 90688n }).recipientBaseAfter, 100000n)
  // Minimum received is checked against the coins delivered after the burn.
  assert.throws(() => modelInclusiveCreatorQuote({ ...input(), rules: burn(500), minAmountOut: 9313n }), /MIN_OUTPUT/)
})
test('a sell burns its share of the coins sold before the curve; the creator fee comes from the SOL out', () => {
  const q = modelInclusiveCreatorQuote({ ...input(), side: 'sell', rules: burn(500) })
  assert.deepEqual([q.burned, q.curveInput, q.grossOutput, q.fees.grossQuote, q.delivered], [500n, 9500n, 9410n, 95n, 9315n])
  assert.deepEqual([q.after.baseReserve, q.after.quoteReserve], [1000000n + 9500n, 1000000n - 9410n], 'the burned coins never reach the pool')
})
test('a burn rounds down and is dropped when it is not below the amount; no burn is the old quote exactly', () => {
  assert.equal(modelInclusiveCreatorQuote({ ...input(), side: 'sell', amountIn: 19n, rules: burn(500) }).burned, 0n)
  assert.equal(modelInclusiveCreatorQuote({ ...input(), side: 'sell', amountIn: 20n, rules: burn(500) }).burned, 1n)
  const none = modelInclusiveCreatorQuote(input()), zero = modelInclusiveCreatorQuote({ ...input(), rules: burn(0) })
  assert.deepEqual({ ...zero, burned: undefined }, { ...none, burned: undefined })
  assert.equal(none.burned, 0n)
  for (const bad of [{ burnBuyBps: 600, burnSellBps: 500 }, { burnBuyBps: 1001, burnSellBps: 1001 }, { burnBuyBps: 1.5, burnSellBps: 1.5 },
    { burnBuyBps: 100, burnSellBps: 100, holderFeeBuyBps: 1 }]) assert.throws(() => modelInclusiveCreatorQuote({ ...input(), rules: bad }), /UNSUPPORTED_INCLUSIVE_ECONOMICS/)
  // The combined ceiling: creator + burn is at most 10% on each side.
  assert.throws(() => modelInclusiveCreatorQuote({ ...input(), creatorFeeBps: 500, policy: { ...input().policy, creatorFeeBps: 500 }, rules: burn(501) }), /UNSUPPORTED_INCLUSIVE_ECONOMICS/)
})
