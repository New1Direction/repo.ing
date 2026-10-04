import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Connection, Keypair, Message, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { createDammTrader, messageFingerprint } from '../src/canonical-damm-trade.mjs'
import { assertPreparedStockSwap, assertStockDammSettlement, assertTradableStockPool, isStockMarket, stockDammQuote,
  verifyStockDammSwapReceipt } from '../src/stock-damm-trade.mjs'
import { estimateTradeCosts } from '../src/trade-costs.mjs'
import { readTradeRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { scriptedChain } from './fixtures/damm-trader-scenario.mjs'

// Graduated trading of a stock-paired market (docs/STOCK_QUOTES.md) on real accounts and transactions from
// tests/stock-graduation-chain.test.mjs (mainnet's programs on a local validator): DOCUSAURUS / METAx's DAMM v2 pool and the
// site's own buy and sell in it. No RPC is touched.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/stock-damm-graduation.json', import.meta.url), 'utf8'))
const solAccounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const metaxMint = JSON.parse(readFileSync(new URL('./fixtures/metax-mint.json', import.meta.url), 'utf8'))
const amm = new CpAmm(new Connection('http://127.0.0.1:1'))
const coder = amm._program.coder
const METAX = new PublicKey(fixture.quoteMint), pool = new PublicKey(fixture.dammPool), mint = new PublicKey(fixture.market.mint)
const poolAccount = fixture.accounts.find(account => account.address === fixture.dammPool)
const poolState = coder.accounts.decode('pool', Buffer.from(poolAccount.data, 'base64'))
const currentPoint = new BN(fixture.transactions.siteSell.blockTime)
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])
const market = { id: 11, githubRepoId: BigInt(fixture.market.repoId), mint: fixture.market.mint, pool: fixture.market.curve, status: 'confirmed',
  creatorWallet: fixture.market.creator, quoteAssetId: 'meta-xstock', quoteMint: METAX.toBase58() }

// A fixture swap as its own prepared trade: amounts and minimum from its swap instruction.
function expectation(raw, direction) {
  const tx = load(raw), keys = tx.transaction.message.accountKeys
  const ix = tx.transaction.message.instructions.find(i => keys[i.programIdIndex].equals(CP_AMM_PROGRAM_ID))
  const data = Buffer.from(bs58.decode(ix.data))
  return { signature: raw.transaction.signatures[0], fingerprint: messageFingerprint(tx.transaction.message), wallet: keys[0], pool, mint, quoteMint: METAX,
    tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, direction, amountIn: data.readBigUInt64LE(8), minimumAmountOut: data.readBigUInt64LE(16) }
}

test('only the market token / stock pool with fees in the stock, a Token-2022 stock and the canonical vaults is tradable', () => {
  assertTradableStockPool(poolState, pool, mint, METAX)
  for (const patch of [{ poolStatus: 1 }, { collectFeeMode: 0 }, { tokenAFlag: 1 }, { tokenBFlag: 0 }, { tokenBMint: NATIVE_MINT },
    { tokenAVault: Keypair.generate().publicKey }, { tokenBVault: Keypair.generate().publicKey }]) {
    assert.throws(() => assertTradableStockPool({ ...poolState, ...patch }, pool, mint, METAX), /not tradable/, Object.keys(patch)[0])
  }
  assert.throws(() => assertTradableStockPool(poolState, Keypair.generate().publicKey, mint, METAX), /not tradable/)
  assert.throws(() => assertTradableStockPool(poolState, pool, mint, new PublicKey('XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX')), /not tradable/)
  for (const quoteMint of [null, undefined, NATIVE_MINT]) assert.throws(() => assertTradableStockPool(poolState, pool, mint, quoteMint), /quote mint is required/)
  // A SOL pool is never a stock pool.
  const solPool = coder.accounts.decode('pool', Buffer.from(solAccounts.accounts[0].data, 'base64'))
  assert.throws(() => assertTradableStockPool(solPool, new PublicKey(solAccounts.accounts[0].address), solPool.tokenAMint, METAX), /not tradable/)
  assert.ok(isStockMarket(market) && !isStockMarket({ ...market, quoteAssetId: null, quoteMint: null }))
})

