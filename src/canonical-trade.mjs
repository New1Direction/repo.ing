import BN from 'bn.js'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'
import { estimateBuySizes } from './trade-depth.mjs'
import { createQuoteAwareConfigResolver, readPoolConfig } from './market-config.mjs'
import { readChainPoint } from './chain-clock.mjs'
import { launchFeeJson, poolFeeFacts, quotePoint } from './launch-fee.mjs'
import { quoteDisplay } from './trade-quote-display.mjs'
import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { markets } from './db/schema.mjs'
import { keptWsolRent, parseReferrer, resolveReferral } from './referral.mjs'
import { ATA_PROGRAM, createWsolAtaInstruction, isCreateWsolAta, TOKEN_PROGRAM, wsolAta } from './wsol-account.mjs'
import { broadcastUntilSettled, readTradeComputeBudget, withPriorityFee } from './trade-landing.mjs'
import { preparedFromRecord, readTradeRecord, serializeUnsigned, TRADE_RECORD_VERSION } from './trade-record.mjs'
import { DEFAULT_SLIPPAGE_BPS, minimumOutAfterSlippage, parseSlippageBps } from './trade-slippage.mjs'
import { quoteOfMarket } from './quote-assets.mjs'

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])
const REFERRAL_SLOT = 12

// One exact-input curve quote at the trader's tolerance. The SDK's minimum output must equal an independent floor of
// its output at the same tolerance before anything is signed (the same agreement check the DAMM trader makes).
export function dbcSwapQuote({ dbc, virtualPool, config, direction, amountIn, currentPoint, slippageBps }) {
  const result = dbc.pool.swapQuote({ virtualPool, config, swapBaseForQuote: direction === 'sell', amountIn, slippageBps,
    hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint })
  const output = BigInt(result.outputAmount?.toString() ?? '0'), minimum = BigInt(result.minimumAmountOut?.toString() ?? '0')
  if (output <= 0n || minimum <= 0n || minimum !== minimumOutAfterSlippage(output, slippageBps)) throw new Error('No executable output quote')
  return result
}

// The one DBC swap must carry the quoted amounts, the canonical accounts, and in its referral slot exactly the
// server-resolved referral account (or the program ID for none). No other instruction may touch that account.
// Account setup is the wallet's own, and after the single WSOL close only the kept-ATA re-create may follow (keepWsol).
// Compute budget: at most one unit limit and one unit price, both first and within the configured maximums.
export function assertPreparedDbcSwap(tx, { wallet, pool, config, mint, amountIn, minimumAmountOut, referral = null, keepWsol = false }) {
  readTradeComputeBudget(tx.instructions)
  const swaps = tx.instructions.filter(ix => ix.programId.equals(DBC_PROGRAM))
  const ix = swaps[0], k = ix?.keys.map(key => key.pubkey) ?? []
  if (swaps.length !== 1 || ix.data.length !== 24 || !ix.data.subarray(0, 8).equals(SWAP_DISCRIMINATOR) ||
      ix.data.readBigUInt64LE(8) !== amountIn || ix.data.readBigUInt64LE(16) !== minimumAmountOut ||
      !k[1]?.equals(config) || !k[2]?.equals(pool) || !k[7]?.equals(mint) || !k[8]?.equals(NATIVE_MINT) || !k[9]?.equals(wallet) ||
      !k[REFERRAL_SLOT]?.equals(referral ?? DBC_PROGRAM) || (referral && !ix.keys[REFERRAL_SLOT].isWritable)) {
    throw new Error('Trade transaction swap does not match the quote')
  }
  if (referral && tx.instructions.some(other => other !== ix && other.keys.some(key => key.pubkey.equals(referral)))) {
    throw new Error('Trade transaction swap does not match the quote')
  }
  const wsol = wsolAta(wallet)
  const closes = tx.instructions.flatMap((other, position) => other.programId.equals(TOKEN_PROGRAM) && other.data.length === 1 &&
    other.data[0] === 9 ? [position] : [])
  const close = tx.instructions[closes[0]]?.keys.map(key => key.pubkey) ?? []
  if (closes.length !== 1 || !close[0]?.equals(wsol) || !close[1]?.equals(wallet) || !close[2]?.equals(wallet)) {
    throw new Error('Trade transaction swap does not match the quote')
  }
  const after = tx.instructions.slice(closes[0] + 1)
  if (after.length !== (keepWsol ? 1 : 0) || (keepWsol && !isCreateWsolAta(after[0], wallet))) {
    throw new Error('Trade transaction contains an unexpected instruction after the WSOL close')
  }
  for (const setup of tx.instructions.slice(0, closes[0]).filter(other => other.programId.equals(ATA_PROGRAM))) {
    const k = setup.keys.map(key => key.pubkey)
    if (!k[0]?.equals(wallet) || !k[2]?.equals(wallet)) throw new Error('Trade transaction contains an unexpected account setup')
  }
}

