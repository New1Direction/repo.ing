import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CP_AMM_PROGRAM_ID, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { quoteDisplay } from './trade-quote-display.mjs'
import { readChainPoint } from './chain-clock.mjs'
import { quotePoint } from './launch-fee.mjs'
import { readPoolConfig } from './market-config.mjs'

// Market-maker view of one market (docs/MARKET_DATA_API.md#liquidity): from ONE pool snapshot, the executable depth on each side
// within an average-price impact band, and the quoted spread at reference sizes, both from the SDK's exact integer quotes.
//   depth (impact X%)  the largest buy (SOL in) and the largest sell (tokens in) whose average execution price, excluding the
//                      trading fee, stays within X% of spot (src/trade-quote-display.mjs);
//   quoted spread      (ask − bid) / spot for a buy of S SOL and a sell of the tokens S SOL buys at spot, fees included: what a
//                      round trip of that size costs right now, before anyone else trades.
// Before graduation the bonding curve is the only liquidity (nobody can add any); after graduation the DAMM v2 pool's liquidity
// comes from its LP positions (src/lp-positions.mjs). Figures are a snapshot, never a promise about execution.

export const IMPACT_PERCENTS = Object.freeze([1, 2, 5])
export const SPREAD_SIZES_LAMPORTS = Object.freeze([100_000_000n, 1_000_000_000n])
// The impact band and reference size stored per sample and used by uptime and sustained-liquidity metrics.
export const SAMPLE_IMPACT_PERCENT = 2
export const SAMPLE_SPREAD_LAMPORTS = 100_000_000n
export const PROFILE_VERSION = 1
const Q128 = 1n << 128n

const big = value => BigInt(value?.toString?.() ?? value)

// Largest amount in [0, max] for which fits(amount) holds, assuming fits is monotone (true up to a point, then false).
export function largestFitting(max, fits) {
  let low = 0n, high = big(max)
  if (high <= 0n) return 0n
  while (low < high) {
    const mid = (low + high + 1n) / 2n
    let ok = false
    try { ok = Boolean(fits(mid)) } catch { ok = false }
    if (ok) low = mid
    else high = mid - 1n
  }
  return low
}

// quote(direction, amountIn) → { outputAmount, fee } (bigints; fee in SOL lamports) or throws when not executable.
const impactOf = (direction, amountIn, quoted, sqrtPrice) => quoteDisplay({ direction, input: amountIn.toString(),
  output: quoted.outputAmount.toString(), sqrtPrice: sqrtPrice.toString(), fee: quoted.fee.toString() }).priceImpactPercent

// Ratio (scaled by 10^6) of an average price to spot: lamports/tokens ÷ (sqrt² / 2^128).
const ratioToSpot = (lamports, tokens, spot) => tokens > 0n && spot > 0n ? lamports * Q128 * 1_000_000n / (tokens * spot) : null

