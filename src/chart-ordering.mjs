import bs58 from 'bs58'
import { readGenesisHash } from './rpc-usage.mjs'
import { releaseAfterUnlock } from './database-pool.mjs'

const MAINNET = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const fail = code => { throw Error(code) }
function bytes(value, length) {
  try { return typeof value === 'string' && bs58.decode(value).length === length } catch { return false }
}

export function chartBlockEvidence(slot, block, requiredSignatures) {
  if (!Number.isSafeInteger(slot) || slot < 1 || !block || !bytes(block.blockhash, 32) ||
      !bytes(block.previousBlockhash, 32) || !Number.isSafeInteger(block.parentSlot) ||
      block.parentSlot < 0 || block.parentSlot >= slot || !Array.isArray(block.signatures) ||
      !block.signatures.length || block.signatures.length > 50000 ||
      block.signatures.some(s => !bytes(s, 64))) fail('CHART_BLOCK_INVALID')
  const signatures = new Set(block.signatures)
  if (signatures.size !== block.signatures.length) fail('CHART_DUPLICATE_SIGNATURE')
  if (!requiredSignatures.length || requiredSignatures.some(s => !signatures.has(s))) fail('CHART_SIGNATURE_MISSING')
  return { slot, blockhash: block.blockhash, previousBlockhash: block.previousBlockhash,
    parentSlot: block.parentSlot, signatures: block.signatures }
}

export async function verifyChartBlock({ connection, verification, slot, signatures }) {
  if (!verification || connection.rpcEndpoint === verification.rpcEndpoint) fail('CHART_VERIFICATION_REQUIRED')
  const genesis = await Promise.all([connection, verification].map(c => readGenesisHash(c)))
  if (genesis.some(value => value !== MAINNET)) fail('CHART_NETWORK_MISMATCH')
  const blocks = await Promise.all([connection, verification].map(async c =>
    chartBlockEvidence(slot, await c.getBlockSignatures(slot, 'finalized'), signatures)))
  if (JSON.stringify(blocks[0]) !== JSON.stringify(blocks[1])) fail('CHART_RPC_DISAGREEMENT')
  return blocks[0]
}

export async function recordChartBlock(db, proof) {
  await db.query(`insert into finalized_chart_blocks(slot,blockhash,previous_blockhash,parent_slot,signatures)
    values($1,$2,$3,$4,$5) on conflict(slot) do nothing`,
  [proof.slot, proof.blockhash, proof.previousBlockhash, proof.parentSlot, proof.signatures])
  // A pruned block (empty list, see pruneChartBlocks) takes its list back from this fresh two-RPC proof of the same block.
  await db.query(`update finalized_chart_blocks set signatures=$5 where slot=$1 and blockhash=$2 and previous_blockhash=$3
    and parent_slot=$4 and cardinality(signatures)=0`, [proof.slot, proof.blockhash, proof.previousBlockhash, proof.parentSlot, proof.signatures])
  const { rows: [stored] } = await db.query('select * from finalized_chart_blocks where slot=$1', [proof.slot])
  if (!stored || stored.blockhash !== proof.blockhash || stored.previous_blockhash !== proof.previousBlockhash ||
      Number(stored.parent_slot) !== proof.parentSlot || JSON.stringify(stored.signatures) !== JSON.stringify(proof.signatures)) {
    fail('CHART_EVIDENCE_CONFLICT')
  }
  // Chart reads order trades by these stored positions instead of searching the block's whole signature list.
  await db.query(`insert into finalized_chart_positions(slot,signature,transaction_index)
    select $1::bigint,s.signature,s.ord from unnest($2::text[]) with ordinality as s(signature,ord)
    where s.signature in (select signature from trade_events where slot=$1 union select signature from damm_trade_events where slot=$1
      union select signature from stock_trade_events where slot=$1)
    on conflict do nothing`, [proof.slot, proof.signatures])
}

// Positions for trades indexed after their block was recorded. Only trades without a stored position read the block's
// signature list; a trade absent from its recorded block (an evidence conflict) stays without one.
const SYNC_POSITIONS = `insert into finalized_chart_positions(slot,signature,transaction_index)
  select slot,signature,transaction_index from (
    select t.slot,t.signature,array_position(b.signatures,t.signature::text) as transaction_index
    from (select slot,signature from trade_events union select slot,signature from damm_trade_events
      union select slot,signature from stock_trade_events) t
    join finalized_chart_blocks b on b.slot=t.slot
    where not exists (select 1 from finalized_chart_positions p where p.slot=t.slot and p.signature=t.signature)
    offset 0) missing
  where transaction_index is not null on conflict do nothing`

