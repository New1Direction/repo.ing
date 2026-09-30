import { ComputeBudgetProgram, Transaction, VersionedTransaction } from '@solana/web3.js'

// Landing for prepared trades: a compute-unit limit sized from a preflight simulation and a priority fee sized from
// what recently landed on the same pool accounts, then a signed transaction rebroadcast until it confirms or expires.
// Without these a trade queues behind priority traffic on its pool and its blockhash runs out first.

// Compute units: simulated use × 1.2 (at least +15k) headroom, kept inside [floor, ceiling]. The fallback applies when simulation
// is unavailable or fails (the separate preflight still rejects a failing trade before it is signed).
export const CU_LIMIT_FLOOR = 60_000
export const CU_LIMIT_CEILING = 400_000
export const CU_LIMIT_FALLBACK = 300_000
const CU_HEADROOM_TENTHS = 12n
// Extra room for wallet-appended Lighthouse assertions (Phantom), which the simulation cannot see.
const CU_HEADROOM_MIN = 40_000n
const SIMULATION_CU_LIMIT = 1_400_000

// Price in microlamports per compute unit. p75 of recent non-zero fees on the pool's writable accounts (or Helius's
// High estimate), clamped to [min, max]. The floor still lands when the pool looks quiet but the leader is busy, at
// ~0.00002 SOL for a typical 70-100k CU trade. MAX × CEILING bounds the priority fee at 0.0008 SOL, under the 0.001 SOL cap.
export const CU_PRICE_MIN = 200_000
export const CU_PRICE_MAX = 2_000_000
export const CU_PRICE_FALLBACK = 500_000
export const PRIORITY_FEE_PERCENTILE = 75
export const MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n
const MICRO = 1_000_000n
const FEE_LOOKUP_TIMEOUT_MS = 2500
if ((BigInt(CU_LIMIT_CEILING) * BigInt(CU_PRICE_MAX) + MICRO - 1n) / MICRO > MAX_PRIORITY_FEE_LAMPORTS) throw Error('Priority fee bounds exceed the cap')

// Rebroadcast the same signed bytes every ~2s, bounded in wall time; the blockhash expiry ends it earlier.
export const REBROADCAST_INTERVAL_MS = 2000
export const REBROADCAST_MAX_MS = 45_000

const SET_LIMIT = 2, SET_PRICE = 3
const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

export function selectComputeUnitPrice(recentFees, percentile = PRIORITY_FEE_PERCENTILE) {
  const fees = (Array.isArray(recentFees) ? recentFees : []).map(row => Number(row?.prioritizationFee))
    .filter(fee => Number.isSafeInteger(fee) && fee > 0).sort((a, b) => a - b)
  if (!fees.length) return CU_PRICE_MIN
  return clamp(fees[Math.max(0, Math.ceil(percentile / 100 * fees.length) - 1)], CU_PRICE_MIN, CU_PRICE_MAX)
}

export function clampComputeUnitPrice(value) {
  const price = Math.ceil(Number(value))
  return Number.isFinite(price) && price >= 0 ? clamp(price, CU_PRICE_MIN, CU_PRICE_MAX) : null
}

export function computeUnitLimit(unitsConsumed) {
  const units = typeof unitsConsumed === 'bigint' ? unitsConsumed : Number.isSafeInteger(unitsConsumed) ? BigInt(unitsConsumed) : -1n
  if (units <= 0n) return CU_LIMIT_FALLBACK
  const scaled = (units * CU_HEADROOM_TENTHS + 9n) / 10n, padded = units + CU_HEADROOM_MIN
  return clamp(Number(scaled > padded ? scaled : padded), CU_LIMIT_FLOOR, CU_LIMIT_CEILING)
}

export const priorityFeeLamports = ({ units, microLamports }) => (BigInt(units) * BigInt(microLamports) + MICRO - 1n) / MICRO

