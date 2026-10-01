import { Message, PublicKey, Transaction } from '@solana/web3.js'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'

// A prepared trade as plain JSON: everything submit and receipt verification need, so any instance (or the same one
// after a restart) can finish a trade it did not prepare. Records are written only by a trader's own prepare and
// stored server-side; they never come from a browser. Amounts are decimal strings, keys base58, bytes base64.
export const TRADE_RECORD_VERSION = 1
const PHASES = ['curve', 'graduated']
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const U64 = /^(0|[1-9][0-9]{0,19})$/

const fail = () => { throw Error('Trade was not prepared by this trader') }
const key = value => { try { return new PublicKey(value) } catch { return fail() } }
const optionalKey = value => value === null ? null : key(value)
const bytes = value => typeof value === 'string' && B64.test(value) ? Buffer.from(value, 'base64') : fail()
const u64 = value => typeof value === 'string' && U64.test(value) && BigInt(value) <= 18446744073709551615n ? BigInt(value) : fail()

// Decoded view of a record for one trader phase. Throws the same "not prepared" error for anything malformed.
export function readTradeRecord(record, phase) {
  if (!record || typeof record !== 'object' || record.v !== TRADE_RECORD_VERSION || record.phase !== phase || !PHASES.includes(phase) ||
      !['buy', 'sell'].includes(record.direction) || !Number.isSafeInteger(record.lastValidBlockHeight) ||
      !(Number.isSafeInteger(record.marketId) || typeof record.marketId === 'string') || typeof record.blockhash !== 'string') fail()
  const saved = { direction: record.direction, wallet: key(record.wallet), marketId: record.marketId, githubRepoId: u64(record.githubRepoId),
    mint: key(record.mint), pool: key(record.pool), referral: optionalKey(record.referral ?? null),
    wsolRent: record.wsolRent === null ? null : u64(record.wsolRent), amountIn: u64(record.amountIn),
    minimumAmountOut: u64(record.minimumAmountOut), message: bytes(record.message), transaction: bytes(record.transaction),
    signedMessage: record.signedMessage ? bytes(record.signedMessage) : null,
    blockhash: key(record.blockhash).toBase58(), lastValidBlockHeight: record.lastValidBlockHeight }
  if (phase === 'graduated') Object.assign(saved, { curve: key(record.curve).toBase58(), tokenAVault: key(record.tokenAVault), tokenBVault: key(record.tokenBVault) })
  // The unsigned transaction handed to the wallet must be exactly the reviewed message; a stored wallet-signed message
  // must be the reviewed one, or it plus only constrained wallet assertions.
  let consistent = false
  try {
    consistent = Buffer.from(Transaction.from(saved.transaction).serializeMessage()).equals(saved.message) &&
      (!saved.signedMessage || matchesReviewedTransaction(saved.message, Transaction.populate(Message.from(saved.signedMessage))))
  } catch { consistent = false }
  if (!consistent) fail()
  return Object.freeze(saved)
}

// The prepared object callers use (route, Solana Actions, scripts), rebuilt from a record.
export function preparedFromRecord(record, transaction = null) {
  const saved = readTradeRecord(record, record?.phase)
  return { transaction: transaction ?? Transaction.from(saved.transaction), direction: saved.direction, amountIn: saved.amountIn,
    minimumAmountOut: saved.minimumAmountOut, lastValidBlockHeight: saved.lastValidBlockHeight, githubRepoId: saved.githubRepoId,
    mint: saved.mint.toBase58(), pool: saved.pool.toBase58(), slippageBps: record.slippageBps, phase: record.phase,
    referral: saved.referral?.toBase58() ?? null, priorityFee: record.priorityFee ?? null, launchFee: record.launchFee ?? null, record }
}

// The record after the wallet signed: the signed message (reviewed + any accepted assertions) is what lands on chain.
export function recordWithSignedMessage(record, signed) {
  return Object.freeze({ ...record, signedMessage: Buffer.from(signed.serializeMessage()).toString('base64') })
}

export const serializeUnsigned = tx => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
