import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, CP_AMM_PROGRAM_ID, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { createQuoteAwareConfigResolver, readPoolConfig } from './market-config.mjs'
import { quoteAssetById, quoteOfMarket } from './quote-assets.mjs'
import { stockQuoteConfigs } from './quote-configs.mjs'
import { assertStockPolicyConfig } from './stock-fee-policy.mjs'
import { isStockPairMarket } from './stock-owner-claims.mjs'

// Reconciliation of stock-paired markets (docs/STOCK_QUOTES.md, "Reconciliation and custody"): the stock ledgers of migration
// 0054 against the chain, in raw units of the stock. The SOL reconciler (src/reconcile.mjs) keeps refusing stock markets.
//
// Per market, each fee source must equal its ledger minus settled collections:
//   curve creator   the DBC pool's creatorQuoteFee  = sum(stock_fee_events.creator_amount) - settled 'dbc_creator' collections
//   curve partner   the DBC pool's partnerQuoteFee  = sum(stock_fee_events.partner_amount) - settled 'dbc_partner' collections
//   graduated side  a DAMM position's fees earned (unclaimed + claimed) = its latest stock_damm_fee_checkpoints cumulative,
//                   and its claimed fees = settled 'damm_creator' / 'damm_partner' collections
// Per stock, the custody's Token-2022 balance = settled collections - settled launcher payouts - settlement spends.
//
// Custody: every stock fee collection (all four sources) lands in the stock's Token-2022 associated account of the DBC config's
// fee claimer, the platform partner wallet (PLATFORM_PARTNER_SECRET_KEY; H7TK… in production). Today that wallet already
// collects every SOL partner fee (src/platform-dbc-fees.mjs, src/platform-fees.mjs) and owns each graduated pool's partner
// position, while creator fees go from the platform creator signer (src/claim.mjs) straight to a builder's payout wallet.
// Stock pairs have no builder payout: launcher payouts and settlement spends leave from this account.
//
// Tolerance, as the SOL reconciler's (chainAheadOfLedger): on-chain fees above the ledger with equal claims mean trades the
// worker has not recorded yet. That, a pending collection or payout and an unavailable read are held for STOCK_RECONCILE_LAG_MS
// before they alert; anything else that does not MATCH raises a RECONCILIATION_MISMATCH operator alert at once, on the same
// graduation_alerts feed the SOL reconciliation alerts use. A custody surplus (anyone can send the stock to the custody
// account) is informational: SURPLUS, one STOCK_CUSTODY_SURPLUS alert per distinct amount. Nothing should gate on custody
// equalling the ledger; a payout or settlement checks the balance covers what it moves. Nothing here signs or sends.
export const STOCK_RECONCILE_LAG_MS = 15 * 60_000
export const STOCK_RECONCILE_INTERVAL_MS = 60_000
export const STOCK_RECONCILE_ALERT = 'RECONCILIATION_MISMATCH'
export const STOCK_CUSTODY_SURPLUS_ALERT = 'STOCK_CUSTODY_SURPLUS'

export const STOCK_RECONCILE_REASONS = Object.freeze({
  // Ledger behind the chain (held, like a fee the indexer has not recorded yet).
  GRADUATION_NOT_RECORDED: 'GRADUATION_NOT_RECORDED',
  GRADUATED_POSITIONS_NOT_RECORDED: 'GRADUATED_POSITIONS_NOT_RECORDED',
  LEDGER_MOVED: 'LEDGER_MOVED',
  // Real mismatches.
  QUOTE_ASSET_MISMATCH: 'QUOTE_ASSET_MISMATCH',
  STOCK_CONFIG_MISMATCH: 'STOCK_CONFIG_MISMATCH',
  CURVE_STATE_MISMATCH: 'CURVE_STATE_MISMATCH',
  POLICY_CONFIG_MISMATCH: 'POLICY_CONFIG_MISMATCH',
  BASE_TOKEN_FEES: 'BASE_TOKEN_FEES',
  FEE_EVENTS_OFF_POOL: 'FEE_EVENTS_OFF_POOL',
  CHECKPOINTS_OFF_POSITION: 'CHECKPOINTS_OFF_POSITION',
  CHECKPOINT_CREDITS_INCONSISTENT: 'CHECKPOINT_CREDITS_INCONSISTENT',
  COLLECTION_AMOUNT_MISSING: 'COLLECTION_AMOUNT_MISSING',
  GRADUATION_NOT_ON_CHAIN: 'GRADUATION_NOT_ON_CHAIN',
  GRADUATED_STATE_MISMATCH: 'GRADUATED_STATE_MISMATCH',
  CUSTODY_WALLET_UNKNOWN: 'CUSTODY_WALLET_UNKNOWN',
  CUSTODY_ACCOUNT_INVALID: 'CUSTODY_ACCOUNT_INVALID',
  CUSTODY_LEDGER_INCONSISTENT: 'CUSTODY_LEDGER_INCONSISTENT',
  CUSTODY_SURPLUS: 'CUSTODY_SURPLUS',
  CUSTODY_SHORTFALL: 'CUSTODY_SHORTFALL',
})
const R = STOCK_RECONCILE_REASONS
const LAG_REASONS = new Set([R.GRADUATION_NOT_RECORDED, R.GRADUATED_POSITIONS_NOT_RECORDED, R.LEDGER_MOVED])

