import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { LAUNCH_CU_LIMIT_CEILING, LAUNCH_CU_LIMIT_FALLBACK, LAUNCH_CU_LIMIT_FLOOR, cappedLaunchPrice, launchComputeUnitLimit,
  readLaunchComputeBudget, withLaunchPriorityFee } from '../src/launch-wallet-fees.mjs'
import { CU_PRICE_FALLBACK, CU_PRICE_MAX, CU_PRICE_MIN, MAX_PRIORITY_FEE_LAMPORTS, priorityFeeLamports } from '../src/trade-landing.mjs'

const blockhash = Keypair.generate().publicKey.toBase58()
const fees = values => values.map((prioritizationFee, slot) => ({ slot, prioritizationFee }))
function launch() {
  const payer = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, pool = Keypair.generate().publicKey
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports: 1, space: 82, programId: SystemProgram.programId }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: pool, lamports: 1 }))
  return { payer, mint, pool, tx }
}
const rpc = overrides => ({ rpcEndpoint: 'http://127.0.0.1:8899',
  simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 165_385 } }),
  getRecentPrioritizationFees: async () => fees([0, 0, 100_000, 250_000, 300_000, 900_000]), ...overrides })
const quiet = () => {}

test('launch limit is simulated units plus 20% (at least +40k) headroom, inside floor and ceiling, else the fallback', () => {
  assert.equal(launchComputeUnitLimit(100_407), 140_407, 'measured no-buy launch')
  assert.equal(launchComputeUnitLimit(165_385), 205_385, 'measured first-buy launch')
  assert.equal(launchComputeUnitLimit(202_396), 242_876, 'measured launch-fee first buy')
  assert.equal(launchComputeUnitLimit(400_000n), 480_000)
  assert.equal(launchComputeUnitLimit(1_000), LAUNCH_CU_LIMIT_FLOOR)
  assert.equal(launchComputeUnitLimit(1_300_000), LAUNCH_CU_LIMIT_CEILING)
  for (const bad of [undefined, null, 0, -5, 1.5, NaN, '100000']) assert.equal(launchComputeUnitLimit(bad), LAUNCH_CU_LIMIT_FALLBACK)
})

test('the unit price is lowered only when limit × price would pass the 0.001 SOL cap', () => {
  assert.equal(cappedLaunchPrice(242_876, CU_PRICE_MAX), CU_PRICE_MAX)
  assert.equal(cappedLaunchPrice(LAUNCH_CU_LIMIT_CEILING, CU_PRICE_MAX), 714_285)
  assert.equal(cappedLaunchPrice(LAUNCH_CU_LIMIT_CEILING, CU_PRICE_MIN), CU_PRICE_MIN)
  for (let units = LAUNCH_CU_LIMIT_FLOOR; units <= LAUNCH_CU_LIMIT_CEILING; units += 9_973) {
    for (const price of [0, 1, CU_PRICE_MIN, CU_PRICE_FALLBACK, 1_234_567, CU_PRICE_MAX]) {
      const capped = cappedLaunchPrice(units, price)
      assert.ok(capped <= price && priorityFeeLamports({ units, microLamports: capped }) <= MAX_PRIORITY_FEE_LAMPORTS, `${units} × ${price}`)
    }
  }
})

test('the budget is [limit, price] ahead of the unchanged launch instructions, from a 1.4M zero-price probe and recent fees', async () => {
  const { payer, mint, pool, tx } = launch()
  let simulated, asked
  const result = await withLaunchPriorityFee(rpc({
    simulateTransaction: async (versioned, options) => { simulated = { versioned, options }; return { value: { err: null, unitsConsumed: 165_385 } } },
    getRecentPrioritizationFees: async config => { asked = config; return fees([0, 0, 100_000, 250_000, 300_000, 900_000]) } }),
  tx, { feePayer: payer, blockhash, log: quiet })
  assert.deepEqual(simulated.options, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true })
  const probe = simulated.versioned.message
  assert.equal(probe.compiledInstructions.length, 4)
  assert.deepEqual([...probe.compiledInstructions[0].data], [...ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }).data])
  assert.deepEqual([...probe.compiledInstructions[1].data], [...ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }).data])
  // The relevant accounts are the launch's writable accounts, each once.
  assert.deepEqual(asked.lockedWritableAccounts.map(key => key.toBase58()).sort(), [payer, mint, pool].map(key => key.toBase58()).sort())
  assert.deepEqual([result.computeUnitLimit, result.microLamports, result.priorityFeeLamports], [205_385, 300_000, 61_616n])
  const out = result.transaction
  assert.equal(out.instructions.length, 4)
  assert.equal(out.instructions[2], tx.instructions[0]); assert.equal(out.instructions[3], tx.instructions[1])
  assert.equal(tx.instructions.length, 2, 'the input transaction is not modified')
  assert.ok(out.feePayer.equals(payer)); assert.equal(out.recentBlockhash, blockhash)
  assert.deepEqual(readLaunchComputeBudget(out.instructions), { limit: 205_385, microLamports: 300_000n, priorityFee: 61_616n })
  await assert.rejects(withLaunchPriorityFee(rpc(), out, { feePayer: payer, blockhash, log: quiet }), /exactly once/)
})

