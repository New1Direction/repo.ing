// Browser steps shared by the suites: connecting the test wallet, the trade panel, and the guided launch signatures.
// Deterministic locators only (roles, labels, exact text).
import { expect } from 'e2e'
import type { Keypair } from '@solana/web3.js'
import { freshWallet, stack, until } from './stack.ts'
import { WALLET_NAME, asNewVisitor, useWallet } from './wallets.ts'

export async function connectWallet(screen: any, address: string): Promise<void> {
  await screen.getByRole('button', { name: 'Connect wallet' }).first().tap()
  await screen.getByRole('dialog').getByRole('button', { name: new RegExp(WALLET_NAME) }).tap()
  await expect(screen.getByRole('button', { name: new RegExp(`^Wallet ${address.slice(0, 4)}`) })).toBeVisible()
}

/** The coin's market as the site serves it to the trade panel (GET /api/hook-lab/market/<mint>). */
export async function marketView(mint: string): Promise<any> {
  const response = await fetch(new URL(`/api/hook-lab/market/${mint}`, stack.origin), { headers: { 'x-forwarded-for': '198.19.0.2' } })
  if (!response.ok) throw new Error(`market ${mint}: HTTP ${response.status}`)
  return (await response.json()).market
}

/** A fresh funded wallet on a coin's page, connected, as its own visitor (its own rate-limit bucket). */
export async function freshBuyerOnCoinPage({ app, screen, browser }: { app: any; screen: any; browser: any }, mint: string, sol = 10): Promise<{ buyer: Keypair; address: string }> {
  const buyer = await freshWallet(sol), address = buyer.publicKey.toBase58()
  await app.clearState()
  await asNewVisitor(browser)
  await useWallet(browser, buyer)
  await app.open(`/hooks/token/${mint}`)
  await connectWallet(screen, address)
  return { buyer, address }
}

/** Signs in from the trade panel before any amount is entered (one message signature, approved by the caller's dialog
 * handler), so the panel shows the signed-in buttons: a refused amount then disables "Buy $X" instead of offering sign-in. */
export async function signInOnPanel(screen: any): Promise<void> {
  const signIn = screen.getByRole('button', { name: 'Sign in with your wallet' })
  await signIn.tap()
  await expect(signIn).toBeHidden({ timeout: 60_000 })
}

/** Picks the side and amount on the coin page's panel. Returns the main button (not pressed). */
export async function prepareTrade(screen: any, symbol: string, side: 'buy' | 'sell', amount: string): Promise<any> {
  await screen.getByRole('tab', { name: side === 'buy' ? 'Buy' : 'Sell' }).tap()
  if (amount === 'Max' || amount.endsWith('%')) await screen.getByRole('group', { name: side === 'buy' ? 'Buy amounts' : 'Sell amounts' }).getByRole('button', { name: amount }).tap()
  else await screen.getByLabel(side === 'buy' ? 'You pay' : 'You sell').fill(amount)
  return screen.getByRole('button', { name: new RegExp(`^(Sign in and ${side}|${side === 'buy' ? 'Buy' : 'Sell'}( and graduate)?) \\$${symbol}$`) })
}

/** Starts one trade through the panel and returns the main button's label as it read before the press. */
export async function startTrade(screen: any, symbol: string, side: 'buy' | 'sell', amount: string): Promise<string> {
  const main = await prepareTrade(screen, symbol, side, amount)
  await expect(main).toBeEnabled({ timeout: 30_000 })
  const label = ((await main.textContent()) ?? '').trim()
  await main.tap()
  return label
}

/** The panel's result line, read after the chain and database have confirmed the trade. */
export async function tradeResult(screen: any, side: 'buy' | 'sell'): Promise<string> {
  const result = screen.getByText(side === 'buy' ? /^You bought / : / went straight to your wallet\.$/)
  await expect(result).toBeVisible({ timeout: 60_000 })
  return ((await result.textContent()) ?? '').trim()
}
