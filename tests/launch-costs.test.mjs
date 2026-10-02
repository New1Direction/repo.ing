import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js'
import { estimateLaunchCosts, launchCostBreakdown } from '../src/launch-costs.mjs'

test('launch costs separate buy, net account deposits and fee without double counting trading fees', () => {
  assert.deepEqual(launchCostBreakdown({ balance: 100_000_000, after: 69_985_000,
    networkFee: 15_000, signatures: 3, initialBuyLamports: '10000000' }), {
    balance: '100000000', initialBuy: '10000000', networkFee: '15000', priorityFee: '0', accountDeposits: '20000000', total: '30015000',
  })
  assert.equal(launchCostBreakdown({ balance: 100_000_000, after: 79_985_000,
    networkFee: 15_000, signatures: 3, initialBuyLamports: '0' }).accountDeposits, '20000000')
})

test('the priority fee is part of the network-fee line and the total, never of the deposits', () => {
  // 3 signatures (15,000) + 205,000 CU × 200,000 microlamports (41,000): the wallet is debited 30,056,000 in all.
  const costs = launchCostBreakdown({ balance: 100_000_000, after: 69_944_000, networkFee: 56_000, priorityFee: '41000',
    signatures: 3, initialBuyLamports: '10000000' })
  assert.deepEqual(costs, { balance: '100000000', initialBuy: '10000000', networkFee: '56000', priorityFee: '41000',
    accountDeposits: '20000000', total: '30056000' })
  assert.equal(BigInt(costs.initialBuy) + BigInt(costs.accountDeposits) + BigInt(costs.networkFee), BigInt(costs.total))
})

test('a network fee that does not cover the signatures and the priority fee cannot be shown', () => {
  // An RPC reporting only the base fee would push the priority fee into "deposits": refuse instead.
  for (const networkFee of [15_000, 55_999]) {
    assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after: 69_944_000, networkFee, priorityFee: '41000',
      signatures: 3, initialBuyLamports: '10000000' }), /unavailable/)
  }
  for (const priorityFee of ['-1', '1.5', 'abc', '']) {
    assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after: 69_944_000, networkFee: 56_000, priorityFee,
      signatures: 3, initialBuyLamports: '0' }), /unavailable/)
  }
  for (const signatures of [0, -1, 1.5, '3']) {
    assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after: 69_944_000, networkFee: 56_000, priorityFee: '41000',
      signatures, initialBuyLamports: '0' }), /unavailable/)
  }
})

test('missing, unsafe or contradictory simulation balances cannot show an invented estimate', () => {
  for (const after of [null, undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after,
      networkFee: 15_000, signatures: 3, initialBuyLamports: '10000000' }), /unavailable/)
  }
  assert.throws(() => launchCostBreakdown({ balance: 100_000_000, after: 99_000_000,
    networkFee: 15_000, signatures: 3, initialBuyLamports: '10000000' }), /balance changed/)
})

test('a launch without exactly one explicit compute budget is refused before any RPC call', async () => {
  const payer = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: other, lamports: 1 })
  const rpc = new Proxy({}, { get: () => { throw Error('no RPC call expected') } })
  const shapes = [[transfer], [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), transfer],
    [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }), transfer,
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 })]]
  for (const instructions of shapes) {
    const tx = new Transaction({ feePayer: payer, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(...instructions)
    await assert.rejects(estimateLaunchCosts(rpc, tx, '0'), /exactly once/)
  }
})

test('estimated costs come from the simulated debit and the quoted fee of the exact priced message', async () => {
  const payer = Keypair.generate().publicKey
  const tx = new Transaction({ feePayer: payer, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 205_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  const quoted = []
  const rpc = {
    getBalanceAndContext: async () => ({ context: { slot: 7 }, value: 10_000_000 }),
    simulateTransaction: async simulated => { quoted.push(simulated.message.compiledInstructions.length); return { value: { err: null, accounts: [{ lamports: 9_950_000 }] } } },
    getFeeForMessage: async message => { quoted.push(message.instructions.length); return { value: 46_000 } },
  }
  const costs = await estimateLaunchCosts(rpc, tx, '0')
  assert.deepEqual(quoted.sort(), [3, 3])
  assert.deepEqual([costs.networkFee, costs.priorityFee, costs.accountDeposits, costs.total], ['46000', '41000', '4000', '50000'])
  // Same transaction, an RPC whose fee omits the priority fee: refused rather than shown.
  await assert.rejects(estimateLaunchCosts({ ...rpc, getFeeForMessage: async () => ({ value: 5_000 }) }, tx, '0'), /unavailable/)
})