// A recorded block keeps every transaction signature in it (~100 KB) only while one of its trades may still need a position
// from that list. Once every indexed trade in the block has a stored position and the block is keepMs old, the list is
// cleared to an empty array: chart, wallet price and P&L reads use the stored positions (blockPosition in market-chart.mjs).
// A trade indexed later in such a block has no position, so the block is pending again and the next pass reads it from both
// RPCs and restores the list (recordChartBlock). Seven days, so a trade indexed that late (an outage, a backfill) is rare,
// and the verification RPC, which may not serve blocks that old, is rarely needed for it. pg_column_size reads a stored
// list's size without loading it. Blocks that still need their list never hold up others.
export const CHART_BLOCK_KEEP_MS = 7 * 86_400_000
export async function pruneChartBlocks(db, { keepMs = CHART_BLOCK_KEEP_MS, limit = 50 } = {}) {
  const { rowCount } = await db.query(`with candidates as (
      select slot from finalized_chart_blocks where checked_at < now() - make_interval(secs => $1) and pg_column_size(signatures) > 64
    ), unpositioned as (
      select distinct t.slot from (select slot,signature from trade_events where slot in (select slot from candidates)
        union all select slot,signature from damm_trade_events where slot in (select slot from candidates)
        union all select slot,signature from stock_trade_events where slot in (select slot from candidates)) t
      where not exists (select 1 from finalized_chart_positions p where p.slot=t.slot and p.signature=t.signature)
    ) update finalized_chart_blocks set signatures='{}' where slot in (
      select c.slot from candidates c where not exists (select 1 from unpositioned u where u.slot=c.slot) order by c.slot limit $2)`,
  [keepMs / 1000, limit])
  return rowCount ?? 0
}

// Auxiliary chart evidence only. Never changes trade amounts, fees, or financial intents. Orders SOL trades (trade_events,
// damm_trade_events) and stock-pair trades (stock_trade_events, docs/STOCK_QUOTES.md) alike: positions are per signature.
export function createChartOrdering({ pool, connection, verification, now = Date.now }) {
  const retryAfter = new Map()
  return { async runOnce() {
    if (!verification) return { status: 'verification-unavailable', verified: 0 }
    const db = await pool.connect()
    let locked = false
    try {
      const { rows: [lock] } = await db.query("select pg_try_advisory_lock(hashtext('chart-block-ordering')) as locked")
      locked = lock.locked
      if (!locked) return { status: 'locked', verified: 0 }
      await db.query(SYNC_POSITIONS)
      // Storage only: a failure here never stops the ordering below.
      let pruned = 0, pruneError = null
      try { pruned = await pruneChartBlocks(db) } catch (error) { pruneError = error?.code ?? 'CHART_PRUNE_UNAVAILABLE' }
      // Multi-transaction slots without a recorded block, or with a trade missing from it (no stored position after the
      // sync above). Never reads the blocks' signature lists, which used to be de-TOASTed in full on every pass.
      const { rows } = await db.query(`with all_trades as (
        select slot,signature from trade_events union all select slot,signature from damm_trade_events
        union all select slot,signature from stock_trade_events
        ) select t.slot::text,array_agg(distinct t.signature) as signatures
        from all_trades t left join finalized_chart_blocks b on b.slot=t.slot
        left join finalized_chart_positions p on p.slot=t.slot and p.signature=t.signature
        group by t.slot,b.slot having count(distinct t.signature)>1
        and (b.slot is null or count(distinct p.signature)<count(distinct t.signature))
        order by t.slot desc`)
      const result = { status: 'checked', verified: 0, pending: rows.length, errors: [], ...pruned ? { pruned } : {}, ...pruneError ? { pruneError } : {} }
      let attempted = 0
      for (const row of rows) {
        if ((retryAfter.get(row.slot) ?? 0) > now()) continue
        if (++attempted > 12) break
        try {
          const proof = await verifyChartBlock({ connection, verification, slot: Number(row.slot), signatures: row.signatures })
          await recordChartBlock(db, proof)
          retryAfter.delete(row.slot); result.verified++; result.pending--
        } catch (error) {
          retryAfter.set(row.slot, now() + 600000)
          result.errors.push({ slot: row.slot, code: /^CHART_[A-Z_]+$/.test(error.message) ? error.message : 'CHART_RPC_UNAVAILABLE' })
        }
      }
      for (const [slot, time] of retryAfter) if (time <= now()) retryAfter.delete(slot)
      return result
    } finally {
      await releaseAfterUnlock(db, () => locked ? db.query("select pg_advisory_unlock(hashtext('chart-block-ordering'))") : null)
    }
  } }
}
