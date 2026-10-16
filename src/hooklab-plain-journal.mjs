// No public write route or scheduler. Use only after authenticated wallet binding and adoption.
import { isDeepStrictEqual } from 'node:util'
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { preparePlainReview } from './hooklab-plain.mjs'
import { verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { verifyPlainReceipt } from './hooklab-plain-receipts.mjs'
import { verifyWalletSignature } from './github-wallet-links.mjs'
import { takeQuota } from './request-quota.mjs'

const ownerSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const fail = () => Object.assign(new Error('Plain recovery entry unavailable or changed'), { status: 409 })
const verifyPlan = plan => {
  const rebuilt = preparePlainReview(plan.intent, plan.observed)
  if (!isDeepStrictEqual(rebuilt, plan)) throw fail()
  return rebuilt
}
const proofContext = ({ sessionId, origin }) => {
  z.string().regex(/^[a-f0-9]{48}$/).parse(sessionId)
  const url = new URL(origin)
  if (url.origin !== origin || url.protocol !== 'https:') throw fail()
  return { sessionHash: createHash('sha256').update(sessionId).digest('hex'), origin }
}
const proofMessage = row => [
  'repo.ing Hook Lab preparation authorization v1',
  `Origin: ${row.origin}`, `GitHub user: ${row.github_user_id}`, `Session: ${row.session_hash}`,
  `Creator: ${row.wallet}`, `Operation: ${row.operation_id}`, `Genesis: ${row.genesis_hash}`,
  `Profile SHA256: ${row.profile_sha256}`, `Message SHA256: ${row.message_sha256}`,
  `Nonce: ${row.nonce}`, `Expires: ${new Date(row.expires_at).toISOString()}`,
  'Wallet control for this preparation only. No spending, creator grant, signing or submission authorization.',
].join('\n')
export function plainRecoveryJournal(pool) {
  async function transaction(owner, id, action) {
    ownerSchema.parse(owner); z.uuid().parse(id)
    const db = await pool.connect()
    try {
      await db.query('begin')
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`plain:${id}`])
      const row = (await db.query('select * from hook_lab_plain_recovery where id=$1', [id])).rows[0]
      if (row && row.github_user_id !== owner) throw fail()
      if (row) verifyPlan(row.plan)
      const result = await action(db, row)
      await db.query('commit')
      return result
    } catch (error) { await db.query('rollback'); throw error }
    finally { db.release() }
  }
  const audit = (db, id, kind, outcome = null) => db.query('insert into hook_lab_plain_events(journal_id,kind,outcome) values($1,$2,$3)', [id, kind, outcome])
  async function savePrepared(db, row, owner, id, plan) {
    if (row) {
      if (!isDeepStrictEqual(row.plan, plan)) throw fail()
      return row
    }
    const saved = (await db.query(`insert into hook_lab_plain_recovery(id,github_user_id,genesis_hash,mint,message_sha256,plan)
      values($1,$2,$3,$4,$5,$6) returning *`, [id, owner, plan.review.genesisHash, plan.intent.mint, plan.review.messageSha256, plan])).rows[0]
    await audit(db, id, 'prepared')
    return saved
  }
  return {
    async prepare(owner, id, input) {
      const plan = verifyPlan(input)
      return transaction(owner, id, (db, row) => savePrepared(db, row, owner, id, plan))
    },
    // These off-chain methods are not a production activation path. HTTP callers must derive
    // owner/session/origin themselves and obtain the plan from trusted preparation, never JSON.
    async challenge(owner, id, input, context) {
      const plan = verifyPlan(input), binding = proofContext(context)
      ownerSchema.parse(owner); z.uuid().parse(id)
      if (!await takeQuota(pool, [[`hooklab-plain-proof:${owner}`, 10, 600]])) {
        throw Object.assign(new Error('Too many preparation proofs'), { status: 429 })
      }
      return transaction(owner, id, async (db, row) => {
        if (row && !isDeepStrictEqual(row.plan, plan)) throw fail()
        await db.query('delete from hook_lab_plain_challenges where github_user_id=$1 and consumed_at is null and expires_at < now()', [owner])
        const challenge = (await db.query(`insert into hook_lab_plain_challenges
          (nonce,github_user_id,session_hash,origin,operation_id,wallet,genesis_hash,profile_sha256,message_sha256,expires_at)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '5 minutes') returning *`,
        [randomBytes(24).toString('hex'), owner, binding.sessionHash, binding.origin, id, plan.intent.creator,
          plan.review.genesisHash, plan.review.profileSha256, plan.review.messageSha256])).rows[0]
        return { nonce: challenge.nonce, message: proofMessage(challenge), expiresAt: challenge.expires_at.toISOString(),
          wallet: plan.intent.creator, canSign: false, canSubmit: false }
      })
    },
    async prepareAuthenticated(owner, id, input, context) {
      const plan = verifyPlan(input), binding = proofContext(context)
      z.string().regex(/^[a-f0-9]{48}$/).parse(context.nonce)
      return transaction(owner, id, async (db, row) => {
        const challenge = (await db.query(`select *, clock_timestamp() as observed_now from hook_lab_plain_challenges
          where nonce=$1 for update`, [context.nonce])).rows[0]
        if (!challenge || String(challenge.github_user_id) !== owner || challenge.operation_id !== id
          || challenge.session_hash !== binding.sessionHash || challenge.origin !== binding.origin
          || challenge.wallet !== plan.intent.creator || challenge.genesis_hash !== plan.review.genesisHash
          || challenge.profile_sha256 !== plan.review.profileSha256 || challenge.message_sha256 !== plan.review.messageSha256
          || challenge.consumed_at || challenge.expires_at <= challenge.observed_now) throw fail()
        try { verifyWalletSignature(plan.intent.creator, proofMessage(challenge), context.signature) } catch { throw fail() }
        const saved = await savePrepared(db, row, owner, id, plan)
        await db.query('update hook_lab_plain_challenges set consumed_at=now(),proof_signature=$2 where nonce=$1', [context.nonce, context.signature])
        return saved
      })
    },
    async recordSigned(owner, id, signedBase64) {
      return transaction(owner, id, async (db, row) => {
        if (!row) throw fail()
        const verified = verifyHookLabSignedMessage(row.plan.review, signedBase64)
        if (row.signature) {
          if (row.signed_transaction !== signedBase64) throw fail()
          return row
        }
        const saved = (await db.query('update hook_lab_plain_recovery set signature=$2,signed_transaction=$3 where id=$1 returning *', [id, verified.signature, signedBase64])).rows[0]
        await audit(db, id, 'signed')
        return saved
      })
    },
    async observe(owner, id, observations, providers) {
      const encoded = JSON.stringify({ observations, providers })
      if (Buffer.byteLength(encoded) > 131072) throw fail()
      ;({ observations, providers } = JSON.parse(encoded))
      return transaction(owner, id, async (db, row) => {
        if (!row?.signed_transaction) throw fail()
        let result = verifyPlainReceipt(row.plan, row.signed_transaction, observations, providers)
        if (row.retained_receipt && ['receipt-state-matched', 'finalized-failure'].includes(result.status)
          && !isDeepStrictEqual(row.retained_receipt.observations[0].receipt, observations[0].receipt)) {
          result = { ...result, status: 'review-required', reason: 'Finalized evidence conflicts with retained receipt; investigate providers' }
        }
        // Preserve known finalized evidence during later provider outages or state drift.
        const receipt = row.retained_receipt ?? (['receipt-state-matched', 'finalized-failure'].includes(result.status)
          ? { verification: result, observations } : null)
        const saved = (await db.query(`update hook_lab_plain_recovery set observation=$2,retained_receipt=$3,checked_at=now() where id=$1 returning *`, [id, result, receipt])).rows[0]
        if (!isDeepStrictEqual(row.observation, result)) await audit(db, id, 'observed', result)
        return { ...saved, status: result.status }
      })
    },
    async get(owner, id) {
      ownerSchema.parse(owner); z.uuid().parse(id)
      const row = (await pool.query('select * from hook_lab_plain_recovery where id=$1 and github_user_id=$2', [id, owner])).rows[0]
      if (!row) return null
      verifyPlan(row.plan)
      return { ...row, status: row.observation?.status ?? (row.signature ? 'unresolved' : 'prepared'), canSubmit: false, canRetry: false, chainVerified: false }
    },
    async list(owner) {
      ownerSchema.parse(owner)
      return (await pool.query(`select id,mint,message_sha256,signature,created_at,checked_at,
        coalesce(observation->>'status',case when signature is null then 'prepared' else 'unresolved' end) as status,
        retained_receipt is not null as receipt_retained from hook_lab_plain_recovery
        where github_user_id=$1 order by created_at desc,id limit 50`, [owner])).rows
    },
    async pending(limit = 25) {
      z.number().int().min(1).max(100).parse(limit)
      return (await pool.query(`select * from hook_lab_plain_recovery where signature is not null order by checked_at nulls first,id limit $1`, [limit])).rows
    },
    async health() {
      const { rows: [counts] } = await pool.query(`select count(*)::text as total,
        count(*) filter (where signature is not null and retained_receipt is null)::text as unresolved,
        count(*) filter (where observation->>'status'='unresolved')::text as latest_unavailable,
        count(*) filter (where observation->>'status'='review-required')::text as review_required,
        min(created_at) filter (where signature is not null and retained_receipt is null) as oldest_unresolved
        from hook_lab_plain_recovery`)
      return { ...counts, executionEnabled: false }
    },
  }
}
