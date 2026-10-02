import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SendTransactionError } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { dbcSwapQuote } from '../src/canonical-trade.mjs'
import { assertPreparedSwap, dammMinimumOut, dammQuote } from '../src/canonical-damm-trade.mjs'
import { DEFAULT_SLIPPAGE_BPS, isPreflightSlippageError, isSlippageError, minimumOutAfterSlippage, nextSlippagePreset, parseSlippageBps,
  parseSlippagePercent, SLIPPAGE_PRESETS_BPS, slippageLabel, swapInstructionIndex } from '../src/trade-slippage.mjs'
import { tradeStatus } from '../app/lib/trade-status.mjs'
import { broadcastUntilSettled } from '../src/trade-landing.mjs'
import { POST as tradeApi } from '../app/api/trade/route.js'

// SDK math only: no RPC call is made through either connection.
const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed')
const amm = new CpAmm(new Connection('http://127.0.0.1:1'))
const accounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const dammPool = new PublicKey(swaps.pool), mint = new PublicKey('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be')
const poolState = amm._program.coder.accounts.decode('pool', Buffer.from(accounts.accounts.find(a => a.address === swaps.pool).data, 'base64'))
const TOLERANCES = [50, 100, 300, 500, 1000, 2000, 2500]
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

test('slippage must be an integer number of basis points from 50 to 2500; absent means the 1% default', () => {
  assert.equal(DEFAULT_SLIPPAGE_BPS, 100)
  assert.equal(parseSlippageBps(undefined), 100)
  for (const ok of [50, 100, 300, 1234, 2500]) assert.equal(parseSlippageBps(ok), ok)
  for (const bad of [null, 0, 49, 2501, 10_000, -100, 100.5, NaN, Infinity, '100', '3%', [], {}, true, 2 ** 53])
    assert.throws(() => parseSlippageBps(bad), /Invalid slippage/, String(bad))
  assert.deepEqual(SLIPPAGE_PRESETS_BPS, [100, 300, 500, 1000, 2000])
})

test('minimum output is the floor of output × (10000 − bps) / 10000, and refuses an unchecked tolerance', () => {
  for (const [output, bps, expected] of [[10_000n, 100, 9_900n], [10_001n, 100, 9_900n], [99n, 100, 98n], [10_000n, 50, 9_950n],
    [10_000n, 300, 9_700n], [12_345_678_901n, 500, 11_728_394_955n], [10n ** 18n, 2500, 750_000_000_000_000_000n], ['1', 2000, 0n]]) {
    assert.equal(minimumOutAfterSlippage(output, bps), expected, `${output} at ${bps}`)
  }
  for (const bad of [undefined, 49, 2501, 99.5, '100']) assert.throws(() => minimumOutAfterSlippage(1000n, bad), /Invalid slippage/)
  assert.equal(dammMinimumOut(10_000n), 9_900n)
  assert.equal(dammMinimumOut(10_000n, 2000), 8_000n)
})

test('DBC curve quotes carry the chosen tolerance and agree with the independent floor', () => {
  const curve = buildLaunchCurve('builders')
  const virtualPool = dbc.pool.buildSimulatedVirtualPool(curve.sqrtStartPrice), config = dbc.pool.normalizeQuoteConfig(curve)
  let previous = null
  for (const slippageBps of TOLERANCES) {
    const quote = dbcSwapQuote({ dbc, virtualPool, config, direction: 'buy', amountIn: new BN(250_000_000), currentPoint: new BN(0), slippageBps })
    const output = BigInt(quote.outputAmount.toString()), minimum = BigInt(quote.minimumAmountOut.toString())
    assert.ok(output > 0n)
    assert.equal(minimum, output * BigInt(10_000 - slippageBps) / 10_000n, `${slippageBps} bps`)
    if (previous) assert.ok(minimum < previous, 'a looser tolerance lowers the minimum')
    previous = minimum
  }
})

