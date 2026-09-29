import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { estimateTradeCosts } from '../src/trade-costs.mjs'
import { assertPreparedSwap, assertTradablePool, createTradeRouter, dammMinimumOut, dammQuote, messageFingerprint,
  verifyDammSwapReceipt } from '../src/canonical-damm-trade.mjs'

// Real finalized $REPOING DAMM swaps and pool account from mainnet; no RPC is touched.
const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const accounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const amm = new CpAmm(new Connection('http://127.0.0.1:8909'))
const coder = amm._program.coder
const pool = new PublicKey(swaps.pool), mint = new PublicKey('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be')
const poolState = coder.accounts.decode('pool', Buffer.from(accounts.accounts.find(a => a.address === swaps.pool).data, 'base64'))
const currentPoint = new BN(1790666590)
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])

// The fixture is its own "prepared" trade: amounts and min-out come from its swap instruction data.
function expectation(raw, direction) {
  const tx = load(raw), keys = tx.transaction.message.accountKeys
  const ix = tx.transaction.message.instructions.find(i => keys[i.programIdIndex].equals(new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')))
  const data = Buffer.from(bs58.decode(ix.data))
  return { signature: raw.transaction.signatures[0], fingerprint: messageFingerprint(tx.transaction.message), wallet: keys[0], pool, mint,
    tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, direction,
    amountIn: data.readBigUInt64LE(8), minimumAmountOut: data.readBigUInt64LE(16) }
}

test('router sends migrated curves to the DAMM trader and active curves to the unchanged DBC trader', async () => {
  const curve = { name: 'curve' }, migrated = new Set(['2'])
  const graduated = { name: 'graduated', isMigrated: async id => migrated.has(String(id)) }
  const route = createTradeRouter({ curve, graduated })
  assert.equal(await route(1n), curve)
  assert.equal(await route('2'), graduated)
  await assert.rejects(createTradeRouter({ curve, graduated: { isMigrated: async () => { throw Error('Repository has no indexed canonical market') } } })(3),
    /no indexed canonical market/)
})

test('quote min-out is the exact 1% floor of the SDK output and fees are SOL-side only', () => {
  assert.equal(dammMinimumOut(10000n), 9900n)
  assert.equal(dammMinimumOut(10001n), 9900n)
  assert.equal(dammMinimumOut(99n), 98n)
  const buy = dammQuote({ amm, poolState, direction: 'buy', amountIn: 10_000_000n, currentPoint })
  assert.ok(buy.outputAmount > 0n)
  assert.equal(buy.minimumAmountOut, buy.outputAmount * 9900n / 10000n)
  assert.ok(buy.fee > 0n && buy.fee < 10_000_000n / 50n)
  const sell = dammQuote({ amm, poolState, direction: 'sell', amountIn: 10_000_000_000n, currentPoint })
  assert.equal(sell.minimumAmountOut, sell.outputAmount * 9900n / 10000n)
  assert.ok(sell.fee > 0n && sell.fee < sell.outputAmount)
  assert.throws(() => dammQuote({ amm, poolState, direction: 'buy', amountIn: 10_000_000n, currentPoint: new BN(1) }))
})

test('only the canonical SOL pair with SOL fees, SPL vaults and enabled swaps is tradable', () => {
  assertTradablePool(poolState, pool, mint)
  for (const patch of [{ poolStatus: 1 }, { collectFeeMode: 0 }, { tokenAFlag: 1 }, { tokenAVault: Keypair.generate().publicKey }]) {
    assert.throws(() => assertTradablePool({ ...poolState, ...patch }, pool, mint), /not tradable/)
  }
  assert.throws(() => assertTradablePool(poolState, Keypair.generate().publicKey, mint), /not tradable/)
  assert.throws(() => assertTradablePool(poolState, pool, Keypair.generate().publicKey), /not tradable/)
})

test('SDK swap2 transaction passes the structural check and the cost estimate; tampering fails closed', async () => {
  const wallet = Keypair.generate().publicKey
  for (const direction of ['buy', 'sell']) {
    const amountIn = direction === 'buy' ? 10_000_000n : 10_000_000_000n
    const { minimumAmountOut } = dammQuote({ amm, poolState, direction, amountIn, currentPoint })
    const build = () => amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, outputTokenMint: direction === 'buy' ? mint : NATIVE_MINT,
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })
    const spec = { wallet, pool, poolState, direction, amountIn, minimumAmountOut }
    const tx = await build()
    assertPreparedSwap(tx, spec)
    tx.feePayer = wallet
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58()
    const costs = await estimateTradeCosts({ getBalance: async () => 1_000_000_000, getFeeForMessage: async () => ({ value: 5000 }),
      getMinimumBalanceForRentExemption: async () => 2039280, getMultipleAccountsInfo: async () => [null, null] }, { transaction: tx, direction, amountIn })
    assert.equal(costs.refundableDeposit, '2039280')
    assert.equal(costs.total, String((direction === 'buy' ? amountIn : 0n) + 5000n + 2039280n))
    assert.throws(() => assertPreparedSwap(tx, { ...spec, minimumAmountOut: minimumAmountOut - 1n }), /does not match the quote/)
    assert.throws(() => assertPreparedSwap(tx, { ...spec, pool: Keypair.generate().publicKey }), /does not match the quote/)
    const extra = await build()
    extra.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
    assert.throws(() => assertPreparedSwap(extra, spec), /unexpected SOL transfer/)
  }
})

