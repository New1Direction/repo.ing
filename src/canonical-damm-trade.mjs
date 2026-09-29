import BN from 'bn.js'
import bs58 from 'bs58'
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CP_AMM_PROGRAM_ID, SwapMode, deriveTokenVaultAddress } from '@meteora-ag/cp-amm-sdk'
import { markets } from './db/schema.mjs'
import { createMarketConfigResolver } from './market-config.mjs'
import { createGraduatedFees } from './graduated-fees.mjs'
import { readChainPoint } from './chain-clock.mjs'
import { quoteDisplay } from './trade-quote-display.mjs'
import { dammSwapEvents } from './damm-trades.mjs'
import { loadTransactionAt } from './finalized-transaction.mjs'
import { keptWsolRent, resolveReferral } from './referral.mjs'
import { createWsolAtaInstruction, isCreateWsolAta } from './wsol-account.mjs'

// Same fixed 1% tolerance and floor rounding as curve trades.
export const DAMM_SLIPPAGE_BPS = 100
const SWAP = '414b3f4ceb5b5b88'
const SWAPS = ['f8c69e91e17587c8', SWAP]
const U64_MAX = 18446744073709551615n
const disc = data => Buffer.from(bs58.decode(data)).subarray(0, 8).toString('hex')
const big = value => BigInt(value.toString())

export const dammMinimumOut = output => BigInt(output) * BigInt(10000 - DAMM_SLIPPAGE_BPS) / 10000n

// Only the migrated SOL pair with SOL-only fees, classic SPL vaults and swaps enabled is tradable here.
export function assertTradablePool(poolState, pool, mint) {
  if (!poolState.tokenAMint.equals(mint) || !poolState.tokenBMint.equals(NATIVE_MINT) || poolState.collectFeeMode !== 1 ||
      poolState.tokenAFlag !== 0 || poolState.tokenBFlag !== 0 || poolState.poolStatus !== 0 ||
      !poolState.tokenAVault.equals(deriveTokenVaultAddress(mint, pool)) ||
      !poolState.tokenBVault.equals(deriveTokenVaultAddress(NATIVE_MINT, pool))) {
    throw Error('Canonical DAMM pool is not tradable')
  }
}

export function dammQuote({ amm, poolState, direction, amountIn, currentPoint }) {
  const quote = amm.getQuote2({ inputTokenMint: direction === 'buy' ? NATIVE_MINT : poolState.tokenAMint, poolState, currentPoint,
    amountIn: new BN(String(amountIn)), slippage: DAMM_SLIPPAGE_BPS, swapMode: SwapMode.ExactIn,
    tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false })
  const outputAmount = big(quote.outputAmount), minimumAmountOut = dammMinimumOut(outputAmount)
  // The SDK slippage argument is basis points; an independent floor must agree before anything is signed.
  if (!quote.amountLeft.isZero() || outputAmount <= 0n || minimumAmountOut <= 0n || big(quote.minimumAmountOut) !== minimumAmountOut) {
    throw Error('No executable output quote')
  }
  const fee = big(quote.claimingFee) + big(quote.compoundingFee) + big(quote.protocolFee) + big(quote.referralFee)
  return { outputAmount, minimumAmountOut, fee }
}

// Compare the exact compiled message, whatever RPC shape returned it.
export function messageFingerprint(message) {
  const h = message.header
  return JSON.stringify({ header: [h.numRequiredSignatures, h.numReadonlySignedAccounts, h.numReadonlyUnsignedAccounts],
    keys: message.accountKeys.map(key => key.toBase58()), blockhash: message.recentBlockhash,
    instructions: message.instructions.map(ix => [ix.programIdIndex, [...ix.accounts], ix.data]),
    lookups: (message.addressTableLookups ?? []).map(l => [String(l.accountKey), [...l.writableIndexes], [...l.readonlyIndexes]]) })
}

