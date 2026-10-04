import { PublicKey } from '@solana/web3.js'
import { CollectFeeMode, DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createQuoteAwareConfigResolver, readPoolConfig } from './market-config.mjs'
import { quoteOfMarket } from './quote-assets.mjs'
import { loadFinalizedTransaction } from './finalized-transaction.mjs'
import { UnparseableTradeError } from './trade-evidence.mjs'
import { StockCurveMigratedError, stockDbcSwapEvents, stockTradeRows } from './stock-trade-evidence.mjs'
import { POLICY_VERSION, assertStockPolicyConfig, splitCurveFee } from './stock-fee-policy.mjs'

// Curve fee accrual for stock-paired markets (docs/STOCK_QUOTES.md). Stock trades and fees live only in the stock ledgers:
// every finalized canonical swap becomes one stock_fee_events row (the creator and partner shares of its trading fee and the
// policy's launcher/accumulator split, src/stock-fee-policy.mjs) and one stock_trade_events row (venue 'dbc'), written in one
// database transaction and idempotent on (signature, event_index). SOL markets are refused here; they keep fee-accrual.mjs.

const MARKET = `select github_repo_id::text as "repoId", status, mint, pool, creator_wallet as "creatorWallet",
  launch_finality as "launchFinality", indexed_at as "indexedAt", quote_asset_id as "quoteAssetId", quote_mint as "quoteMint"
  from markets where github_repo_id = $1`

// The fixed config of a stock-paired curve: it quotes the market's stock through Token-2022, collects fees in the stock, and
// gives the creator the share the fee policy is built on.
export function assertStockCurveConfig(fixed, asset) {
  if (!fixed) throw Error('Stock DBC config is missing')
  if (!new PublicKey(fixed.quoteMint).equals(new PublicKey(asset.mint))) throw Error('Stock DBC config does not quote the market\'s stock')
  if (fixed.quoteTokenFlag !== 1) throw Error('Stock DBC config does not quote through Token-2022')
  if (fixed.collectFeeMode !== CollectFeeMode.QuoteToken) throw Error('Stock DBC config does not collect fees in the stock')
  assertStockPolicyConfig(fixed)
  return true
}

// One swap's fee in raw stock units: the creator share of its trading fee as the program splits it (rounded down, the partner
// gets the rest; the protocol and referral fees are not in the trading fee), then the policy's split of the two.
export function stockFeeSplit({ tradingFee, creatorPercentage }) {
  const fee = BigInt(tradingFee.toString())
  const creatorAmount = fee * BigInt(creatorPercentage) / 100n
  const partnerAmount = fee - creatorAmount
  return { creatorAmount, partnerAmount, ...splitCurveFee({ creatorAmount, partnerAmount }), policyVersion: POLICY_VERSION }
}

const FEE_FIELDS = ['github_repo_id', 'asset_id', 'quote_mint', 'pool', 'signature', 'event_index', 'slot', 'creator_amount',
  'partner_amount', 'launcher_amount', 'accumulator_amount', 'policy_version']
const TRADE_FIELDS = ['github_repo_id', 'asset_id', 'quote_mint', 'venue', 'pool', 'signature', 'event_index', 'slot', 'traded_at',
  'direction', 'quote_amount', 'base_amount', 'next_sqrt_price', 'trader']
const feeValues = row => [row.githubRepoId, row.assetId, row.quoteMint, row.pool, row.signature, row.eventIndex, row.slot,
  row.creatorAmount, row.partnerAmount, row.launcherAmount, row.accumulatorAmount, row.policyVersion].map(value => value === null ? null : String(value))
const tradeValues = row => [row.githubRepoId, row.assetId, row.quoteMint, row.venue, row.pool, row.signature, row.eventIndex, row.slot,
  row.tradedAt.toISOString(), row.direction, row.quoteAmount, row.baseAmount, row.nextSqrtPrice, row.trader].map(value => value === null ? null : String(value))
const insert = (table, fields) => `insert into ${table} (${fields.join(', ')}) values (${fields.map((_, i) => `$${i + 1}`).join(', ')})
  on conflict (signature, event_index) do nothing`
