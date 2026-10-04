import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { STOCK_CUSTODY_SURPLUS_ALERT, STOCK_RECONCILE_ALERT, STOCK_RECONCILE_LAG_MS, STOCK_RECONCILE_REASONS as R, compareCurveSide, compareCustody, compareGraduatedSide,
  createStockChainReads, createStockReconcileRunner, createStockReconciler, mismatchKind, reconcileJSON, stockChainAheadOfLedger,
  stockCustodyAccount, toleratedForNow } from '../src/stock-reconcile.mjs'
import { chainAheadOfLedger } from '../src/reconcile.mjs'
import { METAX_MINT, curveConfig, curvePool, dammPool, dammPosition, fakeConnection, key, stockMarket, token2022Account } from './fixtures/stock-chain.mjs'

// src/stock-reconcile.mjs without services: the comparisons, the chain-ahead tolerance (as the SOL reconciler's), the
// reconciler over fake ledgers and chain accounts encoded with the programs' own coders, and the worker runner raising a
// RECONCILIATION_MISMATCH operator alert for a real mismatch.

test('a curve fee source matches, runs ahead (unrecorded trades) or is behind the ledger', () => {
  assert.equal(compareCurveSide({ ledgerEarned: '1000', ledgerCollected: '400', onchainUnclaimed: 600n }).status, 'MATCH')
  const ahead = compareCurveSide({ ledgerEarned: 1000n, ledgerCollected: 400n, onchainUnclaimed: 650n })
  assert.deepEqual([ahead.status, ahead.expectedRemaining, ahead.difference], ['MISMATCH', 600n, 50n])
  assert.equal(compareCurveSide({ ledgerEarned: 1000n, ledgerCollected: 400n, onchainUnclaimed: 590n }).difference, -10n)
})

test('a graduated position is behind only when its earned fees run ahead with the same claims', () => {
  assert.equal(compareGraduatedSide({ ledgerEarned: 70n, ledgerCollected: 20n, onchainEarned: 70n, onchainClaimed: 20n }).status, 'MATCH')
  const ahead = compareGraduatedSide({ ledgerEarned: 60n, ledgerCollected: 20n, onchainEarned: 70n, onchainClaimed: 20n })
  assert.deepEqual([ahead.status, ahead.difference, ahead.claimedDifference], ['MISMATCH', 10n, 0n])
  assert.equal(compareGraduatedSide({ ledgerEarned: 70n, ledgerCollected: 10n, onchainEarned: 70n, onchainClaimed: 20n }).claimedDifference, 10n)
})

test('custody is collections minus launcher payouts minus settlement spends, exactly', () => {
  assert.deepEqual(compareCustody({ collected: 1000n, launcherPaid: 300n, settlementSpent: 200n, balance: 500n }),
    { collected: 1000n, launcherPaid: 300n, settlementSpent: 200n, expected: 500n, balance: 500n, difference: 0n, status: 'MATCH' })
  const surplus = compareCustody({ collected: 1000n, launcherPaid: 300n, settlementSpent: 200n, balance: 501n })
  assert.deepEqual([surplus.status, surplus.reason, surplus.difference], ['SURPLUS', R.CUSTODY_SURPLUS, 1n], 'stock sent to the account unasked: informational')
  const shortfall = compareCustody({ collected: 1000n, launcherPaid: 300n, settlementSpent: 200n, balance: 499n })
  assert.deepEqual([shortfall.status, shortfall.reason], ['MISMATCH', R.CUSTODY_SHORTFALL])
  assert.equal(compareCustody({ collected: 100n, launcherPaid: 300n, settlementSpent: 0n, balance: 0n }).reason, R.CUSTODY_LEDGER_INCONSISTENT)
})

const side = (difference, extra = {}) => ({ difference, expectedRemaining: 100n, status: difference === 0n ? 'MATCH' : 'MISMATCH', ...extra })
const stock = (over = {}) => ({ ledger: 'stock', status: 'MISMATCH', curve: { creator: side(0n), partner: side(0n) }, graduated: null, ...over })

