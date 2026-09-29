import bs58 from 'bs58'
import { Transaction } from '@solana/web3.js'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'
import { preparedFromRecord, readTradeRecord } from './trade-record.mjs'

// Prepared trade sessions that survive deploys and span replicas. The database row is the truth; the in-process Map is
// only a cache. A row holds the trader's plain prepared record (unsigned transaction, exact reviewed message, amounts,
// blockhash window and every pin receipt verification needs), the first accepted signature, and the final result.
// Wallet addresses are stored here (as they are on chain) and deleted with the row after SESSION_TTL_MS.
export const SESSION_TTL_MS = 10 * 60 * 1000
export const SUBMIT_WINDOW_MS = 120_000
const CLEANUP_EVERY_MS = 60_000
const CACHE_MAX = 5000
export const TRADE_WINDOW_CLOSED = 'TRADE_WINDOW_CLOSED'
const COLUMNS = `id, wallet, record, extract(epoch from created_at) * 1000 as "createdAt", signature, signed_message as "signedMessage",
  extract(epoch from submitted_at) * 1000 as "submittedAt", result`

export const windowClosed = () => Object.assign(Error('The trade window closed — please try again'), { code: TRADE_WINDOW_CLOSED })

// The wallet-returned transaction for a session, accepted only inside the submit window and only if it is the exact
// reviewed message (or it plus constrained wallet assertions), paid by the session wallet, and fully signed.
export function acceptSignedTrade(session, transactionBase64, now = Date.now()) {
  if (!session || now - session.createdAt > SUBMIT_WINDOW_MS) throw windowClosed()
  let signed
  try { signed = Transaction.from(Buffer.from(String(transactionBase64), 'base64')) }
  catch { throw Error('Wallet returned an altered or unsigned trade transaction') }
  if (!signed.signature || !matchesReviewedTransaction(Buffer.from(session.prepared.record.message, 'base64'), signed) ||
      signed.feePayer?.toBase58() !== session.wallet || !signed.verifySignatures()) {
    throw Error('Wallet returned an altered or unsigned trade transaction')
  }
  const signature = bs58.encode(signed.signature)
  if (session.signature && session.signature !== signature) throw Error('Prepared trade already has a different signature')
  return { signed, signature, signedMessage: Buffer.from(signed.serializeMessage()).toString('base64') }
}

export function sessionFromRow(row, engineFor) {
  const record = row.signedMessage ? { ...row.record, signedMessage: row.signedMessage } : row.record
  readTradeRecord(record, record?.phase)
  if (record.wallet !== row.wallet) throw Error('Trade was not prepared by this trader')
  const engine = engineFor(record.phase)
  if (!engine) throw Error('Trade was not prepared by this trader')
  return { id: row.id, prepared: preparedFromRecord(record), engine, wallet: row.wallet, createdAt: Number(row.createdAt),
    signature: row.signature ?? undefined, submittedAt: row.submittedAt === null || row.submittedAt === undefined ? undefined : Number(row.submittedAt),
    result: row.result ?? undefined }
}

export function createTradeSessionStore({ db, engineFor, cache = new Map(), now = Date.now, log = console.error }) {
  let nextCleanup = 0
  const remember = session => {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
    cache.set(session.id, session)
    return session
  }
  const fresh = session => session && now() - session.createdAt <= SESSION_TTL_MS ? session : null

  async function cleanup() {
    for (const [id, session] of cache) if (!fresh(session)) cache.delete(id)
    if (now() < nextCleanup) return 0
    nextCleanup = now() + CLEANUP_EVERY_MS
    const { rowCount } = await db.query('delete from trade_sessions where created_at < $1', [new Date(now() - SESSION_TTL_MS)])
    return rowCount
  }

  // Persisted before the client sees the transaction. If the database is unavailable the session is kept in this
  // process only (the pre-persistence behavior): trading stays up, but that one trade does not survive a restart.
  async function create(id, { prepared, wallet }) {
    const record = prepared.record
    readTradeRecord(record, record?.phase)
    if (record.wallet !== wallet) throw Error('Prepared trade does not match the wallet')
    const createdAt = now(), session = { id, prepared, engine: engineFor(record.phase), wallet, createdAt }
    try {
      await db.query(`insert into trade_sessions(id, wallet, phase, direction, github_repo_id, transaction, message, amount_in, minimum_amount_out,
        blockhash, last_valid_block_height, record, created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, wallet, record.phase, record.direction, record.githubRepoId, record.transaction, record.message, record.amountIn,
        record.minimumAmountOut, record.blockhash, record.lastValidBlockHeight, JSON.stringify(record), new Date(createdAt)])
    } catch (error) {
      log('trade session not persisted; kept in this process only', error?.code ?? error?.name ?? 'error')
      return remember({ ...session, memoryOnly: true })
    }
    cleanup().catch(error => log('trade session cleanup failed', error?.code ?? error?.name ?? 'error'))
    return remember(session)
  }

  // The row is read every time (another replica may have submitted it) unless the cached copy is already final.
  // A database blip falls back to this process's copy. Expired sessions are gone.
  async function load(id) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
    const cached = fresh(cache.get(id))
    if (cached?.result || cached?.memoryOnly) return cached
    let row
    try { ({ rows: [row] } = await db.query(`select ${COLUMNS} from trade_sessions where id = $1`, [id])) }
    catch (error) { if (cached) return cached; throw error }
    if (!row) return null
    const session = fresh(sessionFromRow(row, engineFor))
    return session ? remember({ ...session, recorded: cached?.recorded }) : null
  }

  // The first signature wins across every replica; the same signature may be submitted again (rebroadcast).
  async function markSubmitted(session, { signature, signedMessage }) {
    const at = session.submittedAt ?? now()
    if (session.memoryOnly) {
      const current = cache.get(session.id) ?? session
      if (current.signature && current.signature !== signature) throw Error('Prepared trade already has a different signature')
      const record = { ...session.prepared.record, signedMessage }
      return remember({ ...current, prepared: preparedFromRecord(record), signature, submittedAt: current.submittedAt ?? at })
    }
    const { rows: [row] } = await db.query(`update trade_sessions set signature = $2, signed_message = $3,
        submitted_at = coalesce(submitted_at, $4) where id = $1 and (signature is null or signature = $2)
      returning ${COLUMNS}`, [session.id, signature, signedMessage, new Date(at)])
    if (!row) throw Error('Prepared trade already has a different signature')
    return remember({ ...sessionFromRow(row, engineFor), recorded: session.recorded })
  }

  // Best effort: the trade already confirmed; without the saved result a status poll re-verifies from the record.
  async function saveResult(session, result) {
    if (!session.memoryOnly) {
      try { await db.query('update trade_sessions set result = $2 where id = $1 and signature = $3', [session.id, JSON.stringify(result), result.signature]) }
      catch (error) { log('trade session result not persisted', error?.code ?? error?.name ?? 'error') }
    }
    return remember({ ...session, result })
  }

  return { create, load, markSubmitted, saveResult, cleanup }
}
