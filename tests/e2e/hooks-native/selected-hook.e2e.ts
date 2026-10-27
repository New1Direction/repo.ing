// Genuine nongate acceptance. Never import/relabel the self-serve gate suite as
// selected-hook evidence. The hook_tester default script returns no token fees;
// real callbacks must run, and receipts (not a deterministic arbitrary-hook fee
// estimate) are the final truth. External registry setup uses its public API.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { connection, control, db, freshWallet, stack, until } from './support/stack.ts'
import { approveSignatures, walletLog } from './support/wallets.ts'
import { finalizedOperations, launchRequests, operations } from './support/db.ts'
import { accountKeys, big, coinBalance, events, lamportDelta, launchAccount, launchAddress, poolAccount, programInstructions, receipt, verifySignatures } from './support/chain.ts'
import { openLaunchPage, signInForLaunch, type OpenLaunched } from './support/open-flows.ts'
import { freshBuyerOnCoinPage, startTrade as startPanelTrade, tradeResult } from './support/flows.ts'
import { expectNativeBuy, expectNativeSell } from './support/native-trades.ts'
import { fillUntilOneBuyLeft } from './support/boundaries.ts'
import { claimViaUi } from './support/claims.ts'
import { expectNoLegacyStack, expectNoFundingSurface } from './support/stack-separation.ts'
import { SiteClient } from './support/site-client.ts'
import { expectSelectedInvoked, initializeSelectedRegistry, scriptCalls, selected } from './support/selected-hook.ts'

const SYMBOL = 'NONGATE', FEE = 100
let coin: OpenLaunched
let creatorAccrued = 0n, platformAccrued = 0n
const book = (checked: { creator: bigint; platform: bigint }) => { creatorAccrued += checked.creator; platformAccrued += checked.platform }
const tradingCoin = () => ({ ...coin, symbol: SYMBOL, creatorFeeBps: FEE })

async function startTrade(screen: any, symbol: string, side: 'buy' | 'sell', amount: string, app?: any) {
  const label = await startPanelTrade(screen, symbol, side, amount)
  await expect(screen.getByLabel('Exact selected-hook trade review')).toBeVisible({ timeout: 60_000 })
  if (app) {
    await screen.getByRole('button', { name: 'Approve exact trade', exact: true }).scrollIntoView()
    await app.screenshot('selected-hook-exact-trade-review')
  }
  await screen.getByRole('button', { name: 'Approve exact trade', exact: true }).tap()
  return label
}