test('a quote spends the stock on a buy and the market token on a sell; its minimum is the exact floor and its fee is in the stock', () => {
  const buy = stockDammQuote({ amm, poolState, direction: 'buy', amountIn: 50_000_000n, currentPoint, slippageBps: 500, quoteDecimals: 8 })
  assert.ok(buy.outputAmount > 0n && buy.fee > 0n && buy.fee < 50_000_000n / 50n, 'about 1% of the stock in')
  assert.equal(buy.minimumAmountOut, buy.outputAmount * 9500n / 10000n)
  const sell = stockDammQuote({ amm, poolState, direction: 'sell', amountIn: buy.outputAmount, currentPoint, quoteDecimals: 8 })
  assert.equal(sell.minimumAmountOut, sell.outputAmount * 9900n / 10000n)
  assert.ok(sell.outputAmount < 50_000_000n && sell.fee > 0n, 'a round trip costs the fee')
  // The stock's decimals come from its asset; a quote without them, or before the pool activates, is refused.
  assert.throws(() => stockDammQuote({ amm, poolState, direction: 'buy', amountIn: 50_000_000n, currentPoint }), /decimals are required/)
  assert.throws(() => stockDammQuote({ amm, poolState, direction: 'swap', amountIn: 1n, currentPoint, quoteDecimals: 8 }), /Invalid trade direction/)
  assert.throws(() => stockDammQuote({ amm, poolState, direction: 'buy', amountIn: 50_000_000n, currentPoint: new BN(1), quoteDecimals: 8 }))
})

