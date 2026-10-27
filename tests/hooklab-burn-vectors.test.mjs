// The quote model against hook-lab's inclusive-burn vectors (feat/inclusive-burn; HOOKLAB_BURN_VECTORS names the file):
// every trade's creator fee, platform share, burn, curve output, delivery and the exact minimum received.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { modelInclusiveCreatorQuote } from '../src/hooklab-inclusive-fee-quote.mjs'

const file = process.env.HOOKLAB_BURN_VECTORS
const skip = !file || !existsSync(file) ? 'set HOOKLAB_BURN_VECTORS to hook-lab\'s burn vectors.json' : false
const B = BigInt
const input = (coin, t, minAmountOut) => ({ side: t.direction, amountIn: B(t.amount_in), minAmountOut, maxInput: B(t.amount_in), creatorFeeBps: coin.creator_fee_bps,
  feeModel: 2, protocolShareBps: 2500, lpFeeBps: 0, flatProtocolFeeBps: 0, sniperWindowSecs: 0, sniperStartBps: 0, quoteHook: 'none', modules: 0, authorShareBps: 0,
  rules: coin.burn_buy_bps ? { burnBuyBps: coin.burn_buy_bps, burnSellBps: coin.burn_sell_bps } : 'none', rewards: false, recipientBaseBalance: 0n, maxWalletLifted: true,
  pool: { baseReserve: B(t.pool_before.base_reserve), quoteReserve: B(t.pool_before.quote_reserve), virtualBase: B(t.pool_before.virtual_base), virtualQuote: B(t.pool_before.virtual_quote), protocolFeesQuote: 0n },
  policy: { version: 2, feeModel: 2, protocolShareBps: 2500, creatorFeeBps: coin.creator_fee_bps, lpFeeBps: 0, initialSupply: 10n ** 18n, capBps: 9999 } })

test('every vector trade quotes exactly as the programs settle it', { skip }, () => {
  const { coins } = JSON.parse(readFileSync(file, 'utf8'))
  let trades = 0
  for (const coin of coins) for (const t of coin.trades) {
    const label = `${coin.coin} ${t.label}`, q = modelInclusiveCreatorQuote(input(coin, t, B(t.min_out_exact)))
    assert.deepEqual({ gross: String(q.fees.grossQuote), platform: String(q.fees.platformQuote), creator: String(q.fees.creatorQuote), burn: String(q.burned),
      curveOut: String(q.grossOutput), delivered: String(q.delivered) },
    { gross: t.creator_fee_gross, platform: t.platform, creator: t.creator_net, burn: t.burn, curveOut: t.curve_out, delivered: t.delivered }, label)
    assert.throws(() => modelInclusiveCreatorQuote(input(coin, t, B(t.min_out_refused))), /MIN_OUTPUT/, label)
    trades++
  }
  assert.ok(trades > 0)
})
