// The redesigned Hooks launch form (owner 2026-10-27) on a stack with production's open-creation settings: no fee menu
// (any whole creator fee up to 5%), caps 1/2/3/5%, a 0.05 SOL creation fee. Opening /hooks lands on the form; a 3% coin
// launches, trades and pays its creator exactly; the preview's split and the cost card match the server and the chain;
// an underfunded wallet and an expired review fail clearly and spend nothing they shouldn't.
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { control, freshWallet, stack, until } from './support/stack.ts'
import { approveSignatures } from './support/wallets.ts'
import { finalizedOperations, launchRequests, operations } from './support/db.ts'
import { lamports } from './support/chain.ts'
import { freshBuyerOnCoinPage, startTrade, tradeResult } from './support/flows.ts'
import { expectOpenLaunch, openCreationState } from './support/open-launch.ts'
import { fillAndReview, launchOpenCoinViaUi, openLaunchPage, signInForLaunch, type OpenLaunched } from './support/open-flows.ts'
import { expectNativeBuy, expectNativeSell } from './support/native-trades.ts'
import { claimViaUi } from './support/claims.ts'
import { receipt } from './support/chain.ts'
import { expectNoLegacyStack } from './support/stack-separation.ts'

const THREE = { name: 'Three Percent', symbol: 'THREE', creatorFeeBps: 300, capBps: 300 }
let coin: OpenLaunched
let accrued = 0n

