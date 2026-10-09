import { LIVE_BUNDLE_STATUSES } from './bundle-raise-store.mjs'

// One ticker per market (owner decision 2026-10-08): a new launch is refused when another market already uses its symbol,
// compared without case ($OMARCHY and $omarchy are the same ticker). New launches only: markets that already share a ticker
// keep it. Every market counts, stock-paired and Hugging Face model markets included.
// A ticker is held by another repository's market from its review ('prepared') through its launch ('submitted', 'ambiguous',
// 'confirmed'), and by a live Bundle raise, whose market launches with the ticker it opened with (docs/BUNDLE_LAUNCH.md).
// A review that expires or is cancelled, and a launch proven never to land, end 'failed' and free it.
// The review-time check is early feedback. The authoritative check runs again just before the launch is sent, under the
// ticker's own lock (withSymbolLock), and counts only launches already sent: of two reviews racing for one ticker, the first
// one sent keeps it.
export const SYMBOL_REVIEW_STATUSES = Object.freeze(['prepared', 'submitted', 'ambiguous', 'confirmed'])
export const SYMBOL_SENT_STATUSES = Object.freeze(['submitted', 'ambiguous', 'confirmed'])
export const SYMBOL_TAKEN = 'SYMBOL_TAKEN'

// Tickers are ASCII letters and digits only, as the launch form, the CLI and agent drafts already enforce. On the server it
// closes lookalikes the case-insensitive comparison would miss (a trailing space, a zero-width character, a Cyrillic І) and
// keeps the lock key's toLowerCase() equal to PostgreSQL's lower().
export const TICKER = /^[A-Za-z0-9]{1,10}$/
export const TICKER_MESSAGE = 'Ticker must be 1–10 letters or numbers (A–Z, 0–9).'
export const validTicker = symbol => typeof symbol === 'string' && TICKER.test(symbol)

export const symbolTakenMessage = symbol => `The ticker $${symbol} is already used by another market on repo.ing. Choose a different ticker.`

// error.code SYMBOL_TAKEN: the launch API answers it as a refusal the builder can fix and review again (src/launch-failure.mjs).
export class SymbolTakenError extends Error {
  constructor(symbol) { super(symbolTakenMessage(symbol)); this.name = 'SymbolTakenError'; this.code = SYMBOL_TAKEN }
}

// The ticker as another repository's market (in `statuses`) or live bundle spells it, or null when it is free. A market its
// maintainer has declined (an active maintainer_opt_outs row) does not hold its ticker, so a declined repository can be
// relaunched from a new repository under the same ticker (owner decision 2026-10-09; docs: repo relaunch procedure).
// db: a pg Pool or client (only query is called).
export async function symbolHolder(db, { symbol, githubRepoId, statuses = SYMBOL_REVIEW_STATUSES }) {
  const { rows: [row] } = await db.query(`select token_symbol as "takenSymbol" from markets m
      where lower(m.token_symbol) = lower($1) and m.github_repo_id <> $2::bigint and m.status = any($3::text[])
        and not exists (select 1 from maintainer_opt_outs o where o.github_repo_id = m.github_repo_id and o.withdrawn_at is null)
    union all select token_symbol from bundles
      where lower(token_symbol) = lower($1) and github_repo_id <> $2::bigint and status = any($4::text[])
    limit 1`, [String(symbol), String(githubRepoId), [...statuses], [...LIVE_BUNDLE_STATUSES]])
  return row?.takenSymbol ?? null
}

export async function assertSymbolFree(db, request) {
  const taken = await symbolHolder(db, request)
  if (taken !== null) throw new SymbolTakenError(taken)
}

// Runs fn while holding the ticker's session advisory lock on `client` (a connection, never a Pool: the lock and its release
// must use the same session). Callers already hold their repository's lock, always taken first.
export async function withSymbolLock(client, symbol, fn) {
  const key = `launch-symbol:${String(symbol).toLowerCase()}`
  await client.query('select pg_advisory_lock(hashtextextended($1,0))', [key])
  try { return await fn() }
  finally { await client.query('select pg_advisory_unlock(hashtextextended($1,0))', [key]) }
}