test('chain ahead of the stock ledger is tolerated exactly where the SOL reconciler tolerates it', () => {
  assert.equal(stockChainAheadOfLedger(stock({ curve: { creator: side(12n), partner: side(0n) } })), true, 'unrecorded curve trades')
  assert.equal(stockChainAheadOfLedger(stock({ curve: { creator: side(12n), partner: side(3n) } })), true)
  assert.equal(stockChainAheadOfLedger(stock({ curve: { creator: side(12n), partner: side(-1n) } })), false, 'a ledger ahead on any source')
  assert.equal(stockChainAheadOfLedger(stock({ curve: { creator: side(5n, { expectedRemaining: -5n }), partner: side(0n) } })), false, 'more collected than earned')
  assert.equal(stockChainAheadOfLedger(stock()), false, 'nothing ahead is not lag')
  assert.equal(stockChainAheadOfLedger(stock({ reason: R.GRADUATION_NOT_RECORDED })), true, 'graduation on-chain, not recorded yet')
  assert.equal(stockChainAheadOfLedger(stock({ reason: R.FEE_EVENTS_OFF_POOL, curve: { creator: side(12n), partner: side(0n) } })), false)
  const graduated = (difference, claimedDifference) => ({ pool: 'Pool', creator: { difference, claimedDifference }, partner: { difference: 0n, claimedDifference: 0n } })
  assert.equal(stockChainAheadOfLedger(stock({ graduated: graduated(9n, 0n) })), true, 'an unrecorded checkpoint')
  assert.equal(stockChainAheadOfLedger(stock({ graduated: graduated(9n, 1n) })), false, 'a claim the ledger does not have')
  assert.equal(stockChainAheadOfLedger(stock({ graduated: graduated(-9n, 0n) })), false)
  // Read back from an alert's JSON: amounts are strings.
  assert.equal(stockChainAheadOfLedger(JSON.parse(reconcileJSON(stock({ curve: { creator: side(12n), partner: side(0n) } })))), true)
  for (const status of ['MATCH', 'PENDING_REVIEW', 'UNAVAILABLE', 'ERROR']) assert.equal(stockChainAheadOfLedger(stock({ status, curve: { creator: side(12n), partner: side(0n) } })), false, status)
  assert.equal(stockChainAheadOfLedger({ ...stock({ curve: { creator: side(12n), partner: side(0n) } }), ledger: undefined }), false, 'a SOL result is never read as stock')
  // The SOL rule on the same shape: a creator fee ahead with no partner difference.
  assert.equal(chainAheadOfLedger({ status: 'MISMATCH', difference: 12n, platform: null }), true)
  for (const status of ['PENDING_REVIEW', 'UNAVAILABLE']) assert.equal(toleratedForNow({ status }), true, status)
  assert.equal(toleratedForNow({ status: 'ERROR' }), false)
})

// --- The reconciler over a fake PostgreSQL client and encoded chain accounts.
const ledgerRow = (over = {}) => ({ curveCreator: '1000', curvePartner: '400', offPoolEvents: 0, collectedCurveCreator: '0', collectedCurvePartner: '0',
  collectedGraduatedCreator: '0', collectedGraduatedPartner: '0', settledWithoutAmount: 0, pendingCollections: 0, dammPool: null, creatorPosition: null,
  partnerPosition: null, offPositionCheckpoints: 0, creatorCredits: '0', partnerCredits: '0', creatorCumulative: '0', partnerCumulative: '0', ...over })
const custodyRow = (over = {}) => ({ collected: '1500', settledWithoutAmount: 0, pendingCollections: 0, launcherPaid: '300', pendingPayouts: 0,
  settlementSpent: '200', otherMintRows: 0, ...over })

function fakePool({ market, ledgers = [ledgerRow()], custody = [custodyRow()] }) {
  const queries = []
  const next = rows => rows.length > 1 ? rows.shift() : rows[0]
  const query = async (sql, params) => {
    queries.push(sql)
    if (/pg_advisory_(un)?lock/.test(sql)) return { rows: [] }
    if (/from markets where github_repo_id = \$1/.test(sql)) return { rows: market && params[0] === market.githubRepoId ? [market] : [] }
    if (/^with g as/.test(sql)) return { rows: [next(ledgers)] }
    if (/from stock_settlement_receipts where asset_id = \$1/.test(sql)) return { rows: [next(custody)] }
    throw Error(`unexpected query: ${sql.slice(0, 80)}`)
  }
  return { queries, query, connect: async () => ({ query, release() {} }) }
}

