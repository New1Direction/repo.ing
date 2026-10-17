// Bounded, repeatable-snapshot reads of retained observations. No RPC, schema changes or execution.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { z } from 'zod'
import { hookAddress, hookDigest } from './hooklab-execution-contract.mjs'
import { hookIndexManifestSchema, decodedObservationSchema } from './hooklab-native-indexer.mjs'
import { productionHookEventDecoder } from './hooklab-native-events.mjs'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 32)
const signature = z.string().max(88).refine(value => {
  try { return bs58.decode(value).length === 64 && bs58.encode(bs58.decode(value)) === value } catch { return false }
})
const check = (ok, message = 'Retained index evidence is inconsistent') => { if (!ok) throw Error(message) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const nativeReadStreamId = input => digest(hookIndexManifestSchema.parse(input))
const cursorSchema = z.object({ schema: z.literal('repoing/hook-receipts-cursor/1'), stream: hookDigest,
  throughSlot: integer, afterSlot: integer, afterTransactionIndex: integer,
}).strict()
export const nativeReceiptQuerySchema = z.object({ limit: z.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).refine(value => {
    try { decodeCursor(value); return true } catch { return false }
  }).optional(),
}).strict()
export function parseNativeReceiptQuery(searchParams) {
  const values = {}
  for (const [key, value] of searchParams) {
    check((key === 'limit' || key === 'cursor') && !Object.hasOwn(values, key), 'Invalid receipt query')
    values[key] = value
  }
  if (Object.hasOwn(values, 'limit')) {
    check(/^[1-9]\d{0,2}$/.test(values.limit), 'Invalid receipt query')
    values.limit = Number(values.limit)
  }
  return nativeReceiptQuerySchema.parse(values)
}
function decodeCursor(value) {
  const bytes = Buffer.from(value, 'base64url')
  check(bytes.toString('base64url') === value, 'Invalid receipt cursor')
  const parsed = cursorSchema.parse(JSON.parse(bytes.toString('utf8')))
  check(Buffer.from(JSON.stringify(parsed)).toString('base64url') === value, 'Noncanonical receipt cursor')
  return parsed
}
function storedInteger(value) {
  check(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) || typeof value === 'number', 'Invalid stored position')
  return integer.parse(Number(value))
}
const rowEvidenceSchema = z.object({ slot: integer, transactionIndex: integer, signature,
  programs: z.array(hookAddress).min(1).max(16).refine(p => new Set(p).size === p.length), raw: z.unknown(),
  rawSha256: hookDigest, receiptStatus: z.enum(['finalized-success', 'finalized-failure']),
  eventStatus: z.enum(['undecoded', 'decoded-self-cpi']), events: decodedObservationSchema.shape.events.optional(),
  economicPostconditions: z.literal(false), deploymentAdopted: z.literal(false),
}).strict()
const blockEvidenceSchema = z.object({ slot: integer, blockhash: hookAddress, normalizedSha256: hookDigest }).strict()
const lastBlockSchema = z.object({ slot: integer, blockhash: hookAddress }).strict().nullable()

function projectRow(row, manifest, throughSlot, decoderForStream) {
  const evidence = rowEvidenceSchema.parse(row.evidence)
  const slot = storedInteger(row.slot), transactionIndex = storedInteger(row.transaction_index)
  const block = blockEvidenceSchema.parse(row.block_evidence)
  check(evidence.slot === slot && evidence.transactionIndex === transactionIndex && evidence.signature === row.signature
    && block.slot === slot && slot >= manifest.startSlot && slot <= throughSlot)
  check(evidence.programs.every(p => manifest.programs.includes(p)))
  const raw = evidence.raw, tx = raw?.transaction, meta = raw?.meta
  check((raw?.version === 'legacy' || raw?.version === 0) && tx?.signatures?.[0] === evidence.signature
    && meta && Object.hasOwn(meta, 'err') && Array.isArray(tx.message?.accountKeys)
    && Array.isArray(tx.message.instructions) && Array.isArray(meta.innerInstructions))
  check((meta.err === null ? 'finalized-success' : 'finalized-failure') === evidence.receiptStatus)
  const keys = [...tx.message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])]
  keys.forEach(key => hookAddress.parse(key))
  if (tx.message.addressTableLookups?.length) check(meta.loadedAddresses)
  const invoked = [...tx.message.instructions, ...meta.innerInstructions.flatMap(g => g.instructions)].map(ix => {
    check(Number.isInteger(ix.programIdIndex) && keys[ix.programIdIndex]); return keys[ix.programIdIndex]
  })
  check(isDeepStrictEqual(evidence.programs, manifest.programs.filter(p => invoked.includes(p))))
  let events = []
  if (evidence.eventStatus === 'decoded-self-cpi') {
    const decoded = decodedObservationSchema.parse(decoderForStream().decode(raw))
    check(isDeepStrictEqual(evidence.events, decoded.events), 'Retained event decoding differs')
    events = decoded.events
  } else check(evidence.events === undefined, 'Undecoded receipt cannot contain decoded events')
  return { slot, transactionIndex, signature: evidence.signature, blockhash: block.blockhash,
    programs: evidence.programs, receiptStatus: evidence.receiptStatus, eventStatus: evidence.eventStatus, events,
    retainedRawSha256: evidence.rawSha256, hashMeaning: 'retained-normalized-JSON-not-wire-attestation',
    economicPostconditions: false, deploymentAdopted: false, acceptedTrade: false, executionEnabled: false }
}