// A stock-paired market's curve swap (docs/STOCK_QUOTES.md): the one DBC swap carries the quoted amounts and the canonical
// accounts with the stock as its quote and no referral (referrals pay through wrapped SOL). Nothing is wrapped or closed:
// besides the compute budget, the only other instructions are the wallet's own token accounts for the market token or the stock.
export function assertPreparedStockDbcSwap(tx, { wallet, pool, config, mint, quoteMint, amountIn, minimumAmountOut }) {
  readTradeComputeBudget(tx.instructions)
  const swaps = tx.instructions.filter(ix => ix.programId.equals(DBC_PROGRAM))
  const ix = swaps[0], k = ix?.keys.map(key => key.pubkey) ?? []
  if (swaps.length !== 1 || ix.data.length !== 24 || !ix.data.subarray(0, 8).equals(SWAP_DISCRIMINATOR) ||
      ix.data.readBigUInt64LE(8) !== amountIn || ix.data.readBigUInt64LE(16) !== minimumAmountOut ||
      !k[1]?.equals(config) || !k[2]?.equals(pool) || !k[7]?.equals(mint) || !k[8]?.equals(quoteMint) || !k[9]?.equals(wallet) ||
      !k[REFERRAL_SLOT]?.equals(DBC_PROGRAM)) {
    throw new Error('Trade transaction swap does not match the quote')
  }
  for (const other of tx.instructions) {
    if (other === ix || other.programId.equals(ComputeBudgetProgram.programId)) continue
    const accounts = other.keys.map(key => key.pubkey)
    if (other.programId.equals(ATA_PROGRAM) && accounts[0]?.equals(wallet) && accounts[2]?.equals(wallet) &&
        (accounts[3]?.equals(mint) || accounts[3]?.equals(quoteMint))) continue
    throw new Error('Trade transaction contains an unexpected instruction')
  }
}

// Wallet-side settlement of one confirmed stock-paired curve swap, in raw units of each token: an exact-input buy spends exactly
// amountIn of the stock for at least the minimum of the market token; a sell gives exactly amountIn of the market token for at
// least the minimum of the stock. The pool's stock vault moves the other way.
export function assertStockDbcSettlement({ direction, amountIn, minimumAmountOut, tokenDelta, quoteDelta, quoteVaultDelta }) {
  if (direction === 'buy') {
    if (tokenDelta < minimumAmountOut || quoteDelta !== -amountIn || quoteVaultDelta <= 0n) {
      throw new Error('Buy balances or canonical pool vault did not change as expected')
    }
  } else if (tokenDelta !== -amountIn || quoteDelta < minimumAmountOut || quoteVaultDelta >= 0n) {
    throw new Error('Sell balances or canonical pool vault did not change as expected')
  }
}

// Wallet-side settlement of one confirmed curve swap. meta.fee (base plus priority fee) is part of walletSol, so a
// sell's proceeds are judged before it: a priority fee larger than a dust sale's proceeds is not a settlement failure.
export function assertDbcSettlement({ direction, amountIn, minimumAmountOut, tokenDelta, walletSol, fee, quoteVaultDelta }) {
  if (direction === 'buy') {
    if (tokenDelta < minimumAmountOut || walletSol > -amountIn || quoteVaultDelta <= 0n) {
      throw new Error('Buy balances or canonical pool vault did not change as expected')
    }
  } else if (tokenDelta !== -amountIn || walletSol + fee <= 0n || walletSol + fee < minimumAmountOut || quoteVaultDelta >= 0n) {
    throw new Error('Sell balances or canonical pool vault did not change as expected')
  }
}

