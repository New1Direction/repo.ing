import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { DBC_SWAP_PAYER, swapTrader } from './swap-trader.mjs'
import { UnparseableTradeError } from './trade-evidence.mjs'

// Curve swap evidence for a stock-paired market (docs/STOCK_QUOTES.md). The SOL parser (trade-evidence.mjs) passes over
// what it does not recognise, and the SOL indexer reads "no canonical swap" as "not a swap". For a stock pair that is the
// trap: a swap the parser missed would be credited nothing and the pool's cursor moved past it for good. So this parser is
// strict. Every DBC instruction that names the canonical pool must be fully matched: a canonical swap (its config, pool and
// both mints where the program takes them, the stock as the quote) with exactly one swap event, or one of the known
// non-swap instructions with the pool, config and mints in their places. Every swap event naming the pool must come from a
// canonical swap. Anything else throws StockEvidenceUnmatchedError, an UnparseableTradeError: the indexer quarantines the
// transaction for operator review and retries it on every run; nothing about it is credited. An instruction of the curve's
// migration throws StockCurveMigratedError instead: graduation is not indexed here, so the market stops with an ERROR.

const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const EVENT_CPI_PREFIX = Buffer.from('e445a52e51cb9a1d', 'hex')
const SWAP2_EVENTS = new Set(['evtSwap2', 'evtSwap2WithTransferHook'])

// Every DBC instruction that can name a virtual pool: its discriminator and where it takes the pool and, when it takes them,
// the config and the two mints (account indexes from the program's IDL; tests/stock-trade-evidence.test.mjs holds this table
// to the SDK's IDL). Migration-family instructions need no positions: naming the pool at all stops the market.
const SWAP = 'swap', NON_SWAP = 'non-swap', MIGRATION = 'migration'
const ix = (name, discriminator, kind, accounts = {}) => ({ name, discriminator: Buffer.from(discriminator).toString('hex'), kind, accounts })
const CURVE = { config: 1, pool: 2, baseMint: 7, quoteMint: 8 }
export const STOCK_DBC_INSTRUCTIONS = Object.freeze([
  ix('swap', [248, 198, 158, 145, 225, 117, 135, 200], SWAP, CURVE),
  ix('swap2', [65, 75, 63, 76, 235, 91, 91, 136], SWAP, CURVE),
  ix('swap2WithTransferHook', [183, 93, 153, 40, 24, 230, 194, 151], SWAP, CURVE),
  ix('initializeVirtualPoolWithSplToken', [140, 85, 215, 176, 102, 54, 104, 79], NON_SWAP, { config: 0, baseMint: 3, quoteMint: 4, pool: 5 }),
  ix('initializeVirtualPoolWithToken2022', [169, 118, 51, 78, 145, 110, 220, 155], NON_SWAP, { config: 0, baseMint: 3, quoteMint: 4, pool: 5 }),
  ix('initializeVirtualPoolWithToken2022TransferHook', [182, 13, 233, 177, 42, 145, 135, 2], NON_SWAP, { config: 0, baseMint: 3, quoteMint: 4, pool: 5 }),
  ix('claimCreatorTradingFee', [82, 220, 250, 189, 3, 85, 107, 45], NON_SWAP, { pool: 1, baseMint: 6, quoteMint: 7 }),
  ix('claimCreatorTradingFee2', [238, 247, 213, 94, 110, 145, 88, 142], NON_SWAP, { pool: 1, baseMint: 6, quoteMint: 7 }),
  ix('claimTradingFee', [8, 236, 89, 49, 152, 125, 177, 81], NON_SWAP, CURVE),
  ix('claimTradingFee2', [84, 191, 71, 50, 9, 162, 55, 193], NON_SWAP, CURVE),
  ix('claimProtocolFee2', [235, 194, 54, 69, 65, 10, 236, 112], NON_SWAP, { baseMint: 1, quoteMint: 2, config: 5, pool: 6 }),
  ix('claimPartnerPoolCreationFee', [250, 238, 26, 4, 139, 10, 101, 248], NON_SWAP, { config: 0, pool: 1 }),
  ix('claimProtocolPoolCreationFee', [114, 205, 83, 188, 240, 153, 25, 54], NON_SWAP, { config: 0, pool: 1 }),
  ix('createVirtualPoolMetadata', [45, 97, 187, 103, 254, 109, 124, 134], NON_SWAP, { pool: 0 }),
  ix('transferPoolCreator', [20, 7, 169, 33, 58, 147, 166, 33], NON_SWAP, { pool: 0, config: 1 }),
  // A completed curve's surplus quote (creator, partner) and leftover base tokens: they move no swap fee, and can land before
  // the migration (src/stock-graduation-monitor.mjs proves that), so they are known non-swaps rather than a stop.
  ix('withdrawLeftover', [20, 198, 202, 237, 235, 243, 183, 66], NON_SWAP, { config: 1, pool: 2, baseMint: 5 }),
  ix('creatorWithdrawSurplus', [165, 3, 137, 7, 28, 134, 76, 80], NON_SWAP, { config: 1, pool: 2, quoteMint: 5 }),
  ix('partnerWithdrawSurplus', [168, 173, 72, 100, 201, 98, 38, 92], NON_SWAP, { config: 1, pool: 2, quoteMint: 5 }),
  ix('createLocker', [167, 90, 137, 154, 75, 47, 17, 84], MIGRATION),
  ix('migrateMeteoraDamm', [27, 1, 48, 22, 180, 63, 118, 217], MIGRATION),
  ix('migrateMeteoraDammClaimLpToken', [139, 133, 2, 30, 91, 145, 127, 154], MIGRATION),
  ix('migrateMeteoraDammLockLpToken', [177, 55, 238, 157, 251, 88, 165, 42], MIGRATION),
  ix('migrationDammV2', [156, 169, 230, 103, 53, 228, 80, 64], MIGRATION),
  ix('migrationDammV2CreateMetadata', [109, 189, 19, 36, 195, 183, 222, 82], MIGRATION),
  ix('migrationMeteoraDammCreateMetadata', [47, 94, 126, 115, 221, 226, 194, 133], MIGRATION),
  ix('withdrawMigrationFee', [237, 142, 45, 23, 129, 6, 222, 162], MIGRATION),
].map(Object.freeze))
const BY_DISCRIMINATOR = new Map(STOCK_DBC_INSTRUCTIONS.map(entry => [entry.discriminator, entry]))

