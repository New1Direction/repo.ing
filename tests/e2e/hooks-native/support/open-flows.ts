// The self-serve launch through the browser, as a creator does it on /hooks/launch-review with open launches on: connect
// the wallet, fill in the coin and pick a fee and a cap from the chain's menus, review the costs, sign in, then "Sign and
// launch" (two wallet approvals: the setup, then the launch; repo.ing adds the coin address's signature) until the coin
// is live. No owner, no invite, no grant. Returns the coin and its two finalized operations.
import { expect } from 'e2e'
import type { Keypair } from '@solana/web3.js'
import { freshWallet, stack } from './stack.ts'
import { approveSignatures, asNewVisitor, useWallet } from './wallets.ts'
import { finalizedOperations, launchRequests, type OperationRow } from './db.ts'
import { launchAccount, launchAddress } from './chain.ts'
import { connectWallet } from './flows.ts'
import { watchCustomerApi } from './stack-separation.ts'
import { percent } from '../../../../src/hooklab-launch-menus.mjs'

export interface OpenCoin { name: string; symbol: string; capBps: number; creatorFeeBps: number }
export interface OpenLaunched { creator: Keypair; address: string; mint: string; launch: string; pool: string; preparation: OperationRow; launchOp: OperationRow; reviewText: string }

/** Opens the launch page as a fresh visitor with the given wallet (and the customer-API watch for the quote marker). */
export async function openLaunchPage({ app, screen, browser }: { app: any; screen: any; browser: any }, wallet: Keypair): Promise<void> {
  await app.clearState()
  await asNewVisitor(browser)
  await watchCustomerApi(browser, stack.quoteMint as string)
  await useWallet(browser, wallet)
  await app.open('/hooks/launch-review')
  await connectWallet(screen, wallet.publicKey.toBase58())
}

/** Fills in the coin and goes to the review screen. Returns the review section's text. */
export async function fillAndReview(screen: any, coin: OpenCoin): Promise<string> {
  await screen.getByLabel('Coin name').fill(coin.name)
  await screen.getByLabel('Ticker').fill(coin.symbol)
  await screen.getByLabel('Upload coin image').setInputFiles('fixtures/coin.png')
  await expect(screen.getByText('Looks good')).toBeVisible()
  await screen.getByRole('group', { name: 'Max per wallet' }).getByRole('button', { name: percent(coin.capBps), exact: true }).tap()
  await screen.getByRole('group', { name: 'Creator fee' }).getByRole('button', { name: percent(coin.creatorFeeBps), exact: true }).tap()
  await screen.getByRole('button', { name: 'Review your launch' }).tap()
  const review = screen.getByRole('region', { name: 'Check your launch' })
  await expect(review).toBeVisible()
  return ((await review.textContent()) ?? '').replace(/\s+/g, ' ').trim()
}

/** Signs in from the review screen when the page asks (a free message signature). */
export async function signInForLaunch(screen: any): Promise<void> {
  const signIn = screen.getByRole('button', { name: 'Sign in with wallet' })
  if (await signIn.count()) { await signIn.tap(); await expect(signIn).toBeHidden({ timeout: 60_000 }) }
}

/** A whole ownerless launch by a fresh creator, approving every wallet prompt. */
export async function launchOpenCoinViaUi(ctx: { app: any; screen: any; browser: any }, coin: OpenCoin, { sol = 5 } = {}): Promise<OpenLaunched> {
  const { screen, browser } = ctx, creator = await freshWallet(sol), address = creator.publicKey.toBase58()
  await openLaunchPage(ctx, creator)
  const approvals = await approveSignatures(browser)
  const reviewText = await fillAndReview(screen, coin)
  await signInForLaunch(screen)
  await screen.getByRole('button', { name: 'Sign and launch' }).tap()
  await expect(screen.getByRole('heading', { name: `$${coin.symbol} is live` })).toBeVisible({ timeout: 300_000 })
  const [preparation] = await finalizedOperations(address, 'preparation', 1), [launchOp] = await finalizedOperations(address, 'launch', 1)
  const mint = launchOp.resolved_request.mint as string, launch = launchAddress(mint)
  const pool = (await launchAccount(launch)).value.pool.toBase58()
  expect((await launchRequests(address)).map(r => [r.source, r.status])).toEqual([['open', 'launched']])
  await approvals.off()
  return { creator, address, mint, launch, pool, preparation, launchOp, reviewText }
}