// Defense in depth against SDK drift: the unsigned transaction may contain only the user's own ATA setup,
// the exact SOL wrap, one ExactIn swap2 on the proven pool, and the WSOL close back to the user.
// The referral slot holds exactly the server-resolved referral account, or the program ID when there is none.
// keepWsol: the wallet's WSOL ATA existed before the trade, so exactly one idempotent re-create of it follows the close.
export function assertPreparedSwap(tx, { wallet, pool, poolState, direction, amountIn, minimumAmountOut, referral = null, keepWsol = false }) {
  const mint = poolState.tokenAMint
  const tokenAta = getAssociatedTokenAddressSync(mint, wallet), wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, wallet)
  const [input, output] = direction === 'buy' ? [wsolAta, tokenAta] : [tokenAta, wsolAta]
  let swaps = 0, wraps = 0, closes = 0, recreates = 0
  for (const [position, ix] of tx.instructions.entries()) {
    const k = ix.keys.map(key => key.pubkey)
    if (closes > 0) {
      if (!keepWsol || position !== tx.instructions.length - 1 || !isCreateWsolAta(ix, wallet)) throw Error('Trade transaction contains an unexpected instruction after the WSOL close')
      recreates++
    } else if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (ix.data.length !== 1 || ix.data[0] !== 1 || !k[0]?.equals(wallet) || !k[2]?.equals(wallet) ||
          !(k[1]?.equals(tokenAta) && k[3]?.equals(mint) || k[1]?.equals(wsolAta) && k[3]?.equals(NATIVE_MINT))) throw Error('Trade transaction contains an unexpected account setup')
    } else if (ix.programId.equals(SystemProgram.programId)) {
      if (direction !== 'buy' || ix.data.length !== 12 || ix.data.readUInt32LE(0) !== 2 || ix.data.readBigUInt64LE(4) !== amountIn ||
          !k[0]?.equals(wallet) || !k[1]?.equals(wsolAta)) throw Error('Trade transaction contains an unexpected SOL transfer')
      wraps++
    } else if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      const sync = ix.data.length === 1 && ix.data[0] === 17 && k.length === 1 && k[0].equals(wsolAta) && direction === 'buy'
      const close = ix.data.length === 1 && ix.data[0] === 9 && k[0]?.equals(wsolAta) && k[1]?.equals(wallet) && k[2]?.equals(wallet)
      if (!sync && !close) throw Error('Trade transaction contains an unexpected token instruction')
      if (close) closes++
    } else if (ix.programId.equals(CP_AMM_PROGRAM_ID)) {
      const d = ix.data
      if (d.length !== 25 || d.subarray(0, 8).toString('hex') !== SWAP || d.readBigUInt64LE(8) !== amountIn ||
          d.readBigUInt64LE(16) !== minimumAmountOut || d[24] !== SwapMode.ExactIn || !k[1]?.equals(pool) ||
          !k[2]?.equals(input) || !k[3]?.equals(output) || !k[4]?.equals(poolState.tokenAVault) || !k[5]?.equals(poolState.tokenBVault) ||
          !k[6]?.equals(mint) || !k[7]?.equals(NATIVE_MINT) || !k[8]?.equals(wallet) || !k[11]?.equals(referral ?? CP_AMM_PROGRAM_ID)) throw Error('Trade transaction swap does not match the quote')
      swaps++
    } else throw Error('Trade transaction contains an unexpected program')
  }
  if (swaps !== 1 || closes !== 1 || wraps !== (direction === 'buy' ? 1 : 0) || recreates !== (keepWsol ? 1 : 0)) throw Error('Trade transaction swap does not match the quote')
}

