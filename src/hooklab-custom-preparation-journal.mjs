// Internal, offline-only durable verification journal. No RPC, signing, sending,
// execution, retry or adoption methods, and no public mutation route.
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { z } from 'zod'
import { hookAddress } from './hooklab-execution-contract.mjs'
import { CUSTOM_PREPARATION_EVIDENCE_LIMITS, deriveCustomPreparationRecord,
  verifyCustomPreparationEvidence } from './hooklab-custom-preparation-receipts.mjs'

const ownerSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const provider = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const configSchema = z.object({ expectedProfileSha256: digest,
  expectedProviders: z.array(provider).length(2).refine(v => new Set(v).size === 2),
  evidenceMode: z.enum(['synthetic-fixture', 'configured-readonly-rpc']),
}).strict()
const retainSchema = z.object({ preparationInput: z.unknown(),
  signedTransactionBase64: z.string().min(1).max(20000), observations: z.unknown(),
}).strict()
const limitSchema = z.object({ limit: z.number().int().min(1).max(50).default(25) }).strict()
const finalStatuses = new Set(['finalized-failure', 'candidate-preparation-matched'])
const statuses = new Set(['unresolved', 'pending-finality', ...finalStatuses])
const conflictReasons = new Set(['EVIDENCE_DISAGREEMENT', 'IDENTITY_MISMATCH', 'STATE_MISMATCH', 'SOURCE_MISMATCH', 'ECONOMIC_MISMATCH'])
const disabled = Object.freeze({ canSign: false, canSubmit: false, canRetry: false, canLaunch: false,
  preparationReceiptAccepted: false, productionAccepted: false, chainVerified: false,
  productionPreparationReceiptAccepted: false, adoption: false, artifactAdopted: false, deploymentAdopted: false,
  policyApproved: false, executionAuthorized: false, publicExecutionEnabled: false })
const fail = () => Object.assign(new Error('Custom preparation entry unavailable or changed'), { status: 409 })
const check = value => { if (!value) throw fail() }
const jsonCopy = (value, maximum) => {
  try {
    const encoded = JSON.stringify(value)
    check(typeof encoded === 'string' && Buffer.byteLength(encoded) <= maximum)
    return JSON.parse(encoded)
  } catch { throw fail() }
}
const iso = value => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
  check(typeof value === 'string' && Number.isFinite(new Date(value).getTime()) && new Date(value).toISOString() === value)
  return value
}
const status = row => row.evidence_conflict ? 'review-required' : row.latest_evidence.status
// Collection context and later account balances are not immutable execution
// identity. Donations/later context slots must not manufacture a conflict.
const finalizedIdentity = evidence => ({ status: evidence.status, signature: evidence.signature,
  profileSha256: evidence.profileSha256, preparationInputSha256: evidence.preparationInputSha256,
  signedTransactionSha256: evidence.signedTransactionSha256, messageSha256: evidence.messageSha256,
  transaction: evidence.observations[0].transaction, block: evidence.observations[0].block,
  programAccounts: evidence.observations[0].programSnapshot?.accounts.map(({ lamports, ...immutable }) => immutable) ?? null,
  preparedAccounts: evidence.status === 'candidate-preparation-matched'
    ? evidence.observations[0].snapshot.accounts.map(({ lamports, ...immutable }) => immutable) : null })

/** Deliberately explicit allowlist for owner-authenticated read-only routes.
 * Never includes signed wire, preparation input, account bytes or observations.
 */
export function customPreparationSummary(row) {
  if (!row) return null
  check(z.uuid().safeParse(row.id).success && hookAddress.safeParse(row.mint).success
    && [row.profile_sha256, row.intent_sha256, row.message_sha256].every(v => digest.safeParse(v).success)
    && configSchema.safeParse({ expectedProfileSha256: row.profile_sha256,
      expectedProviders: row.providers, evidenceMode: row.evidence_mode }).success
    && statuses.has(row.latest_evidence?.status) && typeof row.evidence_conflict === 'boolean'
    && Object.keys(disabled).every(key => row.latest_evidence[key] === false && (!Object.hasOwn(row, key) || row[key] === false))
    && (row.retained_evidence === null || typeof row.retained_evidence === 'object'
      && finalStatuses.has(row.retained_evidence.status)
      && Object.keys(disabled).every(key => row.retained_evidence[key] === false)))
  try { check(typeof row.signature === 'string' && bs58.decode(row.signature).length === 64
    && bs58.encode(bs58.decode(row.signature)) === row.signature) } catch { throw fail() }
  return { schema: 'repoing/custom-preparation-summary/1', id: row.id, mint: row.mint,
    profileSha256: row.profile_sha256, preparationIntentSha256: row.intent_sha256,
    messageSha256: row.message_sha256, signature: row.signature, status: status(row),
    evidenceMode: row.evidence_mode, providers: [...row.providers],
    retainedFinalizedEvidence: row.retained_evidence !== null,
    evidenceConflict: row.evidence_conflict, createdAt: iso(row.created_at), checkedAt: iso(row.checked_at), ...disabled }
}

