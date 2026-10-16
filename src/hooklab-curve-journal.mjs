// Internal authenticated-owner boundary only. No public route, schedule, signer or broadcast.
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { prepareCurveReview, verifyCurvePlan, mergeCurveSignatures } from './hooklab-curve.mjs'
import { inspectCurveReceipt } from './hooklab-curve-receipts.mjs'

const ownerSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const conflict = () => Object.assign(new Error('Curve journal unavailable or changed'), { status: 409 })
const snapshot = value => {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > 262144) throw conflict()
  return JSON.parse(text)
}

export function curveRecoveryJournal(pool, expectedProviders) {
  const providers = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).length(2).parse(expectedProviders)
  if (new Set(providers).size !== 2) throw conflict()
  async function transaction(owner, id, action) {
    ownerSchema.parse(owner); z.uuid().parse(id)
    const db = await pool.connect()
    try {
      await db.query('begin')
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`curve:${id}`])
      const row = (await db.query('select * from hook_lab_curve_journal where id=$1 for update', [id])).rows[0]
      if (row && row.github_user_id !== owner) throw conflict()
      if (row) verifyCurvePlan(row.plan)
      const result = await action(db, row)
      await db.query('commit')
      return result
    } catch (error) { await db.query('rollback'); throw error }
    finally { db.release() }
  }
  const append = async (db, id, kind, evidence) => (await db.query(`insert into hook_lab_curve_events(journal_id,sequence,kind,evidence)
    select $1,coalesce(max(sequence),0)+1,$2,$3 from hook_lab_curve_events where journal_id=$1 returning sequence`, [id, kind, evidence])).rows[0].sequence
  return {
    // Application integration: persist exact review before external signing can ever be considered.
    async prepare(owner, id, intent, observed) {
      const plan = prepareCurveReview(intent, observed)
      return transaction(owner, id, async (db, row) => {
        if (row) { if (!isDeepStrictEqual(row.plan, plan)) throw conflict(); return row }
        const saved = (await db.query(`insert into hook_lab_curve_journal(id,github_user_id,message_sha256,plan)
          values($1,$2,$3,$4) returning *`, [id, owner, plan.review.messageSha256, plan])).rows[0]
        await append(db, id, 'prepared', { messageSha256: plan.review.messageSha256 })
        return saved
      })
    },
    async retainPartial(owner, id, incomingBase64) {
      return transaction(owner, id, async (db, row) => {
        if (!row) throw conflict()
        const merged = mergeCurveSignatures(row.plan, row.partial_transaction, incomingBase64)
        if (merged.transactionBase64 === row.partial_transaction) return row
        const saved = (await db.query(`update hook_lab_curve_journal set partial_transaction=$2,complete=$3,
          latest_status=$4 where id=$1 returning *`, [id, merged.transactionBase64, merged.complete,
          merged.complete ? 'unresolved' : 'partially-signed'])).rows[0]
        await append(db, id, 'partial-signatures', merged)
        return saved
      })
    },
    async observe(owner, id, supplied) {
      const observations = snapshot(supplied)
      return transaction(owner, id, async (db, row) => {
        if (!row?.complete) throw conflict()
        let result = inspectCurveReceipt(row.plan, row.partial_transaction, observations, providers)
        const finalized = ['candidate-deltas-matched', 'finalized-failure', 'review-required'].includes(result.status)
          && observations.length === 2 && observations[0]?.receipt?.confirmationStatus === 'finalized'
          && isDeepStrictEqual(observations[0].receipt, observations[1].receipt)
        if (finalized && row.first_finalized && (!isDeepStrictEqual(row.first_finalized.receipt, observations[0].receipt)
          || (row.first_finalized.observations[0].history && observations[0].history
            && !isDeepStrictEqual(row.first_finalized.observations[0].history, observations[0].history)))) {
          result = { ...result, status: 'review-required', reason: 'Finalized receipt conflicts with retained evidence' }
        }
        const first = row.first_finalized ?? (finalized ? { receipt: observations[0].receipt, observations } : null)
        // Append every observation in acquisition order, including outage/conflict and raw history.
        const sequence = await append(db, id, 'observation', { result, observations })
        await db.query(`update hook_lab_curve_journal set latest_status=$2,first_finalized=$3,checked_at=now() where id=$1`, [id, result.status, first])
        if (result.status !== 'candidate-deltas-matched' && (!row.checked_at || result.status !== row.latest_status)) {
          await db.query('insert into hook_lab_curve_alerts(journal_id,sequence) values($1,$2)', [id, sequence])
        }
        return { ...result, sequence }
      })
    },
    async get(owner, id) {
      return transaction(owner, id, async (db, row) => {
        if (!row) return null
        const events = (await db.query('select * from hook_lab_curve_events where journal_id=$1 order by sequence', [id])).rows
        return { ...row, events, canSign: false, canSubmit: false, canRetry: false, chainVerified: false }
      })
    },
    async pending(limit = 25) {
      z.number().int().min(1).max(100).parse(limit)
      return (await pool.query(`select id,github_user_id from hook_lab_curve_journal where complete
        order by checked_at nulls first,id limit $1`, [limit])).rows
    },
  }
}

/** Explicitly invoked only after destination approval. Uses existing sender outcome contract.
 * Crash/timeout after claim is UNKNOWN, never automatically resent. No raw evidence in alerts.
 */
export async function deliverCurveAlert(pool, sender) {
  const db = await pool.connect()
  let job
  try {
    await db.query('begin')
    // A sender may have posted before crashing. Preserve that ambiguity across restarts.
    await db.query(`update hook_lab_curve_alerts set status='unknown'
      where status='sending' and attempted_at < now() - interval '2 minutes'`)
    job = (await db.query(`select a.journal_id,a.sequence
      from hook_lab_curve_alerts a join hook_lab_curve_events e using(journal_id,sequence)
      where a.status in ('pending','failed') and a.attempts < 3 and a.retry_at <= now()
      order by e.created_at,a.journal_id,a.sequence for update of a skip locked limit 1`)).rows[0]
    if (job) await db.query(`update hook_lab_curve_alerts set status='sending',attempts=attempts+1,attempted_at=now()
      where journal_id=$1 and sequence=$2`, [job.journal_id, job.sequence])
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  finally { db.release() }
  if (!job) return { status: 'idle' }
  let outcome
  try {
    outcome = await sender({ text: `Hook Lab curve review required. Journal ${job.journal_id}, event ${job.sequence}. New execution remains disabled.` })
  } catch { outcome = { status: 'unknown' } }
  let status = ['sent', 'failed', 'unknown'].includes(outcome?.status) ? outcome.status : 'unknown'
  if (status === 'sent' && (typeof outcome.messageId !== 'string' || !outcome.messageId)) status = 'unknown'
  const retry = Number.isSafeInteger(outcome?.retryAfterMs) ? Math.max(60000, Math.min(outcome.retryAfterMs, 86400000)) : 60000
  const updated = await pool.query(`update hook_lab_curve_alerts set status=$3,message_id=$4,retry_at=now()+($5 * interval '1 millisecond')
    where journal_id=$1 and sequence=$2 and status='sending'`, [job.journal_id, job.sequence, status,
    status === 'sent' && typeof outcome.messageId === 'string' ? outcome.messageId.slice(0, 128) : null, retry])
  return { status: updated.rowCount === 1 ? status : 'unknown', journalId: job.journal_id, sequence: job.sequence }
}
