// plan STAGE: read-only. Builds the unsigned v0 message, decodes it, simulates it (sigVerify off)
// and writes the unsigned transaction + preview into a fresh run directory.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { STAGES } from './context.mjs'
import { STAGE_DECISIONS, APPROVAL_FLAG_STAGES, decisionOf } from './config.mjs'
import { simulate } from './rpc.mjs'
import { unsignedTransactionBase64 } from './message.mjs'
import { addressBook, decodeMessage, renderPreview } from './preview.mjs'
import { canaryAddresses } from './pins.mjs'
import { signerRoles } from './stages/common.mjs'
import { altRecord } from './stages/canary-common.mjs'

export function book(ctx) {
  const canary = ctx.roles.mint && !ctx.stack ? canaryAddresses(ctx.programs, ctx.quoteMint, ctx.roles.mint) : {}
  const extra = { ...Object.fromEntries(Object.entries(canary).map(([k, v]) => [`canary ${k}`, v])), ...(ctx.stack ? { 'quote marker (internal)': ctx.quoteMint } : { 'canary lookup table': altRecord(ctx)?.address }) }
  return addressBook({ programs: ctx.programs, quoteMint: ctx.quoteMint, roles: ctx.roles, extra })
}
export function describe(ctx, stage, built) {
  const decisions = (STAGE_DECISIONS[stage] ?? []).map(name => ({ name, value: decisionOf(ctx.config, name)?.value ?? null, approved: !!decisionOf(ctx.config, name)?.approved }))
  const base = { stage, network: ctx.network, genesisHash: ctx.genesis, observedSlot: built.observedSlot, providers: ctx.readers.map(r => `${r.provider}=${r.url}`),
    decisions, notes: built.notes ?? [], sections: built.sections ?? [], blocked: built.blocked }
  if (!built.review) return base
  const r = built.review, names = book(ctx), lookupTable = built.lookupTable ?? r.lookupTables[0] ?? null
  return { ...base, messageSha256: r.messageSha256, blockhash: VersionedMessage.deserialize(Buffer.from(r.messageBase64, 'base64')).recentBlockhash,
    lastValidBlockHeight: r.lastValidBlockHeight, deadlineSlot: built.deadlineSlot, payer: r.payer, requiredSigners: r.requiredSigners, signerRoles: signerRoles(ctx, r),
    networkFeeLamports: r.maxFeeLamports, wireBytes: Buffer.from(unsignedTransactionBase64(r.messageBase64), 'base64').length, lookupTable: lookupTable?.address ?? null,
    approvalFlag: APPROVAL_FLAG_STAGES.has(stage), book: Object.fromEntries(names), instructions: decodeMessage(r.messageBase64, { programs: ctx.programs, book: names, lookupTable, abi: ctx.abi }) }
}
export async function plan(ctx, stageName, { write = true, log = console.log } = {}) {
  const stage = STAGES[stageName]
  if (!stage) throw Error(`Unknown stage ${stageName}`)
  const built = await stage.build(ctx, null)
  const preview = describe(ctx, stageName, built)
  if (built.review) preview.simulation = await simulate(ctx.readers[0], new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(built.review.messageBase64, 'base64'))))
  const text = renderPreview({ ...preview, book: preview.book })
  let runDir = null
  if (write) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    runDir = path.join(ctx.root, `${stageName}-${stamp}${built.review ? `-${built.review.messageSha256.slice(0, 8)}` : ''}`)
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    const { book: _book, ...previewJson } = preview
    writeFileSync(path.join(runDir, 'preview.txt'), `${text}\n`, { mode: 0o600 })
    writeFileSync(path.join(runDir, 'preview.json'), JSON.stringify(previewJson, null, 2), { mode: 0o600 })
    if (built.review) {
      writeFileSync(path.join(runDir, 'unsigned-tx.base64'), `${unsignedTransactionBase64(built.review.messageBase64)}\n`, { mode: 0o600 })
      writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify({ schema: 'repoing/hooklab-owner-plan/1', stage: stageName, network: ctx.network, genesisHash: ctx.genesis,
        messageSha256: built.review.messageSha256, messageBase64: built.review.messageBase64, pinned: built.pinned, expect: built.expect, review: built.review, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    }
  }
  log(text)
  if (runDir) log(`\nrun directory: ${runDir}`)
  return { built, preview, runDir, text }
}
