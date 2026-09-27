import { Connection } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { buildLaunchCurve, CURVE_PROFILES } from '../src/launch-curve.mjs'
import { quoteDisplay } from '../src/trade-quote-display.mjs'
import { launchBuyPreset } from '../src/launch-buy.mjs'

// SDK math only. No RPC calls, wallet loading, signing, or submission.
const client = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:8899'), 'confirmed')
const report = Object.entries(CURVE_PROFILES).map(([id, profile]) => {
  const config = buildLaunchCurve(id)
  const quotes = ['100000000', '1000000000', '5000000000'].map(input => {
    const quote = client.pool.getQuoteFromInputAmount({ config, swapBaseForQuote: false,
      amountIn: new BN(input), slippageBps: 100, hasReferral: false, eligibleForFirstSwapWithMinFee: false })
    const fee = quote.tradingFee.add(quote.protocolFee).add(quote.referralFee)
    return { inputLamports: input, outputBaseUnits: quote.outputAmount.toString(),
      supplyPercent: Number(quote.outputAmount.toString()) / 1e13,
      ...quoteDisplay({ direction: 'buy', input, output: quote.outputAmount.toString(),
        sqrtPrice: config.sqrtStartPrice.toString(), fee: fee.toString() }) }
  })
  return { id, label: profile.label,
    initialMarketCapSol: (Number(config.sqrtStartPrice.toString()) / 2 ** 64) ** 2 * 1e6,
    migrationQuoteThresholdLamports: config.migrationQuoteThreshold.toString(),
    initialRealSolReserve: '0',
    maxInitialBuyLamports: launchBuyPreset(client, { ...config, ...config.tokenSupply }, 300), quotes }
})
console.log(JSON.stringify({ basis: 'Fresh pool; SDK integer quotes; impact excludes fees; virtual pricing is not deposited SOL', profiles: report }, null, 2))
