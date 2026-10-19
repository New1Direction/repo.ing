// The graduation boundaries on one native coin, asserted from chain and database: fill the curve from Node until one
// capped buy can finish it, then the overshoot is refused (panel and server), one lamport short lands without
// graduating, and the panel's Max is the exact final fill that graduates in the same transaction.
import { expect } from 'e2e'
import { SiteClient } from './site-client.ts'
import { freshWallet } from './stack.ts'
import { approveSignatures } from './wallets.ts'
import { finalizedOperations, operations } from './db.ts'
import { accountKeys, big, events, launchAccount, poolAccount, programInstructions, receipt } from './chain.ts'
import { freshBuyerOnCoinPage, marketView, prepareTrade, signInOnPanel, startTrade } from './flows.ts'
import { finalFillLamports } from '../../../../src/hooklab-graduation.mjs'
import { estimateTrade, maxBuyLamports, sol } from '../../../../app/lib/hooklab-trade-math.mjs'

export interface BoundaryCoin { mint: string; launch: string; pool: string; symbol: string }
const MAX_FILL_ROUNDS = 40
const sends = async (control: (method: 'GET', route: string) => Promise<Record<string, number>>) => control('GET', '/rpc/sends')
const solText = (lamports: bigint) => `${lamports / 1_000_000_000n}.${(lamports % 1_000_000_000n).toString().padStart(9, '0')}`

/** Buys from fresh Node wallets (real signatures, the same API) until one capped buy can finish the curve. onFilled is
 * called with each settled fill (its operation and the filler's address) for the caller's own exact checks. Graduation
 * is read from chain state and each fill's finalized receipt, never from a page: a coin that graduated takes no more
 * fillers, and a fill that left the curve's quote reserve where it was stops the loop (no silent spinning). */
export async function fillUntilOneBuyLeft(coin: { mint: string; launch: string; pool: string }, onFilled?: (op: any, address: string) => Promise<void>): Promise<number> {
  let reserve: bigint | null = null
  for (let round = 1; ; round++) {
    if (round > MAX_FILL_ROUNDS) throw new Error(`the curve did not come within one buy of its end in ${MAX_FILL_ROUNDS} fill rounds`)
    const [launch, pool] = await Promise.all([launchAccount(coin.launch), poolAccount(coin.pool)])
    if (launch.value.status !== 0 || pool.value.curve !== true) throw new Error(`the coin graduated after ${round - 1} fills (launch status ${launch.value.status}, curve ${pool.value.curve}); no more buyers were added`)
    const now = big(pool.value.quote_reserve)
    if (reserve !== null && now <= reserve) throw new Error(`fill ${round - 1} made no progress: the curve's quote reserve stayed at ${now} lamports`)
    reserve = now
    const market = await marketView(coin.mint), fill = finalFillLamports(market), max = maxBuyLamports(market, 0n)
    if (fill !== null && max === fill) return round - 1
    if (max === null) throw new Error(`fill round ${round}: no buy fits any more (final fill ${fill}); the curve is stuck short of its end`)
    const filler = new SiteClient(await freshWallet(120))
    await filler.signIn()
    const quote = await filler.nativeQuote(market, 'buy', max * 98n / 100n)
    if (quote.status !== 200) throw new Error(`fill round ${round}: review refused ${JSON.stringify(quote.json)}`)
    const op = await filler.signAndSettle(quote.signingId)
    if (op?.status !== 'finalized-success') throw new Error(`fill round ${round}: ${op?.status} ${op?.signature}`)
    if (events(await receipt(op.signature)).some(e => e.name === 'Graduated')) throw new Error(`fill round ${round} graduated the coin (${op.signature}); a fill must never graduate`)
    await onFilled?.(op, filler.address)
  }
}

