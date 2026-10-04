import bs58 from 'bs58'
import { Keypair, Message, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { broadcastUntilSettled, maxPayoutNetworkFee, signedWithPriorityFee } from './trade-landing.mjs'

// Execution of stock-pair fee collections (src/stock-collection-execution.mjs) and launcher payouts
// (src/stock-launcher-payouts.mjs), each off unless its operator flag is 'true' (docs/STOCK_QUOTES.md, "Execution (off by
// default)"). Every transaction takes the path the SOL platform-fee claims take (src/platform-dbc-fees.mjs):
//   1. under the market's lock, its terms are rebuilt from fresh reads, then it is signed and simulated;
//   2. its row is recorded 'pending' with the signed bytes and the intent (blockhash, last valid block height, terms) in
//      `receipt` BEFORE anything is sent (migration 0054 has no other column for them; a settled row's receipt replaces it);
//   3. it is sent and rebroadcast until it lands or its blockhash expires, then followed to finalized;
//   4. its finalized receipt is checked against the terms (the exact signed message, exact raw balance deltas) and the row is
//      settled in one statement.
// A crash anywhere leaves a pending row that recovery finishes: it settles a finalized transaction, rebroadcasts the stored
// bytes while their blockhash is valid, and aborts only once that blockhash has expired at finalized and no RPC knows the
// signature. A landed transaction whose receipt does not match its terms is never aborted: it stays pending for review.

export const STOCK_EXECUTION_FLAGS = Object.freeze({ collections: 'STOCK_COLLECTIONS_EXECUTION_ENABLED', payouts: 'STOCK_LAUNCHER_PAYOUTS_ENABLED' })
// The keys the SOL claim paths sign with (app/lib/server.mjs): the platform creator (a curve's creator and the graduated creator
// position's owner) and the partner (every stock config's fee claimer, the partner position's owner and the custody wallet).
export const STOCK_SIGNER_KEYS = Object.freeze({ creator: 'PLATFORM_CREATOR_SECRET_KEY', partner: 'PLATFORM_PARTNER_SECRET_KEY' })
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
// One signature (the fee payer, who is the only signer) plus the bounded priority fee: 0.000805 SOL.
export const STOCK_MAX_NETWORK_FEE_LAMPORTS = maxPayoutNetworkFee(1)
export const STOCK_EXECUTION_ALERT = 'STOCK_EXECUTION_REVIEW'

export const STOCK_EXECUTION_ERRORS = Object.freeze({
  DISABLED: 'STOCK_EXECUTION_DISABLED',
  INVALID_REQUEST: 'STOCK_EXECUTION_INVALID_REQUEST',
  KEY_MISSING: 'STOCK_EXECUTION_KEY_MISSING',
  KEY_INVALID: 'STOCK_EXECUTION_KEY_INVALID',
  SIGNER_MISMATCH: 'STOCK_EXECUTION_SIGNER_MISMATCH',
  NETWORK: 'STOCK_EXECUTION_NETWORK',
  NOT_EXECUTABLE: 'STOCK_EXECUTION_NOT_EXECUTABLE',
  CUSTODY_SHORTFALL: 'STOCK_EXECUTION_CUSTODY_SHORTFALL',
  TERMS_CHANGED: 'STOCK_EXECUTION_TERMS_CHANGED',
  IN_FLIGHT: 'STOCK_EXECUTION_IN_FLIGHT',
  NETWORK_FEE: 'STOCK_EXECUTION_NETWORK_FEE',
  PREFLIGHT: 'STOCK_EXECUTION_PREFLIGHT_FAILED',
  INTENT: 'STOCK_EXECUTION_INTENT_INVALID',
  RECEIPT: 'STOCK_EXECUTION_RECEIPT_MISMATCH',
})
const E = STOCK_EXECUTION_ERRORS

export class StockExecutionError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StockExecutionError'
    this.code = code
  }
}
export const fail = (code, message) => { throw new StockExecutionError(code, message) }

export function stockExecutionFlags(env = process.env) {
  return { collections: env[STOCK_EXECUTION_FLAGS.collections] === 'true', payouts: env[STOCK_EXECUTION_FLAGS.payouts] === 'true' }
}
export function assertStockExecutionEnabled(kind, env = process.env) {
  if (!stockExecutionFlags(env)[kind]) fail(E.DISABLED, `Stock ${kind} execution is off: ${STOCK_EXECUTION_FLAGS[kind]} is not 'true'`)
}

export const isRepoId = value => /^[1-9]\d{0,18}$/.test(String(value ?? ''))
export const isLocalRpc = connection => /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(connection?.rpcEndpoint ?? '')