// A read that failed on the RPC (UNAVAILABLE) versus a chain state that contradicts the market (MISMATCH with a reason).
class ReconcileStop extends Error {
  constructor(status, reason, message) { super(message); this.status = status; this.reason = reason }
}
const unavailable = message => new ReconcileStop('UNAVAILABLE', null, message)
const mismatch = (reason, message) => new ReconcileStop('MISMATCH', reason, message)

const amount = value => { try { return value == null ? null : BigInt(value) } catch { return null } }
const big = value => BigInt(value ?? 0)

// One curve fee source: the pool's unclaimed fee against what the ledger says remains. difference > 0: the chain is ahead
// (unrecorded trades). difference < 0, or more collected than earned: the ledger is ahead, which no lag explains.
export function compareCurveSide({ ledgerEarned, ledgerCollected, onchainUnclaimed }) {
  const earned = big(ledgerEarned), collected = big(ledgerCollected), onchain = big(onchainUnclaimed)
  const expectedRemaining = earned - collected, difference = onchain - expectedRemaining
  return { ledgerEarned: earned, ledgerCollected: collected, expectedRemaining, onchainUnclaimed: onchain, difference,
    status: difference === 0n ? 'MATCH' : 'MISMATCH' }
}

// One graduated position: fees earned on-chain (unclaimed + claimed) against its latest checkpoint, and fees claimed on-chain
// against settled collections. Only earned-ahead with equal claims is the chain running ahead (an unrecorded checkpoint).
export function compareGraduatedSide({ ledgerEarned, ledgerCollected, onchainEarned, onchainClaimed }) {
  const earned = big(ledgerEarned), collected = big(ledgerCollected), chainEarned = big(onchainEarned), chainClaimed = big(onchainClaimed)
  const difference = chainEarned - earned, claimedDifference = chainClaimed - collected
  return { ledgerEarned: earned, ledgerCollected: collected, onchainEarned: chainEarned, onchainClaimed: chainClaimed, difference, claimedDifference,
    status: difference === 0n && claimedDifference === 0n ? 'MATCH' : 'MISMATCH' }
}

// The custody account against its ledger. A shortfall (or a ledger that spent more than it collected) is a MISMATCH. A surplus
// is SURPLUS: stock anyone sent to the account, never lag (collections are recorded pending before they are sent).
export function compareCustody({ collected, launcherPaid, settlementSpent, balance }) {
  const expected = big(collected) - big(launcherPaid) - big(settlementSpent), onchain = big(balance), difference = onchain - expected
  const reason = expected < 0n ? R.CUSTODY_LEDGER_INCONSISTENT : difference > 0n ? R.CUSTODY_SURPLUS : difference < 0n ? R.CUSTODY_SHORTFALL : null
  const status = !reason ? 'MATCH' : reason === R.CUSTODY_SURPLUS ? 'SURPLUS' : 'MISMATCH'
  return { collected: big(collected), launcherPaid: big(launcherPaid), settlementSpent: big(settlementSpent), expected, balance: onchain, difference,
    status, ...(reason ? { reason } : {}) }
}

