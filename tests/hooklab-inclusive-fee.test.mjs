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