test('the SDK swap passes the prepared-swap check; a wrap, a close, a referral, a foreign account or another pool fails closed', async () => {
  const wallet = Keypair.generate().publicKey
  for (const [direction, amountIn] of [['buy', 50_000_000n], ['sell', 1_000_000_000n]]) {
    const { minimumAmountOut } = stockDammQuote({ amm, poolState, direction, amountIn, currentPoint, quoteDecimals: 8 })
    const build = (overrides = {}) => amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? METAX : mint, outputTokenMint: direction === 'buy' ? mint : METAX, tokenAMint: mint, tokenBMint: METAX,
      tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID,
      referralTokenAccount: null, amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)), ...overrides })
    const spec = { wallet, pool, poolState, quoteMint: METAX, direction, amountIn, minimumAmountOut }
    const tx = await build()
    assertPreparedStockSwap(tx, spec)
    const budgeted = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 }), ...tx.instructions)
    assertPreparedStockSwap(budgeted, spec)
    // No wrap and no close: SOL only pays the network fee and the account rents (src/trade-costs.mjs).
    tx.feePayer = wallet
    tx.recentBlockhash = Keypair.generate().publicKey.toBase58()
    const costs = await estimateTradeCosts({ getBalance: async () => 1_000_000_000, getFeeForMessage: async () => ({ value: 5000 }),
      getMinimumBalanceForRentExemption: async size => size === 165 ? 2_039_280 : size === 179 ? 2_136_720 : assert.fail(`rent for ${size} bytes`),
      getMultipleAccountsInfo: async () => [null, null],
      getAccountInfo: async key => key.equals(METAX) ? { owner: TOKEN_2022_PROGRAM_ID, data: Buffer.from(metaxMint.data, 'base64'), lamports: 1, executable: false } : null },
    { transaction: tx, direction, amountIn, quoteMint: METAX.toBase58() })
    // A new wallet: rent for its market token account and its 179-byte METAx account, and no stock held yet.
    assert.deepEqual([costs.refundableDeposit, costs.accountDeposits, costs.quoteBalance, costs.quoteShortfall],
      ['0', String(2_039_280 + 2_136_720), '0', direction === 'buy' ? String(amountIn) : '0'])
    const refused = (instructions, pattern, overrides = {}) =>
      assert.throws(() => assertPreparedStockSwap(new Transaction().add(...instructions), { ...spec, ...overrides }), pattern)
    refused(tx.instructions, /does not match the quote/, { minimumAmountOut: minimumAmountOut - 1n })
    refused(tx.instructions, /does not match the quote/, { amountIn: amountIn + 1n })
    refused(tx.instructions, /does not match the quote/, { pool: Keypair.generate().publicKey })
    refused(tx.instructions, /does not match the quote/, { direction: direction === 'buy' ? 'sell' : 'buy' })
    // Another wallet: its account setup is not the signer's own, and neither is the swap.
    refused(tx.instructions, /unexpected instruction/, { wallet: Keypair.generate().publicKey })
    refused(tx.instructions.slice(-1), /does not match the quote/, { wallet: Keypair.generate().publicKey })
    refused(tx.instructions, /quote mint is required/, { quoteMint: null })
    refused([...tx.instructions, ...tx.instructions.slice(-1)], /does not match the quote/)
    refused((await build({ referralTokenAccount: getAssociatedTokenAddressSync(METAX, Keypair.generate().publicKey, false, TOKEN_2022_PROGRAM_ID) })).instructions, /does not match the quote/)
    // The stock under SPL Token: its account setup and its swap are both refused.
    refused((await build({ tokenBProgram: TOKEN_PROGRAM_ID })).instructions, /unexpected instruction/)
    refused((await build({ tokenBProgram: TOKEN_PROGRAM_ID })).instructions.slice(-1), /does not match the quote/)
    refused((await build({ swapMode: SwapMode.PartialFill })).instructions, /does not match the quote/)
    const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet)
    refused([SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsol, lamports: 1 }), ...tx.instructions], /unexpected instruction/)
    refused([createSyncNativeInstruction(wsol), ...tx.instructions], /unexpected instruction/)
    refused([...tx.instructions, createCloseAccountInstruction(wsol, wallet, wallet)], /unexpected instruction/)
    refused([...tx.instructions, createCloseAccountInstruction(getAssociatedTokenAddressSync(METAX, wallet, false, TOKEN_2022_PROGRAM_ID), wallet, wallet, [], TOKEN_2022_PROGRAM_ID)], /unexpected instruction/)
    // Account setup: only the wallet's own account for either mint, idempotently, under that mint's token program.
    const other = Keypair.generate().publicKey
    refused([createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(mint, other), other, mint), ...tx.instructions], /unexpected instruction/)
    refused([createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(METAX, wallet), wallet, METAX), ...tx.instructions], /unexpected instruction/)
    refused([createAssociatedTokenAccountInstruction(wallet, getAssociatedTokenAddressSync(mint, wallet), wallet, mint), ...tx.instructions], /unexpected instruction/)
    refused([createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(NATIVE_MINT, wallet), wallet, NATIVE_MINT), ...tx.instructions], /unexpected instruction/)
  }
})

test('receipts of the site\'s real buy and sell settle exactly: the stock in raw units, the market token and both vaults', () => {
  const buy = verifyStockDammSwapReceipt(load(fixture.transactions.siteBuy), expectation(fixture.transactions.siteBuy, 'buy'), coder)
  assert.equal(buy.quoteDelta, -50_000_000n, 'exactly 0.5 METAx spent')
  assert.equal(buy.quoteAmount, 50_000_000n)
  assert.ok(buy.tokenDelta > 0n && buy.tokenDelta === buy.baseAmount)
  assert.equal(buy.quoteMint, METAX.toBase58())
  const sell = verifyStockDammSwapReceipt(load(fixture.transactions.siteSell), expectation(fixture.transactions.siteSell, 'sell'), coder)
  assert.equal(sell.tokenDelta, -buy.tokenDelta, 'every token bought is sold back')
  assert.ok(sell.quoteDelta > 0n && sell.quoteDelta === sell.quoteAmount && sell.quoteDelta < 50_000_000n)
  // Swaps sent straight to the pool by a wallet settle the same way.
  assert.equal(verifyStockDammSwapReceipt(load(fixture.transactions.directBuy), expectation(fixture.transactions.directBuy, 'buy'), coder).quoteDelta, -200_000_000n)
  assert.ok(verifyStockDammSwapReceipt(load(fixture.transactions.directSell), expectation(fixture.transactions.directSell, 'sell'), coder).quoteDelta > 0n)
})

