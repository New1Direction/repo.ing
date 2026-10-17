// Explicit operator invocation only. No worker registration, SDK defaults, signer or broadcast.
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import bs58 from 'bs58'
import { z } from 'zod'
import { HOOK_MAINNET_GENESIS, hookAddress, hookDigest } from './hooklab-execution-contract.mjs'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 32)
const check = (ok, message) => { if (!ok) throw new Error(message) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const hookIndexManifestSchema = z.object({ schema: z.literal('repoing/hook-index/1'),
  genesisHash: z.literal(HOOK_MAINNET_GENESIS), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  profileSha256: hookDigest, idlSha256: hookDigest, startSlot: integer,
  programs: z.array(hookAddress).min(1).max(16).refine(v => new Set(v).size === v.length),
  providers: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).length(2).refine(v => new Set(v).size === 2),
}).strict()

const readMethods = new Set(['getGenesisHash', 'getSlot', 'getFirstAvailableBlock', 'getBlocks', 'getBlock'])
export function createHookIndexRpc(url, fetchImpl = fetch) {
  check(new URL(url).protocol === 'https:', 'HTTPS read adapter required')
  return async (method, params = []) => {
    check(readMethods.has(method), 'RPC method forbidden')
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      check(response.ok, 'RPC unavailable')
      const body = await response.json()
      check(body.jsonrpc === '2.0' && body.id === 1 && !body.error && Object.hasOwn(body, 'result'), 'RPC unavailable')
      return body.result
    } catch { throw new Error('Hook index RPC unavailable') }
  }
}

function rowsForBlock(block, manifest, slot) {
  hookAddress.parse(block.blockhash); hookAddress.parse(block.previousBlockhash); integer.parse(block.parentSlot)
  check(block.parentSlot < slot && Array.isArray(block.transactions), 'Invalid finalized block')
  return block.transactions.flatMap((raw, transactionIndex) => {
    const { transaction: tx, meta } = raw
    check(tx && meta && Object.hasOwn(meta, 'err') && Array.isArray(tx.message?.accountKeys)
      && Array.isArray(tx.message.instructions) && Array.isArray(meta.innerInstructions), 'Incomplete transaction evidence')
    const keys = [...tx.message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])]
    keys.forEach(k => hookAddress.parse(k))
    if (tx.message.addressTableLookups?.length) check(meta.loadedAddresses, 'Missing resolved lookup addresses')
    const invocations = [...tx.message.instructions, ...meta.innerInstructions.flatMap(i => i.instructions)]
      .map(ix => {
        check(Number.isInteger(ix.programIdIndex) && keys[ix.programIdIndex], 'Invalid invoked program index')
        return keys[ix.programIdIndex]
      })
    const programs = manifest.programs.filter(p => invocations.includes(p))
    if (!programs.length) return [] // Merely mentioning a program as data is not an invocation.
    check(raw.version === 'legacy' || raw.version === 0, 'Unsupported transaction version')
    check(Array.isArray(tx.signatures) && tx.signatures.length > 0
      && tx.signatures.every(s => typeof s === 'string' && bs58.decode(s).length === 64), 'Invalid signature inventory')
    check(Number.isSafeInteger(meta.fee) && meta.fee >= 0
      && [meta.preBalances, meta.postBalances].every(b => Array.isArray(b) && b.length === keys.length
        && b.every(n => Number.isSafeInteger(n) && n >= 0)), 'Unsafe native balance evidence')
    return [{ slot, transactionIndex, signature: tx.signatures[0], programs, raw,
      rawSha256: digest(raw), receiptStatus: meta.err === null ? 'finalized-success' : 'finalized-failure',
      eventStatus: 'undecoded', economicPostconditions: false, deploymentAdopted: false }]
  })
}

/** Scan complete finalized block ranges, including CPI invocations and failed transactions.
 * Both independent operator-selected providers must agree. No cursor skips a missing/pruned block.
 * This is native transaction discovery, NOT a decoded event index or accepted trade/volume feed.
 */