export function liquidityProfile({ sqrtPrice, quote, maxBuyLamports, maxSellBaseUnits, impacts = IMPACT_PERCENTS, spreadSizes = SPREAD_SIZES_LAMPORTS }) {
  const sqrt = big(sqrtPrice)
  if (sqrt <= 0n || typeof quote !== 'function') throw new Error('Invalid liquidity snapshot')
  const spot = sqrt * sqrt
  const fits = (direction, percent) => amount => {
    const quoted = quote(direction, amount)
    return quoted.outputAmount > 0n && impactOf(direction, amount, quoted, sqrt) <= percent
  }
  const depth = impacts.map(percent => {
    const buyLamports = largestFitting(maxBuyLamports, fits('buy', percent))
    const sellTokens = largestFitting(maxSellBaseUnits, fits('sell', percent))
    let buyTokens = 0n, sellLamports = 0n
    try { if (buyLamports > 0n) buyTokens = quote('buy', buyLamports).outputAmount } catch { buyTokens = 0n }
    try { if (sellTokens > 0n) sellLamports = quote('sell', sellTokens).outputAmount } catch { sellLamports = 0n }
    return { impactPercent: percent, buyLamports: buyLamports.toString(), buyTokens: buyTokens.toString(),
      sellTokens: sellTokens.toString(), sellLamports: sellLamports.toString() }
  })
  const spreads = spreadSizes.map(size => {
    const lamports = big(size)
    let ask = null, bid = null
    try { const buy = quote('buy', lamports); ask = ratioToSpot(lamports, buy.outputAmount, spot) } catch { ask = null }
    const tokensIn = lamports * Q128 / spot
    try { if (tokensIn > 0n) { const sell = quote('sell', tokensIn); bid = ratioToSpot(sell.outputAmount, tokensIn, spot) } } catch { bid = null }
    const spreadBps = ask !== null && bid !== null ? Number((ask - bid) / 100n) : null
    return { sizeLamports: lamports.toString(), askToSpotPpm: ask?.toString() ?? null, bidToSpotPpm: bid?.toString() ?? null,
      spreadBps: spreadBps === null ? null : Math.max(0, spreadBps) }
  })
  // The fee a small buy pays right now (launch-fee pools charge more in their first 180 seconds).
  let feeBps = null
  try { const probe = quote('buy', 10_000_000n); feeBps = Number(probe.fee * 10_000n / 10_000_000n) } catch { feeBps = null }
  return { version: PROFILE_VERSION, sqrtPrice: sqrt.toString(), lamportsPerToken: spotLamportsPerToken(sqrt), feeBps, depth, spreads }
}

