// A whole owner-approved native launch through the browser (the happy-path suite asserts each step in detail; this is
// the compact form other suites use to get a fresh coin): request, the owner's grant + bundle redeploy + invite, then the
// creator's preparation and launch signatures with the agent's co-signature.
import { expect } from 'e2e'
import type { Keypair } from '@solana/web3.js'
import { control, freshWallet, ownerAgent, until } from './stack.ts'
import { approveSignatures, asNewVisitor, useWallet } from './wallets.ts'
import { finalizedOperations, launchRequests, operations, type OperationRow } from './db.ts'
import { launchAccount, launchAddress, receipt } from './chain.ts'
import { connectWallet } from './flows.ts'

export interface Coin { name: string; symbol: string; capBps: number; creatorFeeBps: number }
export interface Launched { creator: Keypair; mint: string; launch: string; pool: string; preparation: OperationRow; launchOp: OperationRow }

/** One guided signature: tick the review box, sign in the wallet, let repo.ing add each remaining signature, then send. */
export async function signGuidedStage(screen: any, stage: 'preparation' | 'launch', beforeSign?: () => Promise<void>): Promise<void> {
  const accept = screen.getByLabel('I checked the amount and the coin details.')
  await expect(accept).toBeVisible({ timeout: 180_000 }) // a launch review waits for the owner agent's per-launch table
  if (beforeSign) await beforeSign()
  await accept.check()
  await screen.getByRole('button', { name: `Sign ${stage} in wallet` }).tap()
  const cosign = screen.getByRole('button', { name: 'Add repo.ing’s signature' }), send = screen.getByRole('button', { name: `Send ${stage} to Solana` })
  await until(`the ${stage} to collect every signature`, async () => {
    if (await send.isVisible()) return true
    if (await cosign.isVisible() && await cosign.isEnabled()) await cosign.tap()
    return false
  }, { timeoutMs: 180_000, intervalMs: 1000 })
  await send.tap()
}

export async function launchCoinViaUi({ app, screen, browser }: { app: any; screen: any; browser: any }, coin: Coin,
  { beforeLaunchSign }: { beforeLaunchSign?: (launchReview: OperationRow, creator: string) => Promise<void> } = {}): Promise<Launched> {
  const creator = await freshWallet(5), address = creator.publicKey.toBase58()
  await app.clearState()
  await asNewVisitor(browser)
  await useWallet(browser, creator)
  const approvals = await approveSignatures(browser)
  await app.open('/hooks/launch-review')
  await connectWallet(screen, address)
  await screen.getByLabel('Coin name').fill(coin.name)
  await screen.getByLabel('Ticker').fill(coin.symbol)
  await screen.getByLabel('Upload coin image').setInputFiles('fixtures/coin.png')
  await expect(screen.getByText('Looks good')).toBeVisible()
  await screen.getByRole('group', { name: 'Max per wallet' }).getByRole('button', { name: `${coin.capBps / 100}%` }).tap()
  await screen.getByRole('button', { name: 'Sign in and request launch' }).tap()
  await expect(screen.getByText('Waiting for approval')).toBeVisible({ timeout: 60_000 })
  // The owner: grant, the bundle redeploy the grant makes necessary (reported finding), then invite.
  const grant = await control<{ signature: string }>('POST', '/owner/customer-grant', { creator: address })
  expect((await receipt(grant.signature)).meta?.err).toBeNull()
  await control('POST', '/site/restart', { recollect: true })
  expect((await control<{ drifted: string[] }>('GET', '/site/bundle-drift')).drifted).toEqual([])
  await app.open('/hooks/launch-review')
  await expect(screen.getByText('Waiting for approval')).toBeVisible({ timeout: 60_000 })
  await ownerAgent('invite 1', /^Invited until /)
  await expect(screen.getByText(`You’re invited. Launch $${coin.symbol} now.`)).toBeVisible({ timeout: 30_000 })
  await screen.getByRole('button', { name: 'Reserve address' }).tap()
  await screen.getByRole('button', { name: 'Review preparation' }).tap()
  await signGuidedStage(screen, 'preparation')
  const [preparation] = await finalizedOperations(address, 'preparation', 1)
  await expect(screen.getByText('Preparation is confirmed. One more signature to go.')).toBeVisible({ timeout: 60_000 })
  await screen.getByRole('button', { name: 'Continue to the launch signature' }).tap()
  await signGuidedStage(screen, 'launch', beforeLaunchSign && (async () => {
    const review = await until('the launch review row', async () => (await operations(address, 'launch'))[0])
    await beforeLaunchSign(review, address)
  }))
  const [launchOp] = await finalizedOperations(address, 'launch', 1)
  await expect(screen.getByText('Your coin is live.')).toBeVisible({ timeout: 60_000 })
  expect((await launchRequests(address))[0].status).toBe('launched')
  const mint = launchOp.resolved_request.mint as string, launch = launchAddress(mint)
  const pool = (await launchAccount(launch)).value.pool.toBase58()
  await approvals.off()
  return { creator, mint, launch, pool, preparation, launchOp }
}
