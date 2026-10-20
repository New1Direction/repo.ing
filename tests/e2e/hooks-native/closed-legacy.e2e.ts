// The owner's closed-old-programs proof (2026-10-19): with the legacy stack's launch and swap programs CLOSED on the local
// chain (as the owner may close them on mainnet), and the site restarted on the bundles it was deployed with, our own
// stack still works end to end: an open launch by a fresh creator, a buy and a sell in plain SOL, the creator's claim.
// No page or API the customer reaches fails because of the closed programs, and the quote marker never shows.
// The driver (self-serve stack, ELF check, `solana program close`, site restart) runs before this file; it asserts the
// programs' closed state first and runs only against such a stack (HOOKS_E2E_STACK of mode self-serve).
import { PublicKey } from '@solana/web3.js'
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { connection, stack } from './support/stack.ts'
import { approveSignatures } from './support/wallets.ts'
import { finalizedOperations } from './support/db.ts'
import { receipt } from './support/chain.ts'
import { freshBuyerOnCoinPage, startTrade, tradeResult } from './support/flows.ts'
import { expectOpenLaunch, openCreationState } from './support/open-launch.ts'
import { launchOpenCoinViaUi, type OpenLaunched } from './support/open-flows.ts'
import { expectNativeBuy, expectNativeSell } from './support/native-trades.ts'
import { claimViaUi } from './support/claims.ts'
import { LEGACY_PROGRAMS, expectNoLegacyStack, markerLeaks, recordMarkerLeaks } from './support/stack-separation.ts'
import { sol } from '../../../app/lib/hooklab-trade-math.mjs'

const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111'
const CLOSED = Object.freeze({ launch: LEGACY_PROGRAMS.launch, swap: LEGACY_PROGRAMS.swap })
const COIN = { name: 'After Close', symbol: 'AFTRCLS', creatorFeeBps: 100, capBps: 500 }
let coin: OpenLaunched & { creatorFeeBps: number; symbol: string }
let creatorFees = 0n
const marker = () => stack.quoteMint as string

describe('the legacy launch and swap programs closed: our own stack still launches, trades and claims', { serial: true }, () => {
  test('the legacy launch and swap programs are closed on chain; their program data is gone', async () => {
    expect(stack.mode).toBe('self-serve')
    for (const [role, id] of Object.entries(CLOSED)) {
      const programData = PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], new PublicKey(LOADER))[0]
      const data = await connection.getAccountInfo(programData, 'finalized')
      expect(`${role} ${id} program data: ${data === null ? 'closed' : `${data.data.length} bytes`}`).toBe(`${role} ${id} program data: closed`)
    }
    // Our own stack's programs are untouched.
    for (const id of Object.values(stack.programs!)) expect((await connection.getAccountInfo(new PublicKey(id), 'finalized'))?.executable).toBe(true)
  })

  test('a fresh creator launches on our own stack', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    const state = await openCreationState()
    const launched = await launchOpenCoinViaUi({ app, screen, browser }, COIN)
    const prep = await receipt(launched.preparation.signature as string), tx = await receipt(launched.launchOp.signature as string)
    expectOpenLaunch(tx, { creator: launched.address, mint: launched.mint, state, feeBps: COIN.creatorFeeBps, capBps: COIN.capBps })
    expectNoLegacyStack(prep); expectNoLegacyStack(tx)
    coin = { ...launched, creatorFeeBps: COIN.creatorFeeBps, symbol: COIN.symbol }
    await app.open(`/hooks/token/${coin.mint}`)
    await expect(screen.getByRole('tab', { name: 'Buy' })).toBeVisible({ timeout: 60_000 })
    await recordMarkerLeaks(browser, marker(), 'launch after the close')
  })

  test('a holder buys and sells in plain SOL', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await startTrade(screen, coin.symbol, 'buy', '0.1')
    const [buy] = await finalizedOperations(address, 'native-buy', 1), bought = await expectNativeBuy(buy, address, coin, 100_000_000n)
    expectNoLegacyStack(bought.tx); creatorFees += bought.creator
    expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
    await startTrade(screen, coin.symbol, 'sell', '100%')
    const [sell] = await finalizedOperations(address, 'native-sell', 1), sold = await expectNativeSell(sell, address, coin)
    expectNoLegacyStack(sold.tx); creatorFees += sold.creator
    expect(await tradeResult(screen, 'sell')).toBe(`${sol(sold.received, 6)} went straight to your wallet.`)
    await recordMarkerLeaks(browser, marker(), 'buy and sell after the close')
    await approvals.off()
  })

  test('the creator claims exactly the fees the trades paid', async ({ app, screen, browser }) => {
    const { tx, amount } = await claimViaUi({ app, screen, browser }, coin.creator, coin, creatorFees)
    expectNoLegacyStack(tx); expect(amount).toBe(creatorFees)
    await recordMarkerLeaks(browser, marker(), 'claim after the close')
  })

  test('the customer pages and public APIs answer without a server error', async ({ app, screen, browser }) => {
    for (const page of ['/hooks', '/hooks/trade', '/hooks/mine', '/hooks/launch-review', `/hooks/token/${coin.mint}`]) {
      await app.open(page)
      await expect(screen.getByRole('main')).toBeVisible({ timeout: 60_000 })
      await recordMarkerLeaks(browser, marker(), `page ${page}`)
    }
    const statuses: string[] = []
    for (const route of [`/api/hook-lab/market/${coin.mint}`, `/api/hook-lab/market/${coin.mint}?wallet=${coin.address}`, `/api/hook-lab/market/${coin.mint}/trades`,
      '/api/hook-lab/launch-requests']) {
      const response = await fetch(new URL(route, stack.origin), { headers: { 'x-forwarded-for': '198.19.0.3' } })
      const text = await response.text()
      statuses.push(`${route} ${response.status}`)
      expect(`${route} names the marker: ${text.includes(marker())}`).toBe(`${route} names the marker: false`)
    }
    expect(statuses.filter(line => / 5\d\d$/.test(line))).toEqual([])
  })

  test('the internal quote marker reached no page and no customer API response', async () => {
    expect(markerLeaks).toEqual([])
  })
})
