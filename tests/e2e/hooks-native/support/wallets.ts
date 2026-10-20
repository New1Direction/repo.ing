// Putting a disposable key into the page as the Wallet Standard test wallet, approving its signature prompts one by one,
// and reading back what it signed.
import { createPublicKey, verify } from 'node:crypto'
import type { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { installTestWallet } from './test-wallet.ts'

export const WALLET_NAME = 'E2E Test Wallet'
export interface WalletLogEntry { kind: 'message' | 'transaction'; address: string; signature: string; messageBase64?: string; messageSha256?: string }

type Browser = {
  addInitScript(script: (arg: any) => void, arg: unknown): Promise<void>
  evaluate<T>(fn: () => T): Promise<T>
  onDialog(handler: (dialog: { message: string; accept(): Promise<void>; dismiss(): Promise<void> }) => void | Promise<void>): Promise<() => Promise<void>>
}

type Routable = { route(pattern: string, handler: (route: { request: { headers: Readonly<Record<string, string>> }; continue(overrides?: { headers?: Record<string, string> }): Promise<void> }) => Promise<void>): Promise<void> }
let visitors = Math.floor(Math.random() * 60_000)
/**
 * Each disposable wallet is its own visitor. The site rate-limits per client address (src/client-address.mjs: the
 * address Cloudflare or a proxy forwards); every local request comes from loopback, so without this all wallets would
 * share one bucket. Each call gives the browser's API requests a new RFC 2544 benchmark address (198.18.0.0/15).
 */
export async function asNewVisitor(browser: Routable): Promise<string> {
  const n = visitors++, address = `198.18.${(n >> 8) & 255}.${n & 255}`
  await browser.route('**/api/hook-lab/**', route => route.continue({ headers: { ...route.request.headers, 'x-forwarded-for': address } }))
  return address
}
/** Every later page load gets the wallet, signing with this key (the latest key added wins). */
export async function useWallet(browser: Browser, wallet: Keypair): Promise<void> {
  await browser.addInitScript(installTestWallet, { seedBase64: Buffer.from(wallet.secretKey.subarray(0, 32)).toString('base64'), address: wallet.publicKey.toBase58(), name: WALLET_NAME })
}
/** Accepts every wallet prompt and records each one's text; only the test wallet's own prompts are accepted. */
export async function approveSignatures(browser: Browser): Promise<{ prompts: string[]; off: () => Promise<void> }> {
  const prompts: string[] = []
  const off = await browser.onDialog(async dialog => {
    prompts.push(dialog.message)
    if (dialog.message.startsWith('E2E TEST WALLET')) await dialog.accept(); else await dialog.dismiss()
  })
  return { prompts, off }
}
export async function walletLog(browser: Browser): Promise<WalletLogEntry[]> {
  return browser.evaluate(() => (window as any).__e2eWalletLog ?? [])
}
/** An ed25519 check in Node of a message signature the page produced. */
export function verifyMessageSignature(entry: WalletLogEntry): boolean {
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(bs58.decode(entry.address)).toString('base64url') }, format: 'jwk' })
  return verify(null, Buffer.from(entry.messageBase64 as string, 'base64'), key, Buffer.from(bs58.decode(entry.signature)))
}