test('receipts are refused for another pool, mint, wallet, amount, direction, message or a failed transaction', () => {
  const expected = expectation(fixture.transactions.siteBuy, 'buy')
  const verify = (patch = {}, tx = load(fixture.transactions.siteBuy)) => verifyStockDammSwapReceipt(tx, { ...expected, ...patch }, coder)
  assert.throws(() => verify({ pool: Keypair.generate().publicKey }), /did not swap the canonical pool/)
  assert.throws(() => verify({ tokenBVault: Keypair.generate().publicKey }), /did not swap the canonical pool/)
  assert.throws(() => verify({ wallet: Keypair.generate().publicKey }), /did not swap the canonical pool/)
  assert.throws(() => verify({ quoteMint: new PublicKey('XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX') }), /did not swap the canonical pool/)
  assert.throws(() => verify({ quoteMint: NATIVE_MINT }), /quote mint is required/)
  assert.throws(() => verify({ minimumAmountOut: expected.minimumAmountOut + 1n }), /prepared direction/)
  assert.throws(() => verify({ amountIn: expected.amountIn - 1n }), /prepared direction/)
  assert.throws(() => verify({ direction: 'sell' }), /did not swap the canonical pool|prepared direction/)
  assert.throws(() => verify({ signature: fixture.transactions.siteSell.transaction.signatures[0] }), /does not match prepared trade/)
  assert.throws(() => verify({ fingerprint: messageFingerprint({ ...load(fixture.transactions.siteBuy).transaction.message, recentBlockhash: '11111111111111111111111111111111' }) }),
    /does not match prepared trade/)
  const failed = load(fixture.transactions.siteBuy)
  failed.meta.err = { InstructionError: [4, { Custom: 6004 }] }
  assert.throws(() => verify({}, failed), /missing or failed/)
  assert.throws(() => verify({}, null), /missing or failed/)
})

test('balances that do not settle exactly to the wallet and the pool vaults are refused', () => {
  const expected = expectation(fixture.transactions.siteBuy, 'buy')
  const shift = (balances, predicate, by) => {
    const row = balances.find(predicate)
    row.uiTokenAmount = { ...row.uiTokenAmount, amount: String(BigInt(row.uiTokenAmount.amount) + by) }
  }
  const wallet = expected.wallet.toBase58()
  const stockShort = load(fixture.transactions.siteBuy)
  shift(stockShort.meta.postTokenBalances, b => b.owner === wallet && b.mint === METAX.toBase58(), -1n)
  assert.throws(() => verifyStockDammSwapReceipt(stockShort, expected, coder), /Buy balances/)
  const tokenShort = load(fixture.transactions.siteBuy)
  shift(tokenShort.meta.postTokenBalances, b => b.owner === wallet && b.mint === mint.toBase58(), -1n)
  assert.throws(() => verifyStockDammSwapReceipt(tokenShort, expected, coder), /Buy balances/)
  const vaultDrift = load(fixture.transactions.siteBuy), keys = vaultDrift.transaction.message.accountKeys
  const vaultIndex = keys.findIndex(key => key.equals(poolState.tokenBVault))
  shift(vaultDrift.meta.postTokenBalances, b => b.accountIndex === vaultIndex, -1n)
  assert.throws(() => verifyStockDammSwapReceipt(vaultDrift, expected, coder), /Buy balances/)
  const foreign = load(fixture.transactions.siteBuy)
  for (const row of [...foreign.meta.preTokenBalances, ...foreign.meta.postTokenBalances]) if (row.owner === wallet && row.mint === METAX.toBase58()) row.owner = Keypair.generate().publicKey.toBase58()
  assert.throws(() => verifyStockDammSwapReceipt(foreign, expected, coder), /settle to the user wallet/)
  const sellExpected = expectation(fixture.transactions.siteSell, 'sell')
  const sellShort = load(fixture.transactions.siteSell)
  shift(sellShort.meta.postTokenBalances, b => b.owner === sellExpected.wallet.toBase58() && b.mint === METAX.toBase58(), -1n)
  assert.throws(() => verifyStockDammSwapReceipt(sellShort, sellExpected, coder), /Sell balances/)
})

