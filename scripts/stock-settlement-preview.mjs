// Preview of settling a stock's accumulator (docs/STOCK_QUOTES.md, "Accumulator and settlement"): about half of what custody
// holds for the accumulator, collected and unspent, swapped into REPOING through the canonical REPOING/<stock> pool, and both
// sides added to the owner's position as permanently locked liquidity, bounded by slippage and price impact. READ-ONLY: it
// prints the plan, the exact instructions the owner would sign and the hash of its terms. It loads no key and signs, sends and
// writes nothing; the owner settles himself, then records each transaction with scripts/stock-settlement-receipt.mjs.
//   node scripts/stock-settlement-preview.mjs --asset meta-xstock [--max <raw units>] [--slippage-bps 100] [--impact-bps 300]
// Environment: DATABASE_URL, SOLANA_RPC_URL.
import { describeAccumulator, stockAccumulator } from '../src/stock-accumulator.mjs'
import { SETTLEMENT_DEFAULTS, describeSettlementPreview, previewStockSettlement } from '../src/stock-settlement.mjs'
import { asset, cli, run, units } from './stock-cli.mjs'

const USAGE = 'Usage: node scripts/stock-settlement-preview.mjs --asset <stock asset id> [--max <raw units>] [--slippage-bps <bps>] [--impact-bps <bps>]'
const args = cli(USAGE, { asset: { type: 'string' }, max: { type: 'string' }, 'slippage-bps': { type: 'string' }, 'impact-bps': { type: 'string' },
  write: { type: 'boolean' } })
if (args.write) { console.error('stock-settlement-preview only previews: it never writes. The owner settles himself.'); process.exit(2) }
const stock = asset(args.asset, USAGE)
const whole = (value, name, fallback) => {
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/.test(value)) { console.error(`--${name} must be a positive whole number\n${USAGE}`); process.exit(2) }
  return name === 'max' ? value : Number(value)
}

await run(async ({ pool, connection }) => {
  const accumulator = await stockAccumulator(pool, stock.assetId, { units: await units(connection, stock.assetId) })
  const preview = await previewStockSettlement({ pool, connection, assetId: stock.assetId, accumulator, maxAmount: whole(args.max, 'max', null),
    slippageBps: whole(args['slippage-bps'], 'slippage-bps', SETTLEMENT_DEFAULTS.slippageBps),
    priceImpactBps: whole(args['impact-bps'], 'impact-bps', SETTLEMENT_DEFAULTS.priceImpactBps) })
  return { json: { accumulator, preview }, lines: [...describeAccumulator(accumulator), ...describeSettlementPreview(preview), 'Nothing was signed, sent or written.'] }
})