// A stored row read back in the insert's own text form, to compare field by field.
const stored = (table, fields) => `select ${fields.map(field => field === 'traded_at'
  ? `to_char(traded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as traded_at` : `${field}::text as ${field}`).join(', ')}
  from ${table} where signature = $1 and event_index = $2`

// Inserts the row, or proves the stored one is the same evidence. Returns true when the row is new.
async function insertOrMatch(client, table, fields, values, sameAs = (row, expected) => fields.every((field, i) => row[field] === expected[i])) {
  const { rowCount } = await client.query(insert(table, fields), values)
  if (rowCount === 1) return true
  const key = [values[fields.indexOf('signature')], values[fields.indexOf('event_index')]]
  const { rows: [row] } = await client.query(stored(table, fields), key)
  if (!row || !sameAs(row, values)) throw Error(`Stored ${table} row contradicts finalized chain evidence`)
  return false
}
// A fee row split under an earlier policy version stays as it was split; the chain's own amounts must still agree.
const POLICY_SPLIT = ['launcher_amount', 'accumulator_amount', 'policy_version']
const sameFee = (row, expected) => FEE_FIELDS.every((field, i) => row[field] === expected[i] ||
  (POLICY_SPLIT.includes(field) && row.policy_version !== expected[FEE_FIELDS.indexOf('policy_version')]))

export function createStockFeeAccrual({ pool: databasePool, connection, config, stockConfigs = undefined,
  dbc = new DynamicBondingCurveClient(connection, 'finalized'), loadTransaction = loadFinalizedTransaction }) {
  const resolveConfig = createQuoteAwareConfigResolver(config, undefined, stockConfigs)
  const loadMarket = async (executor, repoId) => {
    const { rows: [market] } = await executor.query(MARKET, [String(repoId)])
    if (!market || market.status !== 'confirmed' || market.indexedAt === null || market.launchFinality !== 'finalized') {
      throw Error('Repository has no indexed stock-paired market')
    }
    if (!market.quoteAssetId && !market.quoteMint) throw Error('Repository market is not stock-paired')
    return market
  }

  // The market and its curve as the chain holds them now: its stamped stock still the registry's, its registered stock config,
  // the canonical pool unchanged and not migrated, and the config the fee policy expects. Any failure is an ERROR for the market.
  // migration: the curve's proven migration ({ signature, slot }, stock_graduation_events, src/stock-graduation-monitor.mjs); with
  // it a migrated curve is accepted, only to credit the swaps it finalized up to and in the migration transaction.
  async function checkCurve(githubRepoId, executor = databasePool, migration = null) {
    const market = await loadMarket(executor, BigInt(githubRepoId))
    const asset = quoteOfMarket(market)
    const configKey = resolveConfig(market)
    const [state, fixed] = await Promise.all([dbc.state.getPool(market.pool), readPoolConfig(dbc, configKey)])
    if (!state) throw Error('Canonical stock DBC pool is missing')
    if (!state.poolState.config.equals(configKey) || !state.poolState.baseMint.equals(new PublicKey(market.mint)) ||
        !state.poolState.creator.equals(new PublicKey(market.creatorWallet))) {
      throw Error('Canonical stock DBC pool state does not match market')
    }
    if (state.poolState.isMigrated !== 0 && !migration) throw new StockCurveMigratedError()
    assertStockCurveConfig(fixed, asset)
    return { market, asset, configKey, state, fixed, migration }
  }

  const evidenceFrom = async (signature, { market, asset, configKey, fixed, migration }, allowNonSwap) => {
    const transaction = await loadTransaction(connection, signature)
    if (!transaction || !transaction.meta || transaction.meta.err) throw Error(`Trade ${signature} has no successful finalized transaction evidence`)
    // After a proven migration only the swaps it finalized count: those before it, and one bundled into the migration itself.
    if (migration && BigInt(transaction.slot) > BigInt(migration.slot)) throw new StockCurveMigratedError()
    const { events } = stockDbcSwapEvents(transaction, market, { config: configKey, quoteMint: asset.mint,
      migrationSignature: migration?.signature ?? null }, dbc)
    if (!events.length && !allowNonSwap) throw new UnparseableTradeError(`Trade ${signature} has no canonical stock DBC swap event`)
    const base = { githubRepoId: market.repoId, assetId: asset.assetId, quoteMint: asset.mint, pool: market.pool }
    // Both rows of every swap are built before anything is written: a swap that cannot become a trade row credits no fee.
    const trades = stockTradeRows(transaction, signature, events).map(row => ({ ...base, venue: 'dbc', ...row }))
    const fees = events.map(({ eventIndex, data }) => ({ ...base, signature, eventIndex, slot: BigInt(transaction.slot),
      ...stockFeeSplit({ tradingFee: data.swapResult.tradingFee, creatorPercentage: fixed.creatorTradingFeePercentage }) }))
    return { fees, trades }
  }

  // allowNonSwap: the indexer passes every finalized transaction of the pool, so one with no swap (the launch, a fee claim) is
  // expected; the strict parser has already refused anything on the pool it could not match. quoteMint: the stock a trade was
  // prepared with (the trade route), which must be the market's.
  async function recordTradeFees({ githubRepoId, signatures, allowNonSwap = false, quoteMint = null, migration = null }) {
    const repoId = BigInt(githubRepoId)
    if (!Array.isArray(signatures) || signatures.length === 0) throw Error('Finalized trade signatures required')
    const client = await databasePool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try {
        const curve = await checkCurve(repoId, client, migration)
        if (quoteMint !== null && quoteMint !== curve.asset.mint) throw Error('Trade quote mint differs from the market\'s stock')
        const evidence = await Promise.all([...new Set(signatures)].map(signature => evidenceFrom(signature, curve, allowNonSwap)))
        const fees = evidence.flatMap(item => item.fees), trades = evidence.flatMap(item => item.trades)
        let creditedBaseUnits = 0n, creditedPartnerUnits = 0n
        await client.query('begin')
        try {
          for (const row of fees) {
            if (await insertOrMatch(client, 'stock_fee_events', FEE_FIELDS, feeValues(row), sameFee)) {
              creditedBaseUnits += row.creatorAmount
              creditedPartnerUnits += row.partnerAmount
            }
          }
          for (const row of trades) await insertOrMatch(client, 'stock_trade_events', TRADE_FIELDS, tradeValues(row))
          await client.query('commit')
        } catch (error) {
          await client.query('rollback').catch(() => {})
          throw error
        }
        return { githubRepoId: repoId, assetId: curve.asset.assetId, quoteMint: curve.asset.mint, creditedBaseUnits, creditedPartnerUnits,
          observedCreatorFee: BigInt(curve.state.poolState.creatorQuoteFee.toString()),
          observedPartnerFee: BigInt(curve.state.poolState.partnerQuoteFee.toString()),
          eventKeys: fees.map(row => `${row.signature}:${row.eventIndex}`) }
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }
  return { checkCurve, recordTradeFees }
}