function chain(market, { creatorQuoteFee = 1000n, partnerQuoteFee = 400n, migrated = false, graduated = null, custodyAmount = 1000n, fail } = {}) {
  const feeClaimer = key()
  const accounts = new Map([[market.pool, curvePool({ config: market.config, creator: market.creatorWallet, baseMint: market.mint, creatorQuoteFee, partnerQuoteFee, migrated })],
    [market.config, curveConfig({ quoteMint: METAX_MINT, feeClaimer })]])
  if (graduated) {
    accounts.set(graduated.pool, dammPool({ tokenAMint: market.mint, tokenBMint: METAX_MINT }))
    accounts.set(graduated.creatorPosition, dammPosition({ pool: graduated.pool, ...graduated.creator }))
    accounts.set(graduated.partnerPosition, dammPosition({ pool: graduated.pool, ...graduated.partner }))
  }
  const custody = getAssociatedTokenAddressSync(new PublicKey(METAX_MINT), new PublicKey(feeClaimer), true, TOKEN_2022_PROGRAM_ID).toBase58()
  if (custodyAmount !== null) accounts.set(custody, token2022Account({ mint: METAX_MINT, owner: feeClaimer, amount: custodyAmount }))
  return { connection: fakeConnection(accounts, { fail }), feeClaimer, custody }
}

function reconciler(market, pool, connection) {
  return createStockReconciler({ pool, config: key(), stockConfigs: new Map([['meta-xstock', new PublicKey(market.config)]]),
    reads: createStockChainReads({ connection }) })
}

test('a stock market whose curve fees equal its ledger minus settled collections reconciles to MATCH', async () => {
  const market = stockMarket(), { connection } = chain(market, { creatorQuoteFee: 600n, partnerQuoteFee: 150n })
  const pool = fakePool({ market, ledgers: [ledgerRow({ collectedCurveCreator: '400', collectedCurvePartner: '250' })] })
  const result = await reconciler(market, pool, connection).reconcile(market.githubRepoId)
  assert.equal(result.status, 'MATCH')
  assert.deepEqual([result.curve.creator.expectedRemaining, result.curve.partner.expectedRemaining], [600n, 150n])
  assert.equal(result.graduated, null)
  assert.ok(pool.queries.some(sql => /pg_advisory_lock/.test(sql)), 'under the repository lock, as SOL claims and reconciles')
})

test('fees the indexer has not recorded yet read MISMATCH and count as chain ahead; a ledger ahead of the chain does not', async () => {
  const market = stockMarket()
  const ahead = await reconciler(market, fakePool({ market }), chain(market, { creatorQuoteFee: 1030n }).connection).reconcile(market.githubRepoId)
  assert.deepEqual([ahead.status, ahead.curve.creator.difference, stockChainAheadOfLedger(ahead)], ['MISMATCH', 30n, true])
  const behind = await reconciler(market, fakePool({ market }), chain(market, { creatorQuoteFee: 990n }).connection).reconcile(market.githubRepoId)
  assert.deepEqual([behind.status, behind.curve.creator.difference, stockChainAheadOfLedger(behind)], ['MISMATCH', -10n, false])
})

test('a pending collection is PENDING_REVIEW before any chain read; an RPC failure is UNAVAILABLE', async () => {
  const market = stockMarket(), { connection } = chain(market)
  const pending = await reconciler(market, fakePool({ market, ledgers: [ledgerRow({ pendingCollections: 1 })] }), connection).reconcile(market.githubRepoId)
  assert.equal(pending.status, 'PENDING_REVIEW')
  assert.deepEqual(connection.reads, [])
  const down = chain(market, { fail: address => address === market.pool })
  const unavailable = await reconciler(market, fakePool({ market }), down.connection).reconcile(market.githubRepoId)
  assert.equal(unavailable.status, 'UNAVAILABLE')
  assert.match(unavailable.detail, /rpc unavailable/)
})