test('settlement rules in raw units: exact input, at least the minimum, and the vaults moving the other way', () => {
  const buy = { direction: 'buy', amountIn: 100n, minimumAmountOut: 40n, quoteAmount: 100n, baseAmount: 50n, tokenDelta: 50n, quoteDelta: -100n, vaultADelta: -50n, vaultBDelta: 100n }
  assertStockDammSettlement(buy)
  for (const patch of [{ quoteAmount: 99n }, { quoteDelta: -101n }, { vaultBDelta: 99n }, { baseAmount: 39n, tokenDelta: 39n, vaultADelta: -39n }, { tokenDelta: 49n }, { vaultADelta: -49n }]) {
    assert.throws(() => assertStockDammSettlement({ ...buy, ...patch }), /Buy balances/, JSON.stringify(patch, (_, v) => String(v)))
  }
  const sell = { direction: 'sell', amountIn: 50n, minimumAmountOut: 90n, quoteAmount: 95n, baseAmount: 50n, tokenDelta: -50n, quoteDelta: 95n, vaultADelta: 50n, vaultBDelta: -95n }
  assertStockDammSettlement(sell)
  for (const patch of [{ baseAmount: 49n }, { tokenDelta: -49n }, { vaultADelta: 49n }, { quoteAmount: 89n, quoteDelta: 89n, vaultBDelta: -89n }, { quoteDelta: 94n }, { vaultBDelta: -96n }, { direction: 'swap' }]) {
    assert.throws(() => assertStockDammSettlement({ ...sell, ...patch }), /Sell balances/, JSON.stringify(patch, (_, v) => String(v)))
  }
})

// The stock branch of createDammTrader on a scripted chain: the graduated pool proven by src/stock-graduation.mjs (stubbed here).
function stockTrader({ loadTransaction = async () => null, loadMarket = async () => market } = {}) {
  const connection = scriptedChain({ accounts: [poolAccount], unixTimestamp: fixture.transactions.siteSell.blockTime, slot: fixture.slot })
  return createDammTrader({ pool: null, connection, config: Keypair.generate().publicKey.toBase58(), loadTransaction, loadMarket,
    graduatedFees: { destination: async () => { throw Error('the SOL proof is never read for a stock pair') } },
    stockGraduation: { destination: async candidate => { assert.equal(candidate.quoteMint, METAX.toBase58()); return { target: pool } } } })
}