// Receipt checks for one confirmed/finalized transaction. `expected` holds what was prepared, never chain-derived values.
export function verifyDammSwapReceipt(tx, expected, coder) {
  if (!tx?.meta || tx.meta.err) throw Error('Trade transaction is missing or failed')
  const { wallet, pool, mint, tokenAVault, tokenBVault, direction, amountIn, minimumAmountOut, referral = null, wsolRent = null } = expected
  const message = tx.transaction.message
  if (tx.transaction.signatures?.[0] !== expected.signature || messageFingerprint(message) !== expected.fingerprint) {
    throw Error('Transaction does not match prepared trade')
  }
  const keys = message.accountKeys
  const instructions = [...message.instructions.map(ix => ({ ix, outer: true })),
    ...(tx.meta.innerInstructions ?? []).flatMap(group => group.instructions.map(ix => ({ ix, outer: false })))]
  const swaps = instructions.filter(({ ix }) => keys[ix.programIdIndex]?.equals(CP_AMM_PROGRAM_ID) && SWAPS.includes(disc(ix.data)))
  const a = swaps[0]?.ix.accounts.map(index => keys[index])
  if (swaps.length !== 1 || !swaps[0].outer || !keys[0]?.equals(wallet) || !a[1]?.equals(pool) || !a[4]?.equals(tokenAVault) ||
      !a[5]?.equals(tokenBVault) || !a[6]?.equals(mint) || !a[7]?.equals(NATIVE_MINT) || !a[8]?.equals(wallet) ||
      !a[11]?.equals(referral ?? CP_AMM_PROGRAM_ID)) {
    throw Error('Transaction did not swap the canonical pool exactly once with the user wallet')
  }
  const events = dammSwapEvents(tx, { mint: mint.toBase58() }, pool.toBase58(), coder)
  const event = events[0]
  if (events.length !== 1 || event.direction !== direction || event.params.swapMode !== SwapMode.ExactIn ||
      BigInt(event.params.amount0) !== amountIn || BigInt(event.params.amount1) !== minimumAmountOut) {
    throw Error('Transaction did not swap the canonical pool in the prepared direction')
  }
  const quoteAmount = BigInt(event.quoteAmount), baseAmount = BigInt(event.baseAmount), referralFee = BigInt(event.referralFee)
  const index = key => keys.findIndex(k => k.equals(key))
  const ix = swaps[0].ix.accounts
  const [solAccount, tokenAccount] = direction === 'buy' ? [ix[2], ix[3]] : [ix[3], ix[2]]
  const tokenAt = (balances, accountIndex, tokenMint) => {
    const row = balances?.find(b => b.accountIndex === accountIndex && b.mint === tokenMint.toBase58())
    return row ? { amount: BigInt(row.uiTokenAmount.amount), owner: row.owner } : { amount: 0n, owner: null }
  }
  const tokenDeltaAt = (accountIndex, tokenMint) => tokenAt(tx.meta.postTokenBalances, accountIndex, tokenMint).amount -
    tokenAt(tx.meta.preTokenBalances, accountIndex, tokenMint).amount
  const owner = tokenAt(tx.meta.postTokenBalances, tokenAccount, mint).owner ?? tokenAt(tx.meta.preTokenBalances, tokenAccount, mint).owner
  const tokenDelta = tokenDeltaAt(tokenAccount, mint)
  const vaultA = tokenDeltaAt(index(tokenAVault), mint), vaultB = tokenDeltaAt(index(tokenBVault), NATIVE_MINT)
  // The SOL referral share leaves the SOL vault to the prepared referral account only; without one it must be zero.
  if (referral ? tokenDeltaAt(index(referral), NATIVE_MINT) !== referralFee : referralFee !== 0n) {
    throw Error('Trade referral fee did not settle to the prepared referral account')
  }
  const lamports = i => BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i])
  const solDelta = lamports(0)
  // Wallet SOL plus its own swap accounts, before the network fee: rent in and out nets to zero. Any WSOL already in a
  // kept ATA (e.g. referral earnings) moves ATA -> wallet on close and the re-create moves rent wallet -> ATA; both are
  // transfers inside this sum, so it stays exactly -amountIn (buy) or the SOL received (sell).
  const walletSwapSol = solDelta + lamports(solAccount) + lamports(tokenAccount) + BigInt(tx.meta.fee)
  const solAccountAfter = BigInt(tx.meta.postBalances[solAccount])
  const kept = tokenAt(tx.meta.postTokenBalances, solAccount, NATIVE_MINT)
  // wsolRent: the ATA pre-existed and was re-created, so it must end holding exactly that rent and 0 WSOL.
  const settled = wsolRent !== null ? solAccountAfter === wsolRent && kept.owner === wallet.toBase58() && kept.amount === 0n : solAccountAfter === 0n
  if (owner !== wallet.toBase58() || !settled) {
    throw Error('Trade balances did not settle to the user wallet')
  }
  if (direction === 'buy') {
    if (quoteAmount !== amountIn || baseAmount < minimumAmountOut || tokenDelta !== baseAmount ||
        vaultA !== -baseAmount || vaultB !== amountIn - referralFee || walletSwapSol > -amountIn) throw Error('Buy balances or canonical pool vault did not change as expected')
  } else if (baseAmount !== amountIn || quoteAmount < minimumAmountOut || tokenDelta !== -amountIn ||
      vaultA !== amountIn || vaultB !== -(quoteAmount + referralFee) || walletSwapSol < minimumAmountOut || walletSwapSol > quoteAmount) {
    throw Error('Sell balances or canonical pool vault did not change as expected')
  }
  return { tokenDelta, solDelta, quoteAmount, baseAmount, referralFee, slot: BigInt(tx.slot) }
}

