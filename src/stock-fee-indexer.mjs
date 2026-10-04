import { PublicKey } from '@solana/web3.js'
import { createStockFeeAccrual } from './stock-fee-accrual.mjs'
import { UnparseableTradeError } from './trade-evidence.mjs'
import { createQuoteAwareConfigResolver } from './market-config.mjs'
import { StockCurveMigratedError } from './stock-trade-evidence.mjs'

// The worker's curve indexer for stock-paired markets (docs/STOCK_QUOTES.md): exactly the markets the SOL indexer
// (external-fee-indexer.mjs) leaves out, with their own cursors (stock_pool_cursors) and ledgers (stock-fee-accrual.mjs).
// Nothing here skips silently: a transaction the strict parser cannot fully match is quarantined for operator review
// (STOCK_FEE_EVIDENCE_QUARANTINED on the graduation_alerts feed, retried every run) and later trades keep being credited; a
// missing stock config, a changed or migrated curve, or an RPC failure is an ERROR that leaves the cursor where it was.
// Graduation (the DAMM v2 pool after migration) is indexed by src/stock-graduation-monitor.mjs. A migrated curve stays an ERROR
// here until that job has proven its migration (stock_graduation_events); then the curve is finished: the swaps before the
// migration are credited, the cursor stops on the migration, and the market is GRADUATED here from then on.

const PAGE_SIZE = 1000
const FIRST_PAGE = 100
export const STOCK_QUARANTINE = 'STOCK_FEE_EVIDENCE_QUARANTINED'