test('createDammTrader quotes and prepares a stock pair in its graduated pool: no wrap, no referral, the record carries the stock', async () => {
  const trader = stockTrader(), githubRepoId = fixture.market.repoId, wallet = Keypair.generate().publicKey
  const quote = await trader.quoteBuy({ githubRepoId, amountLamports: '50000000', slippageBps: 500 })
  assert.equal(quote.venue, 'damm')
  assert.ok(BigInt(quote.outputAmount) > 0n && BigInt(quote.tradingFeeLamports) > 0n && quote.priceImpactPercent >= 0)
  for (const [direction, amount] of [['buy', '50000000'], ['sell', '1000000000']]) {
    const request = { githubRepoId, wallet: wallet.toBase58(), slippageBps: 500, referrer: Keypair.generate().publicKey.toBase58(),
      [direction === 'buy' ? 'amountLamports' : 'amountBaseUnits']: amount }
    const prepared = await (direction === 'buy' ? trader.prepareBuy(request) : trader.prepareSell(request))
    assert.deepEqual([prepared.phase, prepared.quoteMint, prepared.referral, prepared.pool, prepared.amountIn], ['graduated', METAX.toBase58(), null, pool.toBase58(), BigInt(amount)])
    const { record } = prepared
    assert.deepEqual([record.referral, record.wsolRent, record.referrer, record.tradingFeeLamports, record.curve, record.tokenBVault],
      [null, null, null, null, market.pool, poolState.tokenBVault.toBase58()])
    assert.ok(readTradeRecord(record, 'graduated').quoteMint.equals(METAX))
    assertPreparedStockSwap(prepared.transaction, { wallet, pool, poolState, quoteMint: METAX, direction, amountIn: BigInt(amount), minimumAmountOut: prepared.minimumAmountOut })
    const programs = prepared.transaction.instructions.map(ix => ix.programId.toBase58())
    assert.deepEqual(programs.filter(id => id === TOKEN_PROGRAM_ID.toBase58() || id === SystemProgram.programId.toBase58()), [], 'nothing wrapped or closed')
  }
  // A market whose pair no longer matches the registry is refused, not guessed.
  const stale = stockTrader({ loadMarket: async () => ({ ...market, quoteMint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX' }) })
  await assert.rejects(stale.quoteBuy({ githubRepoId, amountLamports: '50000000' }), /registry/)
})

// The site's fixture buy as its own prepared record, as prepare stored it.
function stockFixtureRecord(raw, direction) {
  const message = new Message(raw.transaction.message), keys = message.accountKeys
  const swap = raw.transaction.message.instructions.find(ix => keys[ix.programIdIndex].equals(CP_AMM_PROGRAM_ID))
  const data = Buffer.from(bs58.decode(swap.data))
  return { v: TRADE_RECORD_VERSION, phase: 'graduated', direction, wallet: keys[0].toBase58(), marketId: market.id, githubRepoId: fixture.market.repoId,
    mint: market.mint, curve: market.pool, pool: pool.toBase58(), tokenAVault: poolState.tokenAVault.toBase58(), tokenBVault: poolState.tokenBVault.toBase58(),
    referral: null, wsolRent: null, amountIn: data.readBigUInt64LE(8).toString(), minimumAmountOut: data.readBigUInt64LE(16).toString(),
    message: Buffer.from(message.serialize()).toString('base64'), transaction: serializeUnsigned(Transaction.populate(message, [bs58.encode(Buffer.alloc(64))])),
    blockhash: message.recentBlockhash, lastValidBlockHeight: 400_000_000, slippageBps: 500, priorityFee: null, quoteMint: METAX.toBase58() }
}

test('createDammTrader verifies a stock trade from its record alone; a SOL record never verifies against a stock pool', async () => {
  const raw = fixture.transactions.siteBuy, signature = raw.transaction.signatures[0]
  const trader = stockTrader({ loadTransaction: async (_, wanted, commitment) => { assert.equal(commitment, 'finalized'); return wanted === signature ? load(raw) : null } })
  const record = stockFixtureRecord(raw, 'buy')
  const verified = await trader.verifyTrade({ record }, signature, { commitment: 'finalized' })
  assert.deepEqual([verified.quoteDelta, verified.quoteMint, verified.pool, verified.direction, verified.commitment], [-50_000_000n, METAX.toBase58(), pool.toBase58(), 'buy', 'finalized'])
  const { quoteMint, ...sol } = record
  await assert.rejects(trader.verifyTrade({ record: sol }, signature, { commitment: 'finalized' }), /Canonical market changed before trade verification/)
  // A stock record against a SOL market fails the same way.
  const solMarket = { ...market, quoteAssetId: null, quoteMint: null }
  const connection = scriptedChain({ accounts: [poolAccount], unixTimestamp: 1, slot: 1 })
  const solTrader = createDammTrader({ pool: null, connection, config: Keypair.generate().publicKey.toBase58(), loadMarket: async () => solMarket,
    graduatedFees: { destination: async () => ({ target: pool }) }, loadTransaction: async () => load(raw) })
  await assert.rejects(solTrader.verifyTrade({ record }, signature, { commitment: 'finalized' }), /Canonical market changed before trade verification/)
})