// SOL lamports per whole token (6 decimals) at this sqrt price, as a decimal string with 9 significant decimals.
export function spotLamportsPerToken(sqrtPrice) {
  const scaled = big(sqrtPrice) ** 2n * 1_000_000n * 1_000_000_000n / Q128
  const whole = scaled / 1_000_000_000n, fraction = (scaled % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

// The stored sample's summary of a profile: depth at SAMPLE_IMPACT_PERCENT and the spread at SAMPLE_SPREAD_LAMPORTS.
export function sampleSummary(profile) {
  const band = profile.depth.find(row => row.impactPercent === SAMPLE_IMPACT_PERCENT) ?? { buyLamports: '0', sellLamports: '0' }
  const spread = profile.spreads.find(row => row.sizeLamports === SAMPLE_SPREAD_LAMPORTS.toString())?.spreadBps ?? null
  const buy = BigInt(band.buyLamports), sell = BigInt(band.sellLamports)
  return { buyDepthLamports: buy.toString(), sellDepthLamports: sell.toString(), spreadBps: spread, twoSided: buy > 0n && sell > 0n,
    feeBps: profile.feeBps ?? 0 }
}

// Curve snapshot: a DBC pool and its config; quotes at the confirmed chain clock clamped to activation (src/canonical-trade.mjs).
export async function curveSnapshot({ connection, market, configKey }) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const [state, fixed] = await Promise.all([dbc.state.getPool(new PublicKey(market.pool)), readPoolConfig(dbc, new PublicKey(configKey))])
  if (!state || !fixed || state.poolState.isMigrated || state.poolState.baseMint.toBase58() !== market.mint || fixed.collectFeeMode !== 0) {
    throw new Error('Curve snapshot unavailable')
  }
  const currentPoint = quotePoint(await readChainPoint(connection, fixed.activationType), state.poolState.activationPoint)
  const quote = (direction, amountIn) => {
    const result = dbc.pool.swapQuote({ virtualPool: state, config: fixed, swapBaseForQuote: direction === 'sell',
      amountIn: new BN(amountIn.toString()), slippageBps: 0, hasReferral: false, eligibleForFirstSwapWithMinFee: false, currentPoint })
    const outputAmount = big(result.outputAmount)
    if (outputAmount <= 0n) throw new Error('No executable output')
    return { outputAmount, fee: big(result.tradingFee) + big(result.protocolFee) + big(result.referralFee) }
  }
  const quoteReserve = big(state.poolState.quoteReserve)
  const threshold = big(fixed.migrationQuoteThreshold)
  return { venue: 'curve', pool: market.pool, sqrtPrice: big(state.poolState.sqrtPrice), quoteReserve, quote, thresholdLamports: threshold,
    // A buy beyond the remaining curve fills partially, so the search stops at twice the graduation threshold; a sell can never
    // return more SOL than the reserve, so tokens worth twice the reserve at spot bound it.
    maxBuyLamports: threshold * 2n, maxSellBaseUnits: maxSellFor(quoteReserve, big(state.poolState.sqrtPrice)) }
}

// Graduated snapshot: the verified DAMM v2 pool (graduation_events.pool) with SOL-only fees.
export async function dammSnapshot({ connection, market, pool }) {
  const amm = new CpAmm(connection)
  const info = await connection.getAccountInfo(new PublicKey(pool), 'confirmed')
  if (!info?.owner.equals(CP_AMM_PROGRAM_ID)) throw new Error('DAMM pool unavailable')
  const poolState = amm._program.coder.accounts.decode('pool', info.data)
  if (poolState.tokenAMint.toBase58() !== market.mint || !poolState.tokenBMint.equals(NATIVE_MINT) || poolState.collectFeeMode !== 1) {
    throw new Error('DAMM pool unavailable')
  }
  const currentPoint = await readChainPoint(connection, poolState.activationType)
  const quote = (direction, amountIn) => {
    const result = amm.getQuote2({ inputTokenMint: direction === 'buy' ? NATIVE_MINT : poolState.tokenAMint, poolState, currentPoint,
      amountIn: new BN(amountIn.toString()), slippage: 0, swapMode: SwapMode.ExactIn, tokenADecimal: 6, tokenBDecimal: 9, hasReferral: false })
    const outputAmount = big(result.outputAmount)
    if (!result.amountLeft.isZero() || outputAmount <= 0n) throw new Error('No executable output')
    return { outputAmount, fee: big(result.claimingFee) + big(result.compoundingFee) + big(result.protocolFee) + big(result.referralFee) }
  }
  const sqrtPrice = big(poolState.sqrtPrice)
  const vault = await connection.getTokenAccountBalance(poolState.tokenBVault, 'confirmed').catch(() => null)
  const quoteReserve = vault?.value?.amount ? BigInt(vault.value.amount) : null
  const reserveBound = quoteReserve ?? 10_000_000_000_000n
  return { venue: 'damm', pool, sqrtPrice, quoteReserve, quote, poolLiquidity: big(poolState.liquidity),
    maxBuyLamports: reserveBound * 4n, maxSellBaseUnits: maxSellFor(reserveBound, sqrtPrice) }
}

function maxSellFor(quoteReserve, sqrtPrice) {
  const spot = sqrtPrice * sqrtPrice
  if (spot <= 0n) return 0n
  const tokens = quoteReserve * 2n * Q128 / spot
  return tokens > 18_446_744_073_709_551_615n ? 18_446_744_073_709_551_615n : tokens
}

// A full profile from a snapshot (either venue).
export function snapshotProfile(snapshot) {
  const profile = liquidityProfile({ sqrtPrice: snapshot.sqrtPrice, quote: snapshot.quote,
    maxBuyLamports: snapshot.maxBuyLamports, maxSellBaseUnits: snapshot.maxSellBaseUnits })
  return { ...profile, venue: snapshot.venue, pool: snapshot.pool,
    thresholdLamports: snapshot.thresholdLamports === undefined ? null : snapshot.thresholdLamports.toString(),
    quoteReserveLamports: snapshot.quoteReserve === null || snapshot.quoteReserve === undefined ? null : snapshot.quoteReserve.toString() }
}
