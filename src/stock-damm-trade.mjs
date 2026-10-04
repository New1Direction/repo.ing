import BN from 'bn.js'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Message, PublicKey } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CP_AMM_PROGRAM_ID, SwapMode, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk'
import { messageFingerprint } from './canonical-damm-trade.mjs'
import { quoteOfMarket } from './quote-assets.mjs'
import { stockDammSwapEvents } from './stock-damm-trades.mjs'
import { readTradeComputeBudget, withPriorityFee } from './trade-landing.mjs'
import { preparedFromRecord, serializeUnsigned, TRADE_RECORD_VERSION } from './trade-record.mjs'
import { DEFAULT_SLIPPAGE_BPS, minimumOutAfterSlippage } from './trade-slippage.mjs'

// Trading a stock-paired market in its graduated DAMM v2 pool (docs/STOCK_QUOTES.md). The pool pairs the market token (token A,
// SPL Token, 6 decimals) with the stock (token B, Token-2022, the asset's decimals) and collects its fees in the stock. Like the
// stock curve trade (src/canonical-trade.mjs assertPreparedStockDbcSwap), nothing is wrapped or closed and there is no referral,
// because referrals pay through wrapped SOL. createDammTrader (src/canonical-damm-trade.mjs) dispatches a stock-paired market
// here; its SOL path is unchanged.
const SWAP2 = '414b3f4ceb5b5b88'
const SWAPS = ['f8c69e91e17587c8', SWAP2]
const disc = data => Buffer.from(bs58.decode(data)).subarray(0, 8).toString('hex')
const big = value => BigInt(value.toString())

// A stock-paired market: stamped with a quote asset (migration 0053), as the quote-aware config resolver decides.
export const isStockMarket = market => Boolean(market?.quoteMint || market?.quoteAssetId)
const stockQuote = market => {
  const quote = quoteOfMarket(market)
  if (quote.type === 'SOL') throw Error('Stock-paired market required')
  return quote
}
const required = quoteMint => {
  if (!quoteMint) throw Error('Stock quote mint is required')
  const key = new PublicKey(quoteMint)
  if (key.equals(NATIVE_MINT)) throw Error('Stock quote mint is required')
  return key
}

// Only the migrated market token / stock pair with fees in the stock, an SPL market token, a Token-2022 stock, the canonical
// vaults and swaps enabled is tradable here.
export function assertTradableStockPool(poolState, pool, mint, quoteMint) {
  const quote = required(quoteMint)
  if (!poolState.tokenAMint.equals(mint) || !poolState.tokenBMint.equals(quote) || poolState.collectFeeMode !== 1 ||
      poolState.tokenAFlag !== 0 || poolState.tokenBFlag !== 1 || poolState.poolStatus !== 0 ||
      !poolState.tokenAVault.equals(deriveTokenVaultAddress(mint, pool)) ||
      !poolState.tokenBVault.equals(deriveTokenVaultAddress(quote, pool))) {
    throw Error('Canonical DAMM pool is not tradable')
  }
}

// One exact-input quote: a buy spends the stock, a sell spends the market token. The SDK's minimum output must equal an
// independent floor of its output at the same tolerance (the SOL DAMM quote's agreement check). The fee is in the stock.
export function stockDammQuote({ amm, poolState, direction, amountIn, currentPoint, slippageBps = DEFAULT_SLIPPAGE_BPS, quoteDecimals }) {
  if (!Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 18) throw Error('Stock decimals are required')
  if (direction !== 'buy' && direction !== 'sell') throw Error('Invalid trade direction')
  const quote = amm.getQuote2({ inputTokenMint: direction === 'buy' ? poolState.tokenBMint : poolState.tokenAMint, poolState, currentPoint,
    amountIn: new BN(String(amountIn)), slippage: slippageBps, swapMode: SwapMode.ExactIn,
    tokenADecimal: 6, tokenBDecimal: quoteDecimals, hasReferral: false })
  const outputAmount = big(quote.outputAmount), minimumAmountOut = minimumOutAfterSlippage(outputAmount, slippageBps)
  if (!quote.amountLeft.isZero() || outputAmount <= 0n || minimumAmountOut <= 0n || big(quote.minimumAmountOut) !== minimumAmountOut) {
    throw Error('No executable output quote')
  }
  const fee = big(quote.claimingFee) + big(quote.compoundingFee) + big(quote.protocolFee) + big(quote.referralFee)
  return { outputAmount, minimumAmountOut, fee }
}