// The only compute-budget instructions a prepared trade may carry: at most one unit limit (≤ ceiling) and one unit
// price (≤ max), both ahead of every other instruction, with no accounts. Returns what the transaction declares.
export function readTradeComputeBudget(instructions) {
  let limit = null, price = null, prefix = true
  for (const ix of instructions) {
    if (!ix.programId.equals(ComputeBudgetProgram.programId)) { prefix = false; continue }
    const d = ix.data
    if (!prefix || ix.keys.length) throw Error('Trade transaction contains an unexpected compute budget instruction')
    if (d.length === 5 && d[0] === SET_LIMIT && limit === null) limit = d.readUInt32LE(1)
    else if (d.length === 9 && d[0] === SET_PRICE && price === null) price = d.readBigUInt64LE(1)
    else throw Error('Trade transaction contains an unexpected compute budget instruction')
  }
  if ((limit !== null && (limit < 1 || limit > CU_LIMIT_CEILING)) || (price !== null && price > BigInt(CU_PRICE_MAX))) {
    throw Error('Trade transaction compute budget exceeds the configured maximum')
  }
  const count = (limit !== null) + (price !== null)
  return { count, limit, microLamports: price ?? 0n }
}

// Lamports the declared price adds to the network fee. Without a limit instruction the runtime default applies:
// 200k units per non-compute-budget instruction, at most 1.4M.
export function tradePriorityFee(instructions) {
  const budget = readTradeComputeBudget(instructions)
  const units = budget.limit ?? Math.min(SIMULATION_CU_LIMIT, 200_000 * (instructions.length - budget.count))
  return priorityFeeLamports({ units, microLamports: budget.microLamports })
}

export const isHeliusEndpoint = endpoint => {
  try { return /(^|\.)helius-rpc\.com$/.test(new URL(endpoint).hostname) } catch { return false }
}

// Helius's own estimator reads the whole transaction's writable accounts. The endpoint URL carries the API key, so
// only the error class is ever logged.
async function heliusEstimate(endpoint, writableAccounts, fetcher) {
  // Account-key form: the serialized-transaction form failed for unsigned probes in production.
  const accountKeys = writableAccounts.map(key => (typeof key === 'string' ? key : key.toBase58()))
  const response = await fetcher(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(FEE_LOOKUP_TIMEOUT_MS),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'repoing-priority-fee', method: 'getPriorityFeeEstimate',
      params: [{ accountKeys, options: { priorityLevel: 'High' } }] }) })
  if (!response.ok) throw Error(`Helius priority fee HTTP ${response.status}`)
  const price = clampComputeUnitPrice((await response.json())?.result?.priorityFeeEstimate)
  if (price === null) throw Error('Helius priority fee estimate missing')
  return price
}

export async function chooseComputeUnitPrice(connection, { probe, writableAccounts, fetcher = globalThis.fetch, log = console.warn }) {
  if (isHeliusEndpoint(connection.rpcEndpoint)) {
    try { return await heliusEstimate(connection.rpcEndpoint, writableAccounts, fetcher) }
    catch (error) { log('priority fee: Helius estimate unavailable, using recent fees', error?.name ?? 'error') }
  }
  try { return selectComputeUnitPrice(await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts })) }
  catch (error) { log('priority fee: recent fees unavailable, using fallback', error?.name ?? 'error'); return CU_PRICE_FALLBACK }
}

async function simulatedLimit(connection, probe, log) {
  try {
    const encoded = probe.serialize({ requireAllSignatures: false, verifySignatures: false })
    const { value } = await connection.simulateTransaction(VersionedTransaction.deserialize(encoded),
      { commitment: 'confirmed', sigVerify: false, replaceRecentBlockhash: true })
    return value.err ? CU_LIMIT_FALLBACK : computeUnitLimit(value.unitsConsumed)
  } catch (error) { log('priority fee: compute simulation unavailable, using fallback limit', error?.name ?? 'error'); return CU_LIMIT_FALLBACK }
}

const budgeted = (instructions, { feePayer, blockhash, units, microLamports }) => new Transaction({ feePayer, recentBlockhash: blockhash })
  .add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...instructions)

