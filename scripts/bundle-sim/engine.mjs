// Offline DBC curve engine on Meteora's own quote math (SDK 1.5.13) for the launch-fee config.
import BN from 'bn.js'
import { Connection } from '@solana/web3.js'
import { DynamicBondingCurveClient, swapQuoteExactIn, swapQuoteExactOut, swapQuotePartialFill } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../../src/launch-curve.mjs'

const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed')
const curve = buildLaunchCurve('launch-fee')
export const config = dbc.pool.normalizeQuoteConfig({ ...curve, ...curve.tokenSupply })
export const THRESHOLD = BigInt(config.migrationQuoteThreshold.toString())
const CREATOR_PCT = BigInt(config.creatorTradingFeePercentage)
const big = value => BigInt(value.toString())
const zero = () => new BN(0)

export class Curve {
  constructor(activation) {
    this.state = { poolState: { sqrtPrice: new BN(config.sqrtStartPrice), baseReserve: zero(), quoteReserve: zero(), activationPoint: new BN(activation),
      volatilityTracker: { lastUpdateTimestamp: zero(), sqrtPriceReference: zero(), volatilityAccumulator: zero(), volatilityReference: zero(), padding: [] } } }
    this.reserve = 0n
    this.graduated = false
    this.swaps = 0
  }
  fees(result) {
    const trading = big(result.tradingFee), protocol = big(result.protocolFee)
    return { total: trading + protocol, protocol, creator: trading * CREATOR_PCT / 100n, partner: trading - trading * CREATOR_PCT / 100n }
  }
  apply(result) { this.state.poolState.sqrtPrice = result.nextSqrtPrice; this.swaps++ }
  // A buy of `lamports` at unix time t; first: the pool-creating swap (minimum fee). Fills the curve at most.
  buy(lamports, t, first = false) {
    if (this.graduated || lamports <= 0n) return null
    let result
    try { result = swapQuoteExactIn(this.state, config, false, new BN(String(lamports)), 0, false, new BN(t), first) }
    catch { result = swapQuotePartialFill(this.state, config, false, new BN(String(lamports)), 0, false, new BN(t), first) }
    const fee = this.fees(result)
    const spent = big(result.includedFeeInputAmount ?? lamports)
    this.reserve += spent - fee.total
    this.apply(result)
    if (this.reserve >= THRESHOLD || big(result.amountLeft ?? 0) > 0n) this.graduated = true
    return { spent, tokens: big(result.outputAmount), fee }
  }
  // A buy that receives exactly `tokens` (replaying a recorded buy).
  buyTokens(tokens, t, first = false) {
    if (this.graduated || tokens <= 0n) return null
    const result = swapQuoteExactOut(this.state, config, false, new BN(String(tokens)), 0, false, new BN(t), first)
    const fee = this.fees(result), spent = big(result.includedFeeInputAmount)
    this.reserve += spent - fee.total
    this.apply(result)
    if (this.reserve >= THRESHOLD) this.graduated = true
    return { spent, tokens, fee }
  }
  sellTokens(tokens, t) {
    if (this.graduated || tokens <= 0n) return null
    const result = swapQuoteExactIn(this.state, config, true, new BN(String(tokens)), 0, false, new BN(t), false)
    const fee = this.fees(result), sol = big(result.outputAmount)
    this.reserve -= sol + fee.total
    this.apply(result)
    return { tokens, sol, fee }
  }
  // Tokens needed to receive `lamports` of SOL.
  tokensFor(lamports, t) {
    return big(swapQuoteExactOut(this.state, config, true, new BN(String(lamports)), 0, false, new BN(t), false).includedFeeInputAmount)
  }
  // Lamports per base unit at the current price.
  price() { const s = Number(this.state.poolState.sqrtPrice.toString()) / 2 ** 64; return s * s }
}