// The prepared transaction: besides the compute budget, exactly one ExactIn swap2 on the canonical pool with the quoted amounts,
// the wallet's own accounts in and out, both vaults, both mints, both token programs and no referral; and optionally the
// wallet's own associated account for either mint, created idempotently under that mint's token program. Nothing is wrapped,
// closed, transferred or paid to anyone else.
export function assertPreparedStockSwap(tx, { wallet, pool, poolState, quoteMint, direction, amountIn, minimumAmountOut }) {
  readTradeComputeBudget(tx.instructions)
  const quote = required(quoteMint), mint = poolState.tokenAMint
  const tokenAccount = getAssociatedTokenAddressSync(mint, wallet), stockAccount = getAssociatedTokenAddressSync(quote, wallet, false, TOKEN_2022_PROGRAM_ID)
  const [input, output] = direction === 'buy' ? [stockAccount, tokenAccount] : [tokenAccount, stockAccount]
  const own = [[mint, tokenAccount, TOKEN_PROGRAM_ID], [quote, stockAccount, TOKEN_2022_PROGRAM_ID]]
  let swaps = 0
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) continue
    const k = ix.keys.map(key => key.pubkey)
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.data.length === 1 && ix.data[0] === 1 && k[0]?.equals(wallet) && k[2]?.equals(wallet) &&
        own.some(([forMint, address, program]) => k[1]?.equals(address) && k[3]?.equals(forMint) && k[5]?.equals(program))) continue
    if (!ix.programId.equals(CP_AMM_PROGRAM_ID)) throw Error('Trade transaction contains an unexpected instruction')
    const d = ix.data
    if (!['buy', 'sell'].includes(direction) || d.length !== 25 || d.subarray(0, 8).toString('hex') !== SWAP2 || d.readBigUInt64LE(8) !== amountIn ||
        d.readBigUInt64LE(16) !== minimumAmountOut || d[24] !== SwapMode.ExactIn || !k[1]?.equals(pool) || !k[2]?.equals(input) ||
        !k[3]?.equals(output) || !k[4]?.equals(poolState.tokenAVault) || !k[5]?.equals(poolState.tokenBVault) || !k[6]?.equals(mint) ||
        !k[7]?.equals(quote) || !k[8]?.equals(wallet) || !k[9]?.equals(TOKEN_PROGRAM_ID) || !k[10]?.equals(TOKEN_2022_PROGRAM_ID) ||
        !k[11]?.equals(CP_AMM_PROGRAM_ID)) throw Error('Trade transaction swap does not match the quote')
    swaps++
  }
  if (swaps !== 1) throw Error('Trade transaction swap does not match the quote')
}

// Settlement in raw units of each token (as assertStockDbcSettlement for the curve). A buy spends exactly the input of the stock
// for at least the minimum of the market token; a sell gives exactly the input of the market token for at least the minimum of
// the stock. The swap event, the wallet's two accounts and the pool's two vaults must all tell the same story: the stock vault
// takes the whole input on a buy and pays out exactly what the wallet received on a sell (its fees stay in the vault).
export function assertStockDammSettlement({ direction, amountIn, minimumAmountOut, quoteAmount, baseAmount, tokenDelta, quoteDelta, vaultADelta, vaultBDelta }) {
  if (direction === 'buy') {
    if (quoteAmount !== amountIn || quoteDelta !== -amountIn || vaultBDelta !== amountIn || baseAmount < minimumAmountOut ||
        tokenDelta !== baseAmount || vaultADelta !== -baseAmount) throw Error('Buy balances or canonical pool vault did not change as expected')
  } else if (direction !== 'sell' || baseAmount !== amountIn || tokenDelta !== -amountIn || vaultADelta !== amountIn ||
      quoteAmount < minimumAmountOut || quoteDelta !== quoteAmount || vaultBDelta !== -quoteAmount) {
    throw Error('Sell balances or canonical pool vault did not change as expected')
  }
}