// A new transaction: [unit limit, unit price, ...the unchanged trade instructions]. The probe carries the same
// shape at zero price, so the simulated units include the budget instructions and the payer needs no fee headroom.
export async function withPriorityFee(connection, transaction, { feePayer, blockhash, writableAccounts, fetcher, log = console.warn }) {
  if (transaction.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
    throw Error('Trade transaction compute budget must be set exactly once')
  }
  const probe = budgeted(transaction.instructions, { feePayer, blockhash, units: SIMULATION_CU_LIMIT, microLamports: 0 })
  const [units, microLamports] = await Promise.all([simulatedLimit(connection, probe, log),
    chooseComputeUnitPrice(connection, { probe, writableAccounts, fetcher, log })])
  const tx = budgeted(transaction.instructions, { feePayer, blockhash, units, microLamports })
  return { transaction: tx, computeUnitLimit: units, microLamports,
    priorityFeeLamports: priorityFeeLamports({ units, microLamports }) }
}

// Server-signed payouts (platform fee claims, builder fee payouts): the same landing budget, signed by every signer.
// Their network fee is bounded by one base fee per signature plus CU_LIMIT_CEILING × CU_PRICE_MAX (0.0008 SOL);
// getFeeForMessage and the receipt's meta.fee both include the priority fee.
export const LAMPORTS_PER_SIGNATURE = 5000n
export const MAX_PAYOUT_PRIORITY_FEE_LAMPORTS = BigInt(CU_LIMIT_CEILING) * BigInt(CU_PRICE_MAX) / MICRO
export const maxPayoutNetworkFee = signatures => BigInt(signatures) * LAMPORTS_PER_SIGNATURE + MAX_PAYOUT_PRIORITY_FEE_LAMPORTS
// A claim worth less than 20× its own network fee is left to accrue rather than paid for.
export const PAYOUT_DUST_FEE_MULTIPLE = 20n
export const isDustPayout = (amount, networkFee) => BigInt(amount) < PAYOUT_DUST_FEE_MULTIPLE * BigInt(networkFee)

const writableKeys = instructions => [...new Map(instructions.flatMap(ix => ix.keys.filter(k => k.isWritable)
  .map(k => [k.pubkey.toBase58(), k.pubkey]))).values()]

// Rebuilds [limit, price, ...instructions] and signs it with every signer (fee payer first); all signatures must verify.
export async function signedWithPriorityFee(connection, transaction, { feePayer, blockhash, signers, fetcher, log = console.warn }) {
  if (!signers?.[0]?.publicKey.equals(feePayer)) throw Error('Payout fee payer must sign first')
  const landing = await withPriorityFee(connection, transaction, { feePayer, blockhash,
    writableAccounts: writableKeys(transaction.instructions), fetcher, log })
  landing.transaction.sign(...signers)
  if (!landing.transaction.verifySignatures()) throw Error('Payout transaction signatures are incomplete')
  return landing
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const LANDED = ['confirmed', 'finalized']

// Sends the exact signed bytes (preflight on the first send only) and rebroadcasts them until the signature is
// confirmed or failed, the block height passes lastValidBlockHeight, or the wall-time bound runs out. The caller's
// confirmation and verification flow runs afterwards unchanged. Rebroadcast errors ("already processed", a busy
// node) are expected and never alter the outcome, so they are counted, not thrown.
export async function broadcastUntilSettled(connection, raw, { signature, lastValidBlockHeight, intervalMs = REBROADCAST_INTERVAL_MS,
  maxMs = REBROADCAST_MAX_MS, sleep = pause, now = Date.now } = {}) {
  await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 })
  const deadline = now() + maxMs
  let sends = 1, rebroadcastErrors = 0
  while (now() < deadline) {
    await sleep(intervalMs)
    const status = (await connection.getSignatureStatuses([signature]).catch(() => null))?.value?.[0]
    if (status?.err) return { state: 'failed', sends, rebroadcastErrors }
    if (status && LANDED.includes(status.confirmationStatus)) return { state: 'confirmed', sends, rebroadcastErrors }
    const height = await connection.getBlockHeight('confirmed').catch(() => null)
    if (Number.isSafeInteger(height) && height > lastValidBlockHeight) return { state: 'expired', sends, rebroadcastErrors }
    try { await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); sends++ }
    catch { rebroadcastErrors++ }
  }
  return { state: 'timeout', sends, rebroadcastErrors }
}
