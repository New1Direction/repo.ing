import { canonicalTradeEvents } from './trade-evidence.mjs'
import { dammSwapEvents } from './damm-trades.mjs'

// Fills trade_events.trader and damm_trade_events.trader/base_amount for rows indexed before
// migration 0026 by replaying each stored signature's finalized transaction. Only rows still
// missing a value are touched; a replayed event must match the stored direction and amounts,
// otherwise the row is left untouched and reported. Resumable: progress is keyed by the smallest
// row id per signature, and filled rows drop out of the next run by themselves.
const TABLES = {
  dbc: { table: 'trade_events', missing: 'trader is null' },
  damm: { table: 'damm_trade_events', missing: '(trader is null or base_amount is null)' },
}

export async function pendingSignatures(db, kind, afterId, limit) {
  const { table, missing } = TABLES[kind]
  const { rows } = await db.query(`select signature, min(id) as id from ${table} where ${missing}
    group by signature having min(id) > $1 order by min(id) limit $2`, [afterId, limit])
  return rows.map(row => ({ signature: row.signature, id: Number(row.id) }))
}

// A transaction may swap several markets; each is decoded once, keyed by event index.
function byMarket(rows, key, decode) {
  const result = new Map()
  for (const row of rows) if (!result.has(key(row))) result.set(key(row), new Map(decode(row).map(e => [e.eventIndex, e])))
  return result
}

async function dbcUpdates(db, signature, transaction, parse) {
  const { rows } = await db.query(`select t.id, t.event_index, t.direction, t.input_base_units, t.output_base_units, m.pool, m.mint
    from trade_events t join markets m on m.pool = t.pool where t.signature = $1 and t.trader is null`, [signature])
  if (!rows.length) return { updates: [], mismatched: 0 }
  const events = byMarket(rows, row => row.pool, row => parse.dbc(transaction, { pool: row.pool, mint: row.mint, signature }))
  const updates = [], bad = []
  for (const row of rows) {
    const event = events.get(row.pool).get(row.event_index)
    const same = event && event.trader && event.direction === row.direction &&
      event.inputBaseUnits === row.input_base_units && event.outputBaseUnits === row.output_base_units
    if (same) updates.push({ table: 'trade_events', id: row.id, trader: event.trader, baseAmount: null })
    else bad.push(row.id)
  }
  return { updates, mismatched: bad.length }
}

async function dammUpdates(db, signature, transaction, parse) {
  const { rows } = await db.query(`select d.id, d.event_index, d.direction, d.quote_amount::text as quote, d.pool, m.mint
    from damm_trade_events d join markets m on m.github_repo_id = d.github_repo_id
    where d.signature = $1 and (d.trader is null or d.base_amount is null)`, [signature])
  if (!rows.length) return { updates: [], mismatched: 0 }
  const events = byMarket(rows, row => row.pool, row => parse.damm(transaction, { mint: row.mint }, row.pool))
  const updates = [], bad = []
  for (const row of rows) {
    const event = events.get(row.pool).get(row.event_index)
    const same = event && event.trader && event.direction === row.direction && event.quoteAmount === row.quote
    if (same) updates.push({ table: 'damm_trade_events', id: row.id, trader: event.trader, baseAmount: event.baseAmount })
    else bad.push(row.id)
  }
  return { updates, mismatched: bad.length }
}

async function apply(db, updates) {
  if (!updates.length) return
  // One transaction per batch: Postgres coalesces identical market-update notifications on commit.
  const client = db.connect ? await db.connect() : db
  try {
    await client.query('begin')
    for (const u of updates) {
      if (u.table === 'trade_events') await client.query('update trade_events set trader = $2 where id = $1 and trader is null', [u.id, u.trader])
      else await client.query(`update damm_trade_events set trader = coalesce(trader, $2), base_amount = coalesce(base_amount, $3::bigint)
        where id = $1 and (trader is null or base_amount is null)`, [u.id, u.trader, u.baseAmount])
    }
    await client.query('commit')
  } catch (error) { await client.query('rollback'); throw error }
  finally { if (client !== db) client.release() }
}

export async function backfillTraders({ db, loadTransaction, parse, dryRun = true, batch = 50, delayMs = 250,
  afterId = { dbc: 0, damm: 0 }, maxSignatures = Infinity, log = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const totals = { signatures: 0, rows: 0, mismatched: 0, failed: 0, cursor: { ...afterId } }
  for (const kind of ['dbc', 'damm']) {
    let cursor = afterId[kind] ?? 0
    for (;;) {
      const remaining = maxSignatures - totals.signatures
      if (remaining <= 0) break
      const page = await pendingSignatures(db, kind, cursor, Math.min(batch, remaining))
      if (!page.length) break
      const updates = []
      for (const { signature, id } of page) {
        cursor = id
        totals.signatures++
        try {
          const transaction = await loadTransaction(signature)
          if (!transaction) throw Error('TRANSACTION_UNAVAILABLE')
          const result = await (kind === 'dbc' ? dbcUpdates : dammUpdates)(db, signature, transaction, parse)
          updates.push(...result.updates)
          totals.mismatched += result.mismatched
          if (result.mismatched) log({ kind, signature, mismatched: result.mismatched })
        } catch (error) {
          totals.failed++
          log({ kind, signature, error: error.message })
        }
        if (delayMs) await sleep(delayMs)
      }
      if (!dryRun) await apply(db, updates)
      totals.rows += updates.length
      totals.cursor = { ...totals.cursor, [kind]: cursor }
      log({ kind, dryRun, batch: page.length, rows: updates.length, cursor })
    }
  }
  return totals
}

// Rate-limited or transiently failing RPC reads back off exponentially; other errors surface at once.
const TRANSIENT = /HTTP (429|5\d\d)|fetch failed|timeout|aborted|ECONNRESET/i
export function retrying(read, { attempts = 6, baseMs = 1000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return async (...args) => {
    for (let attempt = 1; ; attempt++) {
      try { return await read(...args) }
      catch (error) {
        if (attempt >= attempts || !TRANSIENT.test(error.message)) throw error
        await sleep(baseMs * 2 ** (attempt - 1))
      }
    }
  }
}

// Production parsers: the same canonical decoders the worker uses when indexing.
export function tradeParsers({ dbc, resolveConfig, dammCoder }) {
  return {
    dbc: (transaction, market) => canonicalTradeEvents(transaction, market, resolveConfig(market), dbc),
    damm: (transaction, market, pool) => dammSwapEvents(transaction, market, pool, dammCoder),
  }
}
