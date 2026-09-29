import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, Transaction, SystemProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { estimateTradeCosts, preflightTrade } from '../src/trade-costs.mjs'
import { validateBuyPresets } from '../app/lib/buy-presets.mjs'
import { graduationShare, payoutShare } from '../src/market-share.mjs'
import { graduationProgress } from '../src/graduation-state.mjs'

const payer = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
function trade(direction = 'buy') {
  const tx = new Transaction({ feePayer: payer, recentBlockhash: Keypair.generate().publicKey.toBase58() })
  for (const token of [mint, NATIVE_MINT]) tx.add(createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(token, payer), payer, token))
  tx.add(createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, payer), payer, payer))
  return { transaction: tx, direction, amountIn: 10000000n }
}
const rpc = overrides => ({ getBalance: async () => 100000000,
  getFeeForMessage: async () => ({ value: 5000 }), getMinimumBalanceForRentExemption: async () => 2039280,
  getMultipleAccountsInfo: async () => [null, null], ...overrides })

test('buy costs include rent up front, separate refundable wrap rent, never add the included trading fee again', async () => {
  assert.deepEqual(await estimateTradeCosts(rpc(), trade()), { networkFee: '5000', priorityFee: '0', accountDeposits: '2039280', refundableDeposit: '2039280',
    total: '12044280', required: '14083560', balance: '100000000', shortfall: '0' })
})
test('existing ATAs cost zero setup; prefunded empty accounts only require the rent shortfall', async () => {
  const costs = await estimateTradeCosts(rpc({ getMultipleAccountsInfo: async () => [{ owner: TOKEN_PROGRAM_ID, lamports: 2039280 }, { owner: SystemProgram.programId, lamports: 1000000 }] }), trade())
  assert.equal(costs.accountDeposits, '0'); assert.equal(costs.refundableDeposit, '1039280'); assert.equal(costs.required, '11044280')
})
test('sells still need SOL up front; future sale proceeds cannot pay pre-swap costs', async () => {
  const costs = await estimateTradeCosts(rpc({ getBalance: async () => 0, getMultipleAccountsInfo: async () => [{ owner: TOKEN_PROGRAM_ID }, null] }), trade('sell'))
  assert.equal(costs.total, '5000'); assert.equal(costs.shortfall, '2044280')
  await assert.rejects(preflightTrade({}, trade('sell'), costs), /0.002045 more SOL/)
})
test('unavailable fees, unsafe RPC amounts, unknown account programs and failed simulations fail closed', async () => {
  await assert.rejects(estimateTradeCosts(rpc({ getFeeForMessage: async () => ({ value: null }) }), trade()), /unavailable/)
  await assert.rejects(estimateTradeCosts(rpc({ getBalance: async () => Number.MAX_SAFE_INTEGER + 1 }), trade()), /unavailable/)
  const other = trade(); other.transaction.instructions[0].keys[5].pubkey = TOKEN_2022_PROGRAM_ID
  await assert.rejects(estimateTradeCosts(rpc(), other), /setup estimate unavailable/)
  await assert.rejects(preflightTrade({ simulateTransaction: async () => ({ value: { err: 'Slippage' } }) }, trade(), { shortfall: '0' }), /simulation did not pass/)
})
test('preflight simulates the unsigned exact message and never broadcasts', async () => {
  const prepared = trade(); let called = false
  await preflightTrade({ simulateTransaction: async (tx, options) => {
    called = true; assert.deepEqual(Buffer.from(tx.message.serialize()), prepared.transaction.serializeMessage())
    assert.equal(options.sigVerify, false); return { value: { err: null } }
  } }, prepared, { shortfall: '0' }); assert.equal(called, true)
})
test('presets normalize decimal amounts and reject corrupt storage, zero, negative, duplicate and overprecision values', () => {
  assert.deepEqual(validateBuyPresets(['0.0100', ' 1 ', '2.500']), ['0.01', '1', '2.5'])
  for (const value of [null, ['1'], ['0','1','2'], ['-1','1','2'], ['.5','1','2'], ['0.1','0.10','2'], ['0.0000000001','1','2'], ['NaN','1','2'], ['18446744074','1','2']]) assert.throws(() => validateBuyPresets(value))
})
const market = { repoId: '998887', mint: mint.toBase58(), pool: payer.toBase58(), fullName: 'local/preview', symbol: 'LOCAL' }
function observation(changes = {}) {
  const now = new Date().toISOString()
  return { status: 'VERIFIED', reconciliation: JSON.stringify({ status: 'MATCH' }), observation: JSON.stringify({
    ...graduationProgress('26754064634', '85000000000'), checkedAt: now, chainTime: now,
    repoId: market.repoId, mint: market.mint, curve: market.pool, ...changes }) }
}
test('graduation cards use exact canonical reserve/target and timestamp, reject stale/wrong/mismatched evidence', () => {
  const card = graduationShare(market, observation()); assert.equal(card.metric, '31.47%'); assert.match(card.caption, /26.7540? \/ 85 SOL/)
  for (const changes of [{ mint: payer.toBase58() }, { repoId: '1' }, { curve: 'other' }, { remainingLamports: '0' }, { thresholdLamports: '0' }, { chainTime: '2020-01-01' }, { status: 'migrating' }]) assert.throws(() => graduationShare(market, observation(changes)))
  assert.throws(() => graduationShare(market, { ...observation(), reconciliation: '{"status":"MISMATCH"}' }))
})
test('payout card requires a settled claim AND matching proven amount, signature and canonical repo', () => {
  const row = { status: 'settled', settledAt: new Date(), repoId: market.repoId, claimSignature: 'verified', amountBaseUnits: '123456789' }
  const proof = { status: 'settled', signature: 'verified', amountBaseUnits: 123456789n }
  assert.equal(payoutShare(market, row, proof).metric, '≈ 0.1235 SOL')
  assert.match(payoutShare(market, row, proof).caption, /0.123456789 SOL/)
  assert.equal(payoutShare(market, { ...row, amountBaseUnits: '1' }, { ...proof, amountBaseUnits: 1n }).metric, '<0.0001 SOL')
  for (const r of [{ ...row, status: 'pending' }, { ...row, repoId: '1' }, { ...row, amountBaseUnits: '0' }]) assert.throws(() => payoutShare(market, r, proof))
  for (const p of [null, { ...proof, amountBaseUnits: 1n }, { ...proof, signature: 'wrong' }, { ...proof, status: 'aborted' }]) assert.throws(() => payoutShare(market, row, p))
})