describe('immutable selected hook on repaired independent stack (not max-wallet gate)', { serial: true }, () => {
  test('local validator really contains the repaired programs and the immutable nongate pin', async () => {
    const { pin } = selected()
    expect((await control('GET', '/health')).agent).toBe(false)
    expect(pin.program === stack.programs!.gate).toBe(false)
    const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
    const pd = PublicKey.findProgramAddressSync([new PublicKey(pin.program).toBuffer()], loader)[0]
    const [program, data] = await connection.getMultipleAccountsInfo([new PublicKey(pin.program), pd], 'finalized')
    expect(program?.executable).toBe(true)
    expect(program?.owner.toBase58()).toBe(loader.toBase58())
    expect(Buffer.from(program!.data).subarray(4).equals(pd.toBuffer())).toBe(true)
    const bytes = Buffer.from(data!.data)
    expect(bytes.readUInt32LE()).toBe(3)
    expect(bytes[12]).toBe(0) // immutable, not merely promised by the UI
    expect(bytes.length).toBe(45 + pin.elfLength)
    expect(createHash('sha256').update(bytes.subarray(45)).digest('hex')).toBe(pin.elfSha256)
    for (const [role, digest] of Object.entries({ launch: '3bb8529298e831cf17324ed4b975d4aabc3138c15895237cbee24515fdd10207', swap: '3b910ec4ce65051f0cdce1eaf6cda8fff27edea3790f674e8d46482783b82d32' })) {
      const address = stack.programs![role as 'launch' | 'swap']
      const account = await connection.getAccountInfo(PublicKey.findProgramAddressSync([new PublicKey(address).toBuffer()], loader)[0], 'finalized')
      expect(createHash('sha256').update(Buffer.from(account!.data).subarray(45)).digest('hex')).toBe(digest)
    }
  })

  test('creator selects the nongate program, prepares its registry, then signs actual app preparation and launch', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    const creator = await freshWallet(10), address = creator.publicKey.toBase58(), hook = selected()
    await openLaunchPage({ app, screen, browser }, creator)
    const approvals = await approveSignatures(browser)
    await screen.getByLabel('Coin name').fill('Immutable Nongate')
    await screen.getByLabel('Ticker').fill(SYMBOL)
    await screen.getByLabel('Upload coin image').setInputFiles('fixtures/coin.png')
    await expect(screen.getByText('Looks good')).toBeVisible()
    await screen.getByLabel('Hook configuration').selectOption({ value: 'selected' })
    await screen.getByLabel('Immutable hook program').fill(hook.pin.program)
    await screen.getByLabel('Known token callback flags (1–255)').fill(String(hook.flags))
    await screen.getByRole('group', { name: 'Creator fee' }).getByRole('button', { name: '1%', exact: true }).tap()
    await app.screenshot('selected-hook-creator-configuration')
    await screen.getByRole('button', { name: 'Review launch' }).tap()
    const review = screen.getByRole('region', { name: 'Check your launch' })
    await expect(review).toBeVisible()
    const reviewText = (await review.textContent()) ?? ''
    expect(reviewText).toContain(hook.pin.program)
    expect(reviewText).toContain('No max-wallet gate')
    await signInForLaunch(screen)
    await screen.getByRole('button', { name: /^(Sign and launch|Check hook availability)$/ }).tap()
    // Reservation must preserve the same mint across the external hook handoff.
    // Read only public custody fields; never select sealed_signers or a key.
    const reserved = await until('selected registry handoff with a retained mint', async () => {
      const { rows } = await db.query('select mint, operation_id, preparation_request as prepared_request from hook_lab_native_signer_custody where owner_wallet=$1', [address])
      return rows.length === 1 && rows[0].prepared_request?.policyKind === 'selected-hook' ? rows[0] : null
    }, { timeoutMs: 60_000 })
    expect(reserved.prepared_request.selectedHook).toEqual({ program: hook.pin.program, flags: hook.flags })
    expect(reserved.prepared_request.capBps).toBe(0)
    expect((await walletLog(browser)).filter(x => x.kind === 'transaction')).toEqual([])
    const init = await initializeSelectedRegistry(creator, reserved.mint)
    expect((await receipt(init)).meta?.err).toBeNull()
    expect(await scriptCalls(reserved.mint)).toBe(0n)
    // The app must expose retry/recovery; do not replace its signing path with a
    // hand-built create_launch transaction when integration remains unavailable.
    await screen.getByRole('button', { name: /^(Continue|Sign and launch|Check hook availability)$/ }).tap()
    for (const stage of ['preparation', 'launch']) {
      await until(`exact selected ${stage} review`, async () => (await operations(address, stage)).find(op => op.status === 'reviewed'), { timeoutMs: 120_000 })
      await expect(screen.getByLabel('Exact selected-hook transaction review')).toBeVisible()
      await app.screenshot(`selected-hook-exact-${stage}-review`)
      // Separate, explicit consent for each exact message, before the wallet's
      // actual ed25519 signature prompt. No automatic approval of a new review.
      await screen.getByRole('button', { name: 'Continue', exact: true }).tap()
    }
    await expect(screen.getByRole('heading', { name: `$${SYMBOL} is live` })).toBeVisible({ timeout: 300_000 })
    const [preparation] = await finalizedOperations(address, 'preparation', 1), [launchOp] = await finalizedOperations(address, 'launch', 1)
    expect(launchOp.resolved_request.mint).toBe(reserved.mint)
    expect(launchOp.resolved_request.policyKind).toBe('selected-hook')
    expect(launchOp.resolved_request.selectedHook).toEqual({ program: hook.pin.program, flags: hook.flags })
    expect(launchOp.resolved_request.capBps).toBe(0)
    const prep = await receipt(preparation.signature!), tx = await receipt(launchOp.signature!)
    verifySignatures(prep, address); verifySignatures(tx, address)
    expectNoLegacyStack(prep); expectNoLegacyStack(tx); expectSelectedInvoked(tx)
    expect(accountKeys(tx).slice(0, tx.transaction.message.header.numRequiredSignatures).sort()).toEqual([address, reserved.mint].sort())
    expect(programInstructions(tx)).toEqual(['launch:create_launch_open_v1'])
    expect(await scriptCalls(reserved.mint) > 0n).toBe(true)
    const launch = launchAddress(reserved.mint), pool = (await launchAccount(launch)).value.pool.toBase58()
    coin = { creator, address, mint: reserved.mint, launch, pool, preparation, launchOp, reviewText }
    expect((await launchRequests(address)).map(r => r.status)).toEqual(['launched'])
    await approvals.off()
  })

  test('browser buy and sell invoke the selected hook and settle exact native SOL receipts', async ({ app, screen, browser }) => {
    const c = tradingCoin(), { address } = await freshBuyerOnCoinPage({ app, screen, browser }, c.mint)
    const approvals = await approveSignatures(browser), before = await scriptCalls(c.mint)
    await startTrade(screen, SYMBOL, 'buy', '0.5', app)
    const [buy] = await finalizedOperations(address, 'native-buy', 1), bought = await expectNativeBuy(buy, address, c, 500_000_000n)
    expectSelectedInvoked(bought.tx); expectNoLegacyStack(bought.tx); book(bought)
    await tradeResult(screen, 'buy')
    await startTrade(screen, SYMBOL, 'sell', '100%')
    const [sell] = await finalizedOperations(address, 'native-sell', 1), sold = await expectNativeSell(sell, address, c)
    expectSelectedInvoked(sold.tx); expectNoLegacyStack(sold.tx); book(sold)
    await tradeResult(screen, 'sell')
    expect(await coinBalance(c.mint, address)).toBe(0n)
    expect(await scriptCalls(c.mint) > before).toBe(true)
    await expectNoFundingSurface(screen, address)
    await app.screenshot('selected-hook-curve-trading')
    await approvals.off()
  })

  test('reload and server restart retain the selected hook; in-flight buy sends once', { timeout: 600_000 }, async ({ app, screen, browser }) => {
    const c = tradingCoin(), { address } = await freshBuyerOnCoinPage({ app, screen, browser }, c.mint)
    const approvals = await approveSignatures(browser)
    await control('POST', '/rpc/faults', { holdNextSendMs: 8000 })
    await startTrade(screen, SYMBOL, 'buy', '0.02')
    await until('signed selected buy retained', async () => (await operations(address, 'native-buy'))[0]?.signature)
    await browser.reload()
    const [op] = await finalizedOperations(address, 'native-buy', 1), checked = await expectNativeBuy(op, address, c, 20_000_000n)
    expectSelectedInvoked(checked.tx); book(checked)
    await control('POST', '/site/restart', { recollect: false })
    await app.open(`/hooks/token/${c.mint}`)
    await startTrade(screen, SYMBOL, 'sell', '100%')
    const [sell] = await finalizedOperations(address, 'native-sell', 1), sold = await expectNativeSell(sell, address, c)
    expectSelectedInvoked(sold.tx); book(sold)
    expect((await control<Record<string, number>>('GET', '/rpc/sends'))[op.signature!]).toBe(1)
    await approvals.off()
  })

  test('curve final fill graduates with the nongate callback; postgraduation browser buy/sell still work', { timeout: 3_600_000 }, async ({ app, screen, browser }) => {
    const c = tradingCoin()
    await fillUntilOneBuyLeft(c, async (op, address) => {
      const retained = (await operations(address, 'native-buy')).find(row => row.signature === op.signature)
      expect(retained?.status).toBe('finalized-success')
      const checked = await expectNativeBuy(retained!, address, c, BigInt(retained!.resolved_request.amountIn))
      expectSelectedInvoked(checked.tx); book(checked)
    })
    const buyer = await freshBuyerOnCoinPage({ app, screen, browser }, c.mint, 400)
    const approvals = await approveSignatures(browser)
    await startTrade(screen, SYMBOL, 'buy', 'Max')
    const [graduation] = await finalizedOperations(buyer.address, 'native-buy', 1), tx = await receipt(graduation.signature!)
    expectSelectedInvoked(tx); expectNoLegacyStack(tx)
    expect(events(tx).filter(e => e.name === 'Graduated').length).toBe(1)
    expect(programInstructions(tx)).toEqual(['swap:swap_v2', 'launch:graduate'])
    expect((await launchAccount(c.launch)).value.status).toBe(1)
    expect((await poolAccount(c.pool)).value.curve).toBe(false)
    // Graduation adds account-rent movements, so use its own accrued event.
    creatorAccrued += big(events(tx).find(e => e.name === 'InclusiveCreatorFeeAccrued')!.data.creator_quote)
    platformAccrued += big(events(tx).find(e => e.name === 'InclusiveCreatorFeeAccrued')!.data.platform_quote)
    await tradeResult(screen, 'buy')
    await approvals.off()
    const post = await freshBuyerOnCoinPage({ app, screen, browser }, c.mint, 10), postApprovals = await approveSignatures(browser)
    await startTrade(screen, SYMBOL, 'buy', '0.1')
    const [buy] = await finalizedOperations(post.address, 'native-buy', 1), bought = await expectNativeBuy(buy, post.address, c, 100_000_000n)
    expectSelectedInvoked(bought.tx); book(bought); await tradeResult(screen, 'buy')
    await startTrade(screen, SYMBOL, 'sell', '100%')
    const [sell] = await finalizedOperations(post.address, 'native-sell', 1), sold = await expectNativeSell(sell, post.address, c)
    expectSelectedInvoked(sold.tx); book(sold); await tradeResult(screen, 'sell')
    await app.screenshot('selected-hook-postgraduation-trading')
    await postApprovals.off()
  })

  test('creator claims the sum of actual pre/postgraduation fee receipts', async ({ app, screen, browser }) => {
    expect(creatorAccrued > 0n).toBe(true)
    const { tx, amount } = await claimViaUi({ app, screen, browser }, coin.creator, tradingCoin(), creatorAccrued)
    expectNoLegacyStack(tx)
    expect(amount).toBe(creatorAccrued)
    expect(big((await poolAccount(coin.pool)).value.protocol_fees_quote)).toBe(platformAccrued)
    const { signature } = await control('POST', '/owner/stage', { stage: 'collect-native', mint: coin.mint })
    const collected = await receipt(signature)
    expect(collected.meta?.err).toBeNull(); expectNoLegacyStack(collected)
    expect(lamportDelta(collected, stack.roles.treasury)).toBe(platformAccrued)
    expect(big((await poolAccount(coin.pool)).value.protocol_fees_quote)).toBe(0n)
  })
})

