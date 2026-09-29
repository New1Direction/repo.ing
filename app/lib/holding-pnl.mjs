import { holdingValueLamports } from './portfolio.mjs'

// Average-cost P&L from one wallet's own indexed swaps in one market. Trades are
// { direction, tokens, lamports } (token base units and SOL lamports as strings), in chain order.
// Only tokens explained by indexed buys have a known cost. Sells first consume that covered
// inventory; tokens sold or held beyond it (transfers, airdrops, unindexed routes) carry no cost,
// are reported as partial, and never count as profit.
export function averageCost(trades) {
  let covered = 0n, cost = 0n, realized = 0n, uncoveredSold = 0n, buys = 0
  for (const trade of trades) {
    const tokens = BigInt(trade.tokens), lamports = BigInt(trade.lamports)
    if (tokens <= 0n) continue
    if (trade.direction === 'buy') { covered += tokens; cost += lamports; buys++; continue }
    if (trade.direction !== 'sell') continue
    const matched = tokens < covered ? tokens : covered
    uncoveredSold += tokens - matched
    if (!matched) continue
    const released = cost * matched / covered
    realized += lamports * matched / tokens - released
    covered -= matched; cost -= released
  }
  return { buys, covered, cost, realized, uncoveredSold }
}

// Null when the wallet has no indexed buy here: nothing about its cost is known.
export function holdingPnl(trades, balanceBaseUnits, priceSol) {
  if (!trades?.length || balanceBaseUnits === null || balanceBaseUnits === undefined) return null
  const { buys, covered, cost, realized, uncoveredSold } = averageCost(trades)
  if (!buys) return null
  const balance = BigInt(balanceBaseUnits)
  // Tokens moved out without a sell keep the average cost; only the tokens still held are valued.
  const held = balance < covered ? balance : covered
  const basis = covered ? cost * held / covered : 0n
  const value = held ? holdingValueLamports(held.toString(), priceSol) : '0'
  const unrealized = value === null ? null : BigInt(value) - basis
  return { costBasisLamports: basis.toString(), coveredBaseUnits: held.toString(),
    uncoveredBaseUnits: (balance - held).toString(), partial: balance > held || uncoveredSold > 0n,
    unrealizedLamports: unrealized === null ? null : unrealized.toString(),
    unrealizedPercent: unrealized === null || basis <= 0n ? null : Number(unrealized * 10000n / basis) / 100,
    realizedLamports: realized.toString() }
}

// One wallet's swaps across all requested markets in one query: DBC curve trades by pool, DAMM
// trades by repository. Ordered like the chart (slot, finalized block order, signature, event).
export async function walletTrades(db, wallet, markets) {
  if (!markets.length) return new Map()
  const { rows } = await db.query(`with m as (select * from unnest($2::text[], $3::text[]) as m(repo_id, pool)),
    ev as (
      select m.repo_id, t.direction, t.slot, t.signature, t.event_index,
        case when t.direction = 'buy' then t.output_base_units else t.input_base_units end as tokens,
        case when t.direction = 'buy' then t.input_base_units else t.output_base_units end as lamports
      from trade_events t join m on t.pool = m.pool where t.trader = $1
      union all
      select m.repo_id, d.direction, d.slot, d.signature, d.event_index, d.base_amount::text, d.quote_amount::text
      from damm_trade_events d join m on d.github_repo_id = m.repo_id::bigint where d.trader = $1 and d.base_amount is not null)
    select ev.repo_id as "repoId", ev.direction, ev.tokens, ev.lamports from ev left join finalized_chart_blocks b on b.slot = ev.slot
    order by ev.repo_id, ev.slot, array_position(b.signatures, ev.signature::text) nulls last, ev.signature, ev.event_index`,
  [wallet, markets.map(m => m.repoId), markets.map(m => m.pool)])
  const grouped = new Map()
  for (const row of rows) {
    if (!grouped.has(row.repoId)) grouped.set(row.repoId, [])
    grouped.get(row.repoId).push(row)
  }
  return grouped
}

export function withHoldingPnl(markets, trades) {
  return markets.map(market => BigInt(market.balanceBaseUnits ?? '0') > 0n
    ? { ...market, pnl: holdingPnl(trades.get(market.repoId), market.balanceBaseUnits, market.priceSol) } : market)
}