test('a collection that moves while the chain is read leaves the snapshot inconclusive, not mismatched', async () => {
  const market = stockMarket(), { connection } = chain(market, { creatorQuoteFee: 0n })
  const pool = fakePool({ market, ledgers: [ledgerRow(), ledgerRow({ collectedCurveCreator: '1000' })] })
  const result = await reconciler(market, pool, connection).reconcile(market.githubRepoId)
  assert.deepEqual([result.status, result.reason], ['PENDING_REVIEW', R.LEDGER_MOVED])
})

test('graduated positions reconcile against their latest checkpoints and settled collections', async () => {
  const market = stockMarket(), graduated = { pool: key(), creatorPosition: key(), partnerPosition: key(),
    creator: { unclaimed: 50n, claimed: 20n }, partner: { unclaimed: 9n, claimed: 0n } }
  const recorded = ledgerRow({ dammPool: graduated.pool, creatorPosition: graduated.creatorPosition, partnerPosition: graduated.partnerPosition,
    creatorCredits: '70', creatorCumulative: '70', partnerCredits: '9', partnerCumulative: '9', collectedGraduatedCreator: '20' })
  const { connection } = chain(market, { migrated: true, graduated })
  const match = await reconciler(market, fakePool({ market, ledgers: [recorded] }), connection).reconcile(market.githubRepoId)
  assert.equal(match.status, 'MATCH')
  assert.deepEqual([match.graduated.creator.onchainEarned, match.graduated.partner.onchainEarned], [70n, 9n])
  // A checkpoint not recorded yet: tolerated. A claim the ledger has no collection for: real.
  const lagging = await reconciler(market, fakePool({ market, ledgers: [{ ...recorded, creatorCredits: '60', creatorCumulative: '60' }] }), connection).reconcile(market.githubRepoId)
  assert.deepEqual([lagging.status, stockChainAheadOfLedger(lagging)], ['MISMATCH', true])
  const unrecordedClaim = await reconciler(market, fakePool({ market, ledgers: [{ ...recorded, collectedGraduatedCreator: '0' }] }), connection).reconcile(market.githubRepoId)
  assert.deepEqual([unrecordedClaim.status, unrecordedClaim.graduated.creator.claimedDifference, stockChainAheadOfLedger(unrecordedClaim)], ['MISMATCH', 20n, false])
  // Migrated on-chain with no graduation recorded: lag. A recorded graduation the chain does not show: real.
  const notRecorded = await reconciler(market, fakePool({ market }), chain(market, { migrated: true }).connection).reconcile(market.githubRepoId)
  assert.deepEqual([notRecorded.reason, stockChainAheadOfLedger(notRecorded)], [R.GRADUATION_NOT_RECORDED, true])
  const notOnChain = await reconciler(market, fakePool({ market, ledgers: [recorded] }), chain(market).connection).reconcile(market.githubRepoId)
  assert.deepEqual([notOnChain.reason, stockChainAheadOfLedger(notOnChain)], [R.GRADUATION_NOT_ON_CHAIN, false])
  const inconsistent = await reconciler(market, fakePool({ market, ledgers: [{ ...recorded, creatorCredits: '69' }] }), connection).reconcile(market.githubRepoId)
  assert.equal(inconsistent.reason, R.CHECKPOINT_CREDITS_INCONSISTENT)
})

