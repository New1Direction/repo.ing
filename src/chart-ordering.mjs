import bs58 from 'bs58'

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
  const genesis = await Promise.all([connection, verification].map(c => c.getGenesisHash()))
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
  const { rows: [stored] } = await db.query('select * from finalized_chart_blocks where slot=$1', [proof.slot])
  if (!stored || stored.blockhash !== proof.blockhash || stored.previous_blockhash !== proof.previousBlockhash ||
      Number(stored.parent_slot) !== proof.parentSlot || JSON.stringify(stored.signatures) !== JSON.stringify(proof.signatures)) {
    fail('CHART_EVIDENCE_CONFLICT')
  }
}

// Auxiliary chart evidence only. Never changes trade amounts, fees, or financial intents.
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
      const { rows } = await db.query(`select t.slot::text,array_agg(distinct t.signature) as signatures
        from trade_events t left join finalized_chart_blocks b on b.slot=t.slot
        group by t.slot,b.slot,b.signatures having count(distinct t.signature)>1
        and (b.slot is null or not b.signatures @> array_agg(distinct t.signature)::text[])
        order by t.slot desc`)
      const result = { status: 'checked', verified: 0, pending: rows.length, errors: [] }
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
      if (locked) await db.query("select pg_advisory_unlock(hashtext('chart-block-ordering'))")
      db.release()
    }
  } }
}