const curveAhead = side => { const d = amount(side?.difference), e = amount(side?.expectedRemaining); return d !== null && e !== null && d > 0n && e >= 0n }
const graduatedAhead = side => { const d = amount(side?.difference), c = amount(side?.claimedDifference); return d !== null && c === 0n && d > 0n }
const sideMatches = side => amount(side?.difference) === 0n && (side.claimedDifference === undefined || amount(side.claimedDifference) === 0n)

// A MISMATCH that only means the chain is ahead of the stock ledger (the stock counterpart of src/reconcile.mjs
// chainAheadOfLedger): every fee source matches or is ahead in the way unrecorded trades and checkpoints make it, or the
// graduation is on-chain and not recorded yet. Works on results read back from JSON too.
export function stockChainAheadOfLedger(result) {
  if (result?.status !== 'MISMATCH' || result.ledger !== 'stock') return false
  if (result.reason && !LAG_REASONS.has(result.reason)) return false
  const curve = [result.curve?.creator, result.curve?.partner].filter(Boolean)
  const graduated = [result.graduated?.creator, result.graduated?.partner].filter(Boolean)
  if (!curve.length) return false
  const ok = curve.every(side => sideMatches(side) || curveAhead(side)) && graduated.every(side => sideMatches(side) || graduatedAhead(side))
  return ok && (Boolean(result.reason) || curve.some(curveAhead) || graduated.some(graduatedAhead))
}

// States that may be a moment's lag: held for STOCK_RECONCILE_LAG_MS before they alert.
export const toleratedForNow = result => ['PENDING_REVIEW', 'UNAVAILABLE'].includes(result?.status) || stockChainAheadOfLedger(result)

const sides = (creator, partner) => ({ creator, partner })
function withStatus(base, parts, reasons) {
  const real = reasons.find(reason => !LAG_REASONS.has(reason)), lag = reasons.find(reason => LAG_REASONS.has(reason))
  const all = [parts.curve?.creator, parts.curve?.partner, parts.graduated?.creator, parts.graduated?.partner].filter(Boolean)
  if (real) return { ...base, ...parts, status: 'MISMATCH', reason: real }
  if (lag || all.some(side => side.status !== 'MATCH')) return { ...base, ...parts, status: 'MISMATCH', ...(lag ? { reason: lag } : {}) }
  return { ...base, ...parts, status: 'MATCH' }
}

const MARKET_SQL = `select github_repo_id::text as "githubRepoId", status, mint, pool, creator_wallet as "creatorWallet",
  quote_asset_id as "quoteAssetId", quote_mint as "quoteMint", indexed_at as "indexedAt", launch_finality as "launchFinality"
  from markets where github_repo_id = $1`
const settledCollections = source => `coalesce((select sum(actual_amount) from stock_fee_collections
  where github_repo_id = $1 and status = 'settled' and source = '${source}'), 0)::text`
// One statement, one snapshot. Rows on another pool or position than the market's canonical ones are counted, never summed.
const LEDGER_SQL = `with g as (select damm_pool, creator_position, partner_position from stock_graduation_events where github_repo_id = $1)
select coalesce((select sum(creator_amount) from stock_fee_events where github_repo_id = $1 and pool = $2), 0)::text as "curveCreator",
  coalesce((select sum(partner_amount) from stock_fee_events where github_repo_id = $1 and pool = $2), 0)::text as "curvePartner",
  (select count(*) from stock_fee_events where github_repo_id = $1 and pool <> $2)::int as "offPoolEvents",
  ${settledCollections('dbc_creator')} as "collectedCurveCreator", ${settledCollections('dbc_partner')} as "collectedCurvePartner",
  ${settledCollections('damm_creator')} as "collectedGraduatedCreator", ${settledCollections('damm_partner')} as "collectedGraduatedPartner",
  (select count(*) from stock_fee_collections where github_repo_id = $1 and status = 'settled' and actual_amount is null)::int as "settledWithoutAmount",
  (select count(*) from stock_fee_collections where github_repo_id = $1 and status = 'pending')::int as "pendingCollections",
  (select damm_pool from g) as "dammPool", (select creator_position from g) as "creatorPosition", (select partner_position from g) as "partnerPosition",
  (select count(*) from stock_damm_fee_checkpoints c where c.github_repo_id = $1 and (c.damm_pool is distinct from (select damm_pool from g)
    or (c.side = 'creator' and c.position is distinct from (select creator_position from g))
    or (c.side = 'partner' and c.position is distinct from (select partner_position from g))))::int as "offPositionCheckpoints",
  coalesce((select sum(credit) from stock_damm_fee_checkpoints where github_repo_id = $1 and side = 'creator'), 0)::text as "creatorCredits",
  coalesce((select sum(credit) from stock_damm_fee_checkpoints where github_repo_id = $1 and side = 'partner'), 0)::text as "partnerCredits",
  coalesce((select cumulative_earned from stock_damm_fee_checkpoints where github_repo_id = $1 and side = 'creator' order by slot desc limit 1), 0)::text as "creatorCumulative",
  coalesce((select cumulative_earned from stock_damm_fee_checkpoints where github_repo_id = $1 and side = 'partner' order by slot desc limit 1), 0)::text as "partnerCumulative"`
