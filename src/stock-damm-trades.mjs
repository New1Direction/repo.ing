import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { agreedFinalizedTransaction, agreeGraduation } from './graduation-state.mjs'
import { DAMM_SWAP_PAYER, swapTrader } from './swap-trader.mjs'

// Swaps on a stock-paired market's graduated DAMM v2 pool (docs/STOCK_QUOTES.md), recorded in stock_trade_events with venue
// 'damm'. The SOL parser (src/damm-trades.mjs) only follows swaps quoted in SOL and passes over anything else as "not a swap";
// this one is strict instead, because a swap it passed over would silently drop the stock's volume and fees:
//   - the stock's quote mint is a required argument;
//   - every swap instruction on the canonical pool must name the market token and the stock as tokens A and B, and emit exactly
//     one swap event for the pool; every swap event for the pool must come from such a swap;
//   - any other instruction on the canonical pool the program's coder does not know, and any other swap-like event for it,
//     is refused too.
// Anything that cannot be fully matched throws StockSwapUnmatched, which the indexer quarantines (a durable operator alert,
// retried every run) rather than skipping.
const EVENT = Buffer.from('e445a52e51cb9a1d', 'hex')
const SWAPS = ['f8c69e91e17587c8', '414b3f4ceb5b5b88']
const FIRST_PAGE = 100
// Transactions taken per pass, oldest first: a long backlog (a worker outage, a busy pool) is worked off over several passes,
// the cursor saved after each transaction, rather than holding one pass for minutes.
export const STOCK_DAMM_MAX_TRANSACTIONS_PER_PASS = 250
export const STOCK_DAMM_QUARANTINE = 'STOCK_DAMM_SWAP_QUARANTINED'

export class StockSwapUnmatched extends Error {
  constructor(reason) {
    super(`STOCK_DAMM_SWAP_UNMATCHED: ${reason}`)
    this.name = 'StockSwapUnmatched'
    this.code = 'STOCK_DAMM_SWAP_UNMATCHED'
    this.reason = reason
  }
}
const unmatched = reason => { throw new StockSwapUnmatched(reason) }

const keyText = (value, name) => {
  try { return new PublicKey(value).toBase58() } catch { throw Error(`${name} is required`) }
}