// Receipt checks for one confirmed/finalized stock swap. `expected` holds what was prepared, never chain-derived values.
export function verifyStockDammSwapReceipt(tx, expected, coder) {
  if (!tx?.meta || tx.meta.err) throw Error('Trade transaction is missing or failed')
  const { wallet, pool, mint, tokenAVault, tokenBVault, direction, amountIn, minimumAmountOut } = expected
  const quote = required(expected.quoteMint)
  const message = tx.transaction.message
  if (tx.transaction.signatures?.[0] !== expected.signature || messageFingerprint(message) !== expected.fingerprint) {
    throw Error('Transaction does not match prepared trade')
  }
  const keys = message.accountKeys
  const instructions = [...message.instructions.map(ix => ({ ix, outer: true })),
    ...(tx.meta.innerInstructions ?? []).flatMap(group => group.instructions.map(ix => ({ ix, outer: false })))]
  const swaps = instructions.filter(({ ix }) => keys[ix.programIdIndex]?.equals(CP_AMM_PROGRAM_ID) && SWAPS.includes(disc(ix.data)))
  const tokenAccount = getAssociatedTokenAddressSync(mint, wallet), stockAccount = getAssociatedTokenAddressSync(quote, wallet, false, TOKEN_2022_PROGRAM_ID)
  const [input, output] = direction === 'buy' ? [stockAccount, tokenAccount] : [tokenAccount, stockAccount]
  const a = swaps[0]?.ix.accounts.map(index => keys[index])
  if (swaps.length !== 1 || !swaps[0].outer || !keys[0]?.equals(wallet) || !a[1]?.equals(pool) || !a[2]?.equals(input) || !a[3]?.equals(output) ||
      !a[4]?.equals(tokenAVault) || !a[5]?.equals(tokenBVault) || !a[6]?.equals(mint) || !a[7]?.equals(quote) || !a[8]?.equals(wallet) ||
      !a[9]?.equals(TOKEN_PROGRAM_ID) || !a[10]?.equals(TOKEN_2022_PROGRAM_ID) || !a[11]?.equals(CP_AMM_PROGRAM_ID)) {
    throw Error('Transaction did not swap the canonical pool exactly once with the user wallet')
  }
  const events = stockDammSwapEvents(tx, { mint, quoteMint: quote, pool, coder })
  const event = events[0]
  if (events.length !== 1 || event.direction !== direction || event.params.swapMode !== SwapMode.ExactIn ||
      BigInt(event.params.amount0) !== amountIn || BigInt(event.params.amount1) !== minimumAmountOut || BigInt(event.referralFee) !== 0n) {
    throw Error('Transaction did not swap the canonical pool in the prepared direction')
  }
  const index = key => keys.findIndex(k => k.equals(key))
  const row = (balances, accountIndex, tokenMint) => balances?.find(b => b.accountIndex === accountIndex && b.mint === tokenMint.toBase58())
  const delta = (account, tokenMint) => {
    const at = index(account)
    if (at < 0) throw Error('Trade transaction omitted a settlement account')
    return BigInt(row(tx.meta.postTokenBalances, at, tokenMint)?.uiTokenAmount.amount ?? '0') - BigInt(row(tx.meta.preTokenBalances, at, tokenMint)?.uiTokenAmount.amount ?? '0')
  }
  // The wallet's own accounts: its signer key owns both (an associated account's owner cannot change).
  for (const [account, tokenMint] of [[tokenAccount, mint], [stockAccount, quote]]) {
    const at = index(account), owner = row(tx.meta.postTokenBalances, at, tokenMint)?.owner ?? row(tx.meta.preTokenBalances, at, tokenMint)?.owner
    if (owner !== wallet.toBase58()) throw Error('Trade balances did not settle to the user wallet')
  }
  const quoteAmount = BigInt(event.quoteAmount), baseAmount = BigInt(event.baseAmount)
  const tokenDelta = delta(tokenAccount, mint), quoteDelta = delta(stockAccount, quote)
  assertStockDammSettlement({ direction, amountIn, minimumAmountOut, quoteAmount, baseAmount, tokenDelta, quoteDelta,
    vaultADelta: delta(tokenAVault, mint), vaultBDelta: delta(tokenBVault, quote) })
  const solDelta = BigInt(tx.meta.postBalances[0]) - BigInt(tx.meta.preBalances[0])
  return { tokenDelta, solDelta, quoteDelta, quoteMint: quote.toBase58(), quoteAmount, baseAmount, referralFee: 0n, slot: BigInt(tx.slot) }
}