// Collections are what a concurrent payout or collection changes; they must read the same on both sides of the chain read.
const collectionFingerprint = row => [row.collectedCurveCreator, row.collectedCurvePartner, row.collectedGraduatedCreator,
  row.collectedGraduatedPartner, row.pendingCollections, row.settledWithoutAmount].join(':')

const CUSTODY_SQL = `select coalesce((select sum(actual_amount) from stock_fee_collections where asset_id = $1 and status = 'settled'), 0)::text as collected,
  (select count(*) from stock_fee_collections where asset_id = $1 and status = 'settled' and actual_amount is null)::int as "settledWithoutAmount",
  (select count(*) from stock_fee_collections where asset_id = $1 and status = 'pending')::int as "pendingCollections",
  coalesce((select sum(amount) from stock_launcher_payouts where asset_id = $1 and status = 'settled'), 0)::text as "launcherPaid",
  (select count(*) from stock_launcher_payouts where asset_id = $1 and status = 'pending')::int as "pendingPayouts",
  coalesce((select sum(quote_spent) from stock_settlement_receipts where asset_id = $1), 0)::text as "settlementSpent",
  ((select count(*) from stock_fee_collections where asset_id = $1 and quote_mint <> $2)
    + (select count(*) from stock_launcher_payouts where asset_id = $1 and quote_mint <> $2)
    + (select count(*) from stock_settlement_receipts where asset_id = $1 and quote_mint <> $2))::int as "otherMintRows"`

// Where a stock's fee collections land and launcher payouts and settlement spends leave from: the Token-2022 associated
// account of the stock, owned by the custody wallet (the stock config's fee claimer, header above). Off-curve owners allowed.
export function stockCustodyAccount(wallet, mint) {
  return getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(wallet), true, TOKEN_2022_PROGRAM_ID).toBase58()
}

