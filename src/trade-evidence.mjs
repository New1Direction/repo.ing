import bs58 from 'bs58'
import { createMarketConfigResolver } from './market-config.mjs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { DBC_SWAP_PAYER, swapTrader } from './swap-trader.mjs'
import { tradingEarlyAccessConfig } from './early-access.mjs'

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])
const SWAP2_DISCRIMINATOR = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136])
const SWAP2_TRANSFER_HOOK_DISCRIMINATOR = Buffer.from([183, 93, 153, 40, 24, 230, 194, 151])
const SWAP_DISCRIMINATORS = [SWAP_DISCRIMINATOR, SWAP2_DISCRIMINATOR, SWAP2_TRANSFER_HOOK_DISCRIMINATOR]
const SWAP2_EVENTS = new Set(['evtSwap2', 'evtSwap2WithTransferHook'])
const EVENT_CPI_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')

// Deterministic: retrying the same finalized transaction can never succeed. Callers may quarantine it.
export class UnparseableTradeError extends Error {}

// swap and swap2 emit evtSwap then evtSwap2 for one trade (verified on mainnet); swap2WithTransferHook emits
// only evtSwap2WithTransferHook. Same fee fields; SwapResult2::get_swap_result maps actual input to excluded-fee input.
const legacySwapData = data => ({ pool: data.pool, config: data.config, tradeDirection: data.tradeDirection,
  hasReferral: data.hasReferral, currentTimestamp: data.currentTimestamp,
  swapResult: { ...data.swapResult, actualInputAmount: data.swapResult.excludedFeeInputAmount } })

export function canonicalDbcSwapEvents(transaction, market, config, dbc) {
  if (!transaction?.meta || transaction.meta.err) throw new Error('Finalized trade transaction is unavailable or failed')
  const keys = transaction.transaction.message.accountKeys
  const isKey = (index, expected) => keys[index]?.equals(expected)
  const pool = new PublicKey(market.pool)
  const mint = new PublicKey(market.mint)
  const configKey = new PublicKey(config)
  const found = []
  let swapCount = 0
  const traders = []
  let sawCanonicalSwap = false
  for (const group of transaction.meta.innerInstructions ?? []) {
    const outer = transaction.transaction.message.instructions[group.index]
    const activeSwaps = new Map()
    const swapIds = new Map()
    let lastSwapId
    for (const [position, instruction] of [outer, ...group.instructions].entries()) {
      if (!instruction) continue
      const depth = position === 0 ? 1 : Number.isInteger(instruction.stackHeight) ? instruction.stackHeight : null
      if (depth !== null) for (const active of [activeSwaps, swapIds]) for (const activeDepth of active.keys()) {
        if (activeDepth >= depth) active.delete(activeDepth)
      }
      if (!isKey(instruction.programIdIndex, DBC_PROGRAM)) continue
      const bytes = Buffer.from(bs58.decode(instruction.data))
      const discriminator = bytes.subarray(0, 8)
      if (SWAP_DISCRIMINATORS.some(expected => discriminator.equals(expected))) {
        lastSwapId = swapCount++
        traders[lastSwapId] = swapTrader(transaction, instruction, DBC_SWAP_PAYER)
        swapIds.set(depth ?? 2, lastSwapId)
        const accounts = instruction.accounts ?? []
        if (isKey(accounts[1], configKey) && isKey(accounts[2], pool) &&
            isKey(accounts[7], mint) && isKey(accounts[8], NATIVE_MINT)) {
          sawCanonicalSwap = true
          activeSwaps.set(depth ?? 2, true)
        }
        continue
      }
      if (!discriminator.equals(EVENT_CPI_PREFIX)) continue
      let decoded
      try { decoded = dbc.state.getProgram().coder.events.decode(bytes.subarray(8).toString('base64')) }
      catch (error) { throw new UnparseableTradeError(`DBC event CPI does not decode: ${error.message}`) }
      if (decoded?.name !== 'evtSwap' && !SWAP2_EVENTS.has(decoded?.name)) continue
      found.push({ name: decoded.name, data: decoded.data, swapId: depth === null ? lastSwapId : swapIds.get(depth - 1),
        hasParentSwap: depth === null ? activeSwaps.size > 0 : activeSwaps.has(depth - 1) })
    }
  }
  // Ordinals count evtSwap exactly as before, so stored fee_events keys stay stable. evtSwap2 is used (and
  // takes an ordinal) only when its own swap emitted no evtSwap: crediting both would double-count one trade.
  const legacySwapIds = new Set(found.filter(event => event.name === 'evtSwap').map(event => event.swapId))
  const events = []
  let eventIndex = 0
  let sawCanonicalFeeEvent = false
  for (const event of found) {
    const legacy = event.name === 'evtSwap'
    if (!legacy && (event.swapId === undefined || legacySwapIds.has(event.swapId))) continue
    const ordinal = eventIndex++
    const data = legacy ? event.data : legacySwapData(event.data)
    if (!event.hasParentSwap || !data.pool.equals(pool) || !data.config.equals(configKey)) continue
    sawCanonicalFeeEvent = true
    events.push({ eventIndex: ordinal, data, trader: traders[event.swapId] ?? null })
  }
  return { events, sawCanonicalSwap, sawCanonicalFeeEvent }
}

export function canonicalTradeEvents(transaction, market, config, dbc) {
  const { events: swaps } = canonicalDbcSwapEvents(transaction, market, config, dbc)
  return swaps.map(({ eventIndex, data, trader }) => {
    const direction = data.tradeDirection === 1 ? 'buy' : data.tradeDirection === 0 ? 'sell' : null
    if (!direction) throw new UnparseableTradeError('Canonical DBC swap has an unknown direction')
    const { actualInputAmount, outputAmount, nextSqrtPrice } = data.swapResult
    if (nextSqrtPrice.isZero() || outputAmount.isZero()) throw new UnparseableTradeError('Canonical DBC swap has no price or output')
    return { pool: market.pool, signature: market.signature, eventIndex,
      slot: transaction.slot, tradedAt: new Date(Number(data.currentTimestamp.toString()) * 1000),
      direction, inputBaseUnits: actualInputAmount.toString(), outputBaseUnits: outputAmount.toString(),
      nextSqrtPrice: nextSqrtPrice.toString(), trader }
  })
}

// earlyAccess: as createFeeAccrual (src/fee-accrual.mjs): early access curve trades are recorded when EARLY_ACCESS_DBC_CONFIG is set.
export function createTradeRecorder({ pool, connection, config, earlyAccess = tradingEarlyAccessConfig() }) {
  const resolveConfig = createMarketConfigResolver(config, undefined, undefined, { earlyAccess })
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  return async function record(market, signature) {
    const transaction = await loadFinalizedTransaction(connection, signature)
    const events = canonicalTradeEvents(transaction, { ...market, signature }, resolveConfig(market), dbc)
    for (const event of events) {
      await pool.query(`insert into trade_events (pool, signature, event_index, slot, traded_at, direction,
        input_base_units, output_base_units, next_sqrt_price, trader) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (signature, event_index) do update set trader = excluded.trader where trade_events.trader is null`,
      [event.pool, event.signature, event.eventIndex, event.slot, event.tradedAt, event.direction,
        event.inputBaseUnits, event.outputBaseUnits, event.nextSqrtPrice, event.trader])
    }
    return events.length
  }
}