// A signer key from the environment (base58 or a JSON byte array), read only when a transaction is about to be signed. The
// value never appears in an error, a log or a result.
export function loadStockSigner(role, env = process.env) {
  const name = STOCK_SIGNER_KEYS[role]
  if (!name) fail(E.INVALID_REQUEST, `Unknown signer role ${role}`)
  const value = env[name]?.trim()
  if (!value) fail(E.KEY_MISSING, `${name} is required to sign this`)
  try { return Keypair.fromSecretKey(value.startsWith('[') ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value)) }
  catch { return fail(E.KEY_INVALID, `${name} is not a valid Solana secret key`) }
}

// Mainnet (or a local validator), and off localnet a second, independent RPC on the same network: every read that decides a
// transaction (the previews, recovery's absence checks) is then made on both.
export async function assertExecutionNetwork({ connection, verification = null }) {
  const local = isLocalRpc(connection)
  const genesis = await connection.getGenesisHash()
  if (!local && genesis !== MAINNET_GENESIS) fail(E.NETWORK, 'Stock execution runs on Solana mainnet or a local validator only')
  if (!local && !verification) fail(E.NETWORK, 'Stock execution needs an independent verification RPC (GRADUATION_VERIFICATION_RPC_URL)')
  if (verification && await verification.getGenesisHash() !== genesis) fail(E.NETWORK, 'The two RPCs are on different networks')
  return genesis
}

// Signs [compute limit, compute price, ...instructions] with the fee payer as the only signer, then checks its network fee
// against the ceiling and simulates it with signature verification. Nothing is sent or stored here.
export async function signStockTransaction({ connection, instructions, signer, maxNetworkFee = STOCK_MAX_NETWORK_FEE_LAMPORTS, log }) {
  const latest = await connection.getLatestBlockhash('confirmed')
  const { transaction } = await signedWithPriorityFee(connection, new Transaction().add(...instructions), { feePayer: signer.publicKey,
    blockhash: latest.blockhash, signers: [signer], ...(log ? { log } : {}) })
  const fee = (await connection.getFeeForMessage(transaction.compileMessage(), 'confirmed')).value
  if (fee == null || BigInt(fee) > maxNetworkFee) fail(E.NETWORK_FEE, 'The network fee is unavailable or above its ceiling')
  const raw = transaction.serialize()
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true, commitment: 'confirmed' })
  if (simulation.value.err) fail(E.PREFLIGHT, `Preflight failed: ${JSON.stringify(simulation.value.err)}`)
  return { transaction, raw, signature: bs58.encode(transaction.signature), blockhash: latest.blockhash,
    lastValidBlockHeight: BigInt(latest.lastValidBlockHeight), networkFee: BigInt(fee) }
}

// What a pending row keeps in `receipt` until it settles or aborts.
export function pendingIntent({ kind, landing, terms }) {
  return { state: 'pending', kind, blockhash: landing.blockhash, lastValidBlockHeight: String(landing.lastValidBlockHeight),
    networkFee: String(landing.networkFee), terms }
}

export function readIntent(row, kind) {
  const intent = typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt
  if (intent?.state !== 'pending' || intent.kind !== kind || typeof intent.blockhash !== 'string' ||
    !/^\d{1,19}$/.test(String(intent.lastValidBlockHeight ?? '')) || !intent.terms || typeof intent.terms !== 'object') {
    fail(E.INTENT, `Pending ${kind} ${row.id} has no readable intent; review required`)
  }
  return intent
}

// The stored signed transaction of a pending row: fully signed, with the row's signature and the intent's blockhash.
export function storedTransaction(row, intent) {
  let transaction
  try { transaction = Transaction.from(Buffer.from(String(row.signedTransaction ?? ''), 'base64')) }
  catch { return fail(E.INTENT, `Pending row ${row.id} has no readable signed transaction; review required`) }
  if (!transaction.signature || !transaction.verifySignatures() || bs58.encode(transaction.signature) !== row.signature ||
    transaction.recentBlockhash !== intent.blockhash) fail(E.INTENT, `Pending row ${row.id}'s signed transaction does not match the row; review required`)
  return transaction
}