test('an SDK minimum that ignores the chosen tolerance fails closed before anything is built', () => {
  const sdk = { pool: { swapQuote: ({ slippageBps }) => ({ outputAmount: new BN(1_000_000), minimumAmountOut: new BN(990_000), slippageBps }) } }
  const args = { dbc: sdk, virtualPool: null, config: null, direction: 'buy', amountIn: new BN(1), currentPoint: new BN(0) }
  assert.equal(dbcSwapQuote({ ...args, slippageBps: 100 }).minimumAmountOut.toString(), '990000')
  assert.throws(() => dbcSwapQuote({ ...args, slippageBps: 500 }), /No executable output quote/)
  assert.throws(() => dbcSwapQuote({ ...args, slippageBps: 5000 }), /Invalid slippage/)
  const damm = { getQuote2: () => ({ outputAmount: new BN(1_000_000), minimumAmountOut: new BN(990_000), amountLeft: new BN(0),
    claimingFee: new BN(1), compoundingFee: new BN(0), protocolFee: new BN(0), referralFee: new BN(0) }) }
  assert.equal(dammQuote({ amm: damm, poolState, direction: 'buy', amountIn: 1n, currentPoint: new BN(0), slippageBps: 100 }).minimumAmountOut, 990_000n)
  assert.throws(() => dammQuote({ amm: damm, poolState, direction: 'buy', amountIn: 1n, currentPoint: new BN(0), slippageBps: 300 }), /No executable output quote/)
})

test('DAMM quotes carry the chosen tolerance in both directions, and the swap must encode exactly that minimum', async () => {
  const currentPoint = new BN(1790666590), wallet = Keypair.generate().publicKey
  for (const direction of ['buy', 'sell']) {
    const amountIn = direction === 'buy' ? 10_000_000n : 10_000_000_000n
    const quotes = TOLERANCES.map(slippageBps => ({ slippageBps, ...dammQuote({ amm, poolState, direction, amountIn, currentPoint, slippageBps }) }))
    for (const { slippageBps, outputAmount, minimumAmountOut } of quotes) {
      assert.equal(outputAmount, quotes[0].outputAmount, 'tolerance never changes the quoted output')
      assert.equal(minimumAmountOut, outputAmount * BigInt(10_000 - slippageBps) / 10_000n, `${direction} ${slippageBps} bps`)
    }
    const loose = quotes.find(q => q.slippageBps === 500), strict = quotes.find(q => q.slippageBps === 100)
    const tx = await amm.swap2({ payer: wallet, pool: dammPool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, outputTokenMint: direction === 'buy' ? mint : NATIVE_MINT,
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(loose.minimumAmountOut)) })
    const spec = { wallet, pool: dammPool, poolState, direction, amountIn }
    assertPreparedSwap(tx, { ...spec, minimumAmountOut: loose.minimumAmountOut })
    assert.throws(() => assertPreparedSwap(tx, { ...spec, minimumAmountOut: strict.minimumAmountOut }), /does not match the quote/)
  }
})

test('retry presets, custom percentages and labels', () => {
  assert.deepEqual([50, 100, 250, 300, 500, 1000, 1999, 2000, 2500].map(nextSlippagePreset), [100, 300, 300, 500, 1000, 2000, 2000, null, null])
  for (const [text, bps] of [['0.5', 50], ['.5', 50], ['1', 100], ['3.25', 325], ['5.', 500], [' 12 ', 1200], ['25', 2500]]) assert.equal(parseSlippagePercent(text), bps, text)
  for (const bad of ['', ' ', '.', '0', '0.49', '25.01', '100', 'abc', '1e1', '-1', '3.333', '1,5', null, undefined]) assert.equal(parseSlippagePercent(bad), null, String(bad))
  assert.deepEqual([50, 100, 325, 2500].map(slippageLabel), ['0.5%', '1%', '3.25%', '25%'])
})

const swapInstructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  { programId: TOKEN_PROGRAM_ID }, { programId: DBC }, { programId: TOKEN_PROGRAM_ID }]

