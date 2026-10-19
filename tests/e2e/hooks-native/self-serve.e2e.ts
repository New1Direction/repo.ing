// Self-serve (ownerless) launches on our own stack, in a real browser with real wallet signatures, asserted from chain and
// database. The stack (mode self-serve) holds the legacy stack exactly as deployed and our own stack (hook-lab's
// independent build at its placeholder IDs) on one validator; the site serves both bundles; NO owner agent process runs.
// Every transaction of the new flow is checked to invoke no legacy program and to name no legacy quote mint; no page or
// customer API response shows our quote marker; no Add SOL or Withdraw surface appears.
import { readFileSync } from 'node:fs'
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { control, db, freshWallet, stack, until } from './support/stack.ts'
import { approveSignatures, walletLog } from './support/wallets.ts'
import { finalizedOperations, launchRequests, operations } from './support/db.ts'
import { FLAG, accountKeys, big, coinBalance, events, feeSplit, holdingAddress, lamportDelta, lamports, launchAccount, one, poolAccount, programInstructions,
  receipt, verifySignatures } from './support/chain.ts'
import { expectSettlementIsReceipt } from './support/settlement.ts'
import { freshBuyerOnCoinPage, marketView, prepareTrade, startTrade, tradeResult } from './support/flows.ts'
import { fillUntilOneBuyLeft } from './support/boundaries.ts'
import { SiteClient } from './support/site-client.ts'
import { expectOpenLaunch, openCreationState, type OpenCreationState } from './support/open-launch.ts'
import { fillAndReview, launchOpenCoinViaUi, openLaunchPage, signInForLaunch, type OpenLaunched } from './support/open-flows.ts'
import { expectNativeBuy, expectNativeSell } from './support/native-trades.ts'
import { claimViaUi } from './support/claims.ts'
import { expectNoFundingSurface, expectNoLegacyStack, markerLeaks, recordMarkerLeaks } from './support/stack-separation.ts'
import { CREATION_FEE_LAMPORTS, OWNER_MENUS } from '../../../scripts/e2e/hooks-native/modes.mjs'
import { DELISTED_BUY_TEXT, sol } from '../../../app/lib/hooklab-trade-math.mjs'
import { delistedNotice } from '../../../src/hooklab-coin-moderation.mjs'

// Four creators, four menu choices (fee bps, cap bps): every value on each menu is used at least once across the suite.
const COINS = [
  { name: 'Self Serve One', symbol: 'SSONE', creatorFeeBps: 100, capBps: 500 },
  { name: 'Self Serve Two', symbol: 'SSTWO', creatorFeeBps: 50, capBps: 100 },
  { name: 'Self Serve Three', symbol: 'SSTRI', creatorFeeBps: 200, capBps: 300 },
  { name: 'Self Serve Four', symbol: 'SSFOR', creatorFeeBps: 100, capBps: 200 },
]
const SUPPLY = 1_000_000_000_000_000n
const coins: OpenLaunched[] = []
let initial: OpenCreationState
// Per coin, the creator and platform shares the trades accrued (from each receipt's own event), for the exact claim and
// the exact platform collection.
const accrued = new Map<string, { creator: bigint; platform: bigint }>()
const book = (mint: string, c: { creator: bigint; platform: bigint }) => {
  const now = accrued.get(mint) ?? { creator: 0n, platform: 0n }
  accrued.set(mint, { creator: now.creator + c.creator, platform: now.platform + c.platform })
}
const tradeCoin = (i: number) => ({ ...coins[i], creatorFeeBps: COINS[i].creatorFeeBps, symbol: COINS[i].symbol })
const ownerStage = (body: Record<string, unknown>) => control<{ signature: string; postconditions: string[] }>('POST', '/owner/stage', body)