// Chain reads, injectable for tests. Each throws ReconcileStop: UNAVAILABLE for an RPC failure, MISMATCH for contrary state.
export function createStockChainReads({ connection }) {
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const amm = new CpAmm(connection)
  async function curve({ market, configKey, quote }) {
    let state, fixed
    try { [state, fixed] = await Promise.all([dbc.state.getPool(new PublicKey(market.pool)), readPoolConfig(dbc, configKey)]) }
    catch (error) { throw unavailable(`Meteora pool read failed: ${error.message}`) }
    if (!state || !fixed) throw mismatch(R.CURVE_STATE_MISMATCH, 'Canonical stock pool or config is missing')
    const p = state.poolState
    if (!p.config.equals(configKey) || p.baseMint.toBase58() !== market.mint || p.creator.toBase58() !== market.creatorWallet ||
        new PublicKey(fixed.quoteMint).toBase58() !== quote.mint) throw mismatch(R.CURVE_STATE_MISMATCH, 'Canonical stock pool state differs from the market')
    try { assertStockPolicyConfig(fixed) } catch (error) { throw mismatch(R.POLICY_CONFIG_MISMATCH, error.message) }
    if (!p.creatorBaseFee.isZero() || !p.partnerBaseFee.isZero()) throw mismatch(R.BASE_TOKEN_FEES, 'Curve fees in the market token need separate accounting')
    return { creatorUnclaimed: BigInt(p.creatorQuoteFee.toString()), partnerUnclaimed: BigInt(p.partnerQuoteFee.toString()),
      migrated: Boolean(p.isMigrated), feeClaimer: new PublicKey(fixed.feeClaimer).toBase58() }
  }
  async function graduated({ market, quote, dammPool, creatorPosition, partnerPosition }) {
    const keys = [dammPool, creatorPosition, partnerPosition].map(key => new PublicKey(key))
    let snapshot
    try { snapshot = await connection.getMultipleAccountsInfoAndContext(keys, 'finalized') }
    catch (error) { throw unavailable(`Graduated pool read failed: ${error.message}`) }
    if (!snapshot.value.every(info => info?.owner.equals(CP_AMM_PROGRAM_ID))) throw mismatch(R.GRADUATED_STATE_MISMATCH, 'Graduated pool or position is missing')
    const coder = amm._program.coder.accounts, pool = coder.decode('pool', snapshot.value[0].data)
    if (pool.tokenAMint.toBase58() !== market.mint || pool.tokenBMint.toBase58() !== quote.mint || pool.collectFeeMode !== 1) {
      throw mismatch(R.GRADUATED_STATE_MISMATCH, 'Graduated pool differs from the market or collects fees in the market token')
    }
    const position = info => {
      const state = coder.decode('position', info.data)
      if (!state.pool.equals(keys[0])) throw mismatch(R.GRADUATED_STATE_MISMATCH, 'Graduated position is in another pool')
      const fees = getUnClaimLpFee(pool, state)
      if (!fees.feeTokenA.isZero() || !state.metrics.totalClaimedAFee.isZero()) throw mismatch(R.BASE_TOKEN_FEES, 'Graduated fees in the market token need separate accounting')
      const unclaimed = BigInt(fees.feeTokenB.toString()), claimed = BigInt(state.metrics.totalClaimedBFee.toString())
      return { unclaimed, claimed, earned: unclaimed + claimed }
    }
    return { slot: snapshot.context.slot, creator: position(snapshot.value[1]), partner: position(snapshot.value[2]) }
  }
  // The stock config's fee claimer: the custody wallet (header above).
  async function custodyWallet({ asset, configKey }) {
    let fixed
    try { fixed = await readPoolConfig(dbc, configKey) } catch (error) { throw unavailable(`Stock config read failed: ${error.message}`) }
    if (!fixed || new PublicKey(fixed.quoteMint).toBase58() !== asset.mint) throw mismatch(R.CUSTODY_WALLET_UNKNOWN, 'Stock config is missing or quotes another mint')
    return new PublicKey(fixed.feeClaimer).toBase58()
  }
  async function custodyBalance({ asset, wallet }) {
    const mint = new PublicKey(asset.mint), owner = new PublicKey(wallet), account = new PublicKey(stockCustodyAccount(wallet, asset.mint))
    let info
    try { info = await connection.getAccountInfo(account, 'finalized') } catch (error) { throw unavailable(`Custody account read failed: ${error.message}`) }
    if (!info) return { account: account.toBase58(), balance: 0n, frozen: false }
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw mismatch(R.CUSTODY_ACCOUNT_INVALID, 'Custody account is not a Token-2022 account')
    const token = unpackAccount(account, info, TOKEN_2022_PROGRAM_ID)
    if (!token.mint.equals(mint) || !token.owner.equals(owner)) throw mismatch(R.CUSTODY_ACCOUNT_INVALID, 'Custody account holds another mint or owner')
    return { account: account.toBase58(), balance: token.amount, frozen: token.isFrozen }
  }
  return { curve, graduated, custodyWallet, custodyBalance }
}

