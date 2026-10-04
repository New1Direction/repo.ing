// Verifies one of the owner's own finalized settlement transactions for a stock (docs/STOCK_QUOTES.md, "Accumulator and
// settlement") and records it as a receipt: seed (creating and seeding the canonical pool), swap (the stock into REPOING) or
// add_liquidity (a deposit, after at most one such swap). It must touch only the stock's active canonical REPOING/<stock>
// pool, be paid for by an owner wallet, match the program's events with exact balance deltas of both tokens, and leave every
// position it deposited into permanently locked. DRY RUN BY DEFAULT: it prints what the transaction did. --write records it
// in stock_settlement_receipts (the database only), on mainnet only and with a second RPC (GRADUATION_VERIFICATION_RPC_URL)
// agreeing, refused if it spends more of the stock than the accumulator has collected and not yet spent. It loads no key and
// signs or sends nothing.
//   node scripts/stock-settlement-receipt.mjs --asset meta-xstock --kind seed|swap|add_liquidity --signature <signature> [--write]
// Environment: DATABASE_URL, SOLANA_RPC_URL.
import { SETTLEMENT_KINDS, describeSettlementReceipt, recordStockSettlementReceipt, verifyStockSettlementReceipt } from '../src/stock-settlement.mjs'
import { assertWritable, asset, cli, run } from './stock-cli.mjs'

const USAGE = `Usage: node scripts/stock-settlement-receipt.mjs --asset <stock asset id> --kind ${SETTLEMENT_KINDS.join('|')} --signature <signature> [--write]`
const args = cli(USAGE, { asset: { type: 'string' }, kind: { type: 'string' }, signature: { type: 'string' }, write: { type: 'boolean' } })
const stock = asset(args.asset, USAGE)
if (!SETTLEMENT_KINDS.includes(args.kind)) { console.error(`--kind must be one of ${SETTLEMENT_KINDS.join(', ')}\n${USAGE}`); process.exit(2) }
if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(args.signature ?? '')) { console.error(`--signature must be a transaction signature\n${USAGE}`); process.exit(2) }

await run(async ({ pool, connection, verification, network }) => {
  if (args.write) assertWritable({ network, verification })
  const receipt = await verifyStockSettlementReceipt({ pool, connection, verification, assetId: stock.assetId, kind: args.kind, signature: args.signature })
  const lines = describeSettlementReceipt(receipt, stock.symbol)
  if (!args.write) {
    lines.push('Dry run: nothing written. With --write it is recorded in stock_settlement_receipts, if it fits in the collected, unspent accumulator.')
    return { json: { receipt, written: false }, lines }
  }
  const result = await recordStockSettlementReceipt(pool, receipt)
  lines.push(result.status === 'recorded' ? `Recorded (receipt ${result.id}): the ${stock.symbol} accumulator had ${result.availableBefore} raw units available, now ${result.availableAfter}.`
    : `Already recorded (receipt ${result.id}): nothing changed.`)
  return { json: { receipt, result, written: result.status === 'recorded' }, lines }
})