// Every swap event of the canonical pool in one finalized transaction, in the SOL parser's event order (an instruction's
// position among its group's outer and inner instructions, groups in transaction order), so the two venues order alike.
export function stockDammSwapEvents(transaction, { mint, quoteMint, pool, coder }) {
  if (quoteMint === undefined || quoteMint === null) throw Error('STOCK_QUOTE_MINT_REQUIRED')
  const quote = keyText(quoteMint, 'STOCK_QUOTE_MINT'), base = keyText(mint, 'Market mint'), destination = keyText(pool, 'Canonical pool')
  if (quote === NATIVE_MINT.toBase58()) throw Error('STOCK_QUOTE_MINT_REQUIRED')
  if (!transaction?.meta || transaction.meta.err) throw Error('DAMM_TRADE_EVIDENCE_MISSING')
  const message = transaction.transaction.message, keys = message.accountKeys
  const onPool = ix => keys[ix.programIdIndex]?.equals(CP_AMM_PROGRAM_ID) && (ix.accounts ?? []).some(index => keys[index]?.toBase58() === destination)
  // Liquidity, fee claims and other known instructions on the pool are not swaps; an instruction the coder does not know is.
  const known = bytes => { try { return Boolean(coder.instruction.decode(bytes)) } catch { return false } }
  const grouped = new Set((transaction.meta.innerInstructions ?? []).map(group => group.index))
  // A swap can only report itself through an event CPI: an outer swap on the pool with no inner instructions never did.
  for (const [index, ix] of message.instructions.entries()) {
    if (grouped.has(index) || !onPool(ix)) continue
    const bytes = Buffer.from(bs58.decode(ix.data))
    if (SWAPS.includes(bytes.subarray(0, 8).toString('hex'))) unmatched('a swap on the canonical pool emitted no event')
    if (!known(bytes)) unmatched('an instruction the program coder does not know touched the canonical pool')
  }
  const result = []
  let ordinal = 0
  for (const group of transaction.meta.innerInstructions ?? []) {
    const outer = message.instructions[group.index]
    if (!outer) throw Error('DAMM_TRADE_ORDERING_MISSING')
    // Swaps on the pool still running at each depth, waiting for their one event.
    const open = []
    const close = depth => {
      while (open.length && open.at(-1).depth >= depth) if (open.pop().events !== 1) unmatched('a swap on the canonical pool did not emit exactly one swap event')
    }
    for (const [i, ix] of [outer, ...group.instructions].entries()) {
      const eventIndex = ordinal++
      const depth = i === 0 ? 1 : ix.stackHeight
      if (!Number.isInteger(depth)) throw Error('DAMM_TRADE_ORDERING_MISSING')
      close(depth)
      if (!keys[ix.programIdIndex]?.equals(CP_AMM_PROGRAM_ID)) continue
      const bytes = Buffer.from(bs58.decode(ix.data)), a = ix.accounts ?? []
      if (bytes.subarray(0, 8).equals(EVENT)) {
        const parent = open.at(-1)?.depth === depth - 1 ? open.at(-1) : null
        let decoded = null
        try { decoded = coder.events.decode(bytes.subarray(8).toString('base64')) } catch { decoded = null }
        if (!decoded) { if (parent) unmatched('a swap on the canonical pool emitted an event that does not decode'); continue }
        const name = decoded.name.toLowerCase(), forPool = decoded.data?.pool?.toBase58?.() === destination
        if (name !== 'evtswap2') { if (forPool && name.includes('swap')) unmatched(`unknown swap event ${decoded.name} for the canonical pool`); continue }
        if (!forPool) { if (parent) unmatched('a swap on the canonical pool emitted an event for another pool'); continue }
        if (!parent) unmatched('a swap event for the canonical pool came from no swap on it')
        parent.events++
        result.push({ eventIndex, ...swapFields(decoded.data, parent.trader, group.index, ix) })
        continue
      }
      const discriminator = bytes.subarray(0, 8).toString('hex')
      if (SWAPS.includes(discriminator)) {
        if (keys[a[1]]?.toBase58() !== destination) {
          if (onPool(ix)) unmatched('a swap names the canonical pool outside its pool account')
          continue
        }
        if (keys[a[6]]?.toBase58() !== base || keys[a[7]]?.toBase58() !== quote) unmatched('a swap on the canonical pool names other mints')
        open.push({ depth, events: 0, trader: swapTrader(transaction, ix, DAMM_SWAP_PAYER) })
        continue
      }
      if (onPool(ix) && !known(bytes)) unmatched('an instruction the program coder does not know touched the canonical pool')
    }
    close(0)
  }
  return result
}

// One event's trade fields. A buy pays the stock (token B) in for the market token; a sell the reverse. Fees on the pool are
// collected in the stock only (collect fee mode 1): taken from a buy's input, and from a sell's output.
//   quoteAmount: the stock the wallet paid (a buy, fees included) or received (a sell), as receipts settle it.
//   quoteVolume: stock_trade_events.quote_amount, with the curve rows' meaning: on a buy the stock that reached the pool's curve,
//     fees excluded (the trader paid it plus the fee, which stays in the stock vault); on a sell the stock received.
function swapFields(d, trader, group, instruction) {
  const direction = d.tradeDirection === 1 ? 'buy' : d.tradeDirection === 0 ? 'sell' : null
  if (!direction) unmatched('a swap event has no trade direction')
  if (d.collectFeeMode !== 1) unmatched('a swap event collects fees outside the stock')
  const quoteAmount = (direction === 'buy' ? d.includedTransferFeeAmountIn : d.excludedTransferFeeAmountOut).toString()
  const baseAmount = (direction === 'buy' ? d.excludedTransferFeeAmountOut : d.includedTransferFeeAmountIn).toString()
  if (!/^[1-9]\d*$/.test(quoteAmount) || !/^[1-9]\d*$/.test(baseAmount)) unmatched('a swap event moved no stock or no market token')
  // The stock moves without a Token-2022 transfer fee (a stock pair launches only without one); one appearing later is for
  // review, never a guess: what the wallet sent or got must be what the pool took or paid.
  const [moved, pooled] = direction === 'buy' ? [d.includedTransferFeeAmountIn, d.swapResult?.includedFeeInputAmount] : [d.excludedTransferFeeAmountOut, d.swapResult?.outputAmount]
  if (pooled === undefined || moved.toString() !== pooled.toString()) unmatched('a swap event shows a transfer fee on the stock')
  const quoteVolume = (direction === 'buy' ? d.swapResult.excludedFeeInputAmount : d.excludedTransferFeeAmountOut)?.toString()
  if (!/^[1-9]\d*$/.test(quoteVolume ?? '') || BigInt(quoteVolume) > BigInt(quoteAmount)) unmatched('a swap event has no valid fee-excluded stock amount')
  const nextSqrtPrice = d.swapResult?.nextSqrtPrice?.toString()
  if (!/^[1-9]\d*$/.test(nextSqrtPrice ?? '') || BigInt(nextSqrtPrice) >= (1n << 128n)) unmatched('a swap event has no valid next price')
  const tradedAt = new Date(Number(d.currentTimestamp?.toString()) * 1000)
  if (!Number.isFinite(tradedAt.getTime())) unmatched('a swap event has no valid timestamp')
  const params = { amount0: d.params.amount0.toString(), amount1: d.params.amount1.toString(), swapMode: d.params.swapMode }
  const referralFee = (d.swapResult?.referralFee ?? 0).toString()
  return { direction, quoteAmount, quoteVolume, baseAmount, trader, referralFee, params, group, nextSqrtPrice, tradedAt,
    evidence: { group, instruction, quoteAmount, quoteVolume, baseAmount, direction, nextSqrtPrice } }
}