// Deterministic, like UnparseableTradeError: the same finalized transaction always fails the same way. `unmatched` names
// each instruction or event that could not be matched.
export class StockEvidenceUnmatchedError extends UnparseableTradeError {
  constructor(unmatched) {
    super(`Stock curve evidence is not fully matched: ${unmatched.join('; ')}`)
    this.code = 'STOCK_EVIDENCE_UNMATCHED'
    this.unmatched = unmatched
  }
}
// The curve is migrating or migrated: graduation is not indexed by the curve indexer (an ERROR, never a quarantine).
export class StockCurveMigratedError extends Error {
  constructor(message = 'Stock-paired curve is migrating or migrated; graduation is not indexed yet') {
    super(message)
    this.code = 'STOCK_CURVE_MIGRATED'
  }
}

// evtSwap2's fee fields as evtSwap's (as trade-evidence.mjs maps them): actual input is the fee-excluded input.
const legacySwapData = data => ({ pool: data.pool, config: data.config, tradeDirection: data.tradeDirection,
  hasReferral: data.hasReferral, currentTimestamp: data.currentTimestamp,
  swapResult: { ...data.swapResult, actualInputAmount: data.swapResult.excludedFeeInputAmount } })
const AGREEING = ['actualInputAmount', 'outputAmount', 'nextSqrtPrice', 'tradingFee', 'protocolFee', 'referralFee']