test('ledger rows off the canonical pool, a settled collection without its amount and a config off the policy are real mismatches', async () => {
  const market = stockMarket(), { connection } = chain(market)
  for (const [over, reason] of [[{ offPoolEvents: 1 }, R.FEE_EVENTS_OFF_POOL], [{ settledWithoutAmount: 1 }, R.COLLECTION_AMOUNT_MISSING],
    [{ offPositionCheckpoints: 2 }, R.CHECKPOINTS_OFF_POSITION]]) {
    const result = await reconciler(market, fakePool({ market, ledgers: [ledgerRow(over)] }), connection).reconcile(market.githubRepoId)
    assert.deepEqual([result.status, result.reason, stockChainAheadOfLedger(result)], ['MISMATCH', reason, false], reason)
  }
  const accounts = new Map([[market.pool, curvePool({ config: market.config, creator: market.creatorWallet, baseMint: market.mint, creatorQuoteFee: 1000n, partnerQuoteFee: 400n })],
    [market.config, curveConfig({ quoteMint: METAX_MINT, feeClaimer: key(), creatorTradingFeePercentage: 50 })]])
  const policy = await reconciler(market, fakePool({ market }), fakeConnection(accounts)).reconcile(market.githubRepoId)
  assert.equal(policy.reason, R.POLICY_CONFIG_MISMATCH)
  const otherCreator = new Map([[market.pool, curvePool({ config: market.config, creator: key(), baseMint: market.mint })],
    [market.config, curveConfig({ quoteMint: METAX_MINT, feeClaimer: key() })]])
  assert.equal((await reconciler(market, fakePool({ market }), fakeConnection(otherCreator)).reconcile(market.githubRepoId)).reason, R.CURVE_STATE_MISMATCH)
})

test('only indexed stock markets are reconciled here: a SOL market stays with src/reconcile.mjs', async () => {
  const market = stockMarket(), { connection } = chain(market)
  const sol = { ...market, quoteAssetId: null, quoteMint: null }
  await assert.rejects(reconciler(market, fakePool({ market: sol }), connection).reconcile(market.githubRepoId), /SOL market is reconciled by src\/reconcile\.mjs/)
  await assert.rejects(reconciler(market, fakePool({ market: { ...market, indexedAt: null } }), connection).reconcile(market.githubRepoId), /no indexed canonical market/)
  const foreign = await reconciler(market, fakePool({ market: { ...market, quoteMint: key() } }), connection).reconcile(market.githubRepoId)
  assert.equal(foreign.reason, R.QUOTE_ASSET_MISMATCH)
})

test('custody: the fee claimer\'s Token-2022 account of the stock against the stock ledgers', async () => {
  const market = stockMarket()
  const matched = chain(market, { custodyAmount: 1000n })
  const result = await reconciler(market, fakePool({ market }), matched.connection).reconcileStockCustody('meta-xstock')
  assert.equal(result.status, 'MATCH')
  assert.deepEqual([result.wallet, result.account, result.expected, result.balance], [matched.feeClaimer, matched.custody, 1000n, 1000n])
  assert.equal(stockCustodyAccount(matched.feeClaimer, METAX_MINT), matched.custody, 'the shared custody account definition')
  const short = await reconciler(market, fakePool({ market }), chain(market, { custodyAmount: 990n }).connection).reconcileStockCustody('meta-xstock')
  assert.deepEqual([short.status, short.reason, short.difference], ['MISMATCH', R.CUSTODY_SHORTFALL, -10n])
  const missing = await reconciler(market, fakePool({ market }), chain(market, { custodyAmount: null }).connection).reconcileStockCustody('meta-xstock')
  assert.deepEqual([missing.balance, missing.reason], [0n, R.CUSTODY_SHORTFALL], 'no account yet holds nothing')
  const pending = await reconciler(market, fakePool({ market, custody: [custodyRow({ pendingPayouts: 1 })] }), matched.connection).reconcileStockCustody('meta-xstock')
  assert.equal(pending.status, 'PENDING_REVIEW')
  const moved = await reconciler(market, fakePool({ market, custody: [custodyRow(), custodyRow({ launcherPaid: '400' })] }), matched.connection).reconcileStockCustody('meta-xstock')
  assert.deepEqual([moved.status, moved.reason], ['PENDING_REVIEW', R.LEDGER_MOVED])
  const unconfigured = createStockReconciler({ pool: fakePool({ market }), config: key(), stockConfigs: new Map(), reads: createStockChainReads({ connection: matched.connection }) })
  assert.equal((await unconfigured.reconcileStockCustody('meta-xstock')).reason, R.CUSTODY_WALLET_UNKNOWN)
})