// config: the SOL DBC config (DBC_CONFIG), which the quote-aware resolver needs; stockConfigs: STOCK_QUOTE_CONFIGS as a Map.
export function createStockReconciler({ pool, connection, config, stockConfigs = () => stockQuoteConfigs(), reads = createStockChainReads({ connection }) }) {
  const resolveConfig = createQuoteAwareConfigResolver(config, process.env.DBC_LEGACY_CONFIGS ?? '', stockConfigs)
  const configs = () => typeof stockConfigs === 'function' ? stockConfigs() : stockConfigs

  async function marketResult(client, market) {
    const base = { ledger: 'stock', githubRepoId: market.githubRepoId, assetId: market.quoteAssetId, quoteMint: market.quoteMint, pool: market.pool,
      curve: null, graduated: null }
    let quote, configKey
    try { quote = quoteOfMarket(market) } catch (error) { return { ...base, status: 'MISMATCH', reason: R.QUOTE_ASSET_MISMATCH, detail: error.message } }
    try { configKey = resolveConfig(market) } catch (error) { return { ...base, status: 'MISMATCH', reason: R.STOCK_CONFIG_MISMATCH, detail: error.message } }
    const { rows: [ledger] } = await client.query(LEDGER_SQL, [market.githubRepoId, market.pool])
    if (ledger.pendingCollections > 0) return { ...base, status: 'PENDING_REVIEW', reason: `${ledger.pendingCollections} pending fee collection(s)` }
    const reasons = []
    if (ledger.settledWithoutAmount > 0) reasons.push(R.COLLECTION_AMOUNT_MISSING)
    if (ledger.offPoolEvents > 0) reasons.push(R.FEE_EVENTS_OFF_POOL)
    if (ledger.offPositionCheckpoints > 0) reasons.push(R.CHECKPOINTS_OFF_POSITION)
    if (big(ledger.creatorCredits) !== big(ledger.creatorCumulative) || big(ledger.partnerCredits) !== big(ledger.partnerCumulative)) {
      reasons.push(R.CHECKPOINT_CREDITS_INCONSISTENT)
    }
    let curve, graduated = null
    try {
      curve = await reads.curve({ market, configKey, quote })
      if (curve.migrated && !ledger.dammPool) reasons.push(R.GRADUATION_NOT_RECORDED)
      else if (!curve.migrated && ledger.dammPool) reasons.push(R.GRADUATION_NOT_ON_CHAIN)
      else if (ledger.dammPool && (!ledger.creatorPosition || !ledger.partnerPosition)) reasons.push(R.GRADUATED_POSITIONS_NOT_RECORDED)
      else if (ledger.dammPool) graduated = await reads.graduated({ market, quote, dammPool: ledger.dammPool,
        creatorPosition: ledger.creatorPosition, partnerPosition: ledger.partnerPosition })
    } catch (error) {
      if (!(error instanceof ReconcileStop)) throw error
      return { ...base, status: error.status, ...(error.reason ? { reason: error.reason } : {}), detail: error.message }
    }
    const parts = { curve: sides(
      compareCurveSide({ ledgerEarned: ledger.curveCreator, ledgerCollected: ledger.collectedCurveCreator, onchainUnclaimed: curve.creatorUnclaimed }),
      compareCurveSide({ ledgerEarned: ledger.curvePartner, ledgerCollected: ledger.collectedCurvePartner, onchainUnclaimed: curve.partnerUnclaimed })),
    graduated: graduated && { pool: ledger.dammPool, slot: graduated.slot, ...sides(
      compareGraduatedSide({ ledgerEarned: ledger.creatorCumulative, ledgerCollected: ledger.collectedGraduatedCreator,
        onchainEarned: graduated.creator.earned, onchainClaimed: graduated.creator.claimed }),
      compareGraduatedSide({ ledgerEarned: ledger.partnerCumulative, ledgerCollected: ledger.collectedGraduatedPartner,
        onchainEarned: graduated.partner.earned, onchainClaimed: graduated.partner.claimed })) } }
    // A collection that started or settled while the chain was read leaves this snapshot inconclusive, not mismatched.
    const { rows: [after] } = await client.query(LEDGER_SQL, [market.githubRepoId, market.pool])
    if (collectionFingerprint(after) !== collectionFingerprint(ledger)) return { ...base, ...parts, status: 'PENDING_REVIEW', reason: R.LEDGER_MOVED }
    return withStatus(base, parts, reasons)
  }

  // Same lock as the SOL reconciler and claims: a stock collection must hold it while it is sent and settled.
  const reconcile = async githubRepoId => {
    const repoId = BigInt(githubRepoId)
    if (repoId <= 0n) throw new Error('GitHub repository ID must be positive')
    const client = await pool.connect()
    try {
      await client.query('select pg_advisory_lock($1::bigint)', [repoId.toString()])
      try {
        const { rows: [market] } = await client.query(MARKET_SQL, [repoId.toString()])
        if (!market || market.status !== 'confirmed' || !market.indexedAt || market.launchFinality !== 'finalized') {
          throw new Error('Repository has no indexed canonical market')
        }
        if (!isStockPairMarket(market)) throw new Error('A SOL market is reconciled by src/reconcile.mjs')
        return await marketResult(client, market)
      } finally { await client.query('select pg_advisory_unlock($1::bigint)', [repoId.toString()]) }
    } finally { client.release() }
  }

  const reconcileStockCustody = async assetId => {
    const asset = quoteAssetById(assetId)
    if (!asset || asset.type !== 'TOKENIZED_EQUITY') throw new Error('Unknown stock asset')
    const base = { ledger: 'stock-custody', assetId: asset.assetId, quoteMint: asset.mint, wallet: null, account: null }
    const configKey = configs().get(asset.assetId)
    if (!configKey) return { ...base, status: 'MISMATCH', reason: R.CUSTODY_WALLET_UNKNOWN, detail: 'Stock has no registered config' }
    const { rows: [ledger] } = await pool.query(CUSTODY_SQL, [asset.assetId, asset.mint])
    const pending = { collections: ledger.pendingCollections, payouts: ledger.pendingPayouts }
    if (pending.collections > 0 || pending.payouts > 0) return { ...base, status: 'PENDING_REVIEW', pending }
    if (ledger.settledWithoutAmount > 0) return { ...base, status: 'MISMATCH', reason: R.COLLECTION_AMOUNT_MISSING }
    if (ledger.otherMintRows > 0) return { ...base, status: 'MISMATCH', reason: R.CUSTODY_LEDGER_INCONSISTENT, detail: 'Stock ledger rows name another mint' }
    let wallet, read
    try {
      wallet = await reads.custodyWallet({ asset, configKey })
      read = await reads.custodyBalance({ asset, wallet })
    } catch (error) {
      if (!(error instanceof ReconcileStop)) throw error
      return { ...base, wallet: wallet ?? null, status: error.status, ...(error.reason ? { reason: error.reason } : {}), detail: error.message }
    }
    const { rows: [after] } = await pool.query(CUSTODY_SQL, [asset.assetId, asset.mint])
    const moved = ['collected', 'launcherPaid', 'settlementSpent', 'pendingCollections', 'pendingPayouts'].some(key => String(after[key]) !== String(ledger[key]))
    const compared = compareCustody({ collected: ledger.collected, launcherPaid: ledger.launcherPaid, settlementSpent: ledger.settlementSpent, balance: read.balance })
    const result = { ...base, wallet, account: read.account, frozen: read.frozen, ...compared }
    return moved ? { ...result, status: 'PENDING_REVIEW', reason: R.LEDGER_MOVED } : result
  }

  return { reconcile, reconcileStockCustody }
}