// Quarantine: a durable operator alert per signature (graduation_alerts, kind STOCK_DAMM_SWAP_QUARANTINED), retried every run
// until it parses, then acknowledged by the indexer. Never a skipped swap.
async function quarantine(db, market, pool, signature, slot, error) {
  const detail = { code: error.code ?? 'STOCK_DAMM_SWAP_UNMATCHED', pool, signature, slot: String(slot), reason: error.reason ?? error.message }
  const { rows } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing returning id,kind,github_repo_id::text as "repoId",created_at as "createdAt"`,
  [`stock-damm-quarantine:${pool}:${signature}`, String(market.githubRepoId), STOCK_DAMM_QUARANTINE, JSON.stringify(detail)])
  if (rows.length) console.error(`Stock DAMM swap quarantined for review: ${signature} (${pool}): ${detail.reason}`)
  return rows[0] ?? null
}

// One row per swap event, idempotent on (signature, event_index); a row already stored under that key must be this very event
// (the key is shared with the curve rows), never a different one passed over.
const TRADE_COLUMNS = ['github_repo_id', 'asset_id', 'quote_mint', 'venue', 'pool', 'signature', 'event_index', 'slot', 'traded_at', 'direction',
  'quote_amount', 'base_amount', 'next_sqrt_price', 'trader']
async function recordEvents(db, market, quote, pool, signature, slot, events) {
  let inserted = 0
  for (const event of events) {
    const values = [String(market.githubRepoId), quote.assetId, quote.mint, 'damm', pool, signature, String(event.eventIndex), String(slot),
      event.tradedAt.toISOString(), event.direction, event.quoteVolume, event.baseAmount, event.nextSqrtPrice, event.trader]
    const { rowCount } = await db.query(`insert into stock_trade_events (${TRADE_COLUMNS.join(', ')})
      values (${TRADE_COLUMNS.map((_, i) => `$${i + 1}`).join(',')}) on conflict (signature, event_index) do nothing`, values)
    if (rowCount) { inserted++; continue }
    const { rows: [stored] } = await db.query(`select github_repo_id::text, asset_id, quote_mint, venue, pool, signature, event_index::text,
      slot::text, traded_at, direction, quote_amount::text, base_amount::text, next_sqrt_price, trader
      from stock_trade_events where signature = $1 and event_index = $2`, [signature, event.eventIndex])
    const same = stored && TRADE_COLUMNS.every((column, i) => column === 'traded_at'
      ? new Date(stored.traded_at).getTime() === event.tradedAt.getTime() : stored[column] === values[i])
    if (!same) throw Error('STOCK_TRADE_ROW_CONFLICT')
  }
  return inserted
}

// Indexes every finalized swap on the graduated stock pool from the migration on, both providers agreeing on the pool's history
// and on every transaction (the SOL DAMM indexer's pattern), with the cursor in stock_pool_cursors. The migration transaction
// itself is read too (a swap on the new pool may be bundled into it). graduation: the proven { pool, signature, slot } of the
// migration. quote: the market's registry stock (src/quote-assets.mjs quoteOfMarket).
export async function indexStockDammTrades({ db, connection, verification, market, quote, graduation, coder = new CpAmm(connection)._program.coder,
  maxTransactions = STOCK_DAMM_MAX_TRANSACTIONS_PER_PASS }) {
  if (!quote?.mint || quote.type === 'SOL') throw Error('STOCK_QUOTE_MINT_REQUIRED')
  const address = graduation.pool, parse = tx => stockDammSwapEvents(tx, { mint: market.mint, quoteMint: quote.mint, pool: address, coder })
  const alerts = [], quarantined = []
  let inserted = 0
  const take = async (signature, slot) => {
    const tx = await agreedFinalizedTransaction(connection, verification, signature)
    if (tx.slot < graduation.slot) throw Error('DAMM_TRADE_PRECEDES_MIGRATION')
    let events
    try { events = parse(tx) } catch (error) {
      if (!(error instanceof StockSwapUnmatched)) throw error
      const alert = await quarantine(db, market, address, signature, slot, error)
      if (alert) alerts.push(alert)
      quarantined.push(signature)
      return false
    }
    inserted += await recordEvents(db, market, quote, address, signature, tx.slot, events)
    return true
  }
  const advance = (signature, slot) => db.query(`insert into stock_pool_cursors (pool, github_repo_id, venue, last_signature, last_slot)
    values ($1,$2,'damm',$3,$4) on conflict (pool) do update set last_signature = excluded.last_signature, last_slot = excluded.last_slot,
    updated_at = now()`, [address, String(market.githubRepoId), signature, String(slot)])
  // Earlier quarantines first: one that parses now is recorded and its alert acknowledged.
  const { rows: open } = await db.query(`select id, detail from graduation_alerts where kind = $1 and github_repo_id = $2
    and acknowledged_at is null order by id limit 100`, [STOCK_DAMM_QUARANTINE, String(market.githubRepoId)])
  for (const row of open) {
    const { signature, slot, pool } = JSON.parse(row.detail)
    if (pool !== address) continue
    if (await take(signature, slot)) await db.query(`update graduation_alerts set acknowledged_at = now(), acknowledged_by = 'stock-graduation-monitor'
      where id = $1 and acknowledged_at is null`, [row.id])
  }
  const { rows: [cursor] } = await db.query('select last_signature from stock_pool_cursors where pool = $1', [address])
  // First pass: the migration transaction, then everything after it.
  if (!cursor) {
    await take(graduation.signature, graduation.slot)
    await advance(graduation.signature, graduation.slot)
  }
  const boundary = cursor?.last_signature ?? graduation.signature
  async function history(rpc) {
    const result = []
    let before
    for (;;) {
      // The cursor is normally among the newest few signatures: a small first page keeps idle passes light.
      const limit = before ? 1000 : FIRST_PAGE
      const page = await rpc.getSignaturesForAddress(new PublicKey(address), { limit, ...(before ? { before } : {}) }, 'finalized')
      for (const item of page) { if (item.signature === boundary) return result; result.push({ signature: item.signature, slot: item.slot, err: item.err }) }
      if (page.length < limit) throw Error('DAMM_HISTORY_INCOMPLETE')
      before = page.at(-1).signature
    }
  }
  const histories = await Promise.all([connection, verification].map(history))
  agreeGraduation(...histories)
  const pending = [...histories[0]].reverse(), batch = pending.slice(0, maxTransactions)
  for (const item of batch) {
    if (!item.err) await take(item.signature, item.slot)
    await advance(item.signature, item.slot)
  }
  const { rows: [{ count }] } = await db.query(`select count(*)::int as count from graduation_alerts where kind = $1 and github_repo_id = $2
    and acknowledged_at is null`, [STOCK_DAMM_QUARANTINE, String(market.githubRepoId)])
  return { transactions: batch.length + (cursor ? 0 : 1), remaining: pending.length - batch.length, inserted, quarantined, openQuarantines: count, alerts }
}
