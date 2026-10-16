// Internal authenticated-owner boundary only. No public route, schedule, signer or broadcast.
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { prepareCurveReview, verifyCurvePlan, mergeCurveSignatures, curveDigest } from './hooklab-curve.mjs'
import { inspectCurveReceipt } from './hooklab-curve-receipts.mjs'
import { verifyWalletSignature } from './github-wallet-links.mjs'

const ownerSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const conflict = () => Object.assign(new Error('Curve journal unavailable or changed'), { status: 409 })
const snapshot = value => {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > 262144) throw conflict()
  return JSON.parse(text)
}
const proofContext = context => {
  const { sessionId, origin } = z.object({ sessionId: z.string().regex(/^[a-f0-9]{48}$/),
    origin: z.string().max(256).url() }).strict().parse(context)
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin) throw conflict()
  return { sessionSha256: curveDigest(sessionId), origin }
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
    // Private integration only: caller supplies verified GitHub session/context and server-rebuilt plan.
    // This has its own domain; a plain-preparation or payout challenge cannot authorize a curve plan.
    async challenge(owner, id, suppliedPlan, context) {
      const plan = snapshot(suppliedPlan), { sessionSha256, origin } = proofContext(context)
      verifyCurvePlan(plan)
      return transaction(owner, id, async (db, row) => {
        if (row) throw conflict()
        await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`curve-proof:${owner}`])
        const quota = (await db.query(`select count(*) from hook_lab_curve_challenges
          where github_user_id=$1 and created_at > now()-interval '10 minutes'`, [owner])).rows[0]
        if (Number(quota.count) >= 10) throw Object.assign(new Error('Curve proof quota exceeded'), { status: 429 })
        const nonce = randomBytes(24).toString('hex')
        const expiresAt = (await db.query("select clock_timestamp()+interval '5 minutes' as expires")).rows[0].expires.toISOString()
        const message = ['repo.ing curve review retention v1',
          'I authorize retaining this exact offline curve review only. This is not spending consent or a wallet link.',
          `Origin: ${origin}`, `GitHub user: ${owner}`, `Session SHA256: ${sessionSha256}`, `Operation: ${id}`,
          `Trader: ${plan.intent.trader}`, `Genesis: ${plan.review.genesisHash}`, `Profile SHA256: ${plan.review.profileSha256}`,
          `Message SHA256: ${plan.review.messageSha256}`, `State SHA256: ${plan.review.policySha256}`,
          `Intent SHA256: ${plan.review.intentSha256}`, `Nonce: ${nonce}`, `Expires: ${expiresAt}`].join('\n')
        await db.query(`insert into hook_lab_curve_challenges(nonce,journal_id,github_user_id,session_sha256,origin,plan,message,expires_at)
          values($1,$2,$3,$4,$5,$6,$7,$8)`, [nonce, id, owner, sessionSha256, origin, plan, message, expiresAt])
        return { nonce, message, expiresAt, wallet: plan.intent.trader, canSign: false, canSubmit: false }
      })
    },
    async prepareAuthenticated(owner, id, suppliedPlan, context, proof) {
      const plan = snapshot(suppliedPlan), { sessionSha256, origin } = proofContext(context)
      verifyCurvePlan(plan)
      const { nonce, signature } = z.object({ nonce: z.string().regex(/^[a-f0-9]{48}$/),
        signature: z.string().length(88) }).strict().parse(proof)
      return transaction(owner, id, async (db, row) => {
        if (row) throw conflict()
        const c = (await db.query(`select *,expires_at > clock_timestamp() as fresh
          from hook_lab_curve_challenges where nonce=$1 for update`, [nonce])).rows[0]
        if (!c || !c.fresh || c.consumed_at || c.journal_id !== id || c.github_user_id !== owner
          || c.session_sha256 !== sessionSha256 || c.origin !== origin || !isDeepStrictEqual(c.plan, plan)) throw conflict()
        verifyWalletSignature(plan.intent.trader, c.message, signature)
        const saved = (await db.query(`insert into hook_lab_curve_journal(id,github_user_id,message_sha256,plan)
          values($1,$2,$3,$4) returning *`, [id, owner, plan.review.messageSha256, plan])).rows[0]
        await append(db, id, 'prepared', { messageSha256: plan.review.messageSha256 })
        await append(db, id, 'wallet-proof', { nonce, message: c.message, signature, purpose: 'curve-review-retention',
          spendingConsent: false })
        await db.query('update hook_lab_curve_challenges set consumed_at=clock_timestamp() where nonce=$1', [nonce])
        return { ...saved, canSign: false, canSubmit: false }
      })
    },
    // Application integration: persist exact review before external signing can ever be considered.
    // Legacy internal/offline method. Never expose this as an unauthenticated HTTP mutation.
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
        const disagreement = observations.length === 2 && observations.every(o => o?.receipt?.confirmationStatus === 'finalized')
          && (!isDeepStrictEqual(observations[0].receipt, observations[1].receipt)
            || (observations[0].history && observations[1].history && !isDeepStrictEqual(observations[0].history, observations[1].history)))
        const evidenceConflict = Boolean(row.evidence_conflict || disagreement || (finalized && row.first_finalized
          && (!isDeepStrictEqual(row.first_finalized.receipt, observations[0].receipt)
          || (row.first_finalized.observations[0].history && observations[0].history
            && !isDeepStrictEqual(row.first_finalized.observations[0].history, observations[0].history)))))
        if (evidenceConflict) {
          result = { ...result, status: 'review-required', reason: 'Finalized evidence conflict retained; manual review required' }
        }
        const first = row.first_finalized ?? (finalized ? { receipt: observations[0].receipt, observations } : null)
        // Append every observation in acquisition order, including outage/conflict and raw history.
        const sequence = await append(db, id, 'observation', { result, observations })
        await db.query(`update hook_lab_curve_journal set latest_status=$2,first_finalized=$3,evidence_conflict=$4,checked_at=now()
          where id=$1`, [id, result.status, first, evidenceConflict])
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

