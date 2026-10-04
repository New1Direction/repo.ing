import { StockExecutionError, STOCK_EXECUTION_ERRORS as E } from './stock-execution.mjs'

// The SQL of stock fee collections and launcher payouts (migration 0054). The database itself refuses a second pending row per
// market and source (collections) or per market (payouts), a row whose market, asset and mint do not match the market's stamp,
// and a payout to any wallet but the market's launcher wallet. A collection or payout holds the market's lock from before it
// reads its terms until it is settled: the very lock the stock reconciliation (src/stock-reconcile.mjs), the SOL reconciler and
// the SOL claims take, pg_advisory_lock(github_repo_id). So the worker, the operator script and the reconciliation never
// interleave on one market, and the reconciliation never reads a half-settled collection or payout.
const COLLECTION = `id::text, github_repo_id::text as "repoId", asset_id as "assetId", quote_mint as "quoteMint", source,
  reviewed_amount::text as "reviewedAmount", actual_amount::text as "actualAmount", launcher_amount::text as "launcherAmount",
  accumulator_amount::text as "accumulatorAmount", terms_hash as "termsHash", status, signature, signed_transaction as "signedTransaction",
  receipt, created_at as "createdAt", settled_at as "settledAt"`
const PAYOUT = `id::text, github_repo_id::text as "repoId", asset_id as "assetId", quote_mint as "quoteMint", wallet, amount::text,
  status, signature, signed_transaction as "signedTransaction", receipt, created_at as "createdAt", settled_at as "settledAt"`
const json = value => JSON.stringify(value)

// A second pending row (the partial unique indexes stock_fee_collections_one_pending / stock_launcher_payouts_one_pending). Any
// other refusal, a signature already stored on another row (migration 0056) included, is rethrown as it is: loud.
const inFlight = (error, what, index) => {
  if (error?.code === '23505' && error.constraint === index) throw new StockExecutionError(E.IN_FLIGHT, `A ${what} is already in flight for this market`)
  throw error
}

