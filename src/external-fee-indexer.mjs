import { createGraduatedFees, recordGraduatedFees, recordPlatformFees } from './graduated-fees.mjs'
import { PublicKey } from '@solana/web3.js'
import { createFeeAccrual } from './fee-accrual.mjs'
import { createTradeRecorder, UnparseableTradeError } from './trade-evidence.mjs'
import { graduatedReadDue } from './indexer-schedule.mjs'

const PAGE_SIZE = 1000
const FIRST_PAGE = 100
const QUARANTINE = 'FEE_EVIDENCE_QUARANTINED'

// One unparseable finalized trade must not freeze a pool's cursor. It becomes a durable operator alert,
// is retried each run until acknowledged, and crediting stays idempotent on (signature, event_index, kind).
export async function quarantineTrade(db, market, signature, slot, error) {
  const detail = { code: 'FEE_EVIDENCE_UNPARSEABLE', pool: market.pool, signature, slot: String(slot), reason: error.message }
  const { rowCount } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing`, [`fee-quarantine:${market.pool}:${signature}`, String(market.repoId), QUARANTINE, JSON.stringify(detail)])
  if (rowCount) console.error(`Fee evidence quarantined for review: ${signature} (${market.pool}): ${error.message}`)
}

// Activity columns for scheduled runs: the newest moment anything happened to a market, from shared state only.
const ACTIVITY_COLUMNS = `, indexed_at as "indexedAt",
      (select c.updated_at from pool_fee_cursors c where c.pool = markets.pool) as "curveActivityAt",
      (select g.pool from graduation_events g where g.github_repo_id = markets.github_repo_id) as "dammPool",
      (select c.updated_at from pool_fee_cursors c join graduation_events g on g.pool = c.pool
        where g.github_repo_id = markets.github_repo_id) as "dammActivityAt",
      (select max(s.submitted_at) from trade_sessions s where s.github_repo_id = markets.github_repo_id) as "sessionAt"`
const latest = (...values) => values.reduce((max, value) => {
  const at = value ? new Date(value).getTime() : NaN
  return Number.isFinite(at) && at > max ? at : max
}, -Infinity)

// schedule/feed (worker only, see indexer-schedule.mjs): check a market only when it is due — recent or signalled
// activity, else its idle tier — and read graduated fees only when they can have changed. Without them every
// market is fully checked on every run (one-shot scripts and tests).
export function createExternalFeeIndexer({ pool: databasePool, connection, config,
  graduatedFees = createGraduatedFees({ connection, config, db: databasePool }),
  accrual = createFeeAccrual({ pool: databasePool, connection, config }),
  recordTrade = createTradeRecorder({ pool: databasePool, connection, config }),
  schedule = null, feed = null, now = Date.now, log = line => console.log(line) }) {
  const graduatedReads = new Map()
  let feedLoggedAt = -Infinity

  async function processMarket(market, { readGraduated = () => true } = {}) {
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
          // The cursor is normally among the newest few signatures: a small first page keeps idle checks light.
          const limit = before ? PAGE_SIZE : FIRST_PAGE
          const page = await connection.getSignaturesForAddress(poolKey,
            { commitment: 'finalized', limit, ...(before ? { before } : {}) })
          if (!page.length) break
          for (const item of page) {
            if (item.signature === boundary) { foundBoundary = true; boundaryItem = item; break }
            discovered.push(item)
          }
          if (foundBoundary) break
          before = page.at(-1).signature
          if (page.length < limit) break
        }
        if (!foundBoundary) throw new Error(`Finalized pool history does not contain cursor or launch signature for ${market.pool}`)

        for (const item of [...(!previous ? [boundaryItem] : []), ...discovered.reverse()]) {
          if (!item.err) await credit(item.signature, item.slot)
          await client.query(`insert into pool_fee_cursors (pool, last_signature, last_slot) values ($1, $2, $3)
            on conflict (pool) do update set last_signature = excluded.last_signature,
              last_slot = excluded.last_slot, updated_at = now()`,
          [market.pool, item.signature, item.slot.toString()])
        }
        let graduatedCredit = 0n, platformCredit = 0n, graduated = null
        const graduatedRead = readGraduated(discovered.length)
        if (graduatedRead) {
          await client.query('select pg_advisory_lock($1::bigint)',[String(repoId)])
          try {
            const canonical = { ...market, githubRepoId: repoId }
            const graduatedSnapshot = await graduatedFees.read(canonical)
            graduated = graduatedSnapshot !== null
            graduatedCredit = await recordGraduatedFees(client, canonical, graduatedSnapshot)
            platformCredit = await recordPlatformFees(client, canonical, graduatedSnapshot?.partner ?? null)
          } finally { await client.query('select pg_advisory_unlock($1::bigint)',[String(repoId)]) }
        }
        const cursor = (await client.query('select last_signature, last_slot::text from pool_fee_cursors where pool = $1',
          [market.pool])).rows[0] ?? null
        return { githubRepoId: market.repoId, pool: market.pool, status: 'OK',
          discovered: discovered.length, creditedBaseUnits, quarantined, graduatedCredit, platformCredit, eventKeys,
          ...(graduatedRead ? { graduated } : { graduatedRead: false }),
          cursorBefore: previous ? { signature: previous.last_signature, slot: previous.last_slot } : null,
          cursorAfter: cursor ? { signature: cursor.last_signature, slot: cursor.last_slot } : null }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [market.pool]) }
    } finally { client.release() }
  }

  async function runOnce() {
    const { rows } = await databasePool.query(`select github_repo_id::text as "repoId", mint, pool,
      launch_signature as "launchSignature", creator_wallet as "creatorWallet"${schedule ? ACTIVITY_COLUMNS : ''} from markets where status = 'confirmed'
      and indexed_at is not null and launch_finality = 'finalized' order by github_repo_id`)
    const results = []
    if (!schedule) {
      for (const market of rows) {
        try { results.push(await processMarket(market)) }
        catch (error) { results.push({ githubRepoId: market.repoId, pool: market.pool, status: 'ERROR', error: error.message }) }
      }
      return results
    }
    if (feed) {
      // Hints only: on failure every market keeps its tier schedule.
      try {
        const woken = await feed.poll(rows.map(market => market.pool))
        for (const market of rows) if (woken.all || woken.pools.has(market.pool)) schedule.wake(market.pool)
      } catch (error) {
        if (now() - feedLoggedAt >= 600_000) { feedLoggedAt = now(); log(JSON.stringify({ feeActivityFeedError: error?.message ?? 'unavailable' })) }
      }
    }
    for (const market of rows) {
      const activityAt = latest(market.indexedAt, market.curveActivityAt, market.dammActivityAt, market.sessionAt)
      if (!schedule.due(market.pool, { activityAt: Number.isFinite(activityAt) ? activityAt : null })) continue
      const startedAt = now(), previous = graduatedReads.get(market.pool)
      const dammActivityAt = latest(market.dammActivityAt, market.sessionAt)
      const readGraduated = discovered => graduatedReadDue({ now: startedAt, lastReadAt: previous?.at ?? null,
        lastReadGraduated: previous?.graduated ?? false, discovered, dammPool: market.dammPool,
        activityAt: Number.isFinite(dammActivityAt) ? dammActivityAt : null })
      let result
      try { result = await processMarket(market, { readGraduated }) }
      catch (error) { result = { githubRepoId: market.repoId, pool: market.pool, status: 'ERROR', error: error.message } }
      if (result.status === 'OK' && result.graduatedRead !== false) graduatedReads.set(market.pool, { at: startedAt, graduated: result.graduated })
      // The cursor may have moved past the transactions that made a graduated read due: read on the next good check.
      else if (result.status === 'ERROR') graduatedReads.delete(market.pool)
      if (result.status !== 'BUSY') schedule.checked(market.pool, { startedAt, active: result.discovered > 0, error: result.status === 'ERROR' })
      results.push(result)
    }
    return results
  }
  return { runOnce }
}