/** Configuration is trusted server input, never request JSON. Captured by value;
 * callers cannot change its profile/provider/mode after constructing the journal.
 * All observations are supplied assertions. Even a matching result authorizes no
 * production action. Apply the dedicated SQL explicitly, outside shared migrations.
 */
export function customPreparationJournal(pool, trustedConfig) {
  const config = configSchema.parse(jsonCopy(trustedConfig, 4096))
  Object.freeze(config.expectedProviders); Object.freeze(config)
  const identity = (owner, id) => ({ owner: ownerSchema.parse(owner), id: z.uuid().parse(id).toLowerCase() })
  const scoped = row => row.profile_sha256 === config.expectedProfileSha256
    && row.evidence_mode === config.evidenceMode && isDeepStrictEqual(row.providers, config.expectedProviders)
  const derive = input => {
    try {
      check(input?.profile?.expectedSha256 === config.expectedProfileSha256
        && isDeepStrictEqual(input?.profile?.providers, config.expectedProviders))
      return deriveCustomPreparationRecord(input, config.expectedProfileSha256)
    } catch { throw fail() }
  }
  const verify = (preparationInput, signedTransactionBase64, observations) => {
    let result
    try { result = verifyCustomPreparationEvidence({ preparationInput, signedTransactionBase64, observations, ...config }) }
    catch { throw fail() }
    check(result && statuses.has(result.status) && Array.isArray(result.observations)
      && digest.safeParse(result.rawEvidenceSha256).success
      && result.profileSha256 === config.expectedProfileSha256 && result.evidenceMode === config.evidenceMode
      && isDeepStrictEqual(result.providers, config.expectedProviders)
      && result.observations.length === 2
      && new Set(result.observations.map(o => o.provider)).size === 2
      && result.observations.every(o => config.expectedProviders.includes(o.provider)))
    // Normalize before durability. This second pass removes representational
    // differences such as numeric versus decimal-string lamports from the digest.
    try { result = verifyCustomPreparationEvidence({ preparationInput, signedTransactionBase64, observations: result.observations, ...config }) }
    catch { throw fail() }
    check(result && statuses.has(result.status) && Array.isArray(result.observations)
      && digest.safeParse(result.rawEvidenceSha256).success)
    return { ...jsonCopy(result, CUSTOM_PREPARATION_EVIDENCE_LIMITS.maxEvidenceBytes * 2), ...disabled }
  }
  const validate = row => {
    check(scoped(row))
    const rebuilt = derive(row.preparation_input), plan = rebuilt.plan
    check(isDeepStrictEqual(rebuilt, row.derived_record)
      && row.profile_sha256 === rebuilt.profileSha256 && row.preparation_input_sha256 === rebuilt.preparationInputSha256
      && row.genesis_hash === plan.review.genesisHash && row.mint === plan.request.mint
      && row.intent_sha256 === plan.review.intentSha256 && row.message_sha256 === plan.review.messageSha256)
    for (const evidence of [row.latest_evidence, row.retained_evidence, row.first_conflict].filter(Boolean)) {
      const replayed = verify(row.preparation_input, row.signed_transaction, evidence.observations)
      check(isDeepStrictEqual(replayed, evidence) && evidence.signature === row.signature
        && evidence.messageSha256 === row.message_sha256 && evidence.signedTransactionSha256 === row.signed_transaction_sha256)
    }
    check(!row.retained_evidence || finalStatuses.has(row.retained_evidence.status))
    check(row.evidence_conflict === (row.first_conflict !== null))
    return row
  }
  const expose = row => ({ ...row, status: status(row), ...disabled })
  const audit = (db, row, kind, evidence) => db.query(
    'insert into hook_lab_custom_preparation_events(journal_id,kind,outcome) values($1,$2,$3)',
    [row.id, kind, { status: status(row), evidenceSha256: evidence.rawEvidenceSha256,
      retainedEvidenceSha256: row.retained_evidence?.rawEvidenceSha256 ?? null,
      evidenceConflict: row.evidence_conflict, evidenceMode: config.evidenceMode, ...disabled }])
  async function transaction(owner, id, action) {
    ;({ owner, id } = identity(owner, id))
    const db = await pool.connect()
    try {
      await db.query('begin')
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`custom-preparation:${id}`])
      const row = (await db.query('select * from hook_lab_custom_preparation where id=$1 for update', [id])).rows[0]
      if (row) { check(row.github_user_id === owner); validate(row) }
      const result = await action(db, row, owner, id)
      await db.query('commit')
      return expose(result)
    } catch (error) {
      await db.query('rollback')
      if (error.code === '23505') throw fail()
      throw error
    } finally { db.release() }
  }
  async function updateEvidence(db, row, evidence) {
    if (isDeepStrictEqual(row.latest_evidence, evidence)) return row
    const conflict = row.evidence_conflict || Boolean(row.retained_evidence
      && (conflictReasons.has(evidence.reasonCode) || finalStatuses.has(evidence.status)
        && !isDeepStrictEqual(finalizedIdentity(row.retained_evidence), finalizedIdentity(evidence))))
    const retained = row.retained_evidence ?? (finalStatuses.has(evidence.status) ? evidence : null)
    const firstConflict = row.first_conflict ?? (conflict ? evidence : null)
    const saved = (await db.query(`update hook_lab_custom_preparation set latest_evidence=$2,
      retained_evidence=$3,evidence_conflict=$4,first_conflict=$5,checked_at=clock_timestamp()
      where id=$1 returning *`, [row.id, evidence, retained, conflict, firstConflict])).rows[0]
    await audit(db, saved, !row.evidence_conflict && conflict ? 'conflict' : 'observed', evidence)
    return saved
  }
  const filter = [config.expectedProfileSha256, JSON.stringify(config.expectedProviders), config.evidenceMode]
  return Object.freeze({
    async retain(owner, id, input) {
      identity(owner, id)
      input = retainSchema.parse(input)
      const preparationInput = jsonCopy(input.preparationInput, 67108864)
      const observations = jsonCopy(input.observations, CUSTOM_PREPARATION_EVIDENCE_LIMITS.maxEvidenceBytes)
      const signed = input.signedTransactionBase64, record = derive(preparationInput)
      const evidence = verify(preparationInput, signed, observations), plan = record.plan
      return transaction(owner, id, async (db, row, owner, id) => {
        if (row) {
          check(isDeepStrictEqual(row.preparation_input, preparationInput) && isDeepStrictEqual(row.derived_record, record)
            && row.signed_transaction === signed && row.signature === evidence.signature)
          return updateEvidence(db, row, evidence)
        }
        const saved = (await db.query(`insert into hook_lab_custom_preparation
          (id,github_user_id,profile_sha256,providers,evidence_mode,genesis_hash,mint,intent_sha256,
           message_sha256,preparation_input_sha256,preparation_input,derived_record,signature,
           signed_transaction,signed_transaction_sha256,latest_evidence,retained_evidence)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *`,
        [id, owner, record.profileSha256, JSON.stringify(config.expectedProviders), config.evidenceMode,
          plan.review.genesisHash, plan.request.mint, plan.review.intentSha256, plan.review.messageSha256,
          record.preparationInputSha256, preparationInput, record, evidence.signature, signed,
          evidence.signedTransactionSha256, evidence, finalStatuses.has(evidence.status) ? evidence : null])).rows[0]
        await audit(db, saved, 'retained', evidence)
        return saved
      })
    },
    async observe(owner, id, observations) {
      observations = jsonCopy(observations, CUSTOM_PREPARATION_EVIDENCE_LIMITS.maxEvidenceBytes)
      return transaction(owner, id, async (db, row) => {
        check(row)
        return updateEvidence(db, row, verify(row.preparation_input, row.signed_transaction, observations))
      })
    },
    async get(owner, id) {
      ;({ owner, id } = identity(owner, id))
      const row = (await pool.query(`select * from hook_lab_custom_preparation where id=$1 and github_user_id=$2
        and profile_sha256=$3 and providers=$4::jsonb and evidence_mode=$5`, [id, owner, ...filter])).rows[0]
      return row ? expose(validate(row)) : null
    },
    async list(owner, options = {}) {
      ownerSchema.parse(owner)
      const { limit } = limitSchema.parse(options)
      const db = await pool.connect()
      try {
        // Measure the selected page before transferring full inputs/evidence.
        // The read-only snapshot prevents a concurrent change between the byte
        // bound and payload fetch. Never skip an oversized or corrupt record.
        await db.query('begin isolation level repeatable read read only')
        const page = (await db.query(`select id,
          octet_length(preparation_input::text)::bigint + octet_length(derived_record::text)
          + octet_length(latest_evidence::text) + coalesce(octet_length(retained_evidence::text),0)
          + coalesce(octet_length(first_conflict::text),0) + octet_length(signed_transaction)
          + 8192 as payload_bytes from hook_lab_custom_preparation where github_user_id=$1
          and profile_sha256=$2 and providers=$3::jsonb and evidence_mode=$4
          order by created_at desc,id limit $5`, [owner, ...filter, limit])).rows
        const bytes = page.reduce((total, row) => total + Number(row.payload_bytes), 0)
        if (!Number.isSafeInteger(bytes) || bytes > 32 * 1024 * 1024) {
          throw Object.assign(new Error('Custom preparation page exceeds the read limit; request a smaller page'), { status: 503 })
        }
        const rows = page.length ? (await db.query(`select * from hook_lab_custom_preparation
          where id=any($1::uuid[]) order by created_at desc,id`, [page.map(row => row.id)])).rows : []
        check(isDeepStrictEqual(rows.map(row => row.id), page.map(row => row.id)))
        const summaries = rows.map(row => customPreparationSummary(validate(row)))
        await db.query('commit')
        return summaries
      } catch (error) { await db.query('rollback'); throw error }
      finally { db.release() }
    },
    async pending(options = {}) {
      const { limit } = limitSchema.parse(options)
      const rows = (await pool.query(`select * from hook_lab_custom_preparation where profile_sha256=$1
        and providers=$2::jsonb and evidence_mode=$3 and retained_evidence is null and not evidence_conflict
        order by checked_at,id limit $4`, [...filter, limit])).rows
      return rows.map(row => expose(validate(row)))
    },
  })
}