// Stable JSON (BigInt as text) and its hash: one alert per distinct state, as the SOL monitor keys its alerts.
export const reconcileJSON = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item)
const hash = value => createHash('sha256').update(reconcileJSON(value)).digest('hex')

// An operator alert on the graduation_alerts feed (the operations health and graduation panels), deduplicated by event key.
export async function emitStockReconcileAlert(db, { repoId = null, key, detail, kind = STOCK_RECONCILE_ALERT }) {
  const { rows } = await db.query(`insert into graduation_alerts(event_key,github_repo_id,kind,detail) values($1,$2,$3,$4)
    on conflict(event_key) do nothing returning id, kind, github_repo_id::text as "repoId", created_at as "createdAt"`,
  [key, repoId, kind, reconcileJSON(detail)])
  return rows[0] ?? null
}

const STOCK_MARKETS_SQL = `select github_repo_id::text as "repoId", quote_asset_id as "assetId" from markets
  where quote_asset_id is not null and status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized' order by github_repo_id`
const SETTLED_ASSETS_SQL = 'select distinct asset_id as "assetId" from stock_settlement_receipts'

// The kind of a mismatch, without its amounts: which fee sources differ and which way. A persistent mismatch keeps its kind
// while trades move the amounts, so it alerts once, not on every run.
const sign = value => { const n = amount(value); return n === null ? '?' : n > 0n ? '+' : n < 0n ? '-' : '0' }
export function mismatchKind(result) {
  const parts = [['cc', result.curve?.creator], ['cp', result.curve?.partner], ['gc', result.graduated?.creator], ['gp', result.graduated?.partner]]
    .filter(([, side]) => side).map(([name, side]) => `${name}${sign(side.difference)}${side.claimedDifference === undefined ? '' : sign(side.claimedDifference)}`)
  return [result.status, result.reason ?? '', ...parts].join(':')
}

