import { QUOTE_REGISTRY, quoteAssetById } from './quote-assets.mjs'
import { parseMultiplier } from './scaled-ui-amount.mjs'

// The per-stock protocol accumulator (docs/STOCK_QUOTES.md, "Accumulator and settlement"): the part of every stock-paired
// market's fees that becomes permanent REPOING/<stock> liquidity, per stock, from the stock ledgers of migration 0054. Read-only.
// Every amount is in raw units of the stock (contract rule 4); the ScaledUiAmount multiplier and the USD price only label them.
//
//   credited   the accumulator's share of every recorded fee: stock_fee_events.accumulator_amount (curve swaps) plus
//              stock_damm_fee_checkpoints.accumulator_credit (the graduated pool's positions)
//   inPools    credited but not collected yet: still in the Meteora pools (with a chain read, beside what the pools hold)
//   collected  settled collections' accumulator_amount: in custody
//   owed       the launchers' credited share not paid yet (settled stock_launcher_payouts)
//   spent      settlement receipts' quote_spent: the owner's verified seed, swap and add-liquidity transactions
//   available  collected − spent: what a settlement may still use
// Nothing here moves funds; a problem is reported, never corrected.

const big = value => BigInt(value ?? 0)
const text = value => value.toString()

// A stock asset from the registry, or a refusal: SOL and unknown ids have no accumulator.
export function stockAsset(assetId, registry = QUOTE_REGISTRY) {
  const asset = quoteAssetById(assetId, registry)
  if (!asset || asset.type !== 'TOKENIZED_EQUITY') throw Object.assign(Error(`Unknown stock asset: ${assetId}`), { status: 404 })
  return asset
}

// "123456789", 8 → "1.23456789" (no grouping, no trailing zeros), for raw or shown base units.
export function decimalText(base, decimals) {
  const value = BigInt(base), sign = value < 0n ? '-' : '', abs = value < 0n ? -value : value, unit = 10n ** BigInt(decimals)
  const fraction = decimals ? (abs % unit).toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return `${sign}${abs / unit}${fraction ? `.${fraction}` : ''}`
}

// A raw amount as an operator reads it: the exact raw units, the amount wallets show (raw × the mint's ScaledUiAmount
// multiplier, truncated as Token-2022 does; null without the multiplier) and its USD value at Jupiter's price per whole raw
// token (null without a price).
export function stockAmountView(raw, asset, { multiplier = null, usdPrice = null } = {}) {
  const value = BigInt(raw)
  const scale = multiplier == null ? null : parseMultiplier(multiplier)
  const usd = Number.isFinite(usdPrice) && usdPrice > 0 ? (Number(value) / 10 ** asset.decimals * usdPrice).toFixed(2) : null
  return { raw: text(value), shown: scale ? decimalText(value * scale.num / scale.den, asset.decimals) : null, usd }
}

