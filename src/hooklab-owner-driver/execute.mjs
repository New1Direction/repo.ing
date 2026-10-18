// execute STAGE: rebuild fresh, require the reviewed message sha (or an identical message apart from
// a refreshed blockhash, re-confirmed by the operator), load keys once, sign, send exactly once,
// reconcile to finalized on both providers, verify postconditions and write a receipt.
// One-send is keyed on the REVIEWED sha: once any attempt used a reviewed plan, that plan can only
// be reconciled, never sent again (a new send needs a new plan and a new review).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import bs58 from 'bs58'
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { verifyHookLabSignedMessage } from '../hooklab-message-boundary.mjs'
import { STAGES } from './context.mjs'
import { APPROVAL_FLAG_STAGES, assertExecutable } from './config.mjs'
import { canonicalWithoutBlockhash, signerList } from './message.mjs'
import { loadSigners, parseKeyArgs, wipe } from './keys.mjs'
import { cpiEvents } from './stages/canary-common.mjs'
import { describe } from './plan.mjs'
import { plain, renderPreview } from './preview.mjs'
import { sha256 } from './pins.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const MAX_REBUILD_TO_SIGN_MS = 60000
// Expiry is declared only well past lastValidBlockHeight, on definitive answers from both providers.
export const EXPIRY_MARGIN_BLOCKS = 30

export function findPlan(ctx, stage, messageSha256, runDir) {
  const candidates = runDir ? [runDir] : (existsSync(ctx.root) ? readdirSync(ctx.root).filter(d => d.startsWith(`${stage}-`)).map(d => path.join(ctx.root, d)) : [])
  for (const dir of candidates) {
    const file = path.join(dir, 'plan.json')
    if (!existsSync(file)) continue
    const plan = JSON.parse(readFileSync(file, 'utf8'))
    if (plan.messageSha256 === messageSha256) {
      check(plan.stage === stage && plan.genesisHash === ctx.genesis && plan.network === ctx.network, 'Reviewed plan belongs to another stage or network')
      check(sha256(Buffer.from(plan.messageBase64, 'base64')) === messageSha256 && plan.review?.messageSha256 === messageSha256, 'plan.json message bytes do not hash to the reviewed sha; refusing a tampered plan')
      return { plan, dir }
    }
  }
  throw Error(`No reviewed plan with message sha256 ${messageSha256} for stage ${stage}; run plan first`)
}
async function statusOf(reader, signature) {
  try { return { ok: true, value: (await reader.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0] } }
  catch (error) { return { ok: false, error: error.message } }
}
async function heightOf(reader) {
  try { return await reader.connection.getBlockHeight({ commitment: 'finalized' }) } catch { return null }
}
/** Poll both providers. 'expired-unlanded' needs both to answer "unknown signature" without error
 * AND both finalized heights beyond lastValidBlockHeight + margin; any RPC error keeps it pending. */
