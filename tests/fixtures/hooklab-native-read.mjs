import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { productionHookEventDecoder } from '../../src/hooklab-native-events.mjs'
import { indexHookNativeBatch } from '../../src/hooklab-native-indexer.mjs'
import { nativeIndexFixture, key } from './hooklab-native-index.mjs'

export function decodedNativeFixture(options = {}) {
  const f = nativeIndexFixture(), decoder = productionHookEventDecoder(options)
  const swap = decoder.programs[1]
  Object.assign(f.manifest, { sourceCommit: decoder.sourceCommit, ...(decoder.sourcePatchSha256 ? { sourcePatchSha256: decoder.sourcePatchSha256 } : {}), idlSha256: decoder.idlSha256, programs: [swap] })
  const authority = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(swap))[0].toBase58()
  const body = Buffer.alloc(80)
  Buffer.alloc(32, 6).copy(body); body.writeBigUInt64LE(9007199254740993n, 32)
  Buffer.alloc(32, 7).copy(body, 40); body.writeBigInt64LE(-7n, 72)
  f.blocks.get(100).transactions = [{ version: 'legacy', transaction: { signatures: [bs58.encode(Buffer.alloc(64, 5))],
    message: { accountKeys: [key(2), swap, authority], instructions: [{ programIdIndex: 1, accounts: [], data: '' }] } },
  meta: { err: null, fee: 5000, preBalances: [10000, 1, 1], postBalances: [5000, 1, 1],
    innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], stackHeight: 2,
      data: bs58.encode(Buffer.concat([Buffer.from('e445a52e51cb9a1da5227d9b0f5663bf', 'hex'), body])) }] }] } }]
  return { ...f, decoder }
}

export async function retainedNativeFixture({ decoded = false, decoderOptions = {} } = {}) {
  const f = decoded ? decodedNativeFixture(decoderOptions) : nativeIndexFixture()
  let batch
  await indexHookNativeBatch({ ...f, store: { load: async () => ({ nextSlot: 100, lastBlock: null }), commit: async b => { batch = b } } })
  const state = { id: batch.stream, manifest: structuredClone(f.manifest), next_slot: String(batch.nextSlot), last_block: batch.lastBlock }
  const rows = batch.rows.map(evidence => ({ signature: evidence.signature, slot: String(evidence.slot),
    transaction_index: evidence.transactionIndex, evidence, block_evidence: batch.blocks.find(b => b.slot === evidence.slot) }))
  const calls = [], releases = []
  const pool = { connect: async () => ({
    query: async (sql, params) => {
      calls.push({ sql, params })
      if (sql.includes('from hook_native_index_streams')) return { rows: [structuredClone(state)] }
      if (sql.includes('from hook_native_index_transactions')) {
        const [, through, slot, index, limit] = params
        return { rows: structuredClone(rows.filter(r => Number(r.slot) <= through &&
          (Number(r.slot) > slot || Number(r.slot) === slot && r.transaction_index > index)).slice(0, limit)) }
      }
      return { rows: [] }
    }, release: () => releases.push(true),
  }) }
  return { ...f, batch, state, rows, calls, releases, pool }
}