// Every ledger sum for one stock, read in one transaction-consistent snapshot (REPEATABLE READ), keyed by market.
export async function readAccumulatorLedger(pool, assetId) {
  const db = await pool.connect()
  try {
    await db.query('begin isolation level repeatable read read only')
    try {
      const q = async (sql) => (await db.query(sql, [assetId])).rows
      // The contributing repositories: every launched market stamped with this stock (markets_quote_asset_idx).
      const markets = await q(`select m.github_repo_id::text as "repoId", m.mint, m.pool, m.quote_mint as "quoteMint",
          m.launcher_wallet as "launcherWallet", coalesce(r.full_name, 'Repo ' || m.github_repo_id) as "fullName",
          (m.indexed_at is not null and m.launch_finality = 'finalized') as indexed
        from markets m left join repositories r on r.github_repo_id = m.github_repo_id
        where m.quote_asset_id = $1 and m.status = 'confirmed' order by m.github_repo_id`)
      // Every ledger row's market, stock and mint match by trigger (stock_ledger_market_check, migration 0054).
      const fees = await q(`select github_repo_id::text as "repoId", count(*)::int as events, sum(creator_amount)::text as creator,
          sum(partner_amount)::text as partner, sum(launcher_amount)::text as launcher, sum(accumulator_amount)::text as accumulator
        from stock_fee_events where asset_id = $1 group by github_repo_id`)
      const checkpoints = await q(`select github_repo_id::text as "repoId", side, count(*)::int as checkpoints, sum(credit)::text as credit,
          sum(launcher_credit)::text as launcher, sum(accumulator_credit)::text as accumulator
        from stock_damm_fee_checkpoints where asset_id = $1 group by github_repo_id, side`)
      const collections = await q(`select github_repo_id::text as "repoId", source, status, count(*)::int as count,
          sum(reviewed_amount)::text as reviewed, coalesce(sum(actual_amount), 0)::text as actual,
          sum(launcher_amount)::text as launcher, sum(accumulator_amount)::text as accumulator
        from stock_fee_collections where asset_id = $1 group by github_repo_id, source, status`)
      const payouts = await q(`select github_repo_id::text as "repoId", status, count(*)::int as count, sum(amount)::text as amount
        from stock_launcher_payouts where asset_id = $1 group by github_repo_id, status`)
      const receipts = await q(`select kind, count(*)::int as count, sum(quote_spent)::text as "quoteSpent",
          sum(repoing_spent)::text as "repoingSpent", sum(repoing_received)::text as "repoingReceived"
        from stock_settlement_receipts where asset_id = $1 group by kind`)
      // Settlement receipts and canonical pools have no market trigger (they are per stock): their mint is checked here.
      const receiptMints = await q(`select distinct quote_mint as "quoteMint" from stock_settlement_receipts where asset_id = $1`)
      const pools = await q(`select id::text, pool, quote_mint as "quoteMint", repoing_mint as "repoingMint", position,
          registered_at as "registeredAt" from stock_canonical_pools where asset_id = $1 and active`)
      // A transaction settles one collection or one payout; the same signature settling two would count its money twice.
      const repeated = await q(`select 'collection' as kind, signature from stock_fee_collections where asset_id = $1 and status = 'settled'
          group by signature having count(*) > 1
        union all select 'payout', signature from stock_launcher_payouts where asset_id = $1 and status = 'settled'
          group by signature having count(*) > 1`)
      await db.query('commit')
      return { markets, fees, checkpoints, collections, payouts, receipts, receiptMints, pools, repeated }
    } catch (error) { await db.query('rollback').catch(() => {}); throw error }
  } finally { db.release() }
}

const zero = () => ({ credited: 0n, launcherCredited: 0n, collected: 0n, collectedLauncher: 0n, collectedActual: 0n,
  launcherPaid: 0n, feeTotal: 0n, pendingCollections: 0, pendingPayouts: 0 })