test('a failed probe or fee lookup falls back to fixed values, and the cap still holds at the largest limit', async () => {
  const { payer, tx } = launch(), logs = []
  const fallback = await withLaunchPriorityFee(rpc({ simulateTransaction: async () => ({ value: { err: 'InsufficientFundsForFee', unitsConsumed: 0 } }),
    getRecentPrioritizationFees: async () => { throw Error('rpc https://x.example/?api-key=secret down') } }), tx, { feePayer: payer, blockhash, log: (...args) => logs.push(args) })
  assert.deepEqual([fallback.computeUnitLimit, fallback.microLamports, fallback.priorityFeeLamports], [LAUNCH_CU_LIMIT_FALLBACK, CU_PRICE_FALLBACK, 200_000n])
  const offline = await withLaunchPriorityFee(rpc({ simulateTransaction: async () => { throw Error('offline') } }), tx, { feePayer: payer, blockhash, log: (...args) => logs.push(args) })
  assert.equal(offline.computeUnitLimit, LAUNCH_CU_LIMIT_FALLBACK)
  assert.ok(logs.every(entry => !JSON.stringify(entry).includes('secret')), 'only the error class is logged')
  const busy = await withLaunchPriorityFee(rpc({ simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 1_300_000 } }),
    getRecentPrioritizationFees: async () => fees([9_000_000, 9_000_000]) }), tx, { feePayer: payer, blockhash, log: quiet })
  assert.deepEqual([busy.computeUnitLimit, busy.microLamports, busy.priorityFeeLamports], [LAUNCH_CU_LIMIT_CEILING, 714_285, 999_999n])
})

test('a Helius RPC prices the launch from its estimate for the same writable accounts', async () => {
  const { payer, mint, pool, tx } = launch()
  let request
  const fetcher = async (url, init) => { request = JSON.parse(init.body); return { ok: true, json: async () => ({ result: { priorityFeeEstimate: 412_345.2 } }) } }
  const result = await withLaunchPriorityFee(rpc({ rpcEndpoint: 'https://mainnet.helius-rpc.com/?api-key=k',
    getRecentPrioritizationFees: async () => { throw Error('not used') } }), tx, { feePayer: payer, blockhash, fetcher, log: quiet })
  assert.equal(request.method, 'getPriorityFeeEstimate')
  assert.deepEqual(request.params[0].accountKeys.sort(), [payer, mint, pool].map(key => key.toBase58()).sort())
  assert.equal(result.microLamports, 412_346)
})

test('only exactly [limit, price, ...] within the launch bounds and the cap is accepted', () => {
  const { payer, tx } = launch(), [create, transfer] = tx.instructions
  const limit = units => ComputeBudgetProgram.setComputeUnitLimit({ units })
  const price = microLamports => ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
  assert.deepEqual(readLaunchComputeBudget([limit(205_385), price(200_000), create, transfer]), { limit: 205_385, microLamports: 200_000n, priorityFee: 41_077n })
  for (const instructions of [[create, transfer], [price(1), limit(205_385), create], [limit(205_385), create, price(1)],
    [limit(205_385), price(1), create, price(2)], [limit(205_385), limit(205_385), price(1)], [limit(205_385)]]) {
    assert.throws(() => readLaunchComputeBudget(instructions), /exactly once/)
  }
  const keyed = price(1); keyed.keys = [{ pubkey: payer, isSigner: false, isWritable: false }]
  assert.throws(() => readLaunchComputeBudget([limit(205_385), keyed, create]), /exactly once/)
  for (const instructions of [[limit(1_400_001), price(1)], [limit(0), price(1)], [limit(1_400_000), price(2_000_000)], [limit(500_001), price(2_000_000)]]) {
    assert.throws(() => readLaunchComputeBudget(instructions), /exceeds the configured maximum/)
  }
  assert.equal(readLaunchComputeBudget([limit(500_000), price(2_000_000)]).priorityFee, MAX_PRIORITY_FEE_LAMPORTS)
})