// A finalized transaction (as src/finalized-transaction.mjs normalizes it) must be exactly the stored signed message.
export function assertSignedMessage(finalized, stored) {
  if (finalized?.version !== 'legacy') fail(E.RECEIPT, 'The finalized transaction is not the legacy transaction that was signed')
  const m = finalized.transaction.message
  const message = new Message({ header: m.header, recentBlockhash: m.recentBlockhash,
    accountKeys: m.accountKeys.map(k => (k instanceof PublicKey ? k.toBase58() : String(k))),
    instructions: m.instructions.map(ix => ({ programIdIndex: ix.programIdIndex, accounts: ix.accounts, data: ix.data })) })
  if (!message.serialize().equals(stored.serializeMessage())) fail(E.RECEIPT, 'The finalized transaction is not the stored signed message')
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const status = async (rpc, signature) => (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0] ?? null

// Sends the stored bytes and follows them: 'finalized' (successful), 'failed' (finalized with an error), or, when the send was
// refused or the bytes did not reach finality in time, 'unsettled' with the reason. A failed or unsettled row stays pending
// for recovery; nothing here decides an abort.
export async function sendAndFollow({ connection, landing, sleep = pause, now = Date.now, finalityMs = 120_000, intervalMs = 2000 }) {
  let sent
  try {
    sent = await broadcastUntilSettled(connection, landing.raw, { signature: landing.signature,
      lastValidBlockHeight: Number(landing.lastValidBlockHeight), sleep, now })
  } catch (error) { return { state: 'unsettled', reason: `send refused: ${error?.message ?? 'unknown'}`.slice(0, 200) } }
  if (sent.state === 'expired' || sent.state === 'timeout') return { state: 'unsettled', reason: `broadcast ${sent.state}` }
  const deadline = now() + finalityMs
  while (now() < deadline) {
    const current = await status(connection, landing.signature).catch(() => null)
    if (current?.confirmationStatus === 'finalized') return { state: current.err ? 'failed' : 'finalized' }
    await sleep(intervalMs)
  }
  return { state: 'unsettled', reason: 'not finalized in time' }
}

// What the chain says about a pending row's signed transaction, for recovery:
//   finalized  found at finalized, successful        failed   found at finalized with an error
//   landing    known to an RPC, not finalized yet      valid    unknown, and its blockhash still valid: rebroadcast it
//   expired    unknown to every RPC (both, when a verification RPC is set) after its blockhash expired at finalized
export async function chainState({ connection, verification = null, signature, lastValidBlockHeight, loadTransaction }) {
  const transaction = await loadTransaction(connection, signature)
  if (transaction) return { state: transaction.meta?.err ? 'failed' : 'finalized', transaction }
  if (await status(connection, signature)) return { state: 'landing' }
  if (BigInt(await connection.getBlockHeight('finalized')) <= BigInt(lastValidBlockHeight)) return { state: 'valid' }
  for (const rpc of [connection, verification].filter(Boolean)) {
    if (await loadTransaction(rpc, signature) || await status(rpc, signature)) return { state: 'landing' }
  }
  return { state: 'expired' }
}

// Recovery of one pending row (under its market's lock). settle(transaction) settles a finalized transaction or returns REVIEW;
// abort(reason) aborts the row. dryRun only says what it would do.
export async function recoverPendingRow({ row, kind, connection, verification = null, loadTransaction, dryRun = false, settle, abort }) {
  const intent = readIntent(row, kind)
  const stored = storedTransaction(row, intent)
  const chain = await chainState({ connection, verification, signature: row.signature, lastValidBlockHeight: intent.lastValidBlockHeight, loadTransaction })
  const base = { id: String(row.id), repoId: String(row.repoId), signature: row.signature }
  if (chain.state === 'finalized') return dryRun ? { ...base, status: 'WOULD_SETTLE' } : settle({ transaction: chain.transaction, intent, stored })
  if (chain.state === 'failed') {
    const reason = 'The finalized transaction failed on chain'
    return dryRun ? { ...base, status: 'WOULD_ABORT', reason } : abort({ intent, reason })
  }
  if (chain.state === 'expired') {
    const reason = 'Its blockhash expired at finalized and no RPC knows the signature'
    return dryRun ? { ...base, status: 'WOULD_ABORT', reason } : abort({ intent, reason })
  }
  if (chain.state === 'landing') return { ...base, status: 'WAITING', reason: 'Landed; not finalized yet' }
  if (dryRun) return { ...base, status: 'WOULD_REBROADCAST' }
  try {
    await connection.sendRawTransaction(stored.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 })
    return { ...base, status: 'REBROADCAST' }
  } catch (error) {
    return { ...base, status: 'WAITING', reason: `Rebroadcast refused: ${error?.message ?? 'unknown'}`.slice(0, 200) }
  }
}

// An operator alert for a row that needs a person (graduation_alerts, the operator feed the stock indexer also writes to).
export async function raiseExecutionAlert(db, { repoId, key, detail }) {
  await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4) on conflict(event_key) do nothing`,
    [`stock-execution:${key}`, String(repoId), STOCK_EXECUTION_ALERT, JSON.stringify(detail)])
}

// A result for the job report: never a stack, never a key; the code when there is one.
export function errorResult(base, error) {
  return { ...base, status: 'ERROR', code: error?.code ?? null, reason: String(error?.message ?? error ?? 'unknown').slice(0, 200) }
}
