import test from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCHER_DEN, LAUNCHER_NUM, splitCurveFee, dammCheckpoint } from '../src/stock-fee-policy.mjs'
import { StockLauncherBalanceError, feeRoutingTotals, launcherEarnings, launcherEarningsView, launcherTotalsByAsset, shownStockUnits,
  stockMultipliers, walletStockLauncherEarnings } from '../src/stock-launcher-earnings.mjs'
import { STOCK_FEE_SPLIT } from '../app/lib/stock-fee-routing.mjs'
import { noOwnerClaimMessage } from '../src/stock-owner-claims.mjs'

// src/stock-launcher-earnings.mjs: the launcher's 0.30% of every trade on a stock pair, in raw units of the stock, and shown
// as wallets show the stock (raw × ScaledUiAmount multiplier, truncated).
const METAX = 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'
const MULTIPLIER = '1.0028515433272898'
const row = (over = {}) => ({ repoId: '94911145', mint: 'MintDocs', symbol: 'DOCUSAURUS', launcherWallet: 'LauncherWallet', assetId: 'meta-xstock',
  quoteMint: METAX, curveEarned: '3000', curveAccumulated: '11000', graduatedEarned: '600', graduatedAccumulated: '2200', collected: '2400',
  paid: '1000', pending: '0', ...over })

test('earned, collected, paid, pending, payable and uncollected, from the stock ledgers', () => {
  assert.deepEqual(launcherEarnings(row()), { earned: 3600n, collected: 2400n, paid: 1000n, pending: 0n, payable: 1400n, uncollected: 1200n })
  assert.deepEqual(launcherEarnings(row({ pending: '400' })), { earned: 3600n, collected: 2400n, paid: 1000n, pending: 400n, payable: 1000n, uncollected: 1200n },
    'a payout in flight is never payable twice')
  assert.deepEqual(launcherEarnings(row({ curveEarned: '0', graduatedEarned: '0', collected: '0', paid: '0' })),
    { earned: 0n, collected: 0n, paid: 0n, pending: 0n, payable: 0n, uncollected: 0n })
  assert.throws(() => launcherEarnings(row({ collected: '3601' })), StockLauncherBalanceError, 'more collected than earned needs review')
  assert.throws(() => launcherEarnings(row({ paid: '2000', pending: '401' })), /payouts exceed launcher collections/)
  for (const bad of ['-1', '1.5', 'abc', null]) assert.throws(() => launcherEarnings(row({ paid: bad })), StockLauncherBalanceError, String(bad))
})

test('the launcher\'s ledger share is the policy\'s 150/497 of the creator fee, on the curve and after graduation', () => {
  // A 1 METAx creator fee on the curve, and a graduated creator position that has earned 2 METAx in total.
  const curve = splitCurveFee({ creatorAmount: 100_000_000n, partnerAmount: 40_845_070n })
  const graduated = dammCheckpoint({ side: 'creator', cumulativeEarned: 200_000_000n })
  assert.equal(curve.launcherAmount, 100_000_000n * LAUNCHER_NUM / LAUNCHER_DEN)
  const earnings = launcherEarnings(row({ curveEarned: String(curve.launcherAmount), graduatedEarned: String(graduated.launcherCredit), collected: '0', paid: '0' }))
  assert.equal(earnings.earned, curve.launcherAmount + graduated.launcherCredit)
  assert.deepEqual(feeRoutingTotals(row({ curveEarned: String(curve.launcherAmount), curveAccumulated: String(curve.accumulatorAmount),
    graduatedEarned: String(graduated.launcherCredit), graduatedAccumulated: String(graduated.accumulatorCredit) })),
  { launcher: curve.launcherAmount + graduated.launcherCredit, accumulator: curve.accumulatorAmount + graduated.accumulatorCredit })
})

