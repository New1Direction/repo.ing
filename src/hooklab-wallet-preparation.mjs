// SERVER-ONLY candidate journal. Wallet principal is resolved from an existing
// verified session; no owner ID, observations or acceptance flag is accepted.
// No production resolver, signing, broadcast, retry or public route is provided.
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { deriveCustomPreparationRecord, collectCustomPreparationEvidence, verifyCustomPreparationEvidence } from './hooklab-custom-preparation-receipts.mjs'
import { verifyHookLabSignedMessage } from './hooklab-message-boundary.mjs'
import { hookAddress, HOOK_MAINNET_GENESIS } from './hooklab-execution-contract.mjs'
import { walletPrincipalStore } from './hooklab-wallet-principal.mjs'
import { lockWalletPrincipal } from './hooklab-wallet-principal-lock.mjs'
import { parseMaxWalletPreparationRequest } from './hooklab-inclusive-max-wallet-profile.mjs'
const fail = () => Object.assign(Error('Wallet preparation unavailable or changed'), { status: 409 })
const check = value => { if (!value) throw fail() }
const final = new Set(['candidate-preparation-matched', 'finalized-failure'])
const conflicts = new Set(['EVIDENCE_DISAGREEMENT','IDENTITY_MISMATCH','STATE_MISMATCH','SOURCE_MISMATCH','ECONOMIC_MISMATCH'])
const disabled = Object.freeze({ preparationReceiptAccepted: false, productionAccepted: false, collectionAuthenticated: false,
  eligibleForProductionLaunch: false, executionAuthorized: false, publicExecutionEnabled: false, canLaunch: false, canSign: false, canSubmit: false, canRetry: false })
const immutableEvidence = evidence => ({ status: evidence.status, signature: evidence.signature, profileSha256: evidence.profileSha256,
  messageSha256: evidence.messageSha256, signedTransactionSha256: evidence.signedTransactionSha256,
  transaction: evidence.observations[0].transaction, block: evidence.observations[0].block,
  programAccounts: evidence.observations[0].programSnapshot?.accounts.map(({ lamports, ...account }) => account),
  preparedAccounts: evidence.status === 'candidate-preparation-matched' ? evidence.observations[0].snapshot.accounts.map(({ lamports, ...account }) => account) : null })