// --- The worker runner and its operator alerts.
function alertPool({ markets, settledAssets = [] }) {
  const alerts = new Map()
  return { alerts, async query(sql, params) {
    if (/from markets\s+where quote_asset_id is not null/.test(sql)) return { rows: markets }
    if (/select distinct asset_id/.test(sql)) return { rows: settledAssets }
    if (/insert into graduation_alerts/.test(sql)) {
      if (alerts.has(params[0])) return { rows: [] }
      const row = { id: alerts.size + 1, kind: params[2], repoId: params[1], createdAt: new Date() }
      alerts.set(params[0], { ...row, detail: JSON.parse(params[3]) })
      return { rows: [row] }
    }
    throw Error(`unexpected query: ${sql.slice(0, 80)}`)
  } }
}
const scripted = results => ({ reconcile: async repoId => { const next = results.market(repoId); if (next instanceof Error) throw next; return next },
  reconcileStockCustody: async assetId => results.custody(assetId) })

test('runner: a real mismatch raises one RECONCILIATION_MISMATCH alert at once; chain-ahead lag alerts only once it outlasts the window', async () => {
  let clock = 1_000_000, marketResult, custodyResult = { ledger: 'stock-custody', assetId: 'meta-xstock', status: 'MATCH' }
  const pool = alertPool({ markets: [{ repoId: '94911145', assetId: 'meta-xstock' }] })
  const runner = createStockReconcileRunner({ pool, now: () => clock, reconciler: scripted({ market: () => marketResult, custody: () => custodyResult }) })
  const lagging = stock({ githubRepoId: '94911145', curve: { creator: side(30n), partner: side(0n) } })
  const real = stock({ githubRepoId: '94911145', curve: { creator: side(-10n), partner: side(0n) } })

  marketResult = stock({ status: 'MATCH' })
  assert.deepEqual((await runner.runOnce()).markets, [{ repoId: '94911145', assetId: 'meta-xstock', status: 'MATCH', alert: null }])
  marketResult = lagging
  let run = await runner.runOnce()
  assert.deepEqual(run.markets[0], { repoId: '94911145', assetId: 'meta-xstock', status: 'MISMATCH', chainAhead: true, alert: null })
  clock += STOCK_RECONCILE_LAG_MS - 1
  assert.equal((await runner.runOnce()).markets[0].alert, null, 'still within the lag window')
  clock += 1
  run = await runner.runOnce()
  assert.ok(run.markets[0].alert, 'lag that outlasts the window alerts')
  const lagAlert = [...pool.alerts.values()][0]
  assert.deepEqual([lagAlert.kind, lagAlert.repoId, lagAlert.detail.lagging, lagAlert.detail.ledger], [STOCK_RECONCILE_ALERT, '94911145', true, 'stock'])
  clock += 60_000
  marketResult = stock({ githubRepoId: '94911145', curve: { creator: side(45n), partner: side(0n) } })
  assert.equal((await runner.runOnce()).markets[0].alert, null, 'the same lagging episode alerts once')

  marketResult = real
  run = await runner.runOnce()
  assert.ok(run.markets[0].alert, 'a ledger ahead of the chain alerts at once')
  assert.equal(pool.alerts.size, 2)
  const alert = [...pool.alerts.values()][1]
  assert.deepEqual([alert.kind, alert.detail.status, alert.detail.lagging, alert.detail.result.curve.creator.difference], [STOCK_RECONCILE_ALERT, 'MISMATCH', false, '-10'])
  marketResult = stock({ githubRepoId: '94911145', curve: { creator: side(-25n), partner: side(0n) } })
  assert.equal((await runner.runOnce()).markets[0].alert, null, 'the same kind of mismatch with new amounts does not repeat')
  marketResult = stock({ githubRepoId: '94911145', curve: { creator: side(-25n), partner: side(-1n) } })
  assert.ok((await runner.runOnce()).markets[0].alert, 'another kind of mismatch alerts again')
  marketResult = stock({ status: 'MATCH' })
  await runner.runOnce()
  marketResult = real
  assert.ok((await runner.runOnce()).markets[0].alert, 'after a MATCH, a recurrence is a new episode, even within the same millisecond')
  assert.equal(pool.alerts.size, 4)
})