// Independent synthetic creator: keep negative-path evidence available even if
// the ordered positive lifecycle hits an unmet integration dependency.
describe('selected-hook server tamper refusal', () => {
  test('server refuses browser-supplied ELF pins and selected intent mutation without signing', async () => {
    const creator = await freshWallet(5), client = new SiteClient(creator)
    await client.signIn()
    const imageReply = await fetch(new URL('/api/hook-lab/coin-image', stack.origin), { method: 'POST', headers: { origin: stack.origin, 'content-type': 'image/png', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '198.19.0.15' }, body: readFileSync(new URL('./fixtures/coin.png', import.meta.url)) })
    const { image } = await imageReply.json()
    const recorded = await client.post('/api/hook-lab/launch-requests', { action: 'create', requestId: crypto.randomUUID(), name: 'Tampered Nongate', symbol: 'TAMPER', creatorFeeBps: FEE, capBps: 0,
      selectedHook: { program: selected().pin.program, flags: selected().flags }, image, description: '', x: '', website: '', telegram: '' })
    expect(recorded.status).toBe(200)
    const operationId = crypto.randomUUID(), intent = { action: 'reserve', operationId, capBps: 0, label: 'TAMPER', name: 'Tampered Nongate', symbol: 'TAMPER', uri: recorded.json.request.uri,
      virtualQuote: '53251917070', creatorFeeBps: FEE, selectedHook: { program: selected().pin.program, flags: selected().flags } }
    const original = await client.post('/api/hook-lab/native-launch', intent)
    expect(original.status).toBe(409)
    expect(original.json.blockers?.[0]?.code).toBe('SELECTED_HOOK_REGISTRY_REQUIRED')
    expect(typeof original.json.mint).toBe('string')
    for (const fields of [{ selectedHook: { ...intent.selectedHook, flags: 1 } }, { selectedHook: { program: stack.programs!.gate, flags: 3 } }, { capBps: 500 }, { selectedHookPin: selected().pin }]) {
      const reply = await client.post('/api/hook-lab/native-launch', { ...intent, ...fields })
      expect(reply.status >= 400 && reply.status < 500).toBe(true)
      expect(reply.json.status === 'available').toBe(false)
    }
    const { rows } = await db.query('select mint from hook_lab_native_signer_custody where owner_wallet=$1', [creator.publicKey.toBase58()])
    expect(rows.map(row => row.mint)).toEqual([original.json.mint])
    expect((await operations(creator.publicKey.toBase58())).filter(op => op.signature !== null)).toEqual([])
  })
})