export async function readNativeReceiptPage({ pool, manifest: input, query: queryInput = {} }) {
  const manifest = hookIndexManifestSchema.parse(input), stream = nativeReadStreamId(manifest)
  const query = nativeReceiptQuerySchema.parse(queryInput), cursor = query.cursor ? decodeCursor(query.cursor) : null
  if (cursor) check(cursor.stream === stream && cursor.afterSlot >= manifest.startSlot
    && cursor.afterSlot <= cursor.throughSlot, 'Receipt cursor belongs to a different stream or position')
  let decoder
  const decoderForStream = () => {
    decoder ??= productionHookEventDecoder({ sourceCommit: manifest.sourceCommit, sourcePatchSha256: manifest.sourcePatchSha256 })
    check(decoder.idlSha256 === manifest.idlSha256 && manifest.programs.every(p => decoder.programs.includes(p)), 'Decoder/stream ABI binding differs')
    return decoder
  }
  const db = await pool.connect()
  try {
    await db.query('begin isolation level repeatable read read only')
    const result = await db.query('select id,manifest,next_slot,last_block from hook_native_index_streams where id=$1', [stream])
    check(result.rows.length === 1, 'Reviewed index stream is unavailable')
    const state = result.rows[0], storedManifest = hookIndexManifestSchema.parse(state.manifest)
    check(state.id === stream && nativeReadStreamId(storedManifest) === stream && isDeepStrictEqual(storedManifest, manifest), 'Reviewed index stream differs')
    const nextSlot = storedInteger(state.next_slot), lastBlock = lastBlockSchema.parse(state.last_block)
    check(nextSlot >= manifest.startSlot && (!lastBlock || lastBlock.slot >= manifest.startSlot && lastBlock.slot < nextSlot))
    const throughSlot = cursor?.throughSlot ?? nextSlot - 1
    check(throughSlot < nextSlot && throughSlot >= manifest.startSlot - 1, 'Receipt snapshot is no longer available')
    const rows = await db.query(`select t.signature,t.slot,t.transaction_index,
      case when octet_length(t.evidence::text) <= 1048576 then t.evidence else null end as evidence,
      b.evidence as block_evidence
      from hook_native_index_transactions t join hook_native_index_blocks b on b.stream=t.stream and b.slot=t.slot
      where t.stream=$1 and t.slot<=$2 and (t.slot,t.transaction_index)>($3,$4)
      order by t.slot,t.transaction_index limit $5`,
    [stream, throughSlot, cursor?.afterSlot ?? manifest.startSlot - 1, cursor?.afterTransactionIndex ?? -1, query.limit + 1])
    check(rows.rows.length <= query.limit + 1)
    const projected = rows.rows.map(row => projectRow(row, manifest, throughSlot, decoderForStream))
    for (let i = 0; i < projected.length; i++) {
      const previous = i ? projected[i - 1] : cursor ? { slot: cursor.afterSlot, transactionIndex: cursor.afterTransactionIndex } : null
      if (previous) check(projected[i].slot > previous.slot
        || projected[i].slot === previous.slot && projected[i].transactionIndex > previous.transactionIndex)
    }
    const hasMore = projected.length > query.limit, entries = projected.slice(0, query.limit), last = entries.at(-1)
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ schema: 'repoing/hook-receipts-cursor/1', stream,
      throughSlot, afterSlot: last.slot, afterTransactionIndex: last.transactionIndex })).toString('base64url') : null
    const page = { schema: 'repoing/hook-native-receipts/1', status: 'retained-observations',
      identity: { stream, genesisHash: manifest.genesisHash, sourceCommit: manifest.sourceCommit,
        ...(manifest.sourcePatchSha256 ? { sourcePatchSha256: manifest.sourcePatchSha256 } : {}),
        profileSha256: manifest.profileSha256, idlSha256: manifest.idlSha256, programs: manifest.programs, startSlot: manifest.startSlot },
      checkpoint: { nextSlot, throughSlot, lastProducedBlock: lastBlock, liveHeadChecked: false },
      entries, nextCursor, economicPostconditions: false, deploymentAdopted: false, acceptedTrades: false, executionEnabled: false }
    check(Buffer.byteLength(JSON.stringify(page)) <= 1048576, 'Receipt page exceeds response limit; request fewer rows')
    await db.query('commit')
    return page
  } catch (error) { await db.query('rollback'); throw error }
  finally { db.release() }
}