export async function indexHookNativeBatch({ manifest: input, adapters, store, limit = 8 }) {
  const manifest = hookIndexManifestSchema.parse(input), stream = digest(manifest)
  check(Number.isInteger(limit) && limit > 0 && limit <= 32, 'Invalid batch limit')
  check(Array.isArray(adapters) && adapters.length === 2 && adapters[0].read !== adapters[1].read
    && new Set(adapters.map(a => a.provider)).size === 2
    && adapters.every(a => manifest.providers.includes(a.provider) && typeof a.read === 'function'), 'Independent configured readers required')
  // Bound even injected adapters. Timeout has no write/send side effect and cannot advance a cursor.
  const both = async (method, params) => {
    let timer
    try {
      return await Promise.race([Promise.all(adapters.map(a => a.read(method, params))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Hook index read timeout')), 10000) })])
    } finally { clearTimeout(timer) }
  }
  check((await both('getGenesisHash', [])).every(g => g === manifest.genesisHash), 'Wrong index network')
  const state = await store.load(stream, manifest)
  const start = integer.parse(state.nextSlot)
  const roots = await both('getSlot', [{ commitment: 'finalized' }]); roots.forEach(r => integer.parse(r))
  const end = Math.min(start + limit - 1, ...roots)
  if (end < start) return { status: 'caught-up', nextSlot: start, transactions: 0, executionEnabled: false }
  const oldest = await both('getFirstAvailableBlock', []); oldest.forEach(s => integer.parse(s))
  check(oldest.every(s => s <= start), 'History pruned; preserve checkpoint and use archive providers')
  const lists = await both('getBlocks', [start, end, { commitment: 'finalized' }])
  check(isDeepStrictEqual(lists[0], lists[1]) && Array.isArray(lists[0])
    && lists[0].every((s, i, all) => Number.isSafeInteger(s) && s >= start && s <= end && (i === 0 || s > all[i - 1])),
  'Finalized block inventories disagree')
  const slots = new Set(lists[0]), blocks = [], rows = []
  let lastBlock = state.lastBlock
  for (let slot = start; slot <= end; slot++) {
    if (!slots.has(slot)) { blocks.push({ slot, blockhash: null }); continue }
    const pair = await both('getBlock', [slot, { commitment: 'finalized', encoding: 'json',
      transactionDetails: 'full', rewards: false, maxSupportedTransactionVersion: 0 }])
    check(pair[0] && isDeepStrictEqual(pair[0], pair[1]), 'Missing or disagreeing finalized block')
    const b = pair[0]
    rows.push(...rowsForBlock(b, manifest, slot))
    if (lastBlock) check(b.parentSlot === lastBlock.slot && b.previousBlockhash === lastBlock.blockhash, 'Finalized ancestry differs')
    else check(b.parentSlot < manifest.startSlot, 'Initial block inventory omitted a parent')
    blocks.push({ slot, blockhash: b.blockhash, normalizedSha256: digest(b) })
    lastBlock = { slot, blockhash: b.blockhash }
  }
  await store.commit({ stream, expectedNextSlot: start, nextSlot: end + 1, lastBlock, blocks, rows })
  return { status: 'indexed-raw', nextSlot: end + 1, transactions: rows.length, executionEnabled: false }
}

/** Candidate PostgreSQL store. Schema is deliberately NOT a registered shared migration. */
export function hookNativeIndexStore(pool) {
  return {
    async load(stream, manifest) {
      await pool.query(`insert into hook_native_index_streams(id,manifest,next_slot) values($1,$2,$3) on conflict do nothing`,
        [stream, manifest, manifest.startSlot])
      const row = (await pool.query('select * from hook_native_index_streams where id=$1', [stream])).rows[0]
      check(row && isDeepStrictEqual(row.manifest, manifest), 'Index manifest conflict')
      return { nextSlot: Number(row.next_slot), lastBlock: row.last_block }
    },
    async commit(batch) {
      const db = await pool.connect()
      try {
        await db.query('begin')
        const row = (await db.query('select next_slot from hook_native_index_streams where id=$1 for update', [batch.stream])).rows[0]
        check(row && Number(row.next_slot) === batch.expectedNextSlot, 'Index checkpoint conflict; reread')
        for (const b of batch.blocks) await db.query('insert into hook_native_index_blocks(stream,slot,evidence) values($1,$2,$3)', [batch.stream, b.slot, b])
        for (const r of batch.rows) await db.query(`insert into hook_native_index_transactions(stream,signature,slot,transaction_index,evidence)
          values($1,$2,$3,$4,$5)`, [batch.stream, r.signature, r.slot, r.transactionIndex, r])
        await db.query('update hook_native_index_streams set next_slot=$2,last_block=$3 where id=$1', [batch.stream, batch.nextSlot, batch.lastBlock])
        await db.query('commit')
      } catch (error) { await db.query('rollback'); throw error }
      finally { db.release() }
    },
  }
}
