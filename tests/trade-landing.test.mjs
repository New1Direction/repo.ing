import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CU_LIMIT_CEILING, CU_LIMIT_FALLBACK, CU_LIMIT_FLOOR, CU_PRICE_FALLBACK, CU_PRICE_MAX, CU_PRICE_MIN, MAX_PRIORITY_FEE_LAMPORTS,
  broadcastUntilSettled, computeUnitLimit, isHeliusEndpoint, priorityFeeLamports, readTradeComputeBudget, selectComputeUnitPrice,
  tradePriorityFee, withPriorityFee } from '../src/trade-landing.mjs'
import { assertPreparedSwap, dammQuote } from '../src/canonical-damm-trade.mjs'
import { assertDbcSettlement, assertPreparedDbcSwap } from '../src/canonical-trade.mjs'
import { estimateTradeCosts } from '../src/trade-costs.mjs'

const limitIx = units => ComputeBudgetProgram.setComputeUnitLimit({ units })
const priceIx = microLamports => ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
const fees = values => values.map((prioritizationFee, slot) => ({ slot, prioritizationFee }))
const blockhash = Keypair.generate().publicKey.toBase58()

test('priority price is the p75 of recent non-zero fees, clamped to the configured range', () => {
  assert.equal(selectComputeUnitPrice(fees([0, 0, 100_000, 200_000, 300_000, 400_000])), 300_000)
  assert.equal(selectComputeUnitPrice(fees([600_000, 700_000, 800_000, 900_000])), 800_000)
  assert.equal(selectComputeUnitPrice(fees([60_000, 70_000, 80_000, 90_000])), CU_PRICE_MIN)
  assert.equal(selectComputeUnitPrice(fees([0, 0, 0])), CU_PRICE_MIN)
  assert.equal(selectComputeUnitPrice([]), CU_PRICE_MIN)
  assert.equal(selectComputeUnitPrice(null), CU_PRICE_MIN)
  assert.equal(selectComputeUnitPrice(fees([1, 2, 3])), CU_PRICE_MIN)
  assert.equal(selectComputeUnitPrice(fees([50_000_000, 90_000_000])), CU_PRICE_MAX)
  // The worst case the checks allow stays under the 0.001 SOL cap.
  assert.ok(priorityFeeLamports({ units: CU_LIMIT_CEILING, microLamports: CU_PRICE_MAX }) <= MAX_PRIORITY_FEE_LAMPORTS)
  assert.equal(priorityFeeLamports({ units: 200_000, microLamports: 1 }), 1n)
})

test('compute limit is simulated use with 20% headroom inside floor and ceiling, else the fallback', () => {
  assert.equal(computeUnitLimit(100_000), 120_000)
  assert.equal(computeUnitLimit(100_001), 120_002)
  assert.equal(computeUnitLimit(58_903), 73_903)
  assert.equal(computeUnitLimit(1_000), CU_LIMIT_FLOOR)
  assert.equal(computeUnitLimit(900_000), CU_LIMIT_CEILING)
  for (const bad of [undefined, null, 0, -5, 1.5, NaN, '100000']) assert.equal(computeUnitLimit(bad), CU_LIMIT_FALLBACK)
})

const trade = () => {
  const payer = Keypair.generate().publicKey
  return { payer, tx: new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 })) }
}
const rpc = overrides => ({ rpcEndpoint: 'http://127.0.0.1:8899',
  simulateTransaction: async () => ({ value: { err: null, unitsConsumed: 100_000 } }),
  getRecentPrioritizationFees: async () => fees([100_000, 200_000, 300_000, 400_000]), ...overrides })

test('withPriorityFee prepends exactly limit then price to the unchanged instructions, from simulation and recent fees', async () => {
  const { payer, tx } = trade(), pool = Keypair.generate().publicKey
  let simulated, asked
  const result = await withPriorityFee(rpc({
    simulateTransaction: async (versioned, options) => { simulated = { versioned, options }; return { value: { err: null, unitsConsumed: 100_000 } } },
    getRecentPrioritizationFees: async config => { asked = config; return fees([100_000, 200_000, 300_000, 400_000]) } }),
  tx, { feePayer: payer, blockhash, writableAccounts: [pool], log: () => {} })
  assert.deepEqual(simulated.options, { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true })
  assert.equal(simulated.versioned.message.compiledInstructions.length, 3)
  assert.deepEqual(asked.lockedWritableAccounts, [pool])
  const out = result.transaction
  assert.equal(out.instructions.length, 3)
  assert.deepEqual(readTradeComputeBudget(out.instructions), { count: 2, limit: 120_000, microLamports: 300_000n })
  assert.equal(out.instructions[2], tx.instructions[0])
  assert.equal(tx.instructions.length, 1)
  assert.ok(out.feePayer.equals(payer)); assert.equal(out.recentBlockhash, blockhash)
  assert.equal(result.priorityFeeLamports, 36_000n)
  await assert.rejects(withPriorityFee(rpc(), out, { feePayer: payer, blockhash, writableAccounts: [] }), /exactly once/)
})