test('runner: a market that cannot be reconciled is an ERROR alert, never a skip; custody alerts carry no market', async () => {
  const pool = alertPool({ markets: [{ repoId: '94911145', assetId: 'meta-xstock' }], settledAssets: [{ assetId: 'msft-xstock' }] })
  const custody = { 'meta-xstock': { ledger: 'stock-custody', assetId: 'meta-xstock', status: 'MISMATCH', reason: R.CUSTODY_SHORTFALL, difference: -5n },
    'msft-xstock': { ledger: 'stock-custody', assetId: 'msft-xstock', status: 'MATCH' } }
  const runner = createStockReconcileRunner({ pool, reconciler: scripted({ market: () => Error('Stock-paired market has no registered config'), custody: id => custody[id] }) })
  const run = await runner.runOnce()
  assert.deepEqual(run.markets.map(({ status, reason }) => [status, reason]), [['ERROR', 'Stock-paired market has no registered config']])
  assert.ok(run.markets[0].alert)
  assert.deepEqual(run.custody.map(({ assetId, status }) => [assetId, status]), [['meta-xstock', 'MISMATCH'], ['msft-xstock', 'MATCH']])
  const alerts = [...pool.alerts.values()]
  assert.deepEqual(alerts.map(alert => [alert.repoId, alert.detail.ledger, alert.detail.reason]),
    [['94911145', 'stock', 'Stock-paired market has no registered config'], [null, 'stock-custody', R.CUSTODY_SHORTFALL]])
  assert.match(mismatchKind(custody['meta-xstock']), /^MISMATCH:CUSTODY_SHORTFALL/)
})

test('runner: a custody surplus is informational, one STOCK_CUSTODY_SURPLUS alert per distinct amount; a shortfall is a mismatch', async () => {
  const pool = alertPool({ markets: [], settledAssets: [{ assetId: 'meta-xstock' }] })
  let custody = { ledger: 'stock-custody', assetId: 'meta-xstock', ...compareCustody({ collected: 1000n, launcherPaid: 0n, settlementSpent: 0n, balance: 1001n }) }
  const runner = createStockReconcileRunner({ pool, reconciler: scripted({ market: () => assert.fail('no market'), custody: () => custody }) })
  let run = await runner.runOnce()
  assert.deepEqual([run.custody[0].status, Boolean(run.custody[0].alert)], ['SURPLUS', true])
  assert.equal((await runner.runOnce()).custody[0].alert, null, 'the same surplus alerts once')
  custody = { ledger: 'stock-custody', assetId: 'meta-xstock', ...compareCustody({ collected: 1000n, launcherPaid: 0n, settlementSpent: 0n, balance: 1250n }) }
  assert.ok((await runner.runOnce()).custody[0].alert, 'a new surplus amount alerts again')
  // A restarted worker (fresh runner) does not repeat a surplus already reported.
  const restarted = createStockReconcileRunner({ pool, reconciler: scripted({ market: () => assert.fail('no market'), custody: () => custody }) })
  assert.equal((await restarted.runOnce()).custody[0].alert, null)
  const surplusAlerts = [...pool.alerts.values()]
  assert.deepEqual(surplusAlerts.map(alert => [alert.kind, alert.repoId, alert.detail.surplus, alert.detail.code]),
    [[STOCK_CUSTODY_SURPLUS_ALERT, null, '1', R.CUSTODY_SURPLUS], [STOCK_CUSTODY_SURPLUS_ALERT, null, '250', R.CUSTODY_SURPLUS]])
  custody = { ledger: 'stock-custody', assetId: 'meta-xstock', ...compareCustody({ collected: 1000n, launcherPaid: 0n, settlementSpent: 0n, balance: 999n }) }
  run = await runner.runOnce()
  assert.deepEqual([run.custody[0].status, run.custody[0].reason], ['MISMATCH', R.CUSTODY_SHORTFALL])
  const shortfall = [...pool.alerts.values()].at(-1)
  assert.deepEqual([shortfall.kind, shortfall.detail.code], [STOCK_RECONCILE_ALERT, R.CUSTODY_SHORTFALL], 'a shortfall alerts at once, as a mismatch')
})