test('the fee split shown on stock pairs is the policy\'s: 0.30% to the launcher, 1.10% to the accumulator', () => {
  assert.deepEqual({ ...STOCK_FEE_SPLIT }, { total: '1.75%', meteora: '0.35%', launcher: '0.30%', accumulator: '1.10%' })
  assert.match(noOwnerClaimMessage({ quoteAssetId: 'meta-xstock' }), new RegExp(`${STOCK_FEE_SPLIT.launcher.replace('.', '\\.')} of every trade goes to the wallet that launched the market, paid in METAx`))
  assert.match(noOwnerClaimMessage({ quoteAssetId: 'meta-xstock' }), /permanent \$REPOING \/ METAx liquidity/)
})

test('shown amounts are raw × the multiplier, truncated, as Token-2022 shows balances; raw amounts stay as recorded', () => {
  assert.equal(shownStockUnits(100_000_000n, MULTIPLIER), 100_285_154n)
  assert.equal(shownStockUnits(1n, MULTIPLIER), 1n)
  assert.equal(shownStockUnits(99n, '1'), 99n)
  assert.throws(() => shownStockUnits(1n, '1e-7'), /multiplier/)
  const view = launcherEarningsView(row({ curveEarned: '100000000', graduatedEarned: '0', collected: '0', paid: '0' }), { multiplier: MULTIPLIER })
  assert.deepEqual(view.asset, { assetId: 'meta-xstock', symbol: 'METAx', decimals: 8 })
  assert.deepEqual([view.raw.earned, view.shown.earned, view.raw.payable, view.shown.uncollected], ['100000000', '100285154', '0', '100285154'])
  assert.equal(launcherEarningsView(row(), { multiplier: null }).shown, null, 'no multiplier: no shown amounts, never raw passed off as scaled')
  assert.throws(() => launcherEarningsView(row({ quoteMint: 'SomeOtherMint' })), /registry/, 'a stamp off the registry is never shown')
})

test('totals per stock sum raw amounts first, leave markets under review out, and need one multiplier', () => {
  const views = [launcherEarningsView(row({ curveEarned: '1', graduatedEarned: '0', collected: '1', paid: '0' }), { multiplier: '1.5' }),
    launcherEarningsView(row({ repoId: '2', curveEarned: '1', graduatedEarned: '0', collected: '0', paid: '0' }), { multiplier: '1.5' }),
    { repoId: '3', review: true }]
  const [total] = launcherTotalsByAsset(views)
  assert.deepEqual([total.markets, total.raw.earned, total.shown.earned, total.shown.payable], [2, '2', '3', '1'],
    'shown from the summed raw 2 (3), not from two truncated 1s (2)')
  const mixed = launcherTotalsByAsset([views[0], { ...views[1], multiplier: '2' }])
  assert.equal(mixed[0].shown, null)
})

test('a wallet\'s stock launches: one view per market, review instead of an impossible balance, units only with a multiplier', async () => {
  const rows = [row(), row({ repoId: '7', collected: '9999' })]
  const db = { query: async (sql, params) => {
    assert.match(sql, /m\.launcher_wallet = \$1 and m\.quote_asset_id is not null and m\.status = 'confirmed'/)
    assert.deepEqual(params, ['LauncherWallet'])
    return { rows }
  } }
  const errors = []
  const original = console.error
  console.error = (...args) => errors.push(args)
  try {
    const views = await walletStockLauncherEarnings(db, {}, 'LauncherWallet', { read: async (connection, asset) => { assert.equal(asset.mint, METAX); return MULTIPLIER } })
    assert.equal(views.length, 2)
    assert.deepEqual([views[0].raw.payable, views[0].shown.payable], ['1400', '1403'])
    assert.deepEqual(views[1], { repoId: '7', mint: 'MintDocs', symbol: 'DOCUSAURUS', launcherWallet: 'LauncherWallet', review: true })
    assert.equal(errors.length, 1)
    const unread = await walletStockLauncherEarnings(db, {}, 'LauncherWallet', { read: async () => { throw Error('rpc down') } })
    assert.equal(unread[0].shown, null)
  } finally { console.error = original }
  const multipliers = await stockMultipliers({}, ['meta-xstock', 'meta-xstock', 'sol', 'nope'], { read: async () => MULTIPLIER })
  assert.deepEqual([...multipliers], [['meta-xstock', MULTIPLIER], ['sol', null], ['nope', null]])
})
