// "Backed by": wallets with a net positive position from swaps indexed on repo.ing (DBC curve trades by pool,
// post-graduation DAMM trades by repository — the same sources as per-holding P&L). Public on-chain data only.
// Tokens moved by transfer, airdrop or an unindexed route are not counted; this is not the on-chain holder list.
export const EARLY_BACKERS = 10
export const TOP_BACKERS = 10

// Wallets repo.ing operates, or the repository's own payout wallet. They are disclosed with a label instead of being
// hidden, but never counted as community backers and never ranked as early backers.
export const LABEL_KINDS = Object.freeze(['team', 'buyback', 'platform', 'builder'])

const toBigInt = value => {
  try { return BigInt(value ?? 0) } catch { return null }
}

// One indexed trader row (see readBackerRows) → a position, or null when the row is malformed.
export function backerPosition(row) {
  const bought = toBigInt(row?.boughtBaseUnits), sold = toBigInt(row?.soldBaseUnits), spent = toBigInt(row?.spentLamports)
  if (typeof row?.wallet !== 'string' || !row.wallet || bought === null || sold === null || spent === null) return null
  const firstBuyAt = row.firstBuyAt ? new Date(row.firstBuyAt) : null
  return { wallet: row.wallet, bought, sold, net: bought - sold, spent, buys: Number(row.buys) || 0,
    firstBuyAt: firstBuyAt && Number.isFinite(firstBuyAt.getTime()) ? firstBuyAt : null,
    firstBuySlot: toBigInt(row.firstBuySlot) }
}

const compareBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
// Chain order of each wallet's first buy: slot, then block time, then wallet (a stable, public tie-break).
function byFirstBuy(a, b) {
  const slot = compareBig(a.firstBuySlot ?? 0n, b.firstBuySlot ?? 0n)
  if (slot) return slot
  const time = (a.firstBuyAt?.getTime() ?? 0) - (b.firstBuyAt?.getTime() ?? 0)
  return time || a.wallet.localeCompare(b.wallet)
}
// Largest net position first; equal positions go to whoever bought first.
const byPosition = (a, b) => compareBig(b.net, a.net) || byFirstBuy(a, b)

const publicPosition = (position, extra) => ({ wallet: position.wallet, netBaseUnits: position.net.toString(),
  spentLamports: position.spent.toString(), firstBuyAt: position.firstBuyAt?.toISOString() ?? null, ...extra })

// rows: per-wallet sums from readBackerRows. labels: Map wallet → { kind, label } for platform and builder wallets.
// Early rank is fixed by the first `early` community buyers in chain order, even if some later sold: selling never
// promotes a later buyer, and a rank is shown only while that wallet still backs the repository.
export function summarizeBackers(rows, { labels = new Map(), early = EARLY_BACKERS, limit = TOP_BACKERS } = {}) {
  const positions = (rows ?? []).map(backerPosition).filter(position => position && position.buys > 0)
  const community = positions.filter(position => !labels.has(position.wallet))
  const earlyRank = new Map([...community].sort(byFirstBuy).slice(0, early).map((position, index) => [position.wallet, index + 1]))
  const backers = community.filter(position => position.net > 0n).sort(byPosition)
  const disclosed = positions.filter(position => labels.has(position.wallet) && position.net > 0n).sort(byPosition)
    .map(position => publicPosition(position, { kind: labels.get(position.wallet).kind, label: labels.get(position.wallet).label }))
  return {
    count: backers.length,
    top: backers.slice(0, limit).map(position => publicPosition(position, { earlyRank: earlyRank.get(position.wallet) ?? null })),
    disclosed,
    early,
  }
}

// Per-wallet sums over every attributed swap in one market. Rows indexed before trader attribution (trader null)
// are skipped until scripts/backfill-trade-traders.mjs fills them. DAMM rows need base_amount, as in holding P&L.
export async function readBackerRows(db, { pool, repoId }) {
  const { rows } = await db.query(`with ev as (
      select trader, direction, slot, traded_at,
        (case when direction = 'buy' then output_base_units else input_base_units end)::numeric as tokens,
        (case when direction = 'buy' then input_base_units else output_base_units end)::numeric as lamports
      from trade_events where pool = $1 and trader is not null
      union all
      select trader, direction, slot, traded_at, base_amount::numeric, quote_amount::numeric
      from damm_trade_events where github_repo_id = $2::bigint and trader is not null and base_amount is not null)
    select trader as wallet,
      coalesce(sum(tokens) filter (where direction = 'buy'), 0)::text as "boughtBaseUnits",
      coalesce(sum(tokens) filter (where direction = 'sell'), 0)::text as "soldBaseUnits",
      coalesce(sum(lamports) filter (where direction = 'buy'), 0)::text as "spentLamports",
      count(*) filter (where direction = 'buy')::int as buys,
      min(traded_at) filter (where direction = 'buy') as "firstBuyAt",
      min(slot) filter (where direction = 'buy')::text as "firstBuySlot"
    from ev group by trader`, [pool, repoId == null ? null : String(repoId)])
  return rows
}

// Public holder notes (hidden ones excluded) written by the given wallets for this mint.
export async function readBackerNotes(db, mint, wallets) {
  if (!wallets.length) return new Map()
  const { rows } = await db.query('select wallet, body from holder_notes where mint = $1 and wallet = any($2::text[]) and hidden_at is null', [mint, wallets])
  return new Map(rows.map(row => [row.wallet, row.body]))
}