export function createStockExecutionStore(pool) {
  // work(db) runs on the locked connection, after any other holder of the market's lock has let go.
  async function withLock(repoId, work) {
    const db = await pool.connect()
    try {
      await db.query('select pg_advisory_lock($1::bigint)', [String(repoId)])
      try { return await work(db) } finally { await db.query('select pg_advisory_unlock($1::bigint)', [String(repoId)]) }
    } finally { db.release() }
  }

  return {
    withLock,
    async insertCollection(db, row) {
      try {
        const { rows: [inserted] } = await db.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,
            launcher_amount,accumulator_amount,terms_hash,status,signature,signed_transaction,receipt)
          values ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11) returning ${COLLECTION}`, [row.repoId, row.assetId, row.quoteMint, row.source,
          row.reviewedAmount, row.launcherAmount, row.accumulatorAmount, row.termsHash, row.signature, row.signedTransaction, json(row.receipt)])
        return inserted
      } catch (error) { return inFlight(error, `${row.source} collection`, 'stock_fee_collections_one_pending') }
    },
    async pendingCollections(db, { repoId = null } = {}) {
      return (await db.query(`select ${COLLECTION} from stock_fee_collections where status = 'pending'
        and ($1::bigint is null or github_repo_id = $1) order by id`, [repoId == null ? null : String(repoId)])).rows
    },
    async collection(db, id) {
      return (await db.query(`select ${COLLECTION} from stock_fee_collections where id = $1`, [String(id)])).rows[0] ?? null
    },
    // Settled in one statement, only from pending: the amount received, its parts, the receipt and the time.
    async settleCollection(db, { id, actualAmount, launcherAmount, accumulatorAmount, receipt }) {
      return (await db.query(`update stock_fee_collections set status = 'settled', actual_amount = $2, launcher_amount = $3,
          accumulator_amount = $4, receipt = $5, settled_at = now() where id = $1 and status = 'pending' returning ${COLLECTION}`,
        [String(id), actualAmount, launcherAmount, accumulatorAmount, json(receipt)])).rows[0] ?? null
    },
    async abortCollection(db, { id, receipt }) {
      return (await db.query(`update stock_fee_collections set status = 'aborted', receipt = $2 where id = $1 and status = 'pending'
        returning ${COLLECTION}`, [String(id), json(receipt)])).rows[0] ?? null
    },
    async insertPayout(db, row) {
      try {
        const { rows: [inserted] } = await db.query(`insert into stock_launcher_payouts(github_repo_id,asset_id,quote_mint,wallet,amount,status,
            signature,signed_transaction,receipt) values ($1,$2,$3,$4,$5,'pending',$6,$7,$8) returning ${PAYOUT}`,
        [row.repoId, row.assetId, row.quoteMint, row.wallet, row.amount, row.signature, row.signedTransaction, json(row.receipt)])
        return inserted
      } catch (error) { return inFlight(error, 'launcher payout', 'stock_launcher_payouts_one_pending') }
    },
    async pendingPayouts(db, { repoId = null } = {}) {
      return (await db.query(`select ${PAYOUT} from stock_launcher_payouts where status = 'pending'
        and ($1::bigint is null or github_repo_id = $1) order by id`, [repoId == null ? null : String(repoId)])).rows
    },
    async payout(db, id) {
      return (await db.query(`select ${PAYOUT} from stock_launcher_payouts where id = $1`, [String(id)])).rows[0] ?? null
    },
    async settlePayout(db, { id, receipt }) {
      return (await db.query(`update stock_launcher_payouts set status = 'settled', receipt = $2, settled_at = now()
        where id = $1 and status = 'pending' returning ${PAYOUT}`, [String(id), json(receipt)])).rows[0] ?? null
    },
    async abortPayout(db, { id, receipt }) {
      return (await db.query(`update stock_launcher_payouts set status = 'aborted', receipt = $2 where id = $1 and status = 'pending'
        returning ${PAYOUT}`, [String(id), json(receipt)])).rows[0] ?? null
    },
    // What one stock's ledgers say about its custody account, in raw units: settled collections received, settled and pending
    // payouts, and the owner's recorded settlement spends.
    async custodyLedger(db, assetId) {
      const { rows: [row] } = await db.query(`select
          coalesce((select sum(actual_amount) from stock_fee_collections where asset_id = $1 and status = 'settled'), 0)::text as collected,
          coalesce((select sum(amount) from stock_launcher_payouts where asset_id = $1 and status = 'settled'), 0)::text as paid,
          coalesce((select sum(amount) from stock_launcher_payouts where asset_id = $1 and status = 'pending'), 0)::text as pending,
          coalesce((select sum(quote_spent) from stock_settlement_receipts where asset_id = $1), 0)::text as spent`, [assetId])
      return { collected: BigInt(row.collected), paid: BigInt(row.paid), pending: BigInt(row.pending), spent: BigInt(row.spent) }
    },
    // Whether a settled collection from the graduated creator position received more than its review (a claim takes everything
    // accrued when it runs) in a slot no creator checkpoint has reached yet: the launcher's part of that excess is collected
    // before the DAMM checkpoints credit it (src/stock-graduation.mjs), so for now collected is ahead of earned.
    async collectedAheadOfCheckpoints(db, repoId) {
      const { rows: [row] } = await db.query(`select exists (select 1 from stock_fee_collections c where c.github_repo_id = $1
          and c.source = 'damm_creator' and c.status = 'settled' and c.actual_amount > c.reviewed_amount
          and (c.receipt->>'slot')::bigint > coalesce((select max(k.slot) from stock_damm_fee_checkpoints k
            where k.github_repo_id = $1 and k.side = 'creator'), -1)) as ahead`, [String(repoId)])
      return row.ahead
    },
    // Markets with a pending row, for recovery (the pending rows themselves are re-read under each market's lock).
    async pendingMarkets(kind, { repoId = null } = {}) {
      const table = kind === 'collection' ? 'stock_fee_collections' : 'stock_launcher_payouts'
      return (await pool.query(`select distinct github_repo_id::text as "repoId" from ${table} where status = 'pending'
        and ($1::bigint is null or github_repo_id = $1) order by 1`, [repoId == null ? null : String(repoId)])).rows.map(r => r.repoId)
    },
  }
}