test('only the prepared swap failing on its minimum (6002) counts as a slippage failure', () => {
  assert.equal(swapInstructionIndex(swapInstructions), 3)
  assert.equal(swapInstructionIndex([{ programId: new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG') }]), 0)
  assert.equal(swapInstructionIndex([{ programId: TOKEN_PROGRAM_ID }]), -1)
  assert.equal(isSlippageError({ InstructionError: [3, { Custom: 6002 }] }, 3), true)
  for (const [err, index] of [[{ InstructionError: [4, { Custom: 6002 }] }, 3], [{ InstructionError: [3, { Custom: 6001 }] }, 3],
    [{ InstructionError: [3, 'Custom'] }, 3], ['AccountInUse', 3], [null, 3], [{ InstructionError: [3, { Custom: 6002 }] }, -1]]) {
    assert.equal(isSlippageError(err, index), false, JSON.stringify(err))
  }
  const preflight = (message, action = 'simulate') => new SendTransactionError({ action, signature: '', transactionMessage: message, logs: [] })
  assert.equal(isPreflightSlippageError(preflight('Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1772'), 3), true)
  assert.equal(isPreflightSlippageError(preflight('Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1772'), 3), false)
  assert.equal(isPreflightSlippageError(preflight('Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1771'), 3), false)
  assert.equal(isPreflightSlippageError(preflight('Transaction simulation failed: Blockhash not found'), 3), false)
  assert.equal(isPreflightSlippageError(Error('Trade failed: {"InstructionError":[3,{"Custom":6002}]}'), 3), false)
  assert.equal(isPreflightSlippageError(null, 3), false)
})

test('a real web3.js preflight refusal is classified, and broadcastUntilSettled sends nothing after it', async () => {
  const connection = new Connection('http://127.0.0.1:1')
  const calls = []
  connection._rpcRequest = async (method, args) => {
    calls.push([method, args[1]?.skipPreflight ?? false])
    return { jsonrpc: '2.0', id: '1', error: { code: -32002, message: 'Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1772',
      data: { err: { InstructionError: [3, { Custom: 6002 }] }, logs: ['Program log: AnchorError occurred. Error Code: ExceededSlippage. Error Number: 6002.'] } } }
  }
  const error = await broadcastUntilSettled(connection, Buffer.from([1, 2, 3]), { signature: 'sig', lastValidBlockHeight: 1, sleep: async () => {} })
    .then(() => null, cause => cause)
  assert.ok(error instanceof SendTransactionError)
  assert.equal(isPreflightSlippageError(error, swapInstructionIndex(swapInstructions)), true)
  assert.deepEqual(calls, [['sendTransaction', false]], 'refused at the first, preflighted send: never forwarded, never rebroadcast')
})

test('trade status reports a slippage failure only for its own session\'s swap', async () => {
  const signature = 'signed-trade'
  const connection = err => ({ getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err }] }) })
  const session = { signature, prepared: { lastValidBlockHeight: 100, slippageBps: 300, transaction: { instructions: swapInstructions } } }
  assert.deepEqual(await tradeStatus(connection({ InstructionError: [3, { Custom: 6002 }] }), signature, session),
    { state: 'failed', signature, reason: 'slippage', slippageBps: 300 })
  // A wallet assertion appended after the swap, another program error, or no session: an ordinary failure.
  assert.deepEqual(await tradeStatus(connection({ InstructionError: [5, { Custom: 6002 }] }), signature, session), { state: 'failed', signature })
  assert.deepEqual(await tradeStatus(connection({ InstructionError: [3, { Custom: 6017 }] }), signature, session), { state: 'failed', signature })
  assert.deepEqual(await tradeStatus(connection({ InstructionError: [3, { Custom: 6002 }] }), signature, null), { state: 'failed', signature })
  assert.deepEqual(await tradeStatus(connection({ InstructionError: [3, { Custom: 6002 }] }), signature, { ...session, signature: 'other' }),
    { state: 'failed', signature })
})

test('/api/trade refuses any malformed slippage before quoting, costing or preparing', async () => {
  const call = async body => {
    const response = await tradeApi(new Request('http://localhost/api/trade', { method: 'POST', body: JSON.stringify(body) }))
    return { status: response.status, body: await response.json() }
  }
  const trade = { githubRepoId: '1', direction: 'buy', wallet: Keypair.generate().publicKey.toBase58(), amountBaseUnits: '1000' }
  for (const action of ['quote', 'costs', 'prepare']) {
    for (const slippageBps of [null, 0, 49, 2501, 99.5, '300', 'max', [300], { bps: 300 }]) {
      const { status, body } = await call({ ...trade, action, slippageBps })
      assert.equal(status, 400)
      assert.match(body.error, /^Invalid slippage/, `${action} ${JSON.stringify(slippageBps)}`)
    }
    // A valid tolerance passes validation and reaches the trader (unconfigured here).
    for (const slippageBps of [undefined, 50, 2500]) assert.match((await call({ ...trade, action, slippageBps })).body.error, /Trading is not configured/)
  }
})
