// The owner's separation checks between the new (independent) stack and the legacy one:
//  (a) no transaction of the new flow invokes a legacy program (top level or inner) or names the legacy quote mint;
//  (b) the new flow shows no Add SOL or Withdraw control or step and records no funding operation;
//  (c) the internal quote marker never reaches a page's text or markup, nor any customer API response.
// The legacy identities are written out here on purpose, independent of the code under test.
import { expect } from 'e2e'
import type { VersionedTransactionResponse } from '@solana/web3.js'
import { accountKeys } from './chain.ts'
import { operations } from './db.ts'

export const LEGACY_PROGRAMS = Object.freeze({
  token: '2XoEWp8cF3kRXg74eVwPAyTFhVCAztn3V88komxAvr22', bridge: 'CtLkuFVitoXHTa86Hfp8KmfSDfqJaMYFWr6EGmQVsKb7',
  launch: 'E73c1hvwZr8hG4SaSLoTU1amZPqKKdzvToaYF2prCKft', swap: 'B2crxUdFwow36hy2KDbkiQro75mtLA4cN4pwDeQpZJwk', gate: 'BdAaDVeqX1gvwJ7rLyUY7rGm7qnf1h8sBxHfwKTzjFxb',
})
export const LEGACY_QUOTE_MINT = 'A49oVhX22ExMwTEtFC6Y8nhBdZ4LJDGhdXLDn4c2f59i'

/** Every program the transaction ran: each top-level instruction's program and every inner (CPI) instruction's program. */
export function invokedPrograms(tx: VersionedTransactionResponse): Set<string> {
  const keys = accountKeys(tx), out = new Set<string>()
  for (const ix of tx.transaction.message.compiledInstructions) out.add(keys[ix.programIdIndex])
  for (const group of tx.meta?.innerInstructions ?? []) for (const ix of group.instructions) out.add(keys[ix.programIdIndex])
  return out
}

/** (a): none of the legacy programs ran, and the legacy quote mint is not among the account keys (static or looked up). */
export function expectNoLegacyStack(tx: VersionedTransactionResponse): void {
  const ran = invokedPrograms(tx), keys = accountKeys(tx), signature = tx.transaction.signatures[0]
  const legacyRan = Object.entries(LEGACY_PROGRAMS).filter(([, id]) => ran.has(id)).map(([role, id]) => `${role} ${id}`)
  expect(`${signature} invoked legacy programs: [${legacyRan.join(', ')}]`).toBe(`${signature} invoked legacy programs: []`)
  expect(`${signature} names the legacy quote mint: ${keys.includes(LEGACY_QUOTE_MINT)}`).toBe(`${signature} names the legacy quote mint: false`)
}

/** (b): no Add SOL / Withdraw control or step on the page, and no funding operation recorded for the wallet. */
export async function expectNoFundingSurface(screen: any, wallet: string): Promise<void> {
  for (const name of [/^Withdraw$/, /Add SOL/i, /In Hook Lab/]) expect(await screen.getByText(name).count()).toBe(0)
  expect(await screen.getByRole('button', { name: /Withdraw|Add SOL/i }).count()).toBe(0)
  const funding = (await operations(wallet)).filter(row => ['wallet-fund', 'wallet-withdraw'].includes(row.stage))
  expect(funding.map(row => `${row.stage} ${row.status}`)).toEqual([])
}

/** Watches every same-origin /api/ response the page reads, across navigations (sessionStorage), for the marker: an init
 * script, so install it before the pages load. Counts responses and keeps the paths of any that contain the marker. */
export async function watchCustomerApi(browser: { addInitScript(script: (arg: any) => void, arg: unknown): Promise<void> }, marker: string): Promise<void> {
  await browser.addInitScript((needle: string) => {
    const w = window as any
    if (w.__e2eApiWatch) return
    w.__e2eApiWatch = true
    const KEY = '__e2eApiWatch', read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? '{"responses":0,"leaks":[]}') } catch { return { responses: 0, leaks: [] } } }
    const original = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init)
      try {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
        if (url.origin === location.origin && url.pathname.startsWith('/api/')) response.clone().text().then(text => {
          const state = read(); state.responses++; if (text.includes(needle)) state.leaks.push(url.pathname); sessionStorage.setItem(KEY, JSON.stringify(state))
        }).catch(() => {})
      } catch { /* not a URL this watches */ }
      return response
    }
  }, marker)
}

/** (c), collected: where the marker showed up on the current page and in the customer API responses seen since the last
 * clearState, recorded (with `where`) instead of failing at once, so one leak does not hide the rest of the run. A final
 * test asserts the list is empty. Returns how many API responses were checked. */
export const markerLeaks: string[] = []
export async function recordMarkerLeaks(browser: { evaluate<T>(fn: () => T): Promise<T> }, marker: string, where: string): Promise<number> {
  const seen = await browser.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body?.innerText ?? '',
    watch: JSON.parse(sessionStorage.getItem('__e2eApiWatch') ?? '{"responses":0,"leaks":[]}') }))
  const leaks = [...(seen.html.includes(marker) ? ['page markup'] : []), ...(seen.text.includes(marker) ? ['page text'] : []), ...new Set<string>(seen.watch.leaks.map((p: string) => `API ${p}`))]
  for (const leak of leaks) markerLeaks.push(`${where}: ${leak}`)
  return seen.watch.responses
}

/** (c): no customer API response seen so far held the marker, and it is nowhere in the current page's text or markup (RSC
 * payloads included). Returns how many API responses were checked. */
export async function expectMarkerHidden(browser: { evaluate<T>(fn: () => T): Promise<T> }, marker: string): Promise<number> {
  const seen = await browser.evaluate(() => ({ html: document.documentElement.outerHTML, text: document.body?.innerText ?? '',
    watch: JSON.parse(sessionStorage.getItem('__e2eApiWatch') ?? '{"responses":0,"leaks":[]}') }))
  const leaks = [...(seen.html.includes(marker) ? ['page markup'] : []), ...(seen.text.includes(marker) ? ['page text'] : []), ...seen.watch.leaks.map((p: string) => `API ${p}`)]
  expect(`quote marker in: [${leaks.join(', ')}]`).toBe('quote marker in: []')
  return seen.watch.responses
}