// The stock branch of createDammTrader: the proven graduated pool, its quote, the prepared swap and the receipt. graduation:
// src/stock-graduation.mjs createStockGraduation (destination proven from the curve's own finalized migrate instruction).
export function createStockDammTrading({ connection, amm, graduation, loadTransaction }) {
  const destinations = new Map()
  // The pool address is immutable once proven by the finalized migrate instruction; pool state is re-read every time.
  const canonicalPool = async market => {
    const key = `${market.id}:${market.pool}:${market.mint}:${market.quoteMint}`
    if (destinations.has(key)) return destinations.get(key)
    stockQuote(market)
    const proven = await graduation.destination(market)
    if (!proven) throw Error('Canonical market has not graduated')
    if (destinations.size >= 1000) destinations.delete(destinations.keys().next().value)
    destinations.set(key, proven.target)
    return proven.target
  }
  const poolSnapshot = async market => {
    const quote = stockQuote(market), pool = await canonicalPool(market), mint = new PublicKey(market.mint)
    const info = await connection.getAccountInfo(pool, 'confirmed')
    if (!info?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error('Canonical DAMM pool is missing')
    const poolState = amm._program.coder.accounts.decode('pool', info.data)
    assertTradableStockPool(poolState, pool, mint, quote.mint)
    return { pool, mint, poolState }
  }
  const quote = ({ market, poolState, direction, amountIn, currentPoint, slippageBps }) =>
    stockDammQuote({ amm, poolState, direction, amountIn, currentPoint, slippageBps, quoteDecimals: stockQuote(market).decimals })
  const prepare = async ({ wallet, market, pool, poolState, direction, amountIn, minimumAmountOut, slippageBps }) => {
    const asset = stockQuote(market), quoteMint = new PublicKey(asset.mint), mint = new PublicKey(market.mint)
    const swapTx = await amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? quoteMint : mint, outputTokenMint: direction === 'buy' ? mint : quoteMint,
      tokenAMint: mint, tokenBMint: quoteMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID, referralTokenAccount: null,
      amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minimumAmountOut.toString()) })
    const expected = { wallet, pool, poolState, quoteMint, direction, amountIn, minimumAmountOut }
    assertPreparedStockSwap(swapTx, expected)
    const latest = await connection.getLatestBlockhash('confirmed')
    const landing = await withPriorityFee(connection, swapTx, { feePayer: wallet, blockhash: latest.blockhash,
      writableAccounts: [pool, poolState.tokenAVault, poolState.tokenBVault] })
    const tx = landing.transaction
    assertPreparedStockSwap(tx, expected)
    // Everything submit and verification need, as plain JSON (src/trade-record.mjs): the SOL record's fields, with no referral,
    // no kept WSOL and no SOL trading fee, plus the stock's mint.
    const record = Object.freeze({ v: TRADE_RECORD_VERSION, phase: 'graduated', direction, wallet: wallet.toBase58(), marketId: market.id,
      githubRepoId: String(market.githubRepoId), mint: market.mint, curve: market.pool, pool: pool.toBase58(),
      tokenAVault: poolState.tokenAVault.toBase58(), tokenBVault: poolState.tokenBVault.toBase58(), referral: null, wsolRent: null,
      amountIn: amountIn.toString(), minimumAmountOut: minimumAmountOut.toString(),
      message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx),
      blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, slippageBps,
      priorityFee: { computeUnitLimit: landing.computeUnitLimit, microLamports: landing.microLamports, lamports: landing.priorityFeeLamports.toString() },
      referrer: null, tradingFeeLamports: null, quoteMint: asset.mint })
    return preparedFromRecord(record, tx)
  }
  // The market's stamped stock must be the one the trade was prepared with, both ways: a SOL record never verifies here.
  const verifyTrade = async ({ saved, market, signature, commitment }) => {
    const asset = quoteOfMarket(market)
    if (asset.type === 'SOL' || !saved.quoteMint || saved.quoteMint.toBase58() !== asset.mint) throw new Error('Canonical market changed before trade verification')
    let tx = null
    for (let attempt = 0; attempt < 12 && !tx; attempt++) {
      tx = await loadTransaction(connection, signature, commitment)
      if (!tx) await new Promise(resolve => setTimeout(resolve, 100))
    }
    // The landed message is the wallet-signed one (reviewed, plus any accepted wallet assertions) once known.
    const fingerprint = messageFingerprint(Message.from(saved.signedMessage ?? saved.message))
    const receipt = verifyStockDammSwapReceipt(tx, { signature, fingerprint, wallet: saved.wallet, pool: saved.pool, mint: saved.mint,
      quoteMint: saved.quoteMint, tokenAVault: saved.tokenAVault, tokenBVault: saved.tokenBVault, direction: saved.direction,
      amountIn: saved.amountIn, minimumAmountOut: saved.minimumAmountOut }, amm._program.coder)
    return { signature, direction: saved.direction, mint: market.mint, pool: saved.pool.toBase58(), commitment,
      minimumAmountOut: saved.minimumAmountOut, ...receipt }
  }
  return { canonicalPool, poolSnapshot, quote, prepare, verifyTrade }
}