/** Private operator integration only. The caller authenticates/authorizes the operator and retains
 * the referenced acknowledgement or escalation evidence. Never a public self-attestation API.
 * An acknowledgement does not rewrite delivery status, clear trade conflicts or release budgets.
 */
export async function recordCurveAlertReview(pool, operator, input) {
  ownerSchema.parse(operator)
  const r = z.object({ journalId: z.uuid(), sequence: z.string().regex(/^[1-9]\d{0,17}$/),
    kind: z.enum(['acknowledged', 'escalated']), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input)
  await pool.query(`insert into hook_lab_curve_alert_reviews(journal_id,sequence,kind,operator_github_user_id,evidence_sha256)
    values($1,$2,$3,$4,$5)`, [r.journalId, r.sequence, r.kind, operator, r.evidenceSha256])
  return { recorded: true, canSubmit: false }
}

/** Read-only escalation queue, not a second delivery worker. Escalation never resends an unknown
 * message. A provider message ID alone never counts as a human acknowledgement.
 */
export async function readCurveAlertEscalations(pool) {
  return (await pool.query(`select a.journal_id,a.sequence,a.status,a.attempts,
      case when a.status='unknown' then 'ambiguous-delivery'
        when a.status='failed' and a.attempts >= 3 then 'attempts-exhausted'
        when a.status='sending' then 'stale-in-flight'
        else 'acknowledgement-overdue' end as reason,
      exists(select 1 from hook_lab_curve_alert_reviews r where r.journal_id=a.journal_id
        and r.sequence=a.sequence and r.kind='escalated') as escalation_recorded
    from hook_lab_curve_alerts a join hook_lab_curve_events e using(journal_id,sequence)
    where not exists(select 1 from hook_lab_curve_alert_reviews r where r.journal_id=a.journal_id
      and r.sequence=a.sequence and r.kind='acknowledged')
      and (a.status='unknown' or (a.status='failed' and a.attempts >= 3)
        or (a.status='sending' and a.attempted_at < now()-interval '2 minutes')
        or e.created_at < now()-interval '5 minutes')
    order by e.created_at,a.journal_id,a.sequence limit 100`)).rows
}