test('failed or unavailable simulation and fee lookups fall back to safe fixed values', async () => {
  const { payer, tx } = trade(), logs = []
  const log = (...args) => logs.push(args)
  const failing = await withPriorityFee(rpc({ simulateTransaction: async () => ({ value: { err: 'InsufficientFundsForFee', unitsConsumed: 0 } }),
    getRecentPrioritizationFees: async () => { throw Error('rpc https://x.example/?api-key=secret down') } }), tx, { feePayer: payer, blockhash, writableAccounts: [], log })
  assert.equal(failing.computeUnitLimit, CU_LIMIT_FALLBACK); assert.equal(failing.microLamports, CU_PRICE_FALLBACK)
  const thrown = await withPriorityFee(rpc({ simulateTransaction: async () => { throw Error('offline') } }), tx, { feePayer: payer, blockhash, writableAccounts: [], log })
  assert.equal(thrown.computeUnitLimit, CU_LIMIT_FALLBACK)
  assert.ok(logs.every(args => !JSON.stringify(args).includes('secret')))
})

test('a Helius RPC prices from getPriorityFeeEstimate (High), clamped, and falls back to recent fees on any error', async () => {
  assert.equal(isHeliusEndpoint('https://mainnet.helius-rpc.com/?api-key=k'), true)
  assert.equal(isHeliusEndpoint('https://api.mainnet-beta.solana.com'), false)
  assert.equal(isHeliusEndpoint('https://helius-rpc.com.evil.example'), false)
  const { payer, tx } = trade(), endpoint = 'https://mainnet.helius-rpc.com/?api-key=k'
  let request
  const fetcher = async (url, init) => { request = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ result: { priorityFeeEstimate: 423_456.4 } }) } }
  const helius = await withPriorityFee(rpc({ rpcEndpoint: endpoint }), tx, { feePayer: payer, blockhash, writableAccounts: [], fetcher, log: () => {} })
  assert.equal(helius.microLamports, 423_457)
  assert.equal(request.url, endpoint); assert.equal(request.body.method, 'getPriorityFeeEstimate')
  assert.deepEqual(request.body.params[0].options, { transactionEncoding: 'Base64', priorityLevel: 'High' })
  assert.ok(Transaction.from(Buffer.from(request.body.params[0].transaction, 'base64')).instructions.length === 3)
  const huge = async () => ({ ok: true, json: async () => ({ result: { priorityFeeEstimate: 9e12 } }) })
  assert.equal((await withPriorityFee(rpc({ rpcEndpoint: endpoint }), tx, { feePayer: payer, blockhash, writableAccounts: [], fetcher: huge, log: () => {} })).microLamports, CU_PRICE_MAX)
  for (const broken of [async () => { throw Error('timeout') }, async () => ({ ok: false, status: 429 }), async () => ({ ok: true, json: async () => ({ error: { code: -32602 } }) })]) {
    const fallback = await withPriorityFee(rpc({ rpcEndpoint: endpoint }), tx, { feePayer: payer, blockhash, writableAccounts: [], fetcher: broken, log: () => {} })
    assert.equal(fallback.microLamports, 300_000)
  }
})

test('compute budget check accepts only one limit and one price, first, within maximums', () => {
  const other = SystemProgram.transfer({ fromPubkey: Keypair.generate().publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })
  assert.deepEqual(readTradeComputeBudget([other]), { count: 0, limit: null, microLamports: 0n })
  assert.equal(readTradeComputeBudget([priceIx(5), limitIx(100_000), other]).count, 2)
  const reject = (ixs, pattern) => assert.throws(() => readTradeComputeBudget(ixs), pattern)
  reject([limitIx(100_000), limitIx(100_000), other], /unexpected compute budget/)
  reject([priceIx(1), priceIx(1), other], /unexpected compute budget/)
  reject([limitIx(100_000), other, priceIx(1)], /unexpected compute budget/)
  reject([ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), other], /unexpected compute budget/)
  reject([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, data: Buffer.from([4, 0, 0, 1, 0]), keys: [] }), other], /unexpected compute budget/)
  reject([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, data: limitIx(1000).data,
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }] }), other], /unexpected compute budget/)
  reject([limitIx(CU_LIMIT_CEILING + 1), other], /exceeds the configured maximum/)
  reject([priceIx(CU_PRICE_MAX + 1), other], /exceeds the configured maximum/)
  assert.equal(tradePriorityFee([limitIx(200_000), priceIx(1_000_000), other]), 200_000n)
  assert.equal(tradePriorityFee([priceIx(1_000_000), other, other]), 400_000n)
})