describe('self-serve launches on our own stack: ownerless, menus from the chain, exact costs, nothing from the legacy stack', { serial: true }, () => {
  test('four fresh creators launch back to back with no owner agent, invite or grant; fee and cap only from the on-chain menus', { timeout: 1_800_000 }, async ({ app, screen, browser }) => {
    expect(stack.mode).toBe('self-serve')
    expect((await control<{ agent: boolean }>('GET', '/health')).agent).toBe(false) // no owner agent process at all
    initial = await openCreationState()
    expect([initial.native, initial.open, initial.paused]).toEqual([true, true, false])
    expect([initial.feeMenu, initial.capMenu]).toEqual([[...OWNER_MENUS.creatorFeeBps], [...OWNER_MENUS.capBps]])
    expect(initial.launchFeeLamports).toBe(CREATION_FEE_LAMPORTS)
    for (const coin of COINS) {
      const launched = await launchOpenCoinViaUi({ app, screen, browser }, coin)
      coins.push(launched)
      // The review said what the creation costs, from chain values.
      expect(launched.reviewText).toContain('Creation fee 0.02 SOL (to repo.ing)')
      const prep = await receipt(launched.preparation.signature as string), tx = await receipt(launched.launchOp.signature as string)
      verifySignatures(prep, launched.address); verifySignatures(tx, launched.address)
      const { debit } = expectOpenLaunch(tx, { creator: launched.address, mint: launched.mint, state: initial, feeBps: coin.creatorFeeBps, capBps: coin.capBps })
      for (const t of [prep, tx]) expectNoLegacyStack(t)
      expect(debit > CREATION_FEE_LAMPORTS).toBe(true)
      // The page after launch: no funding surface, no quote marker anywhere the customer can see.
      await app.open(`/hooks/token/${launched.mint}`)
      await expect(screen.getByRole('tab', { name: 'Buy' })).toBeVisible({ timeout: 60_000 }) // the trade panel loaded
      await expectNoFundingSurface(screen, launched.address)
      expect(await recordMarkerLeaks(browser, stack.quoteMint as string, `launch of $${coin.symbol}`) > 0).toBe(true)
    }
    // Ownerless: the governance revision never moved (no grant, no governed change), no owner co-signature was ever asked.
    expect((await openCreationState()).revision).toBe(initial.revision)
    const count = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows[0].n
    expect(await count('select count(*)::int n from hook_lab_owner_sign_requests')).toBe(0)
    expect(await count('select count(*)::int n from hook_lab_owner_table_requests')).toBe(0)
    expect(await count("select count(*)::int n from hook_lab_launch_requests where source is distinct from 'open'")).toBe(0)
    // The server's own co-signatures are the coin address and its launch settings only, never the admin's key.
    expect(await count('select count(*)::int n from hook_lab_native_signing_attempts where signer_address=$1', [stack.roles.admin])).toBe(0)
  })

  test('a holder buys and sells the first coin with ordinary SOL: exact split, lamports and settlement, nothing legacy', async ({ app, screen, browser }) => {
    const coin = tradeCoin(0)
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await startTrade(screen, coin.symbol, 'buy', '0.5')
    const [buy] = await finalizedOperations(address, 'native-buy', 1)
    const bought = await expectNativeBuy(buy, address, coin, 500_000_000n)
    expectNoLegacyStack(bought.tx); book(coin.mint, bought)
    expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
    await startTrade(screen, coin.symbol, 'sell', '100%')
    const [sell] = await finalizedOperations(address, 'native-sell', 1), sold = await expectNativeSell(sell, address, coin)
    expectNoLegacyStack(sold.tx); book(coin.mint, sold)
    expect(await tradeResult(screen, 'sell')).toBe(`${sol(sold.received, 6)} went straight to your wallet.`)
    await expectNoFundingSurface(screen, address)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'buy and sell')
    expect((await operations(address)).map(op => op.stage)).toEqual(['native-buy', 'native-sell'])
    expect((await walletLog(browser)).map(e => e.kind)).toEqual(['message', 'transaction', 'transaction'])
    await approvals.off()
  })

  test('more than ten capped wallets fill the curve; the panel\'s Max is the exact final fill and graduates in one transaction', { timeout: 3_600_000 }, async ({ app, screen, browser }) => {
    const coin = tradeCoin(0), cap = SUPPLY * BigInt(COINS[0].capBps) / 10_000n
    const graduationQuote = big((await launchAccount(coin.launch)).value.graduation_quote)
    const fillers = await fillUntilOneBuyLeft(coin, async (_op, address) => {
      const [row] = await operations(address, 'native-buy')
      const checked = await expectNativeBuy(row, address, coin, BigInt(row.resolved_request.amountIn))
      expectNoLegacyStack(checked.tx); book(coin.mint, checked)
      expect(await coinBalance(coin.mint, address) <= cap).toBe(true) // never over the max per wallet before graduation
    })
    expect(fillers > 10).toBe(true)
    expect((await launchAccount(coin.launch)).value.status).toBe(0)
    // A first-time buyer, not signed in: the notice says this buy finishes the curve, then Max graduates the coin.
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint, 200)
    const approvals = await approveSignatures(browser)
    await screen.getByRole('tab', { name: 'Buy' }).tap()
    await screen.getByRole('group', { name: 'Buy amounts' }).getByRole('button', { name: 'Max' }).tap()
    await expect(screen.getByRole('status').filter({ hasText: `This buy finishes the curve. $${coin.symbol} graduates in the same transaction: its liquidity is locked forever and the max per wallet lifts.` })).toBeVisible()
    const label = await startTrade(screen, coin.symbol, 'buy', 'Max')
    expect(label).toBe(`Sign in and buy $${coin.symbol}`)
    const [op] = await finalizedOperations(address, 'native-buy', 1), tx = await receipt(op.signature as string)
    expect(tx.meta?.err).toBeNull(); verifySignatures(tx, address); expectNoLegacyStack(tx)
    const amount = BigInt(op.resolved_request.amountIn), split = feeSplit(amount, BigInt(coin.creatorFeeBps)), fee = one(events(tx), 'InclusiveCreatorFeeAccrued')
    expect([big(fee.gross_quote), big(fee.platform_quote), big(fee.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
    expect(lamportDelta(tx, address)).toBe(-(BigInt(tx.meta!.fee) + amount + lamportDelta(tx, holdingAddress(coin.mint, address))))
    expect(lamportDelta(tx, coin.launch)).toBe(split.creator)
    expectSettlementIsReceipt(op, tx, split); book(coin.mint, split)
    expect(op.resolved_request.graduate).toBe(true)
    expect(op.first_finalized.graduated).toBe(true)
    expect(tx.transaction.message.header.numRequiredSignatures).toBe(1)
    expect(accountKeys(tx)[0]).toBe(address)
    expect(programInstructions(tx)).toEqual(['swap:swap_v2', 'launch:graduate'])
    expect(events(tx).filter(e => e.name === 'Graduated').length).toBe(1)
    const launch = await launchAccount(coin.launch), pool = await poolAccount(coin.pool)
    expect([launch.value.status, pool.value.curve]).toEqual([1, false])
    expect(big(pool.value.quote_reserve)).toBe(graduationQuote)
    expect(big(op.first_finalized.quote.after.quoteReserve)).toBe(graduationQuote)
    expect([launch.raw[FLAG.launch], pool.raw[FLAG.pool]]).toEqual([1, 1])
    expect((await control<Record<string, number>>('GET', '/rpc/sends'))[op.signature as string]).toBe(1)
    await expect(screen.getByText(new RegExp(`\\$${coin.symbol} has graduated\\.`))).toBeVisible()
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'graduation')
    await approvals.off()
  })

  test('after graduation a fresh wallet buys above the old max per wallet, then sells in parts under the 10% impact limit', { timeout: 1_800_000 }, async ({ app, screen, browser }) => {
    const coin = tradeCoin(0), cap = SUPPLY * BigInt(COINS[0].capBps) / 10_000n
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint, 400)
    const approvals = await approveSignatures(browser)
    for (let n = 1; await coinBalance(coin.mint, address) <= cap; n++) {
      if (n > 8) throw new Error(`still at or under the old cap after ${n - 1} buys`)
      await startTrade(screen, coin.symbol, 'buy', 'Max')
      const op = (await finalizedOperations(address, 'native-buy', n))[n - 1]
      const checked = await expectNativeBuy(op, address, coin, BigInt(op.resolved_request.amountIn))
      expectNoLegacyStack(checked.tx); book(coin.mint, checked)
      expect(op.first_finalized.quote.capLifted).toBe(true)
      expect(events(checked.tx).some(e => e.name === 'Graduated')).toBe(false)
      await tradeResult(screen, 'buy')
    }
    expect(await coinBalance(coin.mint, address) > cap).toBe(true)
    await screen.getByRole('tab', { name: 'Sell' }).tap()
    await screen.getByRole('group', { name: 'Sell amounts' }).getByRole('button', { name: '100%' }).tap()
    await expect(screen.getByText('That moves the price more than 10%. Try a smaller amount.')).toBeVisible()
    for (let n = 1; await coinBalance(coin.mint, address) > 0n; n++) {
      if (n > 14) throw new Error(`still holding ${await coinBalance(coin.mint, address)} after ${n - 1} sales`)
      const held = await coinBalance(coin.mint, address)
      await screen.getByRole('tab', { name: 'Sell' }).tap()
      await startTrade(screen, coin.symbol, 'sell', await largestAcceptedShare(screen, coin.symbol))
      const op = (await finalizedOperations(address, 'native-sell', n))[n - 1], sold = await expectNativeSell(op, address, coin)
      expectNoLegacyStack(sold.tx); book(coin.mint, sold)
      expect(BigInt(op.resolved_request.amountIn)).toBe(held - await coinBalance(coin.mint, address))
      await tradeResult(screen, 'sell')
    }
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'after graduation')
    await approvals.off()
  })

  test('the creator claims exactly the SOL fees every trade accrued; the platform share is collected to the treasury exactly', async ({ app, screen, browser }) => {
    const coin = tradeCoin(0), sums = accrued.get(coin.mint)!
    const { tx: claimTx, amount } = await claimViaUi({ app, screen, browser }, coin.creator, coin, sums.creator)
    expectNoLegacyStack(claimTx)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'creator claim')
    accrued.set(coin.mint, { creator: 0n, platform: sums.platform })
    // collect_protocol_fees_native, run as the owner runs it (the owner driver's collect-native stage; anyone may crank).
    const owed = big((await poolAccount(coin.pool)).value.protocol_fees_quote)
    expect(owed).toBe(sums.platform)
    const { signature } = await ownerStage({ stage: 'collect-native', mint: coin.mint })
    const tx = await receipt(signature)
    expect(tx.meta?.err).toBeNull(); expectNoLegacyStack(tx)
    expect(lamportDelta(tx, stack.roles.treasury)).toBe(owed)
    expect(lamportDelta(tx, coin.pool)).toBe(-owed)
    expect(lamportDelta(tx, stack.roles.payer)).toBe(-BigInt(tx.meta!.fee))
    expect(big((await poolAccount(coin.pool)).value.protocol_fees_quote)).toBe(0n)
    expect(amount > 0n && owed > 0n).toBe(true)
  })

  test('launch recovery: a refused setup or launch signature spends nothing more; a reload and a server restart mid-launch finish it once', { timeout: 2_400_000 }, async ({ app, screen, browser }) => {
    const variants: { coin: { name: string; symbol: string; creatorFeeBps: number; capBps: number }; refuse?: number; interrupt?: 'reload' | 'restart' }[] = [
      { coin: { name: 'Refused Setup', symbol: 'RSETUP', creatorFeeBps: 50, capBps: 300 }, refuse: 1 },
      { coin: { name: 'Refused Launch', symbol: 'RLAUNCH', creatorFeeBps: 200, capBps: 100 }, refuse: 2 },
      { coin: { name: 'Reloaded Launch', symbol: 'RELOAD', creatorFeeBps: 100, capBps: 500 }, interrupt: 'reload' },
      { coin: { name: 'Restarted Launch', symbol: 'RESTART', creatorFeeBps: 100, capBps: 200 }, interrupt: 'restart' },
    ]
    for (const variant of variants) {
      const creator = await freshWallet(5), address = creator.publicKey.toBase58()
      await openLaunchPage({ app, screen, browser }, creator)
      let transactions = 0
      const off = await browser.onDialog(async (dialog: any) => {
        const nth = dialog.message.includes('Sign this transaction:') ? ++transactions : 0
        if (variant.refuse && nth === variant.refuse) await dialog.dismiss(); else await dialog.accept()
      })
      await fillAndReview(screen, variant.coin)
      await signInForLaunch(screen)
      const before = await lamports(address)
      if (variant.interrupt) await control('POST', '/rpc/faults', { holdNextSendMs: 15_000 }) // the setup's send stays in flight
      await screen.getByRole('button', { name: 'Sign and launch' }).tap()
      if (variant.refuse) {
        await expect(screen.getByRole('alert').filter({ hasText: 'You closed the request in your wallet. Nothing was sent.' })).toBeVisible({ timeout: 120_000 })
        const stage = variant.refuse === 1 ? 'preparation' : 'launch'
        expect((await operations(address, stage)).filter(op => op.signature === null).length).toBe(1)
        if (variant.refuse === 1) expect(await lamports(address)).toBe(before) // nothing was spent
        else {
          const [prep] = await finalizedOperations(address, 'preparation', 1)
          expect(await lamports(address)).toBe(before + lamportDelta(await receipt(prep.signature as string), address)) // only the setup
        }
        await screen.getByRole('button', { name: 'Continue' }).tap()
      } else {
        await until('the setup to be sent', async () => (await operations(address, 'preparation'))[0]?.signature)
        if (variant.interrupt === 'restart') await control('POST', '/site/restart', { recollect: false })
        await app.open('/hooks/launch-review')
        await expect(screen.getByText('Your launch is waiting for you. Continue to finish it.')).toBeVisible({ timeout: 120_000 })
        await screen.getByRole('button', { name: 'Continue' }).tap()
      }
      await expect(screen.getByRole('heading', { name: `$${variant.coin.symbol} is live` })).toBeVisible({ timeout: 300_000 })
      const [prep] = await finalizedOperations(address, 'preparation', 1), [launchOp] = await finalizedOperations(address, 'launch', 1)
      const sends = await control<Record<string, number>>('GET', '/rpc/sends')
      expect([sends[prep.signature as string], sends[launchOp.signature as string]]).toEqual([1, 1]) // each sent once
      expect((await operations(address)).filter(op => op.signature !== null).length).toBe(2) // nothing else was signed and sent
      const tx = await receipt(launchOp.signature as string)
      expectOpenLaunch(tx, { creator: address, mint: launchOp.resolved_request.mint, state: await openCreationState(), feeBps: variant.coin.creatorFeeBps, capBps: variant.coin.capBps })
      expectNoLegacyStack(tx); expectNoLegacyStack(await receipt(prep.signature as string))
      expect((await launchRequests(address)).map(r => r.status)).toEqual(['launched'])
      await recordMarkerLeaks(browser, stack.quoteMint as string, `recovery ${variant.coin.symbol}`)
      await off()
    }
  })

  test('a reload mid-trade on our stack finishes the same buy once', async ({ app, screen, browser }) => {
    const coin = tradeCoin(1)
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await control('POST', '/rpc/faults', { holdNextSendMs: 8000 })
    await startTrade(screen, coin.symbol, 'buy', '0.03')
    await until('the signed buy to be sent', async () => (await operations(address, 'native-buy'))[0]?.signature)
    await browser.reload()
    const [op] = await finalizedOperations(address, 'native-buy', 1), checked = await expectNativeBuy(op, address, coin, 30_000_000n)
    expectNoLegacyStack(checked.tx); book(coin.mint, checked)
    expect((await walletLog(browser)).filter(e => e.kind === 'transaction').length).toBe(1)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'reload mid-trade')
    await approvals.off()
  })

  test('a refused trade signature on our stack sends and charges nothing; the retry settles once', async ({ app, screen, browser }) => {
    const coin = tradeCoin(1)
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    let rejectNext = true
    const off = await browser.onDialog(async (dialog: any) => {
      if (rejectNext && dialog.message.includes('Sign this transaction')) { rejectNext = false; await dialog.dismiss() } else await dialog.accept()
    })
    const before = await lamports(address)
    await startTrade(screen, coin.symbol, 'buy', '0.02')
    await expect(screen.getByRole('alert').filter({ hasText: /rejected|cancel|declin|closed the request/i })).toBeVisible({ timeout: 60_000 })
    const [refused] = await until('the refused review row', async () => { const rows = await operations(address, 'native-buy'); return rows.length === 1 ? rows : null })
    expect([refused.signature, refused.status]).toEqual([null, 'reviewed'])
    expect(await lamports(address)).toBe(before) // nothing charged, not even a network fee
    expect((await walletLog(browser)).filter(e => e.kind === 'transaction')).toEqual([])
    // The retry: a fresh review, one approval, one send.
    await startTrade(screen, coin.symbol, 'buy', '0.02')
    const ops = await until('the retried buy to settle', async () => { const rows = await operations(address, 'native-buy'); return rows.length === 2 && rows[1].status === 'finalized-success' ? rows : null }, { timeoutMs: 180_000 })
    const bought = await expectNativeBuy(ops[1], address, coin, 20_000_000n)
    expectNoLegacyStack(bought.tx); book(coin.mint, bought)
    expect((await operations(address, 'native-buy'))[0].signature).toBeNull() // the refused one stays unsigned
    expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'refused trade signature')
    await off()
  })

  test('emergency pauses: the guardian stops new launches (holders still trade, creators still claim) until the admin reopens; a trading pause refuses trades cleanly', { timeout: 2_400_000 }, async ({ app, screen, browser }) => {
    const coin = tradeCoin(1)
    await ownerStage({ stage: 'guardian-pause', pause: 'creation' })
    expect((await openCreationState()).paused).toBe(true)
    // A new launch is refused, in the page and by the server.
    const blocked = await freshWallet(5)
    await openLaunchPage({ app, screen, browser }, blocked)
    await expect(screen.getByRole('status').filter({ hasText: 'Launches are paused right now. Try again later.' })).toBeVisible({ timeout: 60_000 })
    const client = new SiteClient(blocked); await client.signIn()
    const refused = await client.post('/api/hook-lab/launch-requests', { action: 'create', requestId: crypto.randomUUID(), name: 'Paused Coin', symbol: 'PAUSED', creatorFeeBps: 100, capBps: 200,
      image: pngDataUrl(), description: '', x: '', website: '', telegram: '' })
    expect([refused.status, refused.json?.error]).toEqual([409, 'Launches are paused right now. Try again later.'])
    expect(await launchRequests(blocked.publicKey.toBase58())).toEqual([])
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'paused launch page')
    // Existing holders trade and creators claim during the pause, with no redeploy.
    const holder = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    let approvals = await approveSignatures(browser)
    await startTrade(screen, coin.symbol, 'buy', '0.02')
    const [buy] = await finalizedOperations(holder.address, 'native-buy', 1), bought = await expectNativeBuy(buy, holder.address, coin, 20_000_000n)
    expectNoLegacyStack(bought.tx); book(coin.mint, bought)
    await tradeResult(screen, 'buy')
    await startTrade(screen, coin.symbol, 'sell', '100%')
    const [sell] = await finalizedOperations(holder.address, 'native-sell', 1), sold = await expectNativeSell(sell, holder.address, coin)
    expectNoLegacyStack(sold.tx); book(coin.mint, sold)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'trading during the creation pause')
    await approvals.off()
    const { tx: claimTx } = await claimViaUi({ app, screen, browser }, coin.creator, coin, accrued.get(coin.mint)!.creator)
    expectNoLegacyStack(claimTx); accrued.set(coin.mint, { ...accrued.get(coin.mint)!, creator: 0n })
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'claim during the creation pause')
    // The admin reopens; launches work again.
    await ownerStage({ stage: 'open-launches' })
    expect((await openCreationState()).paused).toBe(false)
    const reopened = await launchOpenCoinViaUi({ app, screen, browser }, { name: 'After Reopen', symbol: 'REOPEN', creatorFeeBps: 50, capBps: 500 })
    expectNoLegacyStack(await receipt(reopened.launchOp.signature as string))
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'launch after reopening')
    // A trading pause: a buy is refused before anything is signed or sent, and leaves nothing in flight.
    await ownerStage({ stage: 'guardian-pause', pause: 'trading' })
    const trader = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    approvals = await approveSignatures(browser)
    const before = await lamports(trader.address)
    const main = await prepareTrade(screen, coin.symbol, 'buy', '0.02')
    if (await main.isEnabled()) await main.tap()
    await expect(screen.getByRole('alert').first()).toBeVisible({ timeout: 60_000 })
    const rows = await operations(trader.address)
    expect(rows.filter(row => row.signature !== null || ['submission-claimed', 'submitted', 'outcome-unknown'].includes(row.status))).toEqual([])
    expect(await lamports(trader.address)).toBe(before)
    expect((await walletLog(browser)).filter(e => e.kind === 'transaction')).toEqual([])
    await approvals.off()
    await ownerStage({ stage: 'open-trading' })
    approvals = await approveSignatures(browser)
    await app.open(`/hooks/token/${coin.mint}`)
    await startTrade(screen, coin.symbol, 'buy', '0.02')
    const [after] = await finalizedOperations(trader.address, 'native-buy', 1), resumed = await expectNativeBuy(after, trader.address, coin, 20_000_000n)
    expectNoLegacyStack(resumed.tx); book(coin.mint, resumed)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'pauses')
    await approvals.off()
  })

  test('a delisted coin leaves discovery and shows its notice; buying is off, but holders still sell and the creator still claims', { timeout: 1_200_000 }, async ({ app, screen, browser }) => {
    const coin = tradeCoin(2), reason = 'impersonation' // one of the owner's five delisting reasons
    const holder = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    let approvals = await approveSignatures(browser)
    await startTrade(screen, coin.symbol, 'buy', '0.04')
    const [buy] = await finalizedOperations(holder.address, 'native-buy', 1), bought = await expectNativeBuy(buy, holder.address, coin, 40_000_000n)
    expectNoLegacyStack(bought.tx); book(coin.mint, bought)
    await approvals.off()
    await control('POST', '/owner/moderate', { action: 'delist', mint: coin.mint, reason })
    // Discovery: the Buy & sell list leaves it out (the others stay).
    await app.open('/hooks/trade')
    await expect(screen.getByText(`$${COINS[3].symbol}`).first()).toBeVisible({ timeout: 60_000 })
    expect(await screen.getByText(`$${coin.symbol}`).count()).toBe(0)
    // The coin page: the notice, buying off in the panel and refused by the server.
    approvals = await approveSignatures(browser)
    await app.open(`/hooks/token/${coin.mint}`)
    // The owner's wording for the reason, written out here independent of the code under test.
    await expect(screen.getByText(/^repo\.ing has delisted this coin: It pretends to be a person, project or brand it isn't\./)).toBeVisible({ timeout: 60_000 })
    await expect(screen.getByText(delistedNotice(reason))).toBeVisible()
    await expect(screen.getByText(DELISTED_BUY_TEXT)).toBeVisible()
    await expect(screen.getByRole('group', { name: 'Buy amounts' }).getByRole('button').first()).toBeDisabled()
    const client = new SiteClient(holder.buyer); await client.signIn()
    const refusal = await client.nativeQuote(await marketView(coin.mint), 'buy', 10_000_000n)
    expect(refusal.status).toBe(409)
    // The holder sells everything.
    await startTrade(screen, coin.symbol, 'sell', '100%')
    const [sell] = await finalizedOperations(holder.address, 'native-sell', 1), sold = await expectNativeSell(sell, holder.address, coin)
    expectNoLegacyStack(sold.tx); book(coin.mint, sold)
    expect(await coinBalance(coin.mint, holder.address)).toBe(0n)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'delisted coin')
    await approvals.off()
    // The creator claims.
    const { tx } = await claimViaUi({ app, screen, browser }, coin.creator, coin, accrued.get(coin.mint)!.creator)
    expectNoLegacyStack(tx)
    await recordMarkerLeaks(browser, stack.quoteMint as string, 'claim on a delisted coin')
  })

  test('off-menu fees and caps and a tampered opening price are refused by the server; the site\'s rate limits still hold', async () => {
    const creator = await freshWallet(5), client = new SiteClient(creator), address = creator.publicKey.toBase58()
    await client.signIn()
    const create = (creatorFeeBps: number, capBps: number) => client.post('/api/hook-lab/launch-requests', { action: 'create', requestId: crypto.randomUUID(), name: 'Tampered', symbol: 'TAMPER',
      creatorFeeBps, capBps, image: pngDataUrl(), description: '', x: '', website: '', telegram: '' })
    for (const [fee, cap] of [[150, 200], [0, 200], [100, 250], [100, 1000]]) {
      const reply = await create(fee, cap)
      expect(`${fee}/${cap}: ${reply.status}`).toMatch(new RegExp(`^${fee}/${cap}: 4\\d\\d$`))
    }
    expect(await launchRequests(address)).toEqual([])
    // A recorded on-menu coin, then reserves that try to change its fee or cap off the menu or set their own opening price.
    const recorded = await create(100, 200)
    expect(recorded.status).toBe(200)
    const reserve = (fields: Record<string, unknown>) => client.post('/api/hook-lab/native-launch', { action: 'reserve', operationId: crypto.randomUUID(), capBps: 200, label: 'tampered',
      name: 'Tampered', symbol: 'TAMPER', uri: recorded.json.request.uri, virtualQuote: '53251917070', creatorFeeBps: 100, ...fields })
    expect((await reserve({ creatorFeeBps: 150 })).status).toBe(409)
    expect((await reserve({ capBps: 250 })).status).toBe(409)
    const priced = await reserve({ virtualQuote: '1' })
    expect(priced.status).toBe(200)
    expect(priced.json.pricing.virtualQuote).toBe('53251917070') // the server's price at $105.63, never the request's
    expect((await operations(address)).filter(op => op.signature !== null)).toEqual([])
    // The launch-request action limit (10 per visitor per window) still answers 429.
    let limited: any = null
    for (let i = 0; i < 12 && !limited; i++) { const reply = await client.post('/api/hook-lab/launch-requests', { action: 'cancel', requestId: crypto.randomUUID() }); if (reply.status === 429) limited = reply }
    expect(limited?.json?.error).toBe('Too many requests. Try again later.')
  })

  test('the internal quote marker reached no page and no customer API response anywhere in the run', async () => {
    expect(markerLeaks).toEqual([])
  })
})

const pngDataUrl = () => `data:image/png;base64,${readFileSync(new URL('./fixtures/coin.png', import.meta.url)).toString('base64')}`
/** The largest sell share (100%, 50%, 25%) the panel accepts under its 10% price-impact limit. */
async function largestAcceptedShare(screen: any, symbol: string): Promise<string> {
  const main = screen.getByRole('button', { name: new RegExp(`^(Sign in and sell|Sell) \\$${symbol}$`) })
  const tooMuch = screen.getByText('That moves the price more than 10%. Try a smaller amount.')
  for (const share of ['100%', '50%', '25%']) {
    await screen.getByRole('group', { name: 'Sell amounts' }).getByRole('button', { name: share }).tap()
    const verdict = await until(`the panel to quote a ${share} sale`, async () => (await tooMuch.isVisible()) ? 'refused' : (await main.isEnabled()) ? 'ok' : null, { timeoutMs: 15_000 })
    if (verdict === 'ok') return share
  }
  throw new Error('the panel accepts no sell share under its price-impact limit')
}