export async function graduationBoundaries(ctx: { app: any; screen: any; browser: any }, coin: BoundaryCoin,
  control: (method: any, route: string, body?: unknown) => Promise<any>): Promise<string[]> {
  const { app, screen, browser } = ctx, refusals: string[] = []
  const graduationQuote = big((await launchAccount(coin.launch)).value.graduation_quote)
  await fillUntilOneBuyLeft(coin)
  const market = await marketView(coin.mint), fill = finalFillLamports(market) as bigint
  // Overshoot: a signed-in buyer's panel refuses one lamport more than the exact fill (the main button is disabled)...
  const { buyer, address } = await freshBuyerOnCoinPage(ctx, coin.mint, 200)
  const approvals = await approveSignatures(browser)
  await signInOnPanel(screen)
  await prepareTrade(screen, coin.symbol, 'buy', solText(fill + 1n))
  await expect(screen.getByRole('alert').filter({ hasText: `That’s more than this coin’s curve has left: ${sol(fill, 6)} buys all of it and graduates the coin.` })).toBeVisible()
  await expect(screen.getByRole('button', { name: `Buy $${coin.symbol}`, exact: true })).toBeDisabled()
  // ...and so does the server. Each tampered request carries an honest minimum output (the estimate of the nearest valid
  // amount), so only the boundary itself can be the reason it is refused.
  const client = new SiteClient(buyer)
  await client.signIn()
  const minOut = (amount: bigint) => String(estimateTrade(market, { side: 'buy', amount, coinBalance: 0n, slippageBps: 300 }).minAmountOut)
  for (const [amount, graduate, honest] of [[fill + 1n, true, fill], [fill - 1n, true, fill - 1n], [fill, false, fill]] as [bigint, boolean, bigint][]) {
    const reply = await client.nativeQuote(market, 'buy', amount, { graduate, override: { minAmountOut: minOut(honest) } })
    expect(`${amount}/${graduate}: ${reply.status}`).toBe(`${amount}/${graduate}: 409`)
    refusals.push(`${amount === fill ? 'fill' : amount > fill ? 'fill+1' : 'fill-1'} graduate=${graduate}: ${reply.json?.error ?? reply.json?.blockers?.[0]?.message ?? ''}`)
  }
  expect((await operations(address, 'native-buy')).filter(row => row.signature !== null)).toEqual([])
  // One lamport short (no graduate flag): it lands, and the coin does not graduate.
  const short = await client.nativeQuote(market, 'buy', fill - 1n)
  expect(short.status).toBe(200)
  const shortOp = await client.signAndSettle(short.signingId)
  expect(shortOp.status).toBe('finalized-success')
  expect((await launchAccount(coin.launch)).value.status).toBe(0)
  expect(big((await poolAccount(coin.pool)).value.quote_reserve) < graduationQuote).toBe(true)
  // The exact fill: the panel's Max on the remaining curve, one transaction that runs swap_v2 then graduate.
  await app.open(`/hooks/token/${coin.mint}`)
  const label = await startTrade(screen, coin.symbol, 'buy', 'Max')
  expect(label).toBe(`Buy and graduate $${coin.symbol}`)
  const rows = await finalizedOperations(address, 'native-buy', 2), op = rows[1], tx = await receipt(op.signature as string)
  expect(op.resolved_request.graduate).toBe(true)
  expect(op.first_finalized.graduated).toBe(true)
  expect(tx.transaction.message.header.numRequiredSignatures).toBe(1)
  expect(accountKeys(tx)[0]).toBe(address)
  expect(programInstructions(tx)).toEqual(['swap:swap_v2', 'launch:graduate'])
  expect(events(tx).filter(e => e.name === 'Graduated').length).toBe(1)
  expect((await launchAccount(coin.launch)).value.status).toBe(1)
  expect(big((await poolAccount(coin.pool)).value.quote_reserve)).toBe(graduationQuote)
  expect(big(op.first_finalized.quote.after.quoteReserve)).toBe(graduationQuote)
  expect((await sends(control))[op.signature as string]).toBe(1)
  await approvals.off()
  return refusals
}