// The same SDK-built transactions the traders prepare, with and without the compute budget prefix.
const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const accounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const amm = new CpAmm(new Connection('http://127.0.0.1:8909'))
const pool = new PublicKey(swaps.pool), mint = new PublicKey('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be')
const poolState = amm._program.coder.accounts.decode('pool', Buffer.from(accounts.accounts.find(a => a.address === swaps.pool).data, 'base64'))
const withPrefix = (tx, prefix) => new Transaction().add(...prefix, ...tx.instructions)
const variants = [
  ['duplicate limit', [limitIx(100_000), limitIx(100_000), priceIx(1)]],
  ['duplicate price', [limitIx(100_000), priceIx(1), priceIx(1)]],
  ['oversized limit', [limitIx(CU_LIMIT_CEILING + 1), priceIx(1)]],
  ['oversized price', [limitIx(100_000), priceIx(CU_PRICE_MAX + 1)]],
  ['heap frame', [ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }), limitIx(100_000)]],
]

test('DAMM prepared-swap check accepts the exact compute budget prefix and rejects extra, duplicated, oversized or misplaced ones', async () => {
  const wallet = Keypair.generate().publicKey
  for (const direction of ['buy', 'sell']) {
    const amountIn = direction === 'buy' ? 10_000_000n : 10_000_000_000n
    const { minimumAmountOut } = dammQuote({ amm, poolState, direction, amountIn, currentPoint: new BN(1790666590) })
    const tx = await amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, outputTokenMint: direction === 'buy' ? mint : NATIVE_MINT,
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })
    const spec = { wallet, pool, poolState, direction, amountIn, minimumAmountOut }
    assertPreparedSwap(withPrefix(tx, [limitIx(150_000), priceIx(CU_PRICE_MAX)]), spec)
    assertPreparedSwap(withPrefix(tx, [limitIx(150_000)]), spec)
    for (const [name, prefix] of variants) assert.throws(() => assertPreparedSwap(withPrefix(tx, prefix), spec), /compute budget/, name)
    const late = new Transaction().add(limitIx(150_000), ...tx.instructions.slice(0, 1), priceIx(1), ...tx.instructions.slice(1))
    assert.throws(() => assertPreparedSwap(late, spec), /compute budget/)
    assert.throws(() => assertPreparedSwap(new Transaction().add(...tx.instructions, priceIx(1)), spec), /compute budget|after the WSOL close/)
  }
})

test('DBC prepared-swap check accepts the exact compute budget prefix and rejects extra, duplicated, oversized or misplaced ones', async () => {
  const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:8909'), 'confirmed')
  const wallet = Keypair.generate().publicKey, config = Keypair.generate().publicKey, curve = Keypair.generate().publicKey
  const amountIn = 10_000_000n, minimumAmountOut = 123n
  const swap = await dbc.pool.program.methods.swap({ amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })
    .accountsPartial({ baseMint: mint, quoteMint: NATIVE_MINT, pool: curve, baseVault: Keypair.generate().publicKey,
      quoteVault: Keypair.generate().publicKey, config, poolAuthority: Keypair.generate().publicKey, referralTokenAccount: null,
      inputTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, wallet), outputTokenAccount: getAssociatedTokenAddressSync(mint, wallet),
      payer: wallet, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID }).instruction()
  const close = createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, wallet), wallet, wallet)
  const tx = new Transaction().add(swap, close)
  const spec = { wallet, pool: curve, config, mint, amountIn, minimumAmountOut }
  assertPreparedDbcSwap(tx, spec)
  assertPreparedDbcSwap(withPrefix(tx, [limitIx(150_000), priceIx(CU_PRICE_MAX)]), spec)
  for (const [name, prefix] of variants) assert.throws(() => assertPreparedDbcSwap(withPrefix(tx, prefix), spec), /compute budget/, name)
  assert.throws(() => assertPreparedDbcSwap(new Transaction().add(limitIx(150_000), swap, priceIx(1), close), spec), /compute budget/)
})

