import { ComputeBudgetProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { MAX_PRIORITY_FEE_LAMPORTS, chooseComputeUnitPrice, priorityFeeLamports } from './trade-landing.mjs'

// Phantom adds priority-fee instructions to unsigned transactions without an explicit compute budget, so the launch
// sets both a unit limit and a unit price before review: the reviewed message is final before the wallet signs it and
// before the server co-signs (creator and mint keys).
// Limit: the launch's simulated units × 1.2 (at least +40k for wallet-appended Lighthouse assertions, which the
// simulation cannot see). Measured on a local validator: ~100k units without a first buy, ~160-200k with one.
// Price: the trades' estimate (src/trade-landing.mjs), the p75 of recent fees on the launch's writable accounts, clamped,
// with a fallback. limit × price is capped at the trades' 0.001 SOL priority-fee cap.
export const LAUNCH_CU_LIMIT_FLOOR = 100_000
export const LAUNCH_CU_LIMIT_CEILING = 1_400_000
export const LAUNCH_CU_LIMIT_FALLBACK = 400_000
const CU_HEADROOM_TENTHS = 12n, CU_HEADROOM_MIN = 40_000n, MICRO = 1_000_000n
const SET_LIMIT = 2, SET_PRICE = 3
const isBudget = ix => ix.programId.equals(ComputeBudgetProgram.programId)

export function launchComputeUnitLimit(unitsConsumed) {
  const units = typeof unitsConsumed === 'bigint' ? unitsConsumed : Number.isSafeInteger(unitsConsumed) ? BigInt(unitsConsumed) : -1n
  if (units <= 0n) return LAUNCH_CU_LIMIT_FALLBACK
  const scaled = (units * CU_HEADROOM_TENTHS + 9n) / 10n, padded = units + CU_HEADROOM_MIN
  return Math.min(LAUNCH_CU_LIMIT_CEILING, Math.max(LAUNCH_CU_LIMIT_FLOOR, Number(scaled > padded ? scaled : padded)))
}

// The highest unit price whose fee at this limit stays within the cap (never raises the chosen price).
export const cappedLaunchPrice = (units, microLamports) =>
  Math.min(microLamports, Number(MAX_PRIORITY_FEE_LAMPORTS * MICRO / BigInt(units)))

const budgeted = (instructions, { feePayer, blockhash, units, microLamports }) => new Transaction({ feePayer, recentBlockhash: blockhash })
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions)

async function simulatedUnits(connection, probe, log) {
  try {
    const encoded = probe.serialize({ requireAllSignatures: false, verifySignatures: false })
    const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(encoded),
      { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true })
    return value.err ? null : value.unitsConsumed
  } catch (error) { log('launch priority fee: compute simulation unavailable, using fallback limit', error?.name ?? 'error'); return null }
}

// A new transaction: [unit limit, unit price, ...the unchanged launch instructions]. The probe has the same shape at the
// maximum limit and zero price, so the simulated units include both budget instructions. A failed probe (for example a
// wallet short of SOL) falls back to a fixed limit; the cost review's own simulation then refuses the launch.
export async function withLaunchPriorityFee(connection, transaction, { feePayer, blockhash, fetcher, log = console.warn }) {
  if (transaction.instructions.some(isBudget)) throw new Error('Launch compute budget must be set exactly once')
  const writableAccounts = [...new Map(transaction.instructions.flatMap(ix => ix.keys.filter(key => key.isWritable)
    .map(key => [key.pubkey.toBase58(), key.pubkey]))).values()]
  const probe = budgeted(transaction.instructions, { feePayer, blockhash, units: LAUNCH_CU_LIMIT_CEILING, microLamports: 0 })
  const [units, price] = await Promise.all([simulatedUnits(connection, probe, log),
    chooseComputeUnitPrice(connection, { probe, writableAccounts, fetcher, log })])
  const computeUnitLimit = launchComputeUnitLimit(units)
  const microLamports = cappedLaunchPrice(computeUnitLimit, price)
  return { transaction: budgeted(transaction.instructions, { feePayer, blockhash, units: computeUnitLimit, microLamports }),
    computeUnitLimit, microLamports, priorityFeeLamports: priorityFeeLamports({ units: computeUnitLimit, microLamports }) }
}

// What a launch transaction declares: exactly one unit limit then one unit price, ahead of every other instruction,
// within the launch bounds and the cap. Anything else fails closed (a wallet could otherwise re-price the launch).
export function readLaunchComputeBudget(instructions) {
  const [limitIx, priceIx] = instructions
  const plain = (ix, kind, length) => ix && isBudget(ix) && !ix.keys.length && ix.data.length === length && ix.data[0] === kind
  if (!plain(limitIx, SET_LIMIT, 5) || !plain(priceIx, SET_PRICE, 9) || instructions.slice(2).some(isBudget)) {
    throw new Error('Launch compute budget must be set exactly once')
  }
  const limit = limitIx.data.readUInt32LE(1), microLamports = priceIx.data.readBigUInt64LE(1)
  const priorityFee = priorityFeeLamports({ units: limit, microLamports })
  if (limit < 1 || limit > LAUNCH_CU_LIMIT_CEILING || priorityFee > MAX_PRIORITY_FEE_LAMPORTS) {
    throw new Error('Launch priority fee exceeds the configured maximum')
  }
  return { limit, microLamports, priorityFee }
}