test('receipt verification accepts real canonical buy and sell swaps with exact event, vault and wallet deltas', () => {
  const buy = verifyDammSwapReceipt(load(swaps.buy), expectation(swaps.buy, 'buy'), coder)
  assert.equal(buy.quoteAmount, 30_000_000n)
  assert.equal(buy.tokenDelta, 53_186_326_140n)
  assert.equal(buy.baseAmount, buy.tokenDelta)
  const sell = verifyDammSwapReceipt(load(swaps.sell), expectation(swaps.sell, 'sell'), coder)
  assert.equal(sell.tokenDelta, -307_134_364_468n)
  assert.equal(sell.quoteAmount, 175_635_556n)
})

test('receipt verification rejects wrong pool, two swaps, min-out violations, altered messages and wrong direction', () => {
  const expected = expectation(swaps.buy, 'buy')
  const verify = (tx, patch = {}) => verifyDammSwapReceipt(tx, { ...expected, ...patch }, coder)
  assert.throws(() => verify(load(swaps.buy), { pool: Keypair.generate().publicKey }), /did not swap the canonical pool/)
  assert.throws(() => verify(load(swaps.buy), { tokenBVault: Keypair.generate().publicKey }), /did not swap the canonical pool/)
  assert.throws(() => verify(load(swaps.buy), { wallet: Keypair.generate().publicKey }), /did not swap the canonical pool/)
  // Two swaps: the canonical swap and its event group repeated in the same transaction.
  const doubled = load(swaps.buy), message = doubled.transaction.message
  const swapIndex = message.instructions.findIndex(ix => message.accountKeys[ix.programIdIndex].toBase58().startsWith('cpamdp'))
  message.instructions.push(message.instructions[swapIndex])
  doubled.meta.innerInstructions.push({ ...doubled.meta.innerInstructions.find(g => g.index === swapIndex), index: message.instructions.length - 1 })
  assert.throws(() => verifyDammSwapReceipt(doubled, { ...expected, fingerprint: messageFingerprint(message) }, coder), /exactly once/)
  assert.throws(() => verify(load(swaps.buy), { minimumAmountOut: expected.minimumAmountOut + 1n }), /prepared direction/)
  assert.throws(() => verify(load(swaps.buy), { amountIn: expected.amountIn + 1n }), /prepared direction/)
  assert.throws(() => verify(load(swaps.buy), { fingerprint: messageFingerprint({ ...load(swaps.buy).transaction.message, recentBlockhash: '11111111111111111111111111111111' }) }),
    /does not match prepared trade/)
  assert.throws(() => verify(load(swaps.buy), { signature: swaps.sell.transaction.signatures[0] }), /does not match prepared trade/)
  assert.throws(() => verify(load(swaps.buy), { direction: 'sell' }), /prepared direction/)
  assert.throws(() => verifyDammSwapReceipt(load(swaps.sell), { ...expectation(swaps.sell, 'sell'), direction: 'buy' }, coder), /prepared direction/)
  const failed = load(swaps.buy)
  failed.meta.err = { InstructionError: [6, { Custom: 6004 }] }
  assert.throws(() => verify(failed), /missing or failed/)
  assert.throws(() => verify(null), /missing or failed/)
})

test('receipt verification rejects balances that do not settle exactly to the user and pool vaults', () => {
  const expected = expectation(swaps.buy, 'buy')
  const tokenShort = load(swaps.buy)
  const row = tokenShort.meta.postTokenBalances.find(b => b.owner === expected.wallet.toBase58())
  row.uiTokenAmount = { ...row.uiTokenAmount, amount: String(BigInt(row.uiTokenAmount.amount) - 1n) }
  assert.throws(() => verifyDammSwapReceipt(tokenShort, expected, coder), /Buy balances/)
  const foreignOwner = load(swaps.buy)
  foreignOwner.meta.postTokenBalances.find(b => b.owner === expected.wallet.toBase58()).owner = Keypair.generate().publicKey.toBase58()
  assert.throws(() => verifyDammSwapReceipt(foreignOwner, expected, coder), /settle to the user wallet/)
  const sellExpected = expectation(swaps.sell, 'sell')
  const vaultDrift = load(swaps.sell)
  const vault = vaultDrift.meta.postTokenBalances.find(b => b.mint === NATIVE_MINT.toBase58())
  vault.uiTokenAmount = { ...vault.uiTokenAmount, amount: String(BigInt(vault.uiTokenAmount.amount) - 1n) }
  assert.throws(() => verifyDammSwapReceipt(vaultDrift, sellExpected, coder), /Sell balances/)
  const walletShort = load(swaps.sell)
  walletShort.meta.postBalances[0] -= 20_000_000
  assert.throws(() => verifyDammSwapReceipt(walletShort, sellExpected, coder), /Sell balances/)
  assert.equal(getAssociatedTokenAddressSync(mint, expected.wallet).toBase58(), load(swaps.buy).transaction.message.accountKeys[7].toBase58())
})