test('real mainnet DAMM receipts already carry compute budget instructions and a priority fee inside meta.fee', () => {
  for (const raw of [swaps.buy, swaps.sell]) {
    const message = raw.transaction.message
    const programs = message.instructions.map(ix => message.accountKeys[ix.programIdIndex])
    assert.deepEqual(programs.slice(0, 2), [ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58()])
    assert.ok(raw.meta.fee > 5000)
  }
})

test('trade costs include the priority fee exactly once in network fee, total and required', async () => {
  const payer = Keypair.generate().publicKey
  const tx = new Transaction({ feePayer: payer, recentBlockhash: blockhash }).add(limitIx(200_000), priceIx(1_000_000),
    createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, payer), payer, payer))
  const costs = async fee => estimateTradeCosts({ getBalance: async () => 10_205_000, getFeeForMessage: async () => ({ value: fee }),
    getMinimumBalanceForRentExemption: async () => 2039280, getMultipleAccountsInfo: async () => [] }, { transaction: tx, direction: 'buy', amountIn: 10_000_000n })
  for (const fee of [5000, 205_000]) {
    const result = await costs(fee)
    assert.equal(result.priorityFee, '200000'); assert.equal(result.networkFee, '205000')
    assert.equal(result.total, '10205000'); assert.equal(result.required, '10205000'); assert.equal(result.shortfall, '0')
  }
})

test('sell settlement judges proceeds before the network fee, so a priority fee cannot fail a dust sale', () => {
  const sell = { direction: 'sell', amountIn: 1_000n, minimumAmountOut: 4_000n, tokenDelta: -1_000n, quoteVaultDelta: -5_000n, fee: 20_000n }
  assertDbcSettlement({ ...sell, walletSol: 5_000n - 20_000n })
  assert.throws(() => assertDbcSettlement({ ...sell, walletSol: 3_000n - 20_000n }), /Sell balances/)
  assert.throws(() => assertDbcSettlement({ ...sell, walletSol: -20_000n }), /Sell balances/)
  const buy = { direction: 'buy', amountIn: 1_000n, minimumAmountOut: 5n, tokenDelta: 5n, quoteVaultDelta: 1_000n, fee: 20_000n }
  assertDbcSettlement({ ...buy, walletSol: -21_000n })
  assert.throws(() => assertDbcSettlement({ ...buy, walletSol: -999n }), /Buy balances/)
})

function chain({ confirmAt = Infinity, failAt = Infinity, heights = () => 100, rebroadcastError = false } = {}) {
  const sends = [], clock = { t: 0 }
  let polls = 0
  return { sends, clock, connection: {
    sendRawTransaction: async (raw, options) => { sends.push({ raw, options }); if (rebroadcastError && sends.length > 1) throw Error('already processed'); return 'sig' },
    getSignatureStatuses: async () => { polls++; return { value: [polls >= failAt ? { err: { InstructionError: [0, 'x'] } } : polls >= confirmAt ? { confirmationStatus: 'confirmed', err: null } : null] } },
    getBlockHeight: async () => heights(polls) } }
}
const loop = (c, extra = {}) => broadcastUntilSettled(c.connection, Buffer.from([1, 2, 3]), { signature: 'sig', lastValidBlockHeight: 150,
  sleep: async ms => { c.clock.t += ms }, now: () => c.clock.t, ...extra })

test('rebroadcast resends the same signed bytes every interval and stops once confirmed', async () => {
  const c = chain({ confirmAt: 3 })
  assert.deepEqual(await loop(c), { state: 'confirmed', sends: 3, rebroadcastErrors: 0 })
  assert.deepEqual(c.sends[0].options, { skipPreflight: false, maxRetries: 0 })
  assert.ok(c.sends.slice(1).every(s => s.options.skipPreflight === true && s.options.maxRetries === 0))
  assert.ok(c.sends.every(s => s.raw.equals(Buffer.from([1, 2, 3]))))
  assert.equal(c.clock.t, 6000)
})

test('rebroadcast stops at a chain failure, past lastValidBlockHeight, or the wall-time bound', async () => {
  assert.equal((await loop(chain({ failAt: 2 }))).state, 'failed')
  const expiring = chain({ heights: polls => polls >= 4 ? 151 : 149 })
  assert.deepEqual(await loop(expiring), { state: 'expired', sends: 4, rebroadcastErrors: 0 })
  const slow = chain({ rebroadcastError: true })
  const bounded = await loop(slow, { maxMs: 45_000 })
  assert.equal(bounded.state, 'timeout'); assert.equal(slow.clock.t, 46_000); assert.ok(bounded.rebroadcastErrors > 0)
  const first = chain(); first.connection.sendRawTransaction = async () => { throw Error('Transaction simulation failed') }
  await assert.rejects(loop(first), /simulation failed/)
})