// The accumulator of one stock from its ledger (readAccumulatorLedger) and, optionally, what the chain holds now:
// onchain is a Map repoId → { uncollected } (raw units of the stock still claimable from that market's curve and graduated
// positions, both shares) or { error }; custodyBalance is custody's stock balance (raw). units: { multiplier, usdPrice }.
export function summarizeAccumulator(asset, ledger, { onchain = null, custodyBalance = null, units = {} } = {}) {
  const problems = []
  const per = new Map(ledger.markets.map(market => [market.repoId, { ...market, ...zero() }]))
  const of = repoId => {
    if (!per.has(repoId)) { per.set(repoId, { repoId, fullName: `Repo ${repoId}`, indexed: false, ...zero() }); problems.push(`Ledger rows for market ${repoId}, which is not a launched ${asset.symbol} market`) }
    return per.get(repoId)
  }
  for (const market of ledger.markets) if (market.quoteMint !== asset.mint) problems.push(`Market ${market.repoId} is stamped with mint ${market.quoteMint}, not ${asset.mint}`)
  for (const row of ledger.fees) {
    const m = of(row.repoId)
    m.credited += big(row.accumulator); m.launcherCredited += big(row.launcher); m.feeTotal += big(row.creator) + big(row.partner)
  }
  for (const row of ledger.checkpoints) {
    const m = of(row.repoId)
    m.credited += big(row.accumulator); m.launcherCredited += big(row.launcher); m.feeTotal += big(row.credit)
  }
  for (const row of ledger.collections) {
    const m = of(row.repoId)
    if (row.status === 'settled') {
      m.collected += big(row.accumulator); m.collectedLauncher += big(row.launcher); m.collectedActual += big(row.actual)
      if (big(row.actual) !== big(row.launcher) + big(row.accumulator)) problems.push(`Settled ${row.source} collections of market ${row.repoId} do not split exactly into launcher and accumulator parts`)
    } else if (row.status === 'pending') m.pendingCollections += row.count
  }
  for (const row of ledger.payouts) {
    const m = of(row.repoId)
    if (row.status === 'settled') m.launcherPaid += big(row.amount)
    else if (row.status === 'pending') m.pendingPayouts += row.count
  }
  for (const row of ledger.receiptMints ?? []) if (row.quoteMint !== asset.mint) problems.push(`A settlement receipt names mint ${row.quoteMint}, not ${asset.mint}`)
  for (const row of ledger.pools) if (row.quoteMint !== asset.mint) problems.push(`The canonical pool row names mint ${row.quoteMint}, not ${asset.mint}`)
  for (const row of ledger.repeated ?? []) problems.push(`Signature ${row.signature} settles more than one ${row.kind}`)

  const repositories = [...per.values()].map(m => {
    const inPools = m.credited - m.collected, launcherInPools = m.launcherCredited - m.collectedLauncher
    const owed = m.launcherCredited - m.launcherPaid, ledgerUncollected = m.feeTotal - m.collectedActual
    if (inPools < 0n) problems.push(`Market ${m.repoId}: more accumulator funds collected than credited`)
    if (launcherInPools < 0n) problems.push(`Market ${m.repoId}: more launcher funds collected than credited`)
    if (owed < 0n) problems.push(`Market ${m.repoId}: launcher paid more than credited`)
    if (m.launcherPaid > m.collectedLauncher) problems.push(`Market ${m.repoId}: launcher paid before the launcher's share was collected`)
    let chain = null
    const read = onchain?.get(m.repoId)
    if (read?.error) { chain = { status: 'UNREADABLE', error: read.error }; problems.push(`Market ${m.repoId}: pools unreadable (${read.error})`) }
    else if (read) {
      const uncollected = big(read.uncollected)
      chain = { uncollected: text(uncollected), ledger: text(ledgerUncollected), status: uncollected === ledgerUncollected ? 'MATCH' : 'MISMATCH' }
      if (chain.status !== 'MATCH') problems.push(`Market ${m.repoId}: its pools hold ${uncollected} uncollected, the ledger expects ${ledgerUncollected}`)
    }
    return { repoId: m.repoId, fullName: m.fullName, mint: m.mint ?? null, pool: m.pool ?? null, indexed: Boolean(m.indexed),
      credited: text(m.credited), launcherCredited: text(m.launcherCredited), collected: text(m.collected),
      collectedLauncher: text(m.collectedLauncher), launcherPaid: text(m.launcherPaid), owed: text(owed), inPools: text(inPools),
      launcherInPools: text(launcherInPools), pendingCollections: m.pendingCollections, pendingPayouts: m.pendingPayouts,
      ...(chain ? { onchain: chain } : {}) }
  })
  const sum = key => repositories.reduce((total, r) => total + big(r[key]), 0n)
  const receipts = Object.fromEntries(['seed', 'swap', 'add_liquidity'].map(kind => {
    const row = ledger.receipts.find(r => r.kind === kind)
    return [kind, { count: row?.count ?? 0, quoteSpent: text(big(row?.quoteSpent)), repoingSpent: text(big(row?.repoingSpent)),
      repoingReceived: text(big(row?.repoingReceived)) }]
  }))
  const spent = Object.values(receipts).reduce((total, r) => total + big(r.quoteSpent), 0n)
  const collected = sum('collected'), collectedLauncher = sum('collectedLauncher'), launcherPaid = sum('launcherPaid')
  const available = collected - spent
  if (available < 0n) problems.push(`Settlement receipts spend ${spent} but only ${collected} of accumulator funds were collected`)
  if (ledger.pools.length > 1) problems.push('More than one active canonical pool')
  // What custody should hold of this stock from the ledger alone: everything collected, less launcher payouts and settlements.
  const custodyExpected = collected + collectedLauncher - launcherPaid - spent
  if (custodyBalance != null && BigInt(custodyBalance) < custodyExpected) problems.push(`Custody holds ${custodyBalance}, less than the ` +
    `${custodyExpected} the ledger expects there: funds left custody that no settlement receipt or launcher payout records`)
  const totals = { credited: text(sum('credited')), inPools: text(sum('inPools')), collected: text(collected), spent: text(spent),
    available: text(available), launcherCredited: text(sum('launcherCredited')), launcherInPools: text(sum('launcherInPools')),
    collectedLauncher: text(collectedLauncher), launcherPaid: text(launcherPaid), owedToLaunchers: text(sum('owed')),
    custodyExpected: text(custodyExpected), ...(custodyBalance != null ? { custodyBalance: text(BigInt(custodyBalance)) } : {}),
    ...(onchain ? { onchainUncollected: text(repositories.reduce((total, r) => total + big(r.onchain?.uncollected), 0n)) } : {}) }
  const display = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, stockAmountView(value, asset, units)]))
  const pool = ledger.pools[0] ?? null
  return { assetId: asset.assetId, symbol: asset.symbol, mint: asset.mint, decimals: asset.decimals,
    status: problems.length ? 'MISMATCH' : 'MATCH', problems, totals, display,
    units: { multiplier: units.multiplier ?? null, usdPrice: Number.isFinite(units.usdPrice) ? units.usdPrice : null },
    pending: { collections: repositories.reduce((n, r) => n + r.pendingCollections, 0), payouts: repositories.reduce((n, r) => n + r.pendingPayouts, 0) },
    repoing: { spent: text(Object.values(receipts).reduce((t, r) => t + big(r.repoingSpent), 0n)),
      received: text(Object.values(receipts).reduce((t, r) => t + big(r.repoingReceived), 0n)) },
    receipts, canonicalPool: pool && { pool: pool.pool, repoingMint: pool.repoingMint, position: pool.position, registeredAt: pool.registeredAt },
    repositories, contributing: repositories.filter(r => big(r.credited) > 0n || big(r.launcherCredited) > 0n).length }
}