// The worker job: every indexed stock-paired market, then every stock's custody. Per market or stock, an episode starts when
// its state stops matching: a lagging state (toleratedForNow) alerts once if it lasts lagMs, a real mismatch alerts at once,
// and a mismatch of another kind starts a new episode. A MATCH ends it. Episodes live in this process. A market that cannot be
// reconciled at all is an ERROR and alerts: it is never skipped.
export function createStockReconcileRunner({ pool, connection, config, now = Date.now, lagMs = STOCK_RECONCILE_LAG_MS,
  reconciler = createStockReconciler({ pool, connection, config }) }) {
  const episodes = new Map()
  let sequence = 0
  async function settle(key, repoId, result) {
    if (result.status === 'MATCH' || result.status === 'SURPLUS') episodes.delete(key)
    if (result.status === 'MATCH') return null
    // Informational, once per distinct surplus amount, whatever this process has seen before.
    if (result.status === 'SURPLUS') return emitStockReconcileAlert(pool, { kind: STOCK_CUSTODY_SURPLUS_ALERT,
      key: `protocol:${STOCK_CUSTODY_SURPLUS_ALERT}:${result.assetId}:${result.difference}`,
      detail: { ledger: result.ledger, code: result.reason, assetId: result.assetId, surplus: result.difference, result } })
    const lagging = toleratedForNow(result), kind = lagging ? 'lagging' : mismatchKind(result)
    let episode = episodes.get(key)
    if (episode?.kind !== kind) episodes.set(key, episode = { kind, first: now(), id: ++sequence })
    if (lagging && now() - episode.first < lagMs) return null
    return emitStockReconcileAlert(pool, { repoId, key: `${repoId ?? 'protocol'}:${STOCK_RECONCILE_ALERT}:stock:${key}:${hash([kind, episode.first, episode.id])}`,
      detail: { ledger: result.ledger, code: result.reason ?? result.status, status: result.status, reason: result.reason ?? null, lagging,
        since: new Date(episode.first).toISOString(), result } })
  }
  const summary = (result, alert) => ({ status: result.status, ...(result.reason ? { reason: result.reason } : {}),
    ...(stockChainAheadOfLedger(result) ? { chainAhead: true } : {}), alert: alert?.id ?? null })
  async function runOnce() {
    const [{ rows: markets }, { rows: settled }] = await Promise.all([pool.query(STOCK_MARKETS_SQL), pool.query(SETTLED_ASSETS_SQL)])
    const out = { markets: [], custody: [] }
    for (const market of markets) {
      let result
      try { result = await reconciler.reconcile(market.repoId) }
      catch (error) { result = { ledger: 'stock', githubRepoId: market.repoId, assetId: market.assetId, status: 'ERROR', reason: String(error?.message ?? error).slice(0, 200) } }
      out.markets.push({ repoId: market.repoId, assetId: market.assetId, ...summary(result, await settle(`market:${market.repoId}`, market.repoId, result)) })
    }
    for (const assetId of [...new Set([...markets, ...settled].map(row => row.assetId))].sort()) {
      let result
      try { result = await reconciler.reconcileStockCustody(assetId) }
      catch (error) { result = { ledger: 'stock-custody', assetId, status: 'ERROR', reason: String(error?.message ?? error).slice(0, 200) } }
      out.custody.push({ assetId, ...summary(result, await settle(`custody:${assetId}`, null, result)) })
    }
    return out
  }
  return { runOnce }
}
