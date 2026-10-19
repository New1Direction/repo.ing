// Hooks coin trades from finalized transactions, for the coin page's chart, trades and volume. Display only: nothing that
// moves money reads these. A trade is an event the swap program emitted about itself (Anchor emit_cpi): an inner
// instruction to the swap program, signed by its own event authority, whose caller is the swap program, carrying the
// IDL's exact event bytes. Anything else in a transaction (other programs, other pools, the launch, fee claims) is not a
// trade, and evidence that does not add up throws instead of being skipped or guessed.
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { binding } from './hooklab-owner-driver/artifacts.mjs'
import { PROGRAMS } from './hooklab-owner-driver/pins.mjs'

export const EMIT_CPI_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
const fail = code => { throw Object.assign(Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }
const u64 = value => { const n = BigInt(value.toString()); check(n >= 0n && n < 1n << 64n, 'HOOK_TRADE_AMOUNT_INVALID'); return n }

// Swapped (bridged-SOL pools): direction 1 is a buy (SOL in, coin out), 0 a sell. The trade's SOL is what the trader
// paid (a buy's amount_in, fees included) or received (a sell's delivered_out); its coin amount is what the trader
// received or sold. quoteFee is every SOL fee on the swap (the creator's cut plus the platform's share). curveBase and
// curveQuote are the curve's pricing reserves after the swap (real plus virtual), so its price is curveQuote / curveBase.
function swappedTrade(data, context) {
  const direction = Number(data.direction)
  check(direction === 0 || direction === 1, 'HOOK_TRADE_DIRECTION_INVALID')
  check(u64(data.slot) === BigInt(context.slot), 'HOOK_TRADE_SLOT_MISMATCH')
  const seconds = Number(data.ts.toString())
  check(Number.isSafeInteger(seconds) && seconds > 0, 'HOOK_TRADE_TIME_INVALID')
  const trader = data.trader.toBase58()
  check(context.keys.includes(trader), 'HOOK_TRADE_TRADER_MISSING')
  const buy = direction === 1, swapCount = u64(data.swap_count), amountIn = u64(data.amount_in)
  const curveBase = u64(data.base_reserve) + u64(data.virtual_base), curveQuote = u64(data.quote_reserve) + u64(data.virtual_quote)
  check(swapCount > 0n && amountIn > 0n && curveBase > 0n && curveQuote > 0n, 'HOOK_TRADE_AMOUNT_INVALID')
  return { side: buy ? 'buy' : 'sell', trader, tradedAt: new Date(seconds * 1000).toISOString(), swapCount: String(swapCount),
    quoteAmount: String(buy ? amountIn : u64(data.delivered_out)), baseAmount: String(buy ? u64(data.delivered_out) : amountIn),
    quoteFee: String(u64(data.protocol_fee) + u64(buy ? data.cuts_in : data.cuts_out)), curveBase: String(curveBase), curveQuote: String(curveQuote) }
}

// The events that are trades, by name, with the program role whose pinned IDL decodes them and what the quote is.
// TODO(native-sol): native-SOL pools also emit SwappedNative, quoting lamports. When its IDL is pinned in
// hooklab-owner-driver/artifacts.mjs, add { name: 'SwappedNative', role: <its role>, quoteAsset: 'lamports', trade } here
// (and its pool derivation in app/lib/hooklab-coin-activity.mjs); tests/hooklab-trade-events.test.mjs has its placeholder.
export const HOOK_TRADE_EVENTS = Object.freeze([
  Object.freeze({ name: 'Swapped', role: 'swap', quoteAsset: 'bridged-sol', trade: swappedTrade }),
])

const authorities = new Map()
const eventAuthority = program => {
  if (!authorities.has(program)) authorities.set(program, PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(program))[0].toBase58())
  return authorities.get(program)
}

