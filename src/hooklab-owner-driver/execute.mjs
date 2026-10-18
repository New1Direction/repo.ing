// execute STAGE: rebuild fresh, require the reviewed message sha (or an identical message apart from
// a refreshed blockhash, re-confirmed by the operator), load keys once, sign, send exactly once,
// reconcile to finalized on both providers, verify postconditions and write a receipt.
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
import { renderPreview } from './preview.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function findPlan(ctx, stage, messageSha256, runDir) {
  const candidates = runDir ? [runDir] : (existsSync(ctx.root) ? readdirSync(ctx.root).filter(d => d.startsWith(`${stage}-`)).map(d => path.join(ctx.root, d)) : [])
  for (const dir of candidates) {
    const file = path.join(dir, 'plan.json')
    if (!existsSync(file)) continue
    const plan = JSON.parse(readFileSync(file, 'utf8'))
    if (plan.messageSha256 === messageSha256) {
      check(plan.stage === stage && plan.genesisHash === ctx.genesis && plan.network === ctx.network, 'Reviewed plan belongs to another stage or network')
      return { plan, dir }
    }
  }
  throw Error(`No reviewed plan with message sha256 ${messageSha256} for stage ${stage}; run plan first`)
}
/** Resolve earlier non-terminal attempts of this stage before any new send. */
export async function settlePending(ctx, stage) {
  for (const entry of ctx.journal.pending(stage)) {
    if (!entry.signature) { ctx.journal.update(entry.messageSha256, { status: 'abandoned-unsigned' }); continue }
    const outcome = await awaitFinal(ctx, entry.signature, entry.lastValidBlockHeight, entry.signedTransactionBase64, 1)
    if (outcome.status === 'pending') throw Error(`Earlier ${stage} attempt ${entry.signature} may still land; wait for it to finalize or expire`)
    ctx.journal.update(entry.messageSha256, { status: outcome.status, slot: outcome.slot ?? null })
  }
}
export async function awaitFinal(ctx, signature, lastValidBlockHeight, signedBase64, rounds = 120) {
  for (let i = 0; i < rounds; i++) {
    const statuses = await Promise.all(ctx.readers.map(r => r.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }).then(x => x.value[0]).catch(() => null)))
    if (statuses.some(s => s?.confirmationStatus === 'finalized')) {
      const txs = await Promise.all(ctx.readers.map(r => r.connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })))
      if (txs.every(Boolean)) {
        for (const tx of txs) {
          const wire = new VersionedTransaction(tx.transaction.message); wire.signatures = tx.transaction.signatures.map(s => bs58.decode(s))
          check(Buffer.from(wire.serialize()).toString('base64') === signedBase64, 'Finalized transaction differs from the signed wire')
        }
        check(txs[0].slot === txs[1].slot && JSON.stringify(txs[0].meta.err) === JSON.stringify(txs[1].meta.err), 'Providers disagree on the finalized outcome')
        return { status: txs[0].meta.err === null ? 'finalized-success' : 'finalized-failure', slot: txs[0].slot, tx: txs[0] }
      }
    }
    if (!statuses.some(Boolean)) {
      const heights = await Promise.all(ctx.readers.map(r => r.connection.getBlockHeight({ commitment: 'finalized' })))
      if (Math.min(...heights) > lastValidBlockHeight) return { status: 'expired-unlanded' }
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
export async function execute(ctx, stageName, options) {
  const { messageSha256, keys = [], approved = [], runDir, log = console.log } = options
  const stage = STAGES[stageName]
  check(stage && stageName !== 'status', `Stage ${stageName} cannot be executed`)
  check(/^[a-f0-9]{64}$/.test(messageSha256 ?? ''), '--message-sha256 must be the reviewed 64-hex message hash')
  assertExecutable(ctx.config, stageName)
  if (APPROVAL_FLAG_STAGES.has(stageName)) check(approved.includes(`${stageName}:${messageSha256}`), `Refusing ${stageName}: requires --approved ${stageName}:${messageSha256}`)
  const { plan, dir } = findPlan(ctx, stageName, messageSha256, runDir)
  await settlePending(ctx, stageName)
  check(!ctx.journal.get(messageSha256), 'This reviewed message was already claimed; one-send journal refuses a resend')
  const built = await stage.build(ctx, plan.pinned)
  check(!built.blocked && built.review, `Fresh rebuild is blocked: ${built.blocked ?? 'no message'}`)
  let review = built.review
  if (review.messageSha256 !== messageSha256) {
    check(canonicalWithoutBlockhash(review.messageBase64).equals(canonicalWithoutBlockhash(plan.messageBase64)), 'Fresh message differs from the reviewed message beyond the blockhash; refusing (re-run plan)')
    log(renderPreview(describe(ctx, stageName, built)))
    check(await reconfirm(review.messageSha256, options), 'Refreshed blockhash not re-confirmed by the operator; nothing was signed')
    check(!ctx.journal.get(review.messageSha256), 'Refreshed message already claimed')
  }
  const required = signerList(review.messageBase64)
  // Keys are read (once) and matched to their roles before the claim, so a wrong key never burns
  // the reviewed message; the claim itself is exclusive.
  const signers = loadSigners(parseKeyArgs(keys), ctx.roles, required)
  try { ctx.journal.claim({ stage: stageName, messageSha256: review.messageSha256, reviewedMessageSha256: messageSha256, runDir: dir, lastValidBlockHeight: review.lastValidBlockHeight, network: ctx.network }) }
  catch (error) { wipe(signers); throw error }
  let signedBase64, signature
  try {
    const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(review.messageBase64, 'base64')))
    tx.sign(signers)
    signedBase64 = Buffer.from(tx.serialize()).toString('base64')
    signature = verifyHookLabSignedMessage(review, signedBase64).signature
  } catch (error) { ctx.journal.update(review.messageSha256, { status: 'abandoned-unsigned', error: error.message }); throw error }
  finally { wipe(signers) }
  ctx.journal.update(review.messageSha256, { status: 'signed', signature, signedTransactionBase64: signedBase64 })
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
  ctx.journal.update(review.messageSha256, { status: outcome.status === 'pending' ? 'sent' : outcome.status, slot: outcome.slot ?? null })
  check(outcome.status !== 'pending', `Transaction ${signature} not finalized yet; re-run execute later to reconcile (it will never be resent)`)
  const receipt = { schema: 'repoing/hooklab-owner-receipt/1', stage: stageName, network: ctx.network, genesisHash: ctx.genesis, messageSha256: review.messageSha256,
    reviewedMessageSha256: messageSha256, signature, status: outcome.status, slot: outcome.slot ?? null, feeLamports: outcome.tx?.meta.fee ?? null,
    error: outcome.tx?.meta.err ?? null, logs: outcome.tx?.meta.logMessages ?? [], events: outcome.tx ? cpiEvents(outcome.tx, ctx.programs) : [] }
  let postconditions = null
  if (outcome.status === 'finalized-success') postconditions = await stage.verify(ctx, built.expect, receipt, built.memo)
  const stored = { ...receipt, events: receipt.events.map(e => ({ index: e.index, program: e.program, name: e.name, data: JSON.parse(JSON.stringify(e.data, (k, v) => v?.toBase58 ? v.toBase58() : (v && typeof v === 'object' && v.constructor?.name === 'BN') ? v.toString() : v)) })), postconditions }
  writeFileSync(path.join(dir, `receipt-${review.messageSha256.slice(0, 16)}.json`), JSON.stringify(stored, null, 2), { mode: 0o600 })
  log(`\n=== receipt ${stageName} ===\nstatus     ${receipt.status}\nsignature  ${signature}\nslot       ${receipt.slot}\nfee        ${receipt.feeLamports} lamports\nerror      ${JSON.stringify(receipt.error)}`)
  for (const row of postconditions ?? []) log(`verified   ${row}`)
  if (outcome.status !== 'finalized-success') throw Error(`Transaction finalized with ${outcome.status}: ${JSON.stringify(receipt.error)}`)
  return { receipt: stored, signature, raw: receipt }
}