// One stock's accumulator, read now. See summarizeAccumulator for onchain and units.
export async function stockAccumulator(pool, assetId, options = {}) {
  const asset = stockAsset(assetId)
  return summarizeAccumulator(asset, await readAccumulatorLedger(pool, asset.assetId), options)
}

// Plain-English lines for scripts and the operator panel.
export function describeAccumulator(summary) {
  const amount = key => {
    const view = summary.display[key]
    return `${view.shown ?? decimalText(view.raw, summary.decimals)} ${summary.symbol}${view.shown ? '' : ' (raw units)'}${view.usd ? ` ($${view.usd})` : ''}`
  }
  const t = summary.totals
  const lines = [`${summary.symbol} accumulator (${summary.contributing} contributing repositor${summary.contributing === 1 ? 'y' : 'ies'}, ` +
    `${summary.repositories.length} launched market${summary.repositories.length === 1 ? '' : 's'}): ${summary.status}`,
    `  credited to the accumulator so far: ${amount('credited')}`,
    `  still in the Meteora pools, not collected: ${amount('inPools')}${t.onchainUncollected !== undefined ? `; the pools hold ${amount('onchainUncollected')} uncollected for both shares` : ''}`,
    `  collected into custody: ${amount('collected')}`,
    `  spent by verified settlements: ${amount('spent')}`,
    `  available to settle: ${amount('available')}`,
    `  owed to launchers: ${amount('owedToLaunchers')} (credited ${amount('launcherCredited')}, paid ${amount('launcherPaid')})`,
    `  custody should hold ${amount('custodyExpected')}${t.custodyBalance !== undefined ? `; it holds ${amount('custodyBalance')}` : ''}`]
  if (summary.canonicalPool) lines.push(`  canonical REPOING/${summary.symbol} pool: ${summary.canonicalPool.pool}`)
  else lines.push(`  no canonical REPOING/${summary.symbol} pool registered yet`)
  for (const problem of summary.problems) lines.push(`  PROBLEM: ${problem}`)
  return lines
}