function accountKeys(tx) {
  const message = tx.transaction?.message
  check(message && typeof message.getAccountKeys === 'function', 'HOOK_TRADE_EVIDENCE_MISSING')
  check(!message.addressTableLookups?.length || tx.meta.loadedAddresses, 'HOOK_TRADE_LOOKUPS_MISSING')
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined })
  return Array.from({ length: keys.length }, (_, i) => keys.get(i).toBase58())
}

// One finalized transaction (web3.js getTransaction, maxSupportedTransactionVersion 0) that named `pool`: its trades on
// that pool, in instruction order. eventIndex is the event's position among the transaction's inner instructions, so
// (signature, eventIndex) names one event for good. A failed transaction has none.
export function decodeHookTrades(tx, { signature, pool, programs = PROGRAMS, events = HOOK_TRADE_EVENTS }) {
  check(tx?.meta && Number.isSafeInteger(tx.slot) && tx.slot > 0, 'HOOK_TRADE_EVIDENCE_MISSING')
  check(tx.transaction?.signatures?.[0] === signature, 'HOOK_TRADE_SIGNATURE_MISMATCH')
  if (tx.meta.err !== null) return []
  check(Array.isArray(tx.meta.innerInstructions), 'HOOK_TRADE_EVIDENCE_MISSING')
  const keys = accountKeys(tx), outer = tx.transaction.message.compiledInstructions
  check(keys.includes(pool), 'HOOK_TRADE_POOL_MISSING')
  const swap = programs.swap, authority = eventAuthority(swap)
  // Event discriminator (hex) -> its table row and IDL binding. Only the swap program's events are trades today.
  const table = new Map(events.filter(spec => spec.role === 'swap').map(spec => {
    const { idl, coder } = binding(spec.role), def = idl.events.find(e => e.name === spec.name)
    check(def, 'HOOK_TRADE_EVENT_UNKNOWN')
    return [Buffer.from(def.discriminator).toString('hex'), { spec, coder, discriminator: Buffer.from(def.discriminator) }]
  }))
  const trades = [], groups = new Set()
  let ordinal = -1
  for (const group of tx.meta.innerInstructions) {
    check(Number.isInteger(group.index) && group.index >= 0 && group.index < outer.length && !groups.has(group.index), 'HOOK_TRADE_ORDERING_MISSING')
    groups.add(group.index)
    // stack[h]: the program running at stack height h (1 is the outer instruction).
    const stack = [null, keys[outer[group.index].programIdIndex]]
    for (const ix of group.instructions) {
      ordinal++
      const program = keys[ix.programIdIndex], height = ix.stackHeight
      check(program && Number.isInteger(height) && height >= 2 && height <= stack.length, 'HOOK_TRADE_ORDERING_MISSING')
      stack.length = height; stack[height] = program
      if (program !== swap) continue
      const bytes = Buffer.from(bs58.decode(ix.data))
      if (!bytes.subarray(0, 8).equals(EMIT_CPI_TAG)) continue
      check(stack[height - 1] === swap && ix.accounts.length === 1 && keys[ix.accounts[0]] === authority, 'HOOK_TRADE_EVENT_UNAUTHENTICATED')
      const row = table.get(bytes.subarray(8, 16).toString('hex'))
      if (!row) continue
      const event = row.coder.events.decode(bytes.subarray(8).toString('base64'))
      check(event?.name === row.spec.name, 'HOOK_TRADE_EVENT_ENCODING')
      check(Buffer.concat([EMIT_CPI_TAG, row.discriminator, row.coder.types.encode(row.spec.name, event.data)]).equals(bytes), 'HOOK_TRADE_EVENT_ENCODING')
      if (event.data.pool.toBase58() !== pool) continue
      trades.push({ signature, eventIndex: ordinal, event: row.spec.name, quoteAsset: row.spec.quoteAsset, pool, slot: tx.slot,
        ...row.spec.trade(event.data, { slot: tx.slot, keys }) })
    }
  }
  return trades
}