export async function quarantineStockTrade(db, market, signature, slot, error) {
  const detail = { code: 'STOCK_FEE_EVIDENCE_UNPARSEABLE', pool: market.pool, quoteMint: market.quoteMint, signature, slot: String(slot),
    reason: error.message }
  const { rowCount } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing`, [`stock-fee-quarantine:${market.pool}:${signature}`, String(market.repoId), STOCK_QUARANTINE, JSON.stringify(detail)])
  if (rowCount) console.error(`Stock fee evidence quarantined for review: ${signature} (${market.pool}): ${error.message}`)
}

// Activity columns for scheduled runs, as the SOL indexer's: indexing, this pool's cursor and repo.ing trade sessions.
const ACTIVITY_COLUMNS = `, indexed_at as "indexedAt",
      (select c.updated_at from stock_pool_cursors c where c.pool = markets.pool) as "curveActivityAt",
      (select max(s.submitted_at) from trade_sessions s where s.github_repo_id = markets.github_repo_id) as "sessionAt"`
const latest = (...values) => values.reduce((max, value) => {
  const at = value ? new Date(value).getTime() : NaN
  return Number.isFinite(at) && at > max ? at : max
}, -Infinity)

// schedule/feed as for the SOL indexer (indexer-schedule.mjs), but their own: the feed watches the stock configs
// (STOCK_QUOTE_CONFIGS). Without them every stock market is fully checked on every run.
export function createStockFeeIndexer({ pool: databasePool, connection, config, stockConfigs = undefined,
  accrual = createStockFeeAccrual({ pool: databasePool, connection, config, stockConfigs }),
  schedule = null, feed = null, now = Date.now, log = line => console.log(line) }) {
  let feedLoggedAt = -Infinity, resolveConfig
  // The stock configs the listed markets were launched on; a market whose config cannot be resolved is not listed (its
  // own check reports the ERROR).
  const configsWithMarkets = rows => {
    try { resolveConfig ??= createQuoteAwareConfigResolver(config, undefined, stockConfigs) } catch { return null }
    const used = new Set()
    for (const market of rows) { try { used.add(resolveConfig(market).toBase58()) } catch { /* reported by processMarket */ } }
    return used
  }

  async function processMarket(market) {
    const client = await databasePool.connect()
    const poolKey = new PublicKey(market.pool)
    try {
      const lock = await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [market.pool])
      if (!lock.rows[0].locked) return { githubRepoId: market.repoId, pool: market.pool, status: 'BUSY' }
      try {
        // Before any history is read or any cursor moves: the stock config is registered, the curve is the market's and
        // has not migrated (or its migration is proven), and its config is the one the fee policy expects.
        let migration = null
        try { await accrual.checkCurve(market.repoId) } catch (error) {
          if (!(error instanceof StockCurveMigratedError)) throw error
          migration = (await client.query(`select migration_signature as signature, slot::text as slot from stock_graduation_events
            where github_repo_id = $1`, [String(market.repoId)])).rows[0] ?? null
          if (!migration) throw error
          await accrual.checkCurve(market.repoId, databasePool, migration)
        }
        const finished = cursor => Boolean(migration) && cursor?.last_signature === migration.signature
        let creditedBaseUnits = 0n, creditedPartnerUnits = 0n
        const eventKeys = [], quarantined = []
        const credit = async (signature, slot) => {
          try {
            const result = await accrual.recordTradeFees({ githubRepoId: market.repoId, signatures: [signature], allowNonSwap: true,
              ...(migration ? { migration } : {}) })
            creditedBaseUnits += result.creditedBaseUnits
            creditedPartnerUnits += result.creditedPartnerUnits
            eventKeys.push(...result.eventKeys)
            return true
          } catch (error) {
            if (!(error instanceof UnparseableTradeError)) throw error
            await quarantineStockTrade(client, market, signature, slot, error)
            quarantined.push(signature)
            return false
          }
        }
        // Quarantined transactions are retried until the parser can match them; then their alert is closed.
        const review = await client.query(`select id, detail from graduation_alerts where kind = $1 and github_repo_id = $2
          and acknowledged_at is null order by id limit 100`, [STOCK_QUARANTINE, String(market.repoId)])
        for (const row of review.rows) {
          const { signature, slot } = JSON.parse(row.detail)
          if (await credit(signature, slot)) await client.query(`update graduation_alerts set acknowledged_at = now(),
            acknowledged_by = 'stock-fee-indexer' where id = $1 and acknowledged_at is null`, [row.id])
        }
        const previous = (await client.query('select last_signature, last_slot::text from stock_pool_cursors where pool = $1',
          [market.pool])).rows[0] ?? null
        if (finished(previous)) return { githubRepoId: market.repoId, pool: market.pool, quoteAssetId: market.quoteAssetId, status: 'GRADUATED',
          discovered: 0, creditedBaseUnits, creditedPartnerUnits, quarantined, eventKeys, migration: migration.signature,
          cursorBefore: { signature: previous.last_signature, slot: previous.last_slot }, cursorAfter: { signature: previous.last_signature, slot: previous.last_slot } }
        const boundary = previous?.last_signature ?? market.launchSignature
        const discovered = []
        let before, foundBoundary = false, boundaryItem
        for (;;) {
          const limit = before ? PAGE_SIZE : FIRST_PAGE
          const page = await connection.getSignaturesForAddress(poolKey, { commitment: 'finalized', limit, ...(before ? { before } : {}) })
          if (!page.length) break
          for (const item of page) {
            if (item.signature === boundary) { foundBoundary = true; boundaryItem = item; break }
            discovered.push(item)
          }
          if (foundBoundary) break
          before = page.at(-1).signature
          if (page.length < limit) break
        }
        if (!foundBoundary) throw Error(`Finalized pool history does not contain cursor or launch signature for ${market.pool}`)
        // Oldest first, the launch itself on the first pass. The cursor moves only past a transaction that was credited,
        // quarantined, or failed on chain.
        for (const item of [...(!previous ? [boundaryItem] : []), ...discovered.reverse()]) {
          // A migrated curve stops on its migration: the curve's later transactions (fee claims) credit no swap.
          const atMigration = Boolean(migration) && item.signature === migration.signature
          if (!item.err && !atMigration) await credit(item.signature, item.slot)
          await client.query(`insert into stock_pool_cursors (pool, github_repo_id, venue, last_signature, last_slot, updated_at)
            values ($1, $2, 'dbc', $3, $4, now()) on conflict (pool) do update set last_signature = excluded.last_signature,
              last_slot = excluded.last_slot, updated_at = now()`, [market.pool, String(market.repoId), item.signature, String(item.slot)])
          if (atMigration) break
        }
        const cursor = (await client.query('select last_signature, last_slot::text from stock_pool_cursors where pool = $1',
          [market.pool])).rows[0] ?? null
        return { githubRepoId: market.repoId, pool: market.pool, quoteAssetId: market.quoteAssetId, status: finished(cursor) ? 'GRADUATED' : 'OK',
          discovered: discovered.length, creditedBaseUnits, creditedPartnerUnits, quarantined, eventKeys, ...(migration ? { migration: migration.signature } : {}),
          cursorBefore: previous ? { signature: previous.last_signature, slot: previous.last_slot } : null,
          cursorAfter: cursor ? { signature: cursor.last_signature, slot: cursor.last_slot } : null }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [market.pool]) }
    } finally { client.release() }
  }

  async function runOnce() {
    // Exactly the indexed markets the SOL indexer leaves out (its list has `and quote_asset_id is null`).
    const { rows } = await databasePool.query(`select github_repo_id::text as "repoId", mint, pool,
      launch_signature as "launchSignature", creator_wallet as "creatorWallet", quote_asset_id as "quoteAssetId",
      quote_mint as "quoteMint"${schedule ? ACTIVITY_COLUMNS : ''} from markets where status = 'confirmed'
      and indexed_at is not null and launch_finality = 'finalized' and quote_asset_id is not null order by github_repo_id`)
    const results = []
    const check = async market => {
      try { return await processMarket(market) }
      catch (error) { return { githubRepoId: market.repoId, pool: market.pool, quoteAssetId: market.quoteAssetId, status: 'ERROR', error: error.message } }
    }
    if (!schedule) {
      for (const market of rows) results.push(await check(market))
      return results
    }
    if (feed && rows.length) {
      // Hints only: on failure every market keeps its tier schedule.
      try {
        const woken = await feed.poll(rows.map(market => market.pool), configsWithMarkets(rows))
        for (const market of rows) if (woken.all || woken.pools.has(market.pool)) schedule.wake(market.pool)
      } catch (error) {
        if (now() - feedLoggedAt >= 600_000) { feedLoggedAt = now(); log(JSON.stringify({ stockFeeActivityFeedError: error?.message ?? 'unavailable' })) }
      }
    }
    for (const market of rows) {
      const activityAt = latest(market.indexedAt, market.curveActivityAt, market.sessionAt)
      if (!schedule.due(market.pool, { activityAt: Number.isFinite(activityAt) ? activityAt : null })) continue
      const startedAt = now()
      const result = await check(market)
      if (result.status !== 'BUSY') schedule.checked(market.pool, { startedAt, active: result.discovered > 0, error: result.status === 'ERROR' })
      results.push(result)
    }
    return results
  }
  return { runOnce, processMarket }
}
