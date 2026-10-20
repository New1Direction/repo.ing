// The creator's fee claim through the browser (the coin page's claim card), checked exactly against the chain: what the
// card says the trades paid, the one-signature network fee, the CreatorFeesClaimedSol event, the lamports moved and the
// launch account left at its rent minimum.
import { expect } from 'e2e'
import type { Keypair } from '@solana/web3.js'
import { connection, control } from './stack.ts'
import { approveSignatures, asNewVisitor, useWallet } from './wallets.ts'
import { finalizedOperations } from './db.ts'
import { big, events, lamportDelta, launchAccount, one, receipt, verifySignatures } from './chain.ts'
import { expectSettlementIsReceipt } from './settlement.ts'
import { connectWallet } from './flows.ts'
import { sol } from '../../../../app/lib/hooklab-trade-math.mjs'

const NETWORK_FEE = 5000n
export const claimText = (lamports: bigint) => sol(lamports, lamports < 1_000_000n ? 9 : 6)
/** What the creator can claim now: the launch account's lamports above its rent-exempt minimum. */
export async function claimable(launch: string): Promise<bigint> {
  const account = await launchAccount(launch)
  return account.lamports - BigInt(await connection.getMinimumBalanceForRentExemption(account.raw.length, 'finalized'))
}

/** Signs the creator in, opens the coin page and claims through its card. `expected`: the creator fees the test summed
 * from the trades' events, which the claim must equal. Returns the claim's receipt. */
export async function claimViaUi({ app, screen, browser }: { app: any; screen: any; browser: any }, creator: Keypair,
  coin: { mint: string; launch: string; symbol: string }, expected: bigint, nth = 1) {
  const address = creator.publicKey.toBase58()
  await app.clearState()
  await asNewVisitor(browser)
  await useWallet(browser, creator)
  const approvals = await approveSignatures(browser)
  await app.open('/hooks/wallet-identity')
  await connectWallet(screen, address)
  await screen.getByRole('button', { name: /^Sign in with wallet$|^Connect wallet and sign in$/ }).first().tap()
  await expect(screen.getByText(new RegExp(`^Signed in as ${address.slice(0, 4)}`)).first()).toBeVisible()
  const before = await launchAccount(coin.launch), amount = await claimable(coin.launch)
  expect(amount).toBe(expected)
  await app.open(`/hooks/token/${coin.mint}`)
  await expect(screen.getByText(`Trades of $${coin.symbol} have paid you ${claimText(amount)}. After the network fee, ${claimText(amount - NETWORK_FEE)} comes to this wallet.`)).toBeVisible({ timeout: 60_000 })
  await screen.getByRole('button', { name: `Claim ${claimText(amount - NETWORK_FEE)}` }).tap()
  const ops = await finalizedOperations(address, 'native-claim', nth), op = ops[nth - 1]
  const tx = await receipt(op.signature as string)
  expect(tx.meta?.err).toBeNull(); verifySignatures(tx, address)
  expect(big(one(events(tx), 'CreatorFeesClaimedSol').lamports)).toBe(amount)
  expect(BigInt(tx.meta!.fee)).toBe(NETWORK_FEE)
  expect(lamportDelta(tx, address)).toBe(amount - NETWORK_FEE)
  expect(lamportDelta(tx, coin.launch)).toBe(-amount)
  expect((await launchAccount(coin.launch)).lamports).toBe(before.lamports - amount)
  expectSettlementIsReceipt(op, tx)
  expect((await control<Record<string, number>>('GET', '/rpc/sends'))[op.signature as string]).toBe(1)
  await expect(screen.getByText(`Claimed: ${claimText(amount - NETWORK_FEE)} is in your wallet.`)).toBeVisible({ timeout: 60_000 })
  await approvals.off()
  return { tx, amount }
}