describe('the Hooks launch form: straight to the form, a 3% coin end to end, clear failures', { serial: true }, () => {
  test('opening /hooks shows the form itself: your coin, trading rules, preview, the server’s costs, one Review launch', async ({ app, screen, browser }) => {
    const creator = await freshWallet(1)
    await openLaunchPage({ app, screen, browser }, creator)
    await app.open('/hooks')
    await expect(screen.getByLabel('Coin name')).toBeVisible()
    await expect(screen.getByRole('heading', { name: /Your coin/ })).toBeVisible()
    await expect(screen.getByRole('heading', { name: /Trading rules/ })).toBeVisible()
    await expect(screen.getByRole('button', { name: 'Review launch' })).toHaveCount(1) // the phone bar's twin is hidden on desktop
    const summary = () => screen.getByRole('complementary', { name: 'Coin preview and launch cost' }).textContent().then((s: string | null) => (s ?? '').replace(/\s+/g, ' '))
    expect(await summary()).toMatch(/Creation fee ?0\.05 SOL/)
    expect(await summary()).toMatch(/First buy ?After launch/)
    await screen.getByLabel('Creator fee', { exact: true }).fill('3')
    await until('the preview to show the 3% split', async () => /You receive ?2\.25%/.test(await summary()))
    expect(await summary()).toMatch(/You receive ?2\.25%/)
    expect(await summary()).toMatch(/repo\.ing receives ?0\.75%/)
    await expect(screen.getByText('At 3%: 2.25% to you + 0.75% to repo.ing of every buy and sell, in SOL.')).toBeVisible()
    expect(((await screen.getByLabel('Not available yet').textContent()) ?? '').replace(/\s+/g, ' ')).toMatch(/Burn ?Coming soon ?Holders Earn ?Coming soon/)
  })

  test('a 3% creator fee goes through reserve, review, launch and the chain as 300 bps', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    coin = await launchOpenCoinViaUi({ app, screen, browser }, THREE)
    expect(coin.reviewText).toMatch(/Creator fee ?On every buy and sell, in SOL ?3%/)
    expect(coin.reviewText).toMatch(/Creation fee 0\.05 SOL/)
    const [request] = await launchRequests(coin.address)
    expect([request.status, request.creator_fee_bps, request.cap_bps]).toEqual(['launched', 300, 300])
    expectOpenLaunch(await receipt(coin.launchOp.signature as string), { creator: coin.address, mint: coin.mint, state: await openCreationState(), feeBps: 300, capBps: 300 })
  })

  test('the 3% coin buys and sells with the exact split, then its creator claims exactly what trades accrued', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    const trading = { ...coin, symbol: THREE.symbol, creatorFeeBps: 300 }
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await startTrade(screen, THREE.symbol, 'buy', '0.2')
    const [buy] = await finalizedOperations(address, 'native-buy', 1), bought = await expectNativeBuy(buy, address, trading, 200_000_000n)
    expectNoLegacyStack(bought.tx); accrued += bought.creator
    expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
    await startTrade(screen, THREE.symbol, 'sell', '100%')
    const [sell] = await finalizedOperations(address, 'native-sell', 1), sold = await expectNativeSell(sell, address, trading)
    accrued += sold.creator
    await approvals.off()
    const { amount } = await claimViaUi({ app, screen, browser }, coin.creator, { ...coin, symbol: THREE.symbol }, accrued)
    expect(amount).toBe(accrued)
  })

  test('an underfunded wallet is told it needs more SOL and nothing is sent', { timeout: 600_000 }, async ({ app, screen, browser }) => {
    const creator = await freshWallet(0.01), address = creator.publicKey.toBase58()
    await openLaunchPage({ app, screen, browser }, creator)
    const approvals = await approveSignatures(browser)
    await fillAndReview(screen, { name: 'Too Poor', symbol: 'POOR', creatorFeeBps: 150, capBps: 100 })
    await signInForLaunch(screen)
    const before = await lamports(address)
    await screen.getByRole('button', { name: 'Sign and launch' }).tap()
    await expect(screen.getByRole('alert').filter({ hasText: /Launching needs at least .* SOL\. Add SOL, then try again\. Nothing was signed\./ })).toBeVisible({ timeout: 120_000 })
    expect((await operations(address)).filter(op => op.signature !== null)).toEqual([])
    expect(await lamports(address)).toBe(before)
    expect((await launchRequests(address)).length).toBe(0) // not even recorded: the creator can top up and start again
    await approvals.off()
  })

  test('an expired review is replaced, never signed: the wallet approves the fresh one and the launch lands once', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    const creator = await freshWallet(1), address = creator.publicKey.toBase58()
    await openLaunchPage({ app, screen, browser }, creator)
    let held = false
    const off = await browser.onDialog(async (dialog: any) => {
      // Hold the first transaction prompt well past the review's lifetime (60 s and 140 slots), then approve it. (A signature that arrives just before the deadline leaves a partial operation the server will not expire: a known open case.)
      if (!held && dialog.message.includes('Sign this transaction:')) { held = true; await new Promise(r => setTimeout(r, 150_000)) }
      await dialog.accept()
    })
    await fillAndReview(screen, { name: 'Late Signer', symbol: 'LATE', creatorFeeBps: 257, capBps: 500 })
    await signInForLaunch(screen)
    await screen.getByRole('button', { name: 'Sign and launch' }).tap()
    const live = screen.getByRole('heading', { name: '$LATE is live' }), retry = screen.getByRole('button', { name: 'Continue' })
    await until('the launch to finish or ask to continue', async () => (await live.count()) > 0 || (await retry.count()) > 0, { timeoutMs: 600_000 })
    if (await retry.count()) {
      console.log(`expired review: ${((await screen.getByRole('region', { name: /Launching/ }).textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 400)}`)
      await retry.tap()
    }
    await expect(live).toBeVisible({ timeout: 300_000 })
    const ops = await operations(address), sent = ops.filter(op => op.signature !== null)
    // The expired setup review was closed unsent; its replacement and the launch each landed once, and nothing else was sent.
    expect(ops.filter(op => op.status === 'expired').every(op => op.signature === null)).toBe(true)
    expect(sent.map(op => [op.stage, op.status])).toEqual([['preparation', 'finalized-success'], ['launch', 'finalized-success']])
    const sends = await control<Record<string, number>>('GET', '/rpc/sends')
    expect(sent.map(op => sends[op.signature as string])).toEqual([1, 1])
    expect((await launchRequests(address)).map(r => r.status)).toEqual(['launched'])
    await off()
  })
})
