import bs58 from 'bs58'
import { createMarketConfigResolver } from './market-config.mjs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200])
const SWAP2_DISCRIMINATOR = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136])
const EVENT_CPI_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')

export function canonicalDbcSwapEvents(transaction, market, config, dbc) {
  if (!transaction?.meta || transaction.meta.err) throw new Error('Finalized trade transaction is unavailable or failed')
  const keys = transaction.transaction.message.accountKeys
  const isKey = (index, expected) => keys[index]?.equals(expected)
  const pool = new PublicKey(market.pool)
  const mint = new PublicKey(market.mint)
  const configKey = new PublicKey(config)
  const events = []
  let eventIndex = 0
  let sawCanonicalSwap = false
  let sawCanonicalFeeEvent = false
  for (const group of transaction.meta.innerInstructions ?? []) {
    const outer = transaction.transaction.message.instructions[group.index]
    const activeSwaps = new Map()
    for (const [position, instruction] of [outer, ...group.instructions].entries()) {
      if (!instruction) continue
      const depth = position === 0 ? 1 : Number.isInteger(instruction.stackHeight) ? instruction.stackHeight : null
      if (depth !== null) for (const activeDepth of activeSwaps.keys()) {
        if (activeDepth >= depth) activeSwaps.delete(activeDepth)
      }
      if (!isKey(instruction.programIdIndex, DBC_PROGRAM)) continue
      const bytes = Buffer.from(bs58.decode(instruction.data))
      const discriminator = bytes.subarray(0, 8)
      const isSwap = discriminator.equals(SWAP_DISCRIMINATOR) || discriminator.equals(SWAP2_DISCRIMINATOR)
      if (isSwap) {
        const accounts = instruction.accounts ?? []
        if (isKey(accounts[1], configKey) && isKey(accounts[2], pool) &&
            isKey(accounts[7], mint) && isKey(accounts[8], NATIVE_MINT)) {
          sawCanonicalSwap = true
          activeSwaps.set(depth ?? 2, true)
        }
        continue
      }
      if (!bytes.subarray(0, 8).equals(EVENT_CPI_PREFIX)) continue
      const decoded = dbc.state.getProgram().coder.events.decode(bytes.subarray(8).toString('base64'))
      if (decoded?.name !== 'evtSwap') continue
      const ordinal = eventIndex++
      const hasParentSwap = depth === null ? activeSwaps.size > 0 : activeSwaps.has(depth - 1)
      if (!hasParentSwap || !decoded.data.pool.equals(pool) || !decoded.data.config.equals(configKey)) continue
      sawCanonicalFeeEvent = true
      events.push({ eventIndex: ordinal, data: decoded.data })
    }
  }
  return { events, sawCanonicalSwap, sawCanonicalFeeEvent }
}

export function canonicalTradeEvents(transaction, market, config, dbc) {
  const { events: swaps } = canonicalDbcSwapEvents(transaction, market, config, dbc)
  return swaps.map(({ eventIndex, data }) => {
    const direction = data.tradeDirection === 1 ? 'buy' : data.tradeDirection === 0 ? 'sell' : null
    if (!direction) throw new Error('Canonical DBC swap has an unknown direction')
    const { actualInputAmount, outputAmount, nextSqrtPrice } = data.swapResult
    if (nextSqrtPrice.isZero() || outputAmount.isZero()) throw new Error('Canonical DBC swap has no price or output')
    return { pool: market.pool, signature: market.signature, eventIndex,
      slot: transaction.slot, tradedAt: new Date(Number(data.currentTimestamp.toString()) * 1000),
      direction, inputBaseUnits: actualInputAmount.toString(), outputBaseUnits: outputAmount.toString(),
      nextSqrtPrice: nextSqrtPrice.toString() }
  })
}

export function createTradeRecorder({ pool, connection, config }) {
  const resolveConfig = createMarketConfigResolver(config)
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  return async function record(market, signature) {
    const transaction = await loadFinalizedTransaction(connection, signature)
    const events = canonicalTradeEvents(transaction, { ...market, signature }, resolveConfig(market), dbc)
    for (const event of events) {
      await pool.query(`insert into trade_events (pool, signature, event_index, slot, traded_at, direction,
        input_base_units, output_base_units, next_sqrt_price) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        on conflict (signature, event_index) do nothing`,
      [event.pool, event.signature, event.eventIndex, event.slot, event.tradedAt, event.direction,
        event.inputBaseUnits, event.outputBaseUnits, event.nextSqrtPrice])
    }
    return events.length
  }
}
