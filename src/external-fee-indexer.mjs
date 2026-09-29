import { createGraduatedFees, recordGraduatedFees, recordPlatformFees } from './graduated-fees.mjs'
import { PublicKey } from '@solana/web3.js'
import { createFeeAccrual } from './fee-accrual.mjs'
import { createTradeRecorder, UnparseableTradeError } from './trade-evidence.mjs'

const PAGE_SIZE = 1000
const QUARANTINE = 'FEE_EVIDENCE_QUARANTINED'

// One unparseable finalized trade must not freeze a pool's cursor. It becomes a durable operator alert,
// is retried each run until acknowledged, and crediting stays idempotent on (signature, event_index, kind).
export async function quarantineTrade(db, market, signature, slot, error) {
  const detail = { code: 'FEE_EVIDENCE_UNPARSEABLE', pool: market.pool, signature, slot: String(slot), reason: error.message }
  const { rowCount } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing`, [`fee-quarantine:${market.pool}:${signature}`, String(market.repoId), QUARANTINE, JSON.stringify(detail)])
  if (rowCount) console.error(`Fee evidence quarantined for review: ${signature} (${market.pool}): ${error.message}`)
}

export function createExternalFeeIndexer({ pool: databasePool, connection, config,
  graduatedFees = createGraduatedFees({ connection, config, db: databasePool }),
  accrual = createFeeAccrual({ pool: databasePool, connection, config }),
  recordTrade = createTradeRecorder({ pool: databasePool, connection, config }) }) {

  async function processMarket(market) {
    const client = await databasePool.connect()
    const poolKey = new PublicKey(market.pool)
    const repoId = BigInt(market.repoId)
    try {
      const lock = await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [market.pool])
      if (!lock.rows[0].locked) return { githubRepoId: market.repoId, pool: market.pool, status: 'BUSY' }
      try {
        let creditedBaseUnits = 0n
        const eventKeys = []
        const quarantined = []
        const credit = async (signature, slot, fees = true) => {
          try {
            if (fees) {
              const result = await accrual.recordTradeFees({ githubRepoId: repoId, signatures: [signature], allowNonSwap: true })
              creditedBaseUnits += result.creditedBaseUnits
              eventKeys.push(...result.eventKeys)
            }
            await recordTrade(market, signature)
            return true
          } catch (error) {
            if (!(error instanceof UnparseableTradeError)) throw error
            await quarantineTrade(client, market, signature, slot, error)
            quarantined.push(signature)
            return false
          }
        }
        // Upgrade existing markets and recover a crash between fee credit and chart write.
        const uncharted = await client.query(`select f.signature, max(f.slot)::text as slot from fee_events f
          where f.pool = $1 and not exists (select 1 from trade_events t where t.signature = f.signature)
          group by f.signature order by f.signature limit 100`, [market.pool])
        for (const row of uncharted.rows) await credit(row.signature, row.slot, false)
        const review = await client.query(`select id, detail from graduation_alerts where kind = $1 and github_repo_id = $2
          and acknowledged_at is null order by id limit 100`, [QUARANTINE, String(repoId)])
        for (const row of review.rows) {
          const { signature, slot } = JSON.parse(row.detail)
          if (await credit(signature, slot)) await client.query(`update graduation_alerts set acknowledged_at = now(),
            acknowledged_by = 'external-fee-indexer' where id = $1 and acknowledged_at is null`, [row.id])
        }
        const previous = (await client.query('select last_signature, last_slot::text from pool_fee_cursors where pool = $1',
          [market.pool])).rows[0] ?? null
        const boundary = previous?.last_signature ?? market.launchSignature
        const discovered = []
        let before
        let foundBoundary = false
        let boundaryItem
        for (;;) {
          const page = await connection.getSignaturesForAddress(poolKey,
            { commitment: 'finalized', limit: PAGE_SIZE, ...(before ? { before } : {}) })
          if (!page.length) break
          for (const item of page) {
            if (item.signature === boundary) { foundBoundary = true; boundaryItem = item; break }
            discovered.push(item)
          }
          if (foundBoundary) break
          before = page.at(-1).signature
          if (page.length < PAGE_SIZE) break
        }
        if (!foundBoundary) throw new Error(`Finalized pool history does not contain cursor or launch signature for ${market.pool}`)

        for (const item of [...(!previous ? [boundaryItem] : []), ...discovered.reverse()]) {
          if (!item.err) await credit(item.signature, item.slot)
          await client.query(`insert into pool_fee_cursors (pool, last_signature, last_slot) values ($1, $2, $3)
            on conflict (pool) do update set last_signature = excluded.last_signature,
              last_slot = excluded.last_slot, updated_at = now()`,
          [market.pool, item.signature, item.slot.toString()])
        }
        let graduatedCredit = 0n, platformCredit = 0n
        await client.query('select pg_advisory_lock($1::bigint)',[String(repoId)])
        try {
          const canonical = { ...market, githubRepoId: repoId }
          const graduatedSnapshot = await graduatedFees.read(canonical)
          graduatedCredit = await recordGraduatedFees(client, canonical, graduatedSnapshot)
          platformCredit = await recordPlatformFees(client, canonical, graduatedSnapshot?.partner ?? null)
        } finally { await client.query('select pg_advisory_unlock($1::bigint)',[String(repoId)]) }
        const cursor = (await client.query('select last_signature, last_slot::text from pool_fee_cursors where pool = $1',
          [market.pool])).rows[0] ?? null
        return { githubRepoId: market.repoId, pool: market.pool, status: 'OK',
          discovered: discovered.length, creditedBaseUnits, quarantined, graduatedCredit, platformCredit, eventKeys,
          cursorBefore: previous ? { signature: previous.last_signature, slot: previous.last_slot } : null,
          cursorAfter: cursor ? { signature: cursor.last_signature, slot: cursor.last_slot } : null }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [market.pool]) }
    } finally { client.release() }
  }

  async function runOnce() {
    const { rows } = await databasePool.query(`select github_repo_id::text as "repoId", mint, pool,
      launch_signature as "launchSignature", creator_wallet as "creatorWallet" from markets where status = 'confirmed'
      and indexed_at is not null and launch_finality = 'finalized' order by github_repo_id`)
    const results = []
    for (const market of rows) {
      try { results.push(await processMarket(market)) }
      catch (error) { results.push({ githubRepoId: market.repoId, pool: market.pool, status: 'ERROR', error: error.message }) }
    }
    return results
  }
  return { runOnce }
}