export function createCanonicalTrader({ pool: databasePool, connection, config, loadMarket: marketLoader = null }) {
  const db = drizzle(databasePool)
  // SOL markets on the approved configs; a stock-paired market on its stock's config (docs/STOCK_QUOTES.md).
  const resolveConfig = createQuoteAwareConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const loadMarket = marketLoader ?? (async repoId => {
    const market = (await db.select().from(markets).where(eq(markets.githubRepoId, BigInt(repoId))).limit(1))[0]
    if (!market || market.status !== 'confirmed' || market.indexedAt === null || market.launchFinality !== 'finalized') {
      throw new Error('Repository has no indexed canonical market')
    }
    return market
  })
  const quote = async (request, direction) => {
    if ('pool' in request || 'mint' in request || 'market' in request) throw new Error('Pool and mint are selected by canonical repository ID only')
    const slippageBps = parseSlippageBps(request.slippageBps)
    const input = BigInt(direction === 'buy' ? request.amountLamports : request.amountBaseUnits)
    if (input <= 0n || input > 18446744073709551615n) throw new Error('Input amount must be a positive u64 base-unit integer')
    const market = await loadMarket(request.githubRepoId)
    const configKey = resolveConfig(market)
    const mint = new PublicKey(market.mint)
    const pool = new PublicKey(market.pool)
    const quoteAsset = quoteOfMarket(market)
    const quoteMint = quoteAsset.type === 'SOL' ? NATIVE_MINT : new PublicKey(quoteAsset.mint)
    if (!deriveDbcPoolAddress(quoteMint, mint, configKey).equals(pool)) throw new Error('Canonical pool does not match fixed DBC config')
    const state = await dbc.state.getPool(pool)
    if (!state || !state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(mint) || state.poolState.isMigrated !== 0) {
      throw new Error('Canonical DBC pool is missing, changed, or migrated')
    }
    const fixed = await readPoolConfig(dbc, configKey)
    if (!fixed) throw new Error('Fixed DBC config is missing')
    const amountIn = new BN(input.toString())
    // The fee a launch-fee pool charges falls every second after activation, so quote at the chain's confirmed
    // clock (never later than the slot that executes the trade): the executed fee can only be lower, so the
    // output can only be higher than quoted and the minimum stays safe. Flat configs ignore the point.
    const currentPoint = quotePoint(await readChainPoint(connection, fixed.activationType), state.poolState.activationPoint)
    const result = dbcSwapQuote({ dbc, virtualPool: state, config: fixed, direction, amountIn, currentPoint, slippageBps })
    const fees = poolFeeFacts(fixed, state.poolState.activationPoint, currentPoint)
    return { market, pool, amountIn, result, slippageBps, sqrtPrice: state.poolState.sqrtPrice, collectFeeMode: fixed.collectFeeMode, quoteAsset, ...fees }
  }
  const prepare = async (request, direction, quoted = null) => {
    const wallet = new PublicKey(request.wallet)
    const { market, pool, amountIn, result, slippageBps, collectFeeMode, launchFee, quoteAsset } = quoted || await quote(request, direction)
    const mint = new PublicKey(market.mint)
    // A stock-paired market: no referral and no wrapped SOL; its swap is asserted by assertPreparedStockDbcSwap.
    const stock = quoteAsset.type !== 'SOL'
    const [referral, wsolRent] = stock ? [null, null]
      : await Promise.all([resolveReferral(connection, request.referrer, wallet), keptWsolRent(connection, wallet)])
    const keepWsol = wsolRent !== null
    const swapTx = await dbc.pool.swap({ owner: wallet, payer: wallet, pool, amountIn,
      minimumAmountOut: result.minimumAmountOut, swapBaseForQuote: direction === 'sell', referralTokenAccount: referral })
    if (keepWsol) swapTx.add(createWsolAtaInstruction(wallet))
    const expected = { wallet, pool, config: resolveConfig(market), mint, amountIn: BigInt(amountIn.toString()),
      minimumAmountOut: BigInt(result.minimumAmountOut.toString()), referral, keepWsol,
      ...stock ? { quoteMint: new PublicKey(quoteAsset.mint) } : {} }
    const assertSwap = stock ? assertPreparedStockDbcSwap : assertPreparedDbcSwap
    assertSwap(swapTx, expected)
    const latest = await connection.getLatestBlockhash('confirmed')
    // Priority is priced on the curve and its two vaults (swap accounts 2, 5, 6): the accounts every trade contends for.
    const vaults = swapTx.instructions.find(ix => ix.programId.equals(DBC_PROGRAM)).keys
    const landing = await withPriorityFee(connection, swapTx, { feePayer: wallet, blockhash: latest.blockhash,
      writableAccounts: [pool, vaults[5].pubkey, vaults[6].pubkey] })
    const tx = landing.transaction
    assertSwap(tx, expected)
    // Everything submit and verification need, as plain JSON: any instance can finish the trade (see trade-record.mjs).
    const record = Object.freeze({ v: TRADE_RECORD_VERSION, phase: 'curve', direction, wallet: wallet.toBase58(), marketId: market.id,
      githubRepoId: String(market.githubRepoId), mint: market.mint, pool: market.pool, referral: referral?.toBase58() ?? null,
      wsolRent: wsolRent === null ? null : wsolRent.toString(), amountIn: amountIn.toString(), minimumAmountOut: result.minimumAmountOut.toString(),
      message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx),
      blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, slippageBps,
      priorityFee: { computeUnitLimit: landing.computeUnitLimit, microLamports: landing.microLamports, lamports: landing.priorityFeeLamports.toString() },
      // Display only (Solana Actions message): the launch fee quoted for this trade while the window is open.
      launchFee: launchFee?.active ? launchFeeJson(launchFee) : null,
      // Referral leaderboard only (estimated earnings): the wallet behind `referral` and the quoted SOL trading fee.
      referrer: referral ? parseReferrer(request.referrer).toBase58() : null,
      tradingFeeLamports: !stock && collectFeeMode === 0 ? result.tradingFee.add(result.protocolFee).add(result.referralFee).toString() : null,
      ...stock ? { quoteMint: quoteAsset.mint } : {} })
    return preparedFromRecord(record, tx)
  }
  const verifyTrade = async (prepared, signature) => {
    const saved = readTradeRecord(prepared?.record, 'curve')
    const market = await loadMarket(saved.githubRepoId)
    const configKey = resolveConfig(market)
    if (market.id !== saved.marketId || market.mint !== saved.mint.toBase58() || market.pool !== saved.pool.toBase58()) {
      throw new Error('Canonical market changed before trade verification')
    }
    let tx
    for (let attempt = 0; attempt < 12; attempt++) {
      tx = await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      if (tx) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!tx || !tx.meta || tx.meta.err) throw new Error('Trade transaction is missing or failed')
    const message = tx.transaction.message
    const keys = message.accountKeys
    const keyAt = (index, expected) => keys[index]?.equals(expected)
    // The market's stamped quote must be the one this trade was prepared with.
    const quoteAsset = quoteOfMarket(market)
    if ((quoteAsset.type === 'SOL' ? null : quoteAsset.mint) !== (saved.quoteMint?.toBase58() ?? null)) {
      throw new Error('Canonical market changed before trade verification')
    }
    const quoteMint = saved.quoteMint ?? NATIVE_MINT
    const swap = message.instructions?.find(ix => keyAt(ix.programIdIndex, DBC_PROGRAM) &&
      Buffer.from(bs58.decode(ix.data)).subarray(0, 8).equals(SWAP_DISCRIMINATOR) &&
      keyAt(ix.accounts[1], configKey) && keyAt(ix.accounts[2], saved.pool) &&
      keyAt(ix.accounts[7], saved.mint) && keyAt(ix.accounts[8], quoteMint) &&
      keyAt(ix.accounts[9], saved.wallet) && keyAt(ix.accounts[REFERRAL_SLOT], saved.referral ?? DBC_PROGRAM))
    const walletIndex = keys.findIndex(key => key.equals(saved.wallet))
    if (!swap || walletIndex < 0 || walletIndex >= message.header.numRequiredSignatures) {
      throw new Error('Transaction did not swap the canonical pool with the user wallet')
    }
    const solDelta = BigInt(tx.meta.postBalances[walletIndex]) - BigInt(tx.meta.preBalances[walletIndex])
    if (saved.quoteMint) return verifyStockSettlement({ tx, keys, swap, saved, market, configKey, solDelta, signature })
    // Wallet plus its WSOL ATA: WSOL unwrapped on close and rent re-paid to a kept ATA are transfers inside this sum.
    const wsolIndex = keys.findIndex(key => key.equals(wsolAta(saved.wallet)))
    const wsolAfter = wsolIndex < 0 ? 0n : BigInt(tx.meta.postBalances[wsolIndex])
    const walletSol = solDelta + (wsolIndex < 0 ? 0n : wsolAfter - BigInt(tx.meta.preBalances[wsolIndex]))
    if (saved.wsolRent !== null ? wsolAfter !== saved.wsolRent : wsolAfter !== 0n) throw new Error('Trade balances did not settle to the user wallet')
    const ata = getAssociatedTokenAddressSync(saved.mint, saved.wallet)
    const ataIndex = keys.findIndex(key => key.equals(ata))
    if (ataIndex < 0) throw new Error('Trade transaction omitted wallet token account')
    const amountAt = (balances, accountIndex, mint) => BigInt(
      balances?.find(balance => balance.accountIndex === accountIndex && balance.mint === mint)?.uiTokenAmount.amount ?? '0')
    const tokenDelta = amountAt(tx.meta.postTokenBalances, ataIndex, market.mint) -
      amountAt(tx.meta.preTokenBalances, ataIndex, market.mint)
    const quoteVaultIndex = swap.accounts[6]
    const quoteVaultDelta = amountAt(tx.meta.postTokenBalances, quoteVaultIndex, NATIVE_MINT.toBase58()) -
      amountAt(tx.meta.preTokenBalances, quoteVaultIndex, NATIVE_MINT.toBase58())
    const afterPool = await dbc.state.getPool(saved.pool)
    if (!afterPool || !afterPool.poolState.config.equals(configKey) || !afterPool.poolState.baseMint.equals(saved.mint)) {
      throw new Error('Canonical pool missing or changed after trade')
    }
    assertDbcSettlement({ direction: saved.direction, amountIn: saved.amountIn, minimumAmountOut: saved.minimumAmountOut,
      tokenDelta, walletSol, fee: BigInt(tx.meta.fee), quoteVaultDelta })
    return { signature, direction: saved.direction, mint: market.mint, pool: market.pool,
      tokenDelta, solDelta, quoteVaultDelta, slot: BigInt(tx.slot), minimumAmountOut: saved.minimumAmountOut }
  }
  // The stock-paired branch of verifyTrade: the market token through its SPL account, the stock through the wallet's Token-2022
  // account, both in raw units (a scaled-UI multiplier only changes how wallets display the stock).
  const verifyStockSettlement = async ({ tx, keys, swap, saved, market, configKey, solDelta, signature }) => {
    const amountAt = (balances, accountIndex, mint) => BigInt(
      balances?.find(balance => balance.accountIndex === accountIndex && balance.mint === mint)?.uiTokenAmount.amount ?? '0')
    const delta = (accountIndex, mint) => amountAt(tx.meta.postTokenBalances, accountIndex, mint) - amountAt(tx.meta.preTokenBalances, accountIndex, mint)
    const tokenIndex = keys.findIndex(key => key.equals(getAssociatedTokenAddressSync(saved.mint, saved.wallet)))
    const quoteIndex = keys.findIndex(key => key.equals(getAssociatedTokenAddressSync(saved.quoteMint, saved.wallet, false, TOKEN_2022_PROGRAM_ID)))
    if (tokenIndex < 0 || quoteIndex < 0) throw new Error('Trade transaction omitted wallet token account')
    const quote = saved.quoteMint.toBase58()
    const tokenDelta = delta(tokenIndex, market.mint), quoteDelta = delta(quoteIndex, quote), quoteVaultDelta = delta(swap.accounts[6], quote)
    const afterPool = await dbc.state.getPool(saved.pool)
    if (!afterPool || !afterPool.poolState.config.equals(configKey) || !afterPool.poolState.baseMint.equals(saved.mint)) {
      throw new Error('Canonical pool missing or changed after trade')
    }
    assertStockDbcSettlement({ direction: saved.direction, amountIn: saved.amountIn, minimumAmountOut: saved.minimumAmountOut,
      tokenDelta, quoteDelta, quoteVaultDelta })
    return { signature, direction: saved.direction, mint: market.mint, pool: market.pool, tokenDelta, solDelta, quoteDelta, quoteMint: quote,
      quoteVaultDelta, slot: BigInt(tx.slot), minimumAmountOut: saved.minimumAmountOut }
  }
  const submitTrade = async (prepared, signTransaction) => {
    const saved = readTradeRecord(prepared?.record, 'curve')
    const signed = await signTransaction(prepared.transaction)
    if (!(signed instanceof Transaction) || !matchesReviewedTransaction(saved.message, signed) ||
        !signed.feePayer.equals(saved.wallet) || !signed.verifySignatures()) {
      throw new Error('Wallet returned an altered or unsigned trade transaction')
    }
    const signature = bs58.encode(signed.signature)
    await broadcastUntilSettled(connection, signed.serialize(), { signature, lastValidBlockHeight: saved.lastValidBlockHeight })
    const confirmation = await connection.confirmTransaction({ signature, blockhash: saved.blockhash,
      lastValidBlockHeight: saved.lastValidBlockHeight }, 'confirmed')
    if (confirmation.value.err) throw new Error(`Trade failed: ${JSON.stringify(confirmation.value.err)}`)
    return verifyTrade(prepared, signature)
  }
  const publicQuote = async (request, direction) => {
    const quoted = await quote(request, direction)
    const { result, amountIn, slippageBps, sqrtPrice, collectFeeMode, feeNumerator, launchFee } = quoted
    if (collectFeeMode !== 0) throw Error('Quote fee currency is unsupported')
    const display = quoteDisplay({ direction, input: amountIn.toString(), output: result.outputAmount.toString(),
      sqrtPrice: sqrtPrice.toString(), fee: result.tradingFee.add(result.protocolFee).add(result.referralFee).toString() })
    return { ...display, outputAmount: result.outputAmount.toString(), minimumAmountOut: result.minimumAmountOut.toString(),
      slippageBps, feeNumerator: feeNumerator?.toString() ?? null, launchFee: launchFeeJson(launchFee) }
  }
  const depthCache = new Map()
  async function buyDepth(repoId) {
    const key = String(repoId)
    const cached = depthCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.value
    const market = await loadMarket(repoId), configKey = resolveConfig(market)
    const [state, fixed] = await Promise.all([dbc.state.getPool(market.pool), readPoolConfig(dbc, configKey)])
    if (!state || !fixed || state.poolState.isMigrated || !state.poolState.config.equals(configKey) ||
        state.poolState.baseMint.toBase58() !== market.mint || fixed.collectFeeMode !== 0) throw Error('Trade size guide unavailable')
    const currentPoint = quotePoint(await readChainPoint(connection, fixed.activationType), state.poolState.activationPoint)
    const sizes = estimateBuySizes(BigInt(fixed.migrationQuoteThreshold.toString()) * 2n, input => {
      const result = dbc.pool.swapQuote({ virtualPool: state, config: fixed, swapBaseForQuote: false,
        amountIn: new BN(String(input)), slippageBps: DEFAULT_SLIPPAGE_BPS, hasReferral: false,
        eligibleForFirstSwapWithMinFee: false, currentPoint })
      if (result.minimumAmountOut.lten(0)) throw Error('No executable output')
      return quoteDisplay({ direction: 'buy', input: String(input), output: result.outputAmount.toString(),
        sqrtPrice: state.poolState.sqrtPrice.toString(), fee: result.tradingFee.add(result.protocolFee).add(result.referralFee).toString() }).priceImpactPercent
    })
    const value = { sizes, checkedAt: new Date().toISOString() }
    if (depthCache.size >= 250) depthCache.delete(depthCache.keys().next().value)
    depthCache.set(key, { value, expiresAt: Date.now() + 10000 })
    return value
  }
  return { buyDepth, quoteBuy: request => publicQuote(request, 'buy'), quoteSell: request => publicQuote(request, 'sell'),
    prepareBuy: request => prepare(request, 'buy'), prepareSell: request => prepare(request, 'sell'),
    submitTrade, verifyTrade }
}