export function createDammTrader({ pool: databasePool, connection, config, graduatedFees = null, loadTransaction = loadTransactionAt, loadMarket: marketLoader = null }) {
  const resolveConfig = createMarketConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const amm = new CpAmm(connection)
  const proofs = graduatedFees ?? createGraduatedFees({ connection, config, db: databasePool })
  const destinations = new Map()
  const preparedState = new WeakMap()
  const loadMarket = marketLoader ?? (async repoId => {
    const market = (await drizzle(databasePool).select().from(markets).where(eq(markets.githubRepoId, BigInt(repoId))).limit(1))[0]
    if (!market || market.status !== 'confirmed' || market.indexedAt === null || market.launchFinality !== 'finalized') {
      throw new Error('Repository has no indexed canonical market')
    }
    return market
  })
  // A curve migrates once, so a migrated answer is permanent; an active answer is always re-read.
  const migrated = new Set()
  const isMigrated = async repoId => {
    const market = await loadMarket(repoId)
    const key = `${market.id}:${market.pool}`
    if (migrated.has(key)) return true
    const configKey = resolveConfig(market), mint = new PublicKey(market.mint), curve = new PublicKey(market.pool)
    if (!deriveDbcPoolAddress(NATIVE_MINT, mint, configKey).equals(curve)) throw Error('Canonical pool does not match fixed DBC config')
    const state = await dbc.state.getPool(curve)
    if (!state || !state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(mint)) throw Error('Canonical DBC pool is missing or changed')
    if (!state.poolState.isMigrated) return false
    if (migrated.size >= 1000) migrated.delete(migrated.values().next().value)
    migrated.add(key)
    return true
  }
  // The pool address is immutable once proven by the finalized migrate instruction; pool state is re-read every time.
  const canonicalPool = async market => {
    const key = `${market.id}:${market.pool}:${market.mint}`
    if (destinations.has(key)) return destinations.get(key)
    const proven = await proofs.destination(market)
    if (!proven) throw Error('Canonical market has not graduated')
    if (destinations.size >= 1000) destinations.delete(destinations.keys().next().value)
    destinations.set(key, proven.target)
    return proven.target
  }
  const poolSnapshot = async market => {
    const pool = await canonicalPool(market), mint = new PublicKey(market.mint)
    const info = await connection.getAccountInfo(pool, 'confirmed')
    if (!info?.owner.equals(CP_AMM_PROGRAM_ID)) throw Error('Canonical DAMM pool is missing')
    const poolState = amm._program.coder.accounts.decode('pool', info.data)
    assertTradablePool(poolState, pool, mint)
    return { pool, mint, poolState }
  }
  const quote = async (request, direction) => {
    if ('pool' in request || 'mint' in request || 'market' in request) throw new Error('Pool and mint are selected by canonical repository ID only')
    const input = BigInt(direction === 'buy' ? request.amountLamports : request.amountBaseUnits)
    if (input <= 0n || input > U64_MAX) throw new Error('Input amount must be a positive u64 base-unit integer')
    const market = await loadMarket(request.githubRepoId)
    const { pool, mint, poolState } = await poolSnapshot(market)
    const currentPoint = await readChainPoint(connection, poolState.activationType)
    return { market, pool, mint, poolState, amountIn: input, ...dammQuote({ amm, poolState, direction, amountIn: input, currentPoint }) }
  }
  const prepare = async (request, direction) => {
    const wallet = new PublicKey(request.wallet)
    const { market, pool, mint, poolState, amountIn, minimumAmountOut } = await quote(request, direction)
    const [referral, wsolRent] = await Promise.all([resolveReferral(connection, request.referrer, wallet), keptWsolRent(connection, wallet)])
    const keepWsol = wsolRent !== null
    const tx = await amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, outputTokenMint: direction === 'buy' ? mint : NATIVE_MINT,
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: referral,
      amountIn: new BN(amountIn.toString()), minimumAmountOut: new BN(minimumAmountOut.toString()) })
    if (keepWsol) tx.add(createWsolAtaInstruction(wallet))
    assertPreparedSwap(tx, { wallet, pool, poolState, direction, amountIn, minimumAmountOut, referral, keepWsol })
    const latest = await connection.getLatestBlockhash('confirmed')
    tx.feePayer = wallet
    tx.recentBlockhash = latest.blockhash
    const prepared = { transaction: tx, direction, amountIn, minimumAmountOut, lastValidBlockHeight: latest.lastValidBlockHeight,
      githubRepoId: market.githubRepoId, mint: market.mint, pool: pool.toBase58(), slippageBps: DAMM_SLIPPAGE_BPS, phase: 'graduated',
      referral: referral?.toBase58() ?? null }
    preparedState.set(prepared, { wallet, marketId: market.id, curve: market.pool, mint, pool, referral, wsolRent,
      tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      message: Buffer.from(tx.serializeMessage()), fingerprint: messageFingerprint(tx.compileMessage()),
      blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight })
    return prepared
  }
  const verifyTrade = async (prepared, signature, { commitment = 'confirmed' } = {}) => {
    const saved = preparedState.get(prepared)
    if (!saved) throw new Error('Trade was not prepared by this trader')
    const market = await loadMarket(prepared.githubRepoId)
    if (market.id !== saved.marketId || market.mint !== saved.mint.toBase58() || market.pool !== saved.curve ||
        !(await canonicalPool(market)).equals(saved.pool)) throw new Error('Canonical market changed before trade verification')
    let tx = null
    for (let attempt = 0; attempt < 12 && !tx; attempt++) {
      tx = await loadTransaction(connection, signature, commitment)
      if (!tx) await new Promise(resolve => setTimeout(resolve, 100))
    }
    const receipt = verifyDammSwapReceipt(tx, { signature, fingerprint: saved.fingerprint, wallet: saved.wallet, pool: saved.pool,
      mint: saved.mint, tokenAVault: saved.tokenAVault, tokenBVault: saved.tokenBVault, direction: prepared.direction,
      amountIn: prepared.amountIn, minimumAmountOut: prepared.minimumAmountOut, referral: saved.referral, wsolRent: saved.wsolRent }, amm._program.coder)
    return { signature, direction: prepared.direction, mint: market.mint, pool: prepared.pool, commitment,
      minimumAmountOut: prepared.minimumAmountOut, ...receipt }
  }
  const submitTrade = async (prepared, signTransaction) => {
    const saved = preparedState.get(prepared)
    if (!saved) throw new Error('Trade was not prepared by this trader')
    const signed = await signTransaction(prepared.transaction)
    if (!(signed instanceof Transaction) || !Buffer.from(signed.serializeMessage()).equals(saved.message) ||
        !signed.feePayer.equals(saved.wallet) || !signed.verifySignatures()) {
      throw new Error('Wallet returned an altered or unsigned trade transaction')
    }
    const signature = bs58.encode(signed.signature)
    await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false })
    const confirmation = await connection.confirmTransaction({ signature, blockhash: saved.blockhash,
      lastValidBlockHeight: saved.lastValidBlockHeight }, 'confirmed')
    if (confirmation.value.err) throw new Error(`Trade failed: ${JSON.stringify(confirmation.value.err)}`)
    return verifyTrade(prepared, signature)
  }
  const publicQuote = async (request, direction) => {
    const { amountIn, outputAmount, minimumAmountOut, fee, poolState } = await quote(request, direction)
    const display = quoteDisplay({ direction, input: amountIn.toString(), output: outputAmount.toString(),
      sqrtPrice: poolState.sqrtPrice.toString(), fee: fee.toString() })
    return { ...display, outputAmount: outputAmount.toString(), minimumAmountOut: minimumAmountOut.toString(),
      slippageBps: DAMM_SLIPPAGE_BPS, venue: 'damm' }
  }
  return { phase: 'graduated', isMigrated, buyDepth: async () => { throw Error('Trade size guide unavailable') },
    quoteBuy: request => publicQuote(request, 'buy'), quoteSell: request => publicQuote(request, 'sell'),
    prepareBuy: request => prepare(request, 'buy'), prepareSell: request => prepare(request, 'sell'),
    submitTrade, verifyTrade }
}

// Curve markets keep the unchanged DBC trader; only a curve the chain reports as migrated uses the DAMM trader.
export function createTradeRouter({ curve, graduated }) {
  return async repoId => (await graduated.isMigrated(repoId)) ? graduated : curve
}