// transaction: a finalized transaction (finalized-transaction.mjs); market: { pool, mint }; config: the market's stock DBC
// config; quoteMint: the market's stamped stock mint (required: nothing here assumes a quote). Returns the canonical swap
// events exactly as canonicalDbcSwapEvents shapes them, with the same transaction-wide event ordinals, so a ledger key
// (signature, event_index) means the same thing for both quotes.
// migrationSignature: the curve's proven migration (stock_graduation_events, src/stock-graduation-monitor.mjs). In exactly
// that transaction its migrationDammV2 is accepted, so a swap bundled before it is still read; anywhere else a migration
// instruction stays a StockCurveMigratedError.
export function stockDbcSwapEvents(transaction, market, { config, quoteMint, migrationSignature = null } = {}, dbc) {
  if (!quoteMint) throw Error('Stock swap evidence needs the market\'s quote mint')
  if (!config) throw Error('Stock swap evidence needs the market\'s DBC config')
  if (!transaction?.meta || transaction.meta.err) throw Error('Finalized trade transaction is unavailable or failed')
  const message = transaction.transaction.message, keys = message.accountKeys
  const groups = transaction.meta.innerInstructions
  // Without the recorded inner instructions a swap made through another program cannot be seen.
  if (!Array.isArray(groups)) throw new StockEvidenceUnmatchedError(['the transaction has no recorded inner instructions'])
  const pool = new PublicKey(market.pool), mint = new PublicKey(market.mint)
  const configKey = new PublicKey(config), quote = new PublicKey(quoteMint)
  const isKey = (index, expected) => Number.isInteger(index) && Boolean(keys[index]?.equals(expected))
  const namesPool = instruction => (instruction.accounts ?? []).some(index => isKey(index, pool))
  const provenMigration = Boolean(migrationSignature) && transaction.transaction.signatures?.[0] === migrationSignature
  const expected = { pool, config: configKey, baseMint: mint, quoteMint: quote }
  // The pool, config and mints exactly where the instruction takes them, and the pool nowhere else.
  const fullyMatches = (instruction, positions) => {
    const accounts = instruction.accounts ?? []
    if (!Object.entries(positions).every(([role, at]) => isKey(accounts[at], expected[role]))) return false
    return accounts.every((index, at) => at === positions.pool || !isKey(index, pool))
  }
  const unmatched = [], found = [], traders = [], canonical = new Map()
  let swapCount = 0, sawCanonicalSwap = false

  // A DBC instruction other than an event: a swap is numbered (as the SOL parser numbers them) and is canonical only when
  // fully matched; any other instruction naming the pool must be a known non-swap in its exact layout.
  const instructionOf = (instruction, label) => {
    const bytes = Buffer.from(bs58.decode(instruction.data ?? ''))
    const known = bytes.length >= 8 ? BY_DISCRIMINATOR.get(bytes.subarray(0, 8).toString('hex')) : undefined
    if (known?.kind === SWAP) return known
    if (!namesPool(instruction)) return null
    if (!known) unmatched.push(`${label}: an unknown DBC instruction names the pool`)
    else if (known.kind === MIGRATION && !(provenMigration && known.name === 'migrationDammV2')) throw new StockCurveMigratedError(`Stock-paired curve ${market.pool} is migrating (${known.name}); graduation is not indexed yet`)
    else if (known.kind === MIGRATION) return null
    else if (!fullyMatches(instruction, known.accounts)) unmatched.push(`${label}: ${known.name} names the pool with other accounts`)
    return null
  }

  // An outer DBC instruction without inner instructions made no CPI, so it emitted no event: it may not be a swap.
  const grouped = new Set(groups.map(group => group.index))
  message.instructions.forEach((instruction, index) => {
    if (grouped.has(index) || !isKey(instruction.programIdIndex, DBC_PROGRAM)) return
    const known = instructionOf(instruction, `instruction ${index}`)
    if (known && namesPool(instruction)) unmatched.push(`instruction ${index}: ${known.name} on the pool has no inner instructions`)
  })

  for (const group of groups) {
    const outer = message.instructions[group.index]
    const activeSwaps = new Map(), swapIds = new Map()
    let lastSwapId
    for (const [position, instruction] of [outer, ...group.instructions].entries()) {
      if (!instruction) continue
      const label = position === 0 ? `instruction ${group.index}` : `instruction ${group.index}.${position}`
      const depth = position === 0 ? 1 : Number.isInteger(instruction.stackHeight) ? instruction.stackHeight : null
      if (depth !== null) for (const active of [activeSwaps, swapIds]) for (const activeDepth of active.keys()) {
        if (activeDepth >= depth) active.delete(activeDepth)
      }
      if (!isKey(instruction.programIdIndex, DBC_PROGRAM)) continue
      const bytes = Buffer.from(bs58.decode(instruction.data ?? ''))
      if (bytes.subarray(0, 8).equals(EVENT_CPI_PREFIX)) {
        let decoded
        try { decoded = dbc.state.getProgram().coder.events.decode(bytes.subarray(8).toString('base64')) }
        catch (error) { throw new UnparseableTradeError(`DBC event CPI does not decode: ${error.message}`) }
        if (decoded?.name !== 'evtSwap' && !SWAP2_EVENTS.has(decoded?.name)) continue
        found.push({ name: decoded.name, data: decoded.data, label, swapId: depth === null ? lastSwapId : swapIds.get(depth - 1),
          hasParentSwap: depth === null ? activeSwaps.size > 0 : activeSwaps.has(depth - 1) })
        continue
      }
      const known = instructionOf(instruction, label)
      if (!known) continue
      lastSwapId = swapCount++
      traders[lastSwapId] = swapTrader(transaction, instruction, DBC_SWAP_PAYER)
      swapIds.set(depth ?? 2, lastSwapId)
      if (fullyMatches(instruction, known.accounts)) {
        sawCanonicalSwap = true
        activeSwaps.set(depth ?? 2, true)
        canonical.set(lastSwapId, { label, legacy: [], current: [] })
      } else if (namesPool(instruction)) unmatched.push(`${label}: ${known.name} names the pool with other accounts`)
    }
  }

  // Every swap event naming the pool belongs to a canonical swap on this config, and every event of a canonical swap names
  // the pool. Each canonical swap has exactly one evtSwap and/or one evtSwap2, and when it has both they agree.
  for (const event of found) {
    const parent = event.hasParentSwap ? canonical.get(event.swapId) : undefined
    const onPool = event.data.pool.equals(pool)
    if (onPool && !parent) unmatched.push(`${event.label}: ${event.name} for the pool outside a canonical swap`)
    else if (parent && !onPool) unmatched.push(`${event.label}: ${event.name} of a canonical swap names another pool`)
    else if (parent && !event.data.config.equals(configKey)) unmatched.push(`${event.label}: ${event.name} names another config`)
    else if (parent && ![0, 1].includes(event.data.tradeDirection)) unmatched.push(`${event.label}: ${event.name} has an unknown direction`)
    else if (parent) parent[event.name === 'evtSwap' ? 'legacy' : 'current'].push(event)
  }
  for (const { label, legacy, current } of canonical.values()) {
    if (legacy.length > 1 || current.length > 1 || legacy.length + current.length === 0) {
      unmatched.push(`${label}: a canonical swap emitted ${legacy.length} evtSwap and ${current.length} evtSwap2 events`)
    } else if (legacy.length && current.length) {
      const [a, b] = [legacy[0].data, legacySwapData(current[0].data)]
      if (a.tradeDirection !== b.tradeDirection || AGREEING.some(field => a.swapResult[field].toString() !== b.swapResult[field].toString())) {
        unmatched.push(`${label}: the swap's evtSwap and evtSwap2 disagree`)
      }
    }
  }
  if (unmatched.length) throw new StockEvidenceUnmatchedError(unmatched)

  // Ordinals exactly as canonicalDbcSwapEvents counts them: every evtSwap takes one; an evtSwap2 only when its own swap
  // emitted no evtSwap.
  const legacySwapIds = new Set(found.filter(event => event.name === 'evtSwap').map(event => event.swapId))
  const events = []
  let eventIndex = 0, sawCanonicalFeeEvent = false
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

// The stock_trade_events rows (venue 'dbc') of a transaction's canonical swap events. Amounts are raw units, the ones SOL
// charts derive from trade_events (market-chart.mjs): a buy's fee-excluded stock input and the market tokens it received; a
// sell's market tokens in and the stock it received. A dust swap can move nothing out (a buy's fee, rounded up, takes its whole
// input; a sell's output rounds down to nothing): still a swap, recorded with its zero amounts and its fee credited, as the
// DAMM side does (stock-damm-trades.mjs). A swap without a price is still refused.
export function stockTradeRows(transaction, signature, events) {
  return events.map(({ eventIndex, data, trader }) => {
    const direction = data.tradeDirection === 1 ? 'buy' : data.tradeDirection === 0 ? 'sell' : null
    if (!direction) throw new UnparseableTradeError('Canonical stock swap has an unknown direction')
    const { actualInputAmount, outputAmount, nextSqrtPrice } = data.swapResult
    if (nextSqrtPrice.isZero()) throw new UnparseableTradeError('Canonical stock swap has no price')
    const [quoteAmount, baseAmount] = direction === 'buy' ? [actualInputAmount, outputAmount] : [outputAmount, actualInputAmount]
    return { signature, eventIndex, slot: BigInt(transaction.slot), tradedAt: new Date(Number(data.currentTimestamp.toString()) * 1000),
      direction, quoteAmount: BigInt(quoteAmount.toString()), baseAmount: BigInt(baseAmount.toString()),
      nextSqrtPrice: nextSqrtPrice.toString(), trader }
  })
}