function createJournal(pool, { enabled = false, principalStore, providers: configured, expectedProfileSha256 } = {}, lockPrincipal = null) {
  z.string().regex(/^[a-f0-9]{64}$/).parse(expectedProfileSha256)
  check(principalStore && typeof principalStore.resolve === 'function' && Array.isArray(configured) && configured.length === 2)
  const providers = configured.map(({ provider, connection }) => Object.freeze({ provider, connection }))
  const names = providers.map(p => z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).parse(p.provider))
  check(new Set(names).size === 2 && providers[0].connection !== providers[1].connection)
  const owner = async sessionToken => {
    check(enabled === true)
    const principal = await principalStore.resolve(sessionToken)
    check(principal?.kind === 'wallet' && principal.audience === 'general-launcher' && principal.genesisHash === HOOK_MAINNET_GENESIS)
    return hookAddress.parse(principal.wallet)
  }
  const derive = (preparationInput, signedTransactionBase64) => {
    const record = deriveCustomPreparationRecord(preparationInput, expectedProfileSha256)
    check(record.policyKind === 'max-wallet' && isDeepStrictEqual(preparationInput.profile.providers, names))
    return { record, signed: verifyHookLabSignedMessage(record.plan.review, signedTransactionBase64) }
  }
  const validate = row => {
    check(row.profile_sha256 === expectedProfileSha256 && isDeepStrictEqual(row.providers, names))
    const { record, signed } = derive(row.preparation_input, row.signed_transaction), plan = record.plan
    check(row.owner_wallet === plan.request.creator && row.mint === plan.request.mint && row.genesis_hash === plan.review.genesisHash
      && row.intent_sha256 === plan.review.intentSha256 && row.message_sha256 === plan.review.messageSha256
      && row.preparation_input_sha256 === record.preparationInputSha256 && row.signature === signed.signature
      && row.signed_transaction_sha256 === signed.signedTransactionSha256)
    for (const evidence of [row.latest_evidence,row.retained_evidence,row.first_conflict].filter(Boolean)) {
      const rebuilt = verifyCustomPreparationEvidence({ preparationInput: row.preparation_input, signedTransactionBase64: row.signed_transaction,
        observations: evidence.observations, expectedProfileSha256, expectedProviders: names, evidenceMode: 'configured-readonly-rpc' })
      check(isDeepStrictEqual(rebuilt,evidence))
    }
    check(!row.retained_evidence || final.has(row.retained_evidence.status))
    check(row.evidence_conflict === (row.first_conflict !== null))
    return row
  }
  const summary = row => Object.freeze({ id:row.id, wallet:row.owner_wallet, mint:row.mint, profileSha256:row.profile_sha256,
    signature:row.signature, messageSha256:row.message_sha256, preparationIntentSha256:row.intent_sha256,
    preparedRequest:Object.freeze(parseMaxWalletPreparationRequest(row.preparation_input.request)), status:row.evidence_conflict ? 'review-required' : row.latest_evidence?.status ?? 'collection-pending',
    retainedFinalizedEvidence:Boolean(row.retained_evidence), evidenceConflict:row.evidence_conflict,
    lastCollectionPrelaunchEligible:row.latest_evidence?.currentPrelaunchEligible === true && !row.evidence_conflict,
    checkedAt:row.checked_at.toISOString(), sessionAuthorization:lockPrincipal ? 'co-located-transaction-lock' : 'candidate-injected-store', ...disabled })
  async function transaction(wallet,id,work,sessionToken) {
    z.uuid().parse(id)
    const db=await pool.connect()
    try {
      await db.query('begin'); await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`wallet-preparation:${id}`])
      const {rows:[row]}=await db.query('select * from hook_lab_wallet_preparations where id=$1 for update',[id])
      if(row){check(row.owner_wallet===wallet);validate(row)}
      if(lockPrincipal)check((await lockPrincipal(db,sessionToken)).wallet===wallet)
      else check(await owner(sessionToken)===wallet)
      const result=await work(db,row)
      // Keep the session row locked through commit; expiry is rechecked after work.
      if(lockPrincipal)check((await lockPrincipal(db,sessionToken)).wallet===wallet)
      await db.query('commit');return result
    }catch(error){await db.query('rollback');if(error.code==='23505')throw fail();throw error}finally{db.release()}
  }
  async function collect(wallet,id,row,sessionToken) {
    const collection=await collectCustomPreparationEvidence({preparationInput:row.preparation_input,signedTransactionBase64:row.signed_transaction,
      providers,expectedProfileSha256,evidenceMode:'configured-readonly-rpc'})
    // Session revocation/expiry during network reads cannot change ownership or authorize a write.
    check(await owner(sessionToken)===wallet)
    return transaction(wallet,id,async(db,current)=>{
      check(current && current.signed_transaction_sha256===row.signed_transaction_sha256)
      const evidence=collection.result
      check(evidence.observations && evidence.signature===current.signature)
      const conflict=current.evidence_conflict || conflicts.has(evidence.reasonCode) || Boolean(current.retained_evidence
        && final.has(evidence.status) && !isDeepStrictEqual(immutableEvidence(current.retained_evidence),immutableEvidence(evidence)))
      const retained=current.retained_evidence ?? (final.has(evidence.status)?evidence:null)
      const firstConflict=current.first_conflict ?? (conflict?evidence:null)
      const {rows:[saved]}=await db.query(`update hook_lab_wallet_preparations set latest_evidence=$2,retained_evidence=$3,evidence_conflict=$4,first_conflict=$5,
        checked_at=clock_timestamp() where id=$1 returning *`,[id,evidence,retained,conflict,firstConflict])
      return summary(validate(saved))
    },sessionToken)
  }
  return Object.freeze({
    async collectAndRetain(sessionToken,id,input) {
      const wallet=await owner(sessionToken)
      const parsed=z.object({preparationInput:z.unknown(),signedTransactionBase64:z.string().max(20000)}).strict().parse(input)
      const encoded=JSON.stringify(parsed.preparationInput);check(Buffer.byteLength(encoded)<=64*1024*1024)
      const preparationInput=JSON.parse(encoded),signedTransactionBase64=parsed.signedTransactionBase64
      const {record,signed}=derive(preparationInput,signedTransactionBase64),plan=record.plan
      check(plan.request.creator===wallet)
      // Persist original wire before collection: a timeout leaves a resumable identity, never approval to retry a chain action.
      const row=await transaction(wallet,id,async(db,current)=>{
        if(current){check(current.signed_transaction===signedTransactionBase64 && isDeepStrictEqual(current.preparation_input,preparationInput));return current}
        const {rows:[saved]}=await db.query(`insert into hook_lab_wallet_preparations
          (id,owner_wallet,profile_sha256,providers,genesis_hash,mint,intent_sha256,message_sha256,preparation_input_sha256,
           preparation_input,signed_transaction,signed_transaction_sha256,signature)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
          [id,wallet,expectedProfileSha256,JSON.stringify(names),plan.review.genesisHash,plan.request.mint,plan.review.intentSha256,
            plan.review.messageSha256,record.preparationInputSha256,preparationInput,signedTransactionBase64,signed.signedTransactionSha256,signed.signature])
        return validate(saved)
      },sessionToken)
      return collect(wallet,id,row,sessionToken)
    },
    async reconcile(sessionToken,id) {
      const wallet=await owner(sessionToken),row=await transaction(wallet,id,async(_db,row)=>{check(row);return row},sessionToken)
      return collect(wallet,id,row,sessionToken)
    },
    // Server-only durable handoff. Never expose through the candidate JSON API.
    async resolveForLaunch(sessionToken,id) {
      check(lockPrincipal !== null)
      const wallet=await owner(sessionToken)
      const row=await transaction(wallet,id,async(_db,row)=>{check(row);return row},sessionToken)
      await collect(wallet,id,row,sessionToken)
      return transaction(wallet,id,async(_db,current)=>{
        check(current && !current.evidence_conflict && current.retained_evidence?.status==='candidate-preparation-matched'
          && current.latest_evidence?.status==='candidate-preparation-matched' && current.latest_evidence.currentPrelaunchEligible===true)
        const evidence=current.latest_evidence
        return Object.freeze({ id:current.id,wallet:current.owner_wallet,signature:current.signature,
          profileSha256:current.profile_sha256,preparationIntentSha256:current.intent_sha256,
          preparedRequest:parseMaxWalletPreparationRequest(current.preparation_input.request),
          executionSlot:evidence.finalizedSlot,preparedAccountHashes:{...evidence.matchedAccountHashes} })
      },sessionToken)
    },
    async get(sessionToken,id) {
      const wallet=await owner(sessionToken)
      return transaction(wallet,id,async(_db,row)=>{check(row);return summary(row)},sessionToken)
    },
  })
}

// Retained candidate/test entry point. Never treat injected principals as production authority.
export function walletPreparationJournal(pool, options) { return createJournal(pool, options) }

// Same explicit application PostgreSQL pool owns identity and evidence tables.
// No principal-store or lock callback override is accepted by this factory.
export function coLocatedWalletPreparationJournal(pool, input) {
  const { enabled, origin, providers, expectedProfileSha256 } = z.object({ enabled:z.boolean().default(false),
    origin:z.string(),providers:z.array(z.object({provider:z.string(),connection:z.unknown()}).strict()).length(2),
    expectedProfileSha256:z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(input)
  const principalStore=walletPrincipalStore(pool,{enabled,origin,audience:'general-launcher',genesisHash:HOOK_MAINNET_GENESIS})
  return createJournal(pool,{enabled,principalStore,providers,expectedProfileSha256},(db,token)=>lockWalletPrincipal(db,token,origin))
}