export async function awaitFinal(ctx, signature, lastValidBlockHeight, signedBase64, rounds = 150) {
  for (let i = 0; i < rounds; i++) {
    const statuses = await Promise.all(ctx.readers.map(r => statusOf(r, signature)))
    if (statuses.some(s => s.ok && s.value?.confirmationStatus === 'finalized')) {
      const txs = await Promise.all(ctx.readers.map(r => r.connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => null)))
      if (txs.every(Boolean)) {
        for (const tx of txs) {
          const wire = new VersionedTransaction(tx.transaction.message); wire.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
          check(Buffer.from(wire.serialize()).toString('base64') === signedBase64, 'Finalized transaction differs from the signed wire')
        }
        check(txs[0].slot === txs[1].slot && JSON.stringify(txs[0].meta.err) === JSON.stringify(txs[1].meta.err), 'Providers disagree on the finalized outcome')
        return { status: txs[0].meta.err === null ? 'finalized-success' : 'finalized-failure', slot: txs[0].slot, tx: txs[0] }
      }
    } else if (statuses.every(s => s.ok && s.value === null)) {
      const heights = await Promise.all(ctx.readers.map(heightOf))
      if (heights.every(h => h !== null && h > lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS)) return { status: 'expired-unlanded' }
    }
    if (i + 1 < rounds) await sleep(1000)
  }
  return { status: 'pending' }
}
async function reconfirm(freshSha, options) {
  if (options.confirm) return options.confirm(freshSha)
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(`Blockhash refreshed; every other byte is identical. Type the first 16 hex of the new message sha256 (${freshSha}) to continue: `)).trim() === freshSha.slice(0, 16) }
  finally { rl.close() }
}
function receiptOf(ctx, stageName, entry, outcome) {
  return { schema: 'repoing/hooklab-owner-receipt/1', stage: stageName, network: ctx.network, genesisHash: ctx.genesis, messageSha256: entry.messageSha256,
    reviewedMessageSha256: entry.reviewedMessageSha256, signature: entry.signature, status: outcome.status, slot: outcome.slot ?? null, feeLamports: outcome.tx?.meta.fee ?? null,
    error: outcome.tx?.meta.err ?? null, logs: outcome.tx?.meta.logMessages ?? [], events: outcome.tx ? cpiEvents(outcome.tx, ctx.programs) : [] }
}
/** Write the receipt whatever happened; journal the postcondition result separately from finality. */
async function settle(ctx, stage, entry, outcome, dir, { expect, memo, log }) {
  const receipt = receiptOf(ctx, stage.name, entry, outcome)
  let postconditions = null, postconditionError = null
  if (outcome.status === 'finalized-success') {
    if (memo === undefined && stage.needsMemo) postconditionError = 'pre-state unavailable in a recovery run; postconditions not re-verified'
    else { try { postconditions = await stage.verify(ctx, expect, receipt, memo) } catch (error) { postconditionError = error.message } }
  }
  const verdict = postconditions ? 'verified' : outcome.status === 'finalized-success' ? 'failed' : 'not-applicable'
  ctx.journal.update(entry.messageSha256, { status: outcome.status, slot: outcome.slot ?? null, postconditions: verdict, postconditionError })
  const stored = { ...receipt, events: receipt.events.map(e => ({ index: e.index, program: e.program, name: e.name, data: plain(e.data) })), postconditions, postconditionError }
  writeFileSync(path.join(dir, `receipt-${entry.messageSha256.slice(0, 16)}.json`), JSON.stringify(stored, null, 2), { mode: 0o600 })
  log(`\n=== receipt ${stage.name} ===\nstatus     ${receipt.status}\nsignature  ${receipt.signature}\nslot       ${receipt.slot}\nfee        ${receipt.feeLamports} lamports\nerror      ${JSON.stringify(receipt.error)}`)
  for (const row of postconditions ?? []) log(`verified   ${row}`)
  if (postconditionError) log(`POSTCONDITIONS NOT VERIFIED: ${postconditionError}`)
  if (outcome.status !== 'finalized-success') throw Error(`Transaction finalized with ${outcome.status}: ${JSON.stringify(receipt.error)}`)
  if (verdict !== 'verified') throw Error(`Transaction succeeded on chain but postconditions are not verified: ${postconditionError}`)
  return { receipt: stored, signature: receipt.signature, raw: receipt }
}
/** A reviewed plan that was already used: reconcile its attempt(s); never send again. */
async function recover(ctx, stage, used, plan, dir, log) {
  const live = used.filter(e => e.signature && ['signed', 'sent', 'send-unknown'].includes(e.status))
  if (!live.length) throw Error(`Reviewed plan already used (${used.map(e => `${e.messageSha256.slice(0, 16)}=${e.status}`).join(', ')}); one-send refuses a resend. Re-run plan for a new review.`)
  check(live.length === 1, 'More than one live attempt for this reviewed plan; reconcile manually')
  const entry = live[0], outcome = await awaitFinal(ctx, entry.signature, entry.lastValidBlockHeight, entry.signedTransactionBase64)
  if (outcome.status === 'pending') throw Error(`Attempt ${entry.signature} still unresolved; re-run later (it is never resent)`)
  log(`recovered earlier attempt ${entry.signature} without resending`)
  return settle(ctx, stage, entry, outcome, dir, { expect: plan.expect, memo: undefined, log })
}
export async function execute(ctx, stageName, options) {
  const { messageSha256, keys = [], approved = [], runDir, log = console.log } = options
  const stage = STAGES[stageName]
  check(stage && stageName !== 'status', `Stage ${stageName} cannot be executed`)
  check(/^[a-f0-9]{64}$/.test(messageSha256 ?? ''), '--message-sha256 must be the reviewed 64-hex message hash')
  assertExecutable(ctx.config, stageName)
  if (APPROVAL_FLAG_STAGES.has(stageName)) check(approved.includes(`${stageName}:${messageSha256}`), `Refusing ${stageName}: requires --approved ${stageName}:${messageSha256}`)
  const { plan, dir } = findPlan(ctx, stageName, messageSha256, runDir)
  const release = ctx.journal.lock(stageName)
  try {
    const used = ctx.journal.byReviewed(messageSha256)
    if (used.length) return await recover(ctx, stage, used, plan, dir, log)
    for (const entry of ctx.journal.pending(stageName)) {
      if (!entry.signature) { ctx.journal.update(entry.messageSha256, { status: 'abandoned-unsigned' }); continue }
      throw Error(`Earlier ${stageName} attempt ${entry.signature} (plan ${entry.reviewedMessageSha256.slice(0, 16)}) is unresolved; run execute with that plan's sha to reconcile it first`)
    }
    const built = await stage.build(ctx, plan.pinned), builtAt = Date.now()
    check(!built.blocked && built.review, `Fresh rebuild is blocked: ${built.blocked ?? 'no message'}`)
    const review = built.review
    if (review.messageSha256 !== messageSha256) {
      check(canonicalWithoutBlockhash(review.messageBase64).equals(canonicalWithoutBlockhash(plan.messageBase64)), 'Fresh message differs from the reviewed message beyond the blockhash; refusing (re-run plan)')
      log(renderPreview(describe(ctx, stageName, built)))
      check(await reconfirm(review.messageSha256, options), 'Refreshed blockhash not re-confirmed by the operator; nothing was signed')
    }
    // Keys are read once and matched to their roles before the claim, so a wrong key never burns a plan.
    const signers = loadSigners(parseKeyArgs(keys), ctx.roles, signerList(review.messageBase64))
    let signedBase64, signature
    try {
      check(Date.now() - builtAt <= MAX_REBUILD_TO_SIGN_MS, 'Rebuilt state is older than 60 s (confirmation or key wait); nothing was signed, re-run execute')
      ctx.journal.claim({ stage: stageName, messageSha256: review.messageSha256, reviewedMessageSha256: messageSha256, runDir: dir, lastValidBlockHeight: review.lastValidBlockHeight, network: ctx.network })
      try {
        const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64, 'base64')))
        tx.sign(signers)
        signedBase64 = Buffer.from(tx.serialize()).toString('base64')
        signature = verifyHookLabSignedMessage(review, signedBase64).signature
      } catch (error) { ctx.journal.update(review.messageSha256, { status: 'abandoned-unsigned', error: error.message }); throw error }
    } finally { wipe(signers) }
    const entry = ctx.journal.update(review.messageSha256, { status: 'signed', signature, signedTransactionBase64: signedBase64 })
    // Exactly one send through the primary provider. Preflight on: a rejected simulation is not forwarded.
    try {
      const sent = await ctx.readers[0].connection.sendRawTransaction(Buffer.from(signedBase64, 'base64'), { skipPreflight: false, preflightCommitment: 'finalized', maxRetries: 0 })
      check(sent === signature, 'RPC returned a different signature')
      ctx.journal.update(review.messageSha256, { status: 'sent' })
    } catch (error) {
      const preflight = /simulation failed|Transaction simulation|preflight/i.test(error.message ?? '')
      ctx.journal.update(review.messageSha256, { status: preflight ? 'preflight-rejected' : 'send-unknown', error: String(error.message).slice(0, 2000), logs: error.logs ?? null })
      if (preflight) throw Error(`Preflight rejected the transaction (not broadcast): ${error.message}`)
    }
    const outcome = await awaitFinal(ctx, signature, review.lastValidBlockHeight, signedBase64)
    if (outcome.status === 'pending') throw Error(`Transaction ${signature} not finalized yet; re-run execute with --message-sha256 ${messageSha256} to reconcile (it is never resent)`)
    return await settle(ctx, stage, entry, outcome, dir, { expect: built.expect, memo: built.memo, log })
  } finally { release() }
}
