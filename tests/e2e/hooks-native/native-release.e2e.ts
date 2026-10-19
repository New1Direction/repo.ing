// The native-SOL release, end to end in a real browser on the local stack (scripts/e2e/hooks-native-stack.mjs):
// fresh disposable wallets connect through the site's real Wallet Standard chooser and sign every message and
// transaction themselves (tests/e2e/hooks-native/support/test-wallet.ts), the owner approves through the real owner
// agent, and every step is asserted against the chain (finalized receipts, lamport deltas, events, account bytes) and
// the database (persisted signing operations) before the UI is checked. No agent steps, no model.
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import type { Keypair } from '@solana/web3.js'
import { connection, control, db, freshWallet, ownerAgent, stack, until } from './support/stack.ts'
import { asNewVisitor, useWallet, approveSignatures, walletLog, verifyMessageSignature, WALLET_NAME } from './support/wallets.ts'
import { finalizedOperations, launchRequests, operations, ownerSignRequests, type OperationRow } from './support/db.ts'
import { FLAG, accountKeys, allDeltas, big, coinBalance, events, feeSplit, holdingAddress, lamportDelta, launchAccount, launchAddress, one, poolAccount, programInstructions,
  receipt, verifySignatures } from './support/chain.ts'
import { formatUnits, maxBuyLamports, sol } from '../../../app/lib/hooklab-trade-math.mjs'
import { buyOnCurve, finalFillLamports } from '../../../src/hooklab-graduation.mjs'
import { expectSettlementIsReceipt } from './support/settlement.ts'

const COIN = { name: 'E2E Native Coin', symbol: 'E2ENAT', capBps: 500, creatorFeeBps: 100 }
// ceil(1.125 x $5,000 / $105.63) in lamports: the opening quote the invite fixes at the stack's fixed SOL price.
const EXPECTED_VIRTUAL_QUOTE = '53251917070'
const run: { creator?: Keypair; mint?: string; launch?: string; pool?: string; creatorFees?: bigint; graduation?: { signature: string; slot: number; rounds: number; planned: number } } = {}

describe('native-SOL release: fresh wallets, real signatures, chain and database truth', { serial: true }, () => {
  test('a fresh creator wallet connects, signs in with a server-verified wallet signature and requests a launch', async ({ app, screen, browser }) => {
    const creator = run.creator = await freshWallet(5)
    const address = creator.publicKey.toBase58()
    await asNewVisitor(browser)
    await useWallet(browser, creator)
    const approvals = await approveSignatures(browser)
    await app.open('/hooks/launch-review')

    await screen.getByRole('button', { name: 'Connect wallet' }).first().tap()
    await screen.getByRole('dialog').getByRole('button', { name: new RegExp(WALLET_NAME) }).tap()
    await expect(screen.getByRole('button', { name: new RegExp(`^Wallet ${address.slice(0, 4)}`) })).toBeVisible()

    await screen.getByLabel('Coin name').fill(COIN.name)
    await screen.getByLabel('Ticker').fill(COIN.symbol)
    await screen.getByLabel('Upload coin image').setInputFiles('fixtures/coin.png')
    await expect(screen.getByText('Looks good')).toBeVisible()
    await screen.getByRole('group', { name: 'Max per wallet' }).getByRole('button', { name: '5%' }).tap()
    await screen.getByRole('button', { name: 'Sign in and request launch' }).tap()
    await expect(screen.getByText('Waiting for approval')).toBeVisible({ timeout: 60_000 })

    // The wallet signed exactly one message: the site's identity message for this origin and this local genesis.
    const signed = await walletLog(browser)
    expect(signed.map(entry => entry.kind)).toEqual(['message'])
    expect(verifyMessageSignature(signed[0])).toBe(true)
    const message = Buffer.from(signed[0].messageBase64 as string, 'base64').toString('utf8').split('\n')
    expect(message[0]).toBe('repo.ing general launcher wallet identity v1')
    expect(message).toContain(`Origin: ${stack.origin}`)
    expect(message).toContain(`Genesis: ${stack.genesisHash}`)
    expect(message).toContain(`Wallet: ${address}`)
    expect(approvals.prompts.length).toBe(1)

    // The server verified that signature: the challenge is consumed and a session exists for this wallet and genesis.
    const challenge = (await db.query('select message, consumed_at from hook_lab_wallet_challenges where wallet=$1', [address])).rows
    expect(challenge.length).toBe(1)
    expect(challenge[0].message.split('\n')).toEqual(message)
    expect(challenge[0].consumed_at).not.toBeNull()
    const sessions = (await db.query('select genesis_hash, origin, revoked_at from hook_lab_wallet_sessions where wallet=$1', [address])).rows
    expect(sessions).toEqual([{ genesis_hash: stack.genesisHash, origin: stack.origin, revoked_at: null }])

    // The request is queued exactly as entered.
    const requests = await launchRequests(address)
    expect(requests.map(r => ({ name: r.name, symbol: r.symbol, cap: r.cap_bps, fee: r.creator_fee_bps, status: r.status })))
      .toEqual([{ name: COIN.name, symbol: COIN.symbol, cap: COIN.capBps, fee: COIN.creatorFeeBps, status: 'queued' }])
    await approvals.off()
  })

  test('the owner grants and invites through the owner agent; the creator signs preparation and the native v4 launch; the agent co-signs', async ({ app, screen, browser }) => {
    const creator = run.creator as Keypair, address = creator.publicKey.toBase58()
    const approvals = await approveSignatures(browser)
    // The owner, as in production: the owner driver's customer-grant for this wallet, then `invite 1` in the agent.
    const grant = await control<{ signature: string }>('POST', '/owner/customer-grant', { creator: address })
    expect((await receipt(grant.signature)).meta?.err).toBeNull()
    // FINDING (reported, not hidden): the grant advances launch governance, and the operator bundle pins that account
    // exactly ('creation-control'), so the site refuses every review until the owner re-collects the bundle and redeploys.
    // The test does exactly that owner step, and proves the drift before and its absence after.
    expect((await control<{ drifted: string[] }>('GET', '/site/bundle-drift')).drifted).toEqual(['creation-control'])
    await control('POST', '/site/restart', { recollect: true })
    expect((await control<{ drifted: string[] }>('GET', '/site/bundle-drift')).drifted).toEqual([])
    await app.open('/hooks/launch-review')
    await expect(screen.getByText('Waiting for approval')).toBeVisible({ timeout: 60_000 })
    await ownerAgent('invite 1', /^Invited until /)
    const invited = (await launchRequests(address))[0]
    expect(invited.status).toBe('invited')
    // The invite fixed the USD-priced opening quote from the (fixed, local) SOL price, inside the on-chain bounds.
    const price = (await db.query('select sol_usd_micros, virtual_quote from hook_lab_launch_request_prices where request_id=$1', [invited.id])).rows
    expect(price.map(p => [String(p.sol_usd_micros), String(p.virtual_quote)])).toEqual([['105630000', EXPECTED_VIRTUAL_QUOTE]])

    // The creator's page picks the invite up by itself (it polls), then the guided launcher runs.
    await expect(screen.getByText(`You’re invited. Launch $${COIN.symbol} now.`)).toBeVisible({ timeout: 30_000 })
    await screen.getByRole('button', { name: 'Reserve address' }).tap()
    await screen.getByRole('button', { name: 'Review preparation' }).tap()
    await signGuidedStage(screen, 'preparation')
    // Database first (the page reconciles by itself), then the page.
    const [preparation] = await finalizedOperations(address, 'preparation', 1)
    expect((await receipt(preparation.signature as string)).meta?.err).toBeNull()
    await expect(screen.getByText('Preparation is confirmed. One more signature to go.')).toBeVisible({ timeout: 60_000 })
    await screen.getByRole('button', { name: 'Continue to the launch signature' }).tap()
    await signGuidedStage(screen, 'launch')
    const [launch] = await finalizedOperations(address, 'launch', 1)
    const mint = launch.resolved_request?.mint ?? preparation.resolved_request?.mint
    expect(typeof mint).toBe('string')
    run.mint = mint
    for (const op of [preparation, launch]) expect(op.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/)
    // The owner agent signed exactly the launch message through the real approval path.
    const signRequests = (await ownerSignRequests()).filter(r => r.message_sha256 === launch.message_sha256)
    expect(signRequests.map(r => ({ status: r.status, signer: r.signer_address }))).toEqual([{ status: 'signed', signer: stack.roles.admin }])

    // Chain: both receipts finalized without error, every signature verifies, the creator and the admin signed the launch.
    const prepTx = await receipt(preparation.signature as string), launchTx = await receipt(launch.signature as string)
    expect(prepTx.meta?.err).toBeNull(); expect(launchTx.meta?.err).toBeNull()
    verifySignatures(prepTx, address); verifySignatures(launchTx, address); verifySignatures(launchTx, stack.roles.admin)
    // It is the native v4 launch at the invited (USD-fixed) opening quote, and both native flags are set by the programs.
    const created = one(events(launchTx), 'NativeLaunchCreated')
    expect(created.virtual_quote.toString()).toBe(EXPECTED_VIRTUAL_QUOTE)
    const launchPda = launchAddress(mint), launchAcct = await launchAccount(launchPda)
    expect(created.launch.toBase58()).toBe(launchPda)
    run.launch = launchPda; run.pool = launchAcct.value.pool.toBase58()
    expect(launchAcct.raw[FLAG.launch]).toBe(1)
    expect((await poolAccount(run.pool as string)).raw[FLAG.pool]).toBe(1)
    expect(launchAcct.value.status).toBe(0)
    expect(launchAcct.value.creator.toBase58()).toBe(address)
    expect(launchAcct.value.creator_fee_bps).toBe(COIN.creatorFeeBps)
    // The creator paid exactly the network fee plus the rent of every account the launch created; nothing else moved.
    for (const tx of [prepTx, launchTx]) {
      const deltas = allDeltas(tx), fee = BigInt(tx.meta!.fee)
      const created = Object.entries(deltas).filter(([key]) => key !== address && BigInt(deltas[key]) > 0n).reduce((sum, [, value]) => sum + BigInt(value), 0n)
      expect(lamportDelta(tx, address)).toBe(-(fee + created))
      expect(Object.values(deltas).reduce((sum, value) => sum + BigInt(value), 0n)).toBe(-fee)
    }
    // Each signed transaction went out exactly once through the RPC proxies.
    const sends = await control<Record<string, number>>('GET', '/rpc/sends')
    expect([sends[preparation.signature as string], sends[launch.signature as string]]).toEqual([1, 1])
    // The stored settlements are these receipts.
    expectSettlementIsReceipt(preparation, prepTx); expectSettlementIsReceipt(launch, launchTx)
    expect((await launchRequests(address))[0].status).toBe('launched')
    // Only after chain and database agree: the page shows the coin live, and only the test wallet's prompts appeared.
    await expect(screen.getByText('Your coin is live.')).toBeVisible({ timeout: 60_000 })
    await expect(screen.getByText(`$${COIN.symbol} is live`)).toBeVisible({ timeout: 30_000 })
    expect(approvals.prompts.every(text => text.startsWith('E2E TEST WALLET'))).toBe(true)
    expect(approvals.prompts.length).toBe(2)
    await approvals.off()
  })

  test('a separate fresh wallet buys with one approval and no Add SOL, then sells; exact lamports and fee split on chain', async ({ app, screen, browser }) => {
    const buyer = await freshWallet(20), address = buyer.publicKey.toBase58(), mint = run.mint as string
    await app.clearState()
    await asNewVisitor(browser)
    await useWallet(browser, buyer)
    const approvals = await approveSignatures(browser)
    await app.open(`/hooks/token/${mint}`)
    await connectWallet(screen, address)

    const amount = 500_000_000n // 0.5 SOL
    const platformBefore = big((await poolAccount(run.pool as string)).value.protocol_fees_quote)
    await startTrade(screen, 'buy', '0.5')
    const [buyOp] = await finalizedOperations(address, 'native-buy', 1)
    const buyTx = await receipt(buyOp.signature as string)
    expect(buyTx.meta?.err).toBeNull(); verifySignatures(buyTx, address)
    expect(buyTx.transaction.message.header.numRequiredSignatures).toBe(1)
    const split = feeSplit(amount, BigInt(COIN.creatorFeeBps)), fee = BigInt(buyTx.meta!.fee)
    const accrued = one(events(buyTx), 'InclusiveCreatorFeeAccrued')
    expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
    const holding = holdingAddress(mint, address), rent = lamportDelta(buyTx, holding)
    expect(rent > 0n).toBe(true) // the first buy creates the coin holding in the same approval
    expect(lamportDelta(buyTx, address)).toBe(-(fee + amount + rent))
    expect(lamportDelta(buyTx, run.launch as string)).toBe(split.creator)
    expect(lamportDelta(buyTx, run.pool as string)).toBe(amount - split.creator)
    // P = floor(G/4) stays in the pool as protocol_fees_quote; N = G - P went to the launch account (above).
    const platformAfterBuy = big((await poolAccount(run.pool as string)).value.protocol_fees_quote)
    expect(platformAfterBuy - platformBefore).toBe(split.platform)
    expect(big(accrued.protocol_fees_quote_after)).toBe(platformAfterBuy)
    expectSettlementIsReceipt(buyOp, buyTx, split)
    const bought = await coinBalance(mint, address)
    expect(bought > 0n).toBe(true)
    expect(await tradeResult(screen, 'buy')).toBe(`You bought ${formatUnits(bought, 6, 0)} $${COIN.symbol}.`)
    run.creatorFees = split.creator
    trades.push({ label: 'buy', signature: buyOp.signature as string, deltas: allDeltas(buyTx), split })

    await startTrade(screen, 'sell', '100%')
    const [sellOp] = await finalizedOperations(address, 'native-sell', 1)
    const sellTx = await receipt(sellOp.signature as string)
    expect(sellTx.meta?.err).toBeNull(); verifySignatures(sellTx, address)
    // A sale: the curve pays out X; the trader receives R = X - G (SwappedNative.quote_lamports), so X = R + G.
    const sold = one(events(sellTx), 'InclusiveCreatorFeeAccrued'), received = big(one(events(sellTx), 'SwappedNative').quote_lamports)
    const out = received + big(sold.gross_quote), sellSplit = feeSplit(out, BigInt(COIN.creatorFeeBps))
    expect([big(sold.gross_quote), big(sold.platform_quote), big(sold.creator_quote)]).toEqual([sellSplit.gross, sellSplit.platform, sellSplit.creator])
    const sellFee = BigInt(sellTx.meta!.fee)
    expect(lamportDelta(sellTx, address)).toBe(received - sellFee) // SOL straight to the wallet, no withdraw step
    expect(lamportDelta(sellTx, run.launch as string)).toBe(sellSplit.creator)
    expect(lamportDelta(sellTx, run.pool as string)).toBe(-received - sellSplit.creator)
    expect(await coinBalance(mint, address)).toBe(0n)
    expect(big((await poolAccount(run.pool as string)).value.protocol_fees_quote) - platformAfterBuy).toBe(sellSplit.platform)
    run.creatorFees = (run.creatorFees as bigint) + sellSplit.creator
    expectSettlementIsReceipt(sellOp, sellTx, sellSplit)
    trades.push({ label: 'sell', signature: sellOp.signature as string, deltas: allDeltas(sellTx), split: sellSplit })
    // Exactly one wallet approval per trade (plus the one sign-in message), and one send per signed trade.
    const signed = await walletLog(browser)
    expect(signed.map(e => e.kind)).toEqual(['message', 'transaction', 'transaction'])
    expect(signed.slice(1).map(e => e.signature)).toEqual([buyOp.signature, sellOp.signature])
    const sends = await control<Record<string, number>>('GET', '/rpc/sends')
    expect([sends[buyOp.signature as string], sends[sellOp.signature as string]]).toEqual([1, 1])
    // No Add SOL / Withdraw: the wallet's only operations are the buy and the sale.
    expect((await operations(address)).map(op => op.stage)).toEqual(['native-buy', 'native-sell'])
    expect(await tradeResult(screen, 'sell')).toBe(`${sol(received, 6)} went straight to your wallet.`)
    expect(approvals.prompts.length).toBe(3)
    await approvals.off()
  })

  test('the creator claims exactly the SOL fees the trades accrued to the launch account', async ({ app, screen, browser }) => {
    const creator = run.creator as Keypair, address = creator.publicKey.toBase58(), mint = run.mint as string
    await app.clearState()
    await asNewVisitor(browser)
    await useWallet(browser, creator)
    const approvals = await approveSignatures(browser)
    await app.open('/hooks/wallet-identity')
    await connectWallet(screen, address)
    await screen.getByRole('button', { name: /^Sign in with wallet$|^Connect wallet and sign in$/ }).first().tap()
    await expect(screen.getByText(new RegExp(`^Signed in as ${address.slice(0, 4)}`)).first()).toBeVisible()

    const launchBefore = await launchAccount(run.launch as string)
    const claimable = launchBefore.lamports - BigInt(await connection.getMinimumBalanceForRentExemption(launchBefore.raw.length, 'finalized'))
    expect(claimable).toBe(run.creatorFees as bigint)
    await app.open(`/hooks/token/${mint}`)
    // The card shows what trades paid and what reaches the wallet after the one-signature network fee.
    const networkFee = 5000n
    await expect(screen.getByText(`Trades of $${COIN.symbol} have paid you ${claimText(claimable)}. After the network fee, ${claimText(claimable - networkFee)} comes to this wallet.`)).toBeVisible()
    await screen.getByRole('button', { name: `Claim ${claimText(claimable - networkFee)}` }).tap()
    const [claimOp] = await finalizedOperations(address, 'native-claim', 1)
    const claimTx = await receipt(claimOp.signature as string)
    expect(claimTx.meta?.err).toBeNull(); verifySignatures(claimTx, address)
    const claimed = one(events(claimTx), 'CreatorFeesClaimedSol')
    expect(big(claimed.lamports)).toBe(claimable)
    expect(lamportDelta(claimTx, address)).toBe(claimable - BigInt(claimTx.meta!.fee))
    expect(lamportDelta(claimTx, run.launch as string)).toBe(-claimable)
    expectSettlementIsReceipt(claimOp, claimTx)
    trades.push({ label: 'creator claim', signature: claimOp.signature as string, deltas: allDeltas(claimTx), split: { gross: 0n, platform: 0n, creator: claimable } })
    expect((await launchAccount(run.launch as string)).lamports).toBe(launchBefore.lamports - claimable)
    expect((await control<Record<string, number>>('GET', '/rpc/sends'))[claimOp.signature as string]).toBe(1)
    expect(BigInt(claimTx.meta!.fee)).toBe(networkFee)
    await expect(screen.getByText(`Claimed: ${claimText(claimable - networkFee)} is in your wallet.`)).toBeVisible({ timeout: 60_000 })
    expect((await walletLog(browser)).map(e => e.kind)).toEqual(['message', 'transaction'])
    await approvals.off()
  })

  test('fresh buyers fill the curve; the final buy graduates the coin in the same transaction', { timeout: 3_600_000 }, async ({ app, screen, browser }) => {
    const mint = run.mint as string, cap = SUPPLY * BigInt(COIN.capBps) / 10_000n
    const graduationQuote = big((await launchAccount(run.launch as string)).value.graduation_quote)
    // The bound, up front: the site's own Max rule (the cap- and impact-limited amount at 98%, or the exact final fill when
    // it fits) replayed on the curve as it stands, plus a small margin. Exceeding it fails at once.
    const planned = planFillRounds(await marketView(mint)), bound = planned + 3
    const buyers = await Promise.all(Array.from({ length: bound }, () => freshWallet(120)))
    let graduation: { op: OperationRow; buyer: Keypair; noticeText: string } | null = null, last: OperationRow | null = null
    for (let round = 1; round <= bound && !graduation; round++) {
      const buyer = buyers[round - 1], address = buyer.publicKey.toBase58()
      const before = { quote: big((await poolAccount(run.pool as string)).value.quote_reserve), fill: finalFillLamports(await marketView(mint)) }
      const stuck = (why: string) => new Error(`fill round ${round}/${bound} (planned ${planned}): ${why}; quote reserve ${before.quote} of ${graduationQuote}, `
        + `remaining final fill ${before.fill}; last op ${last?.id} ${last?.status} ${last?.signature}`)
      // A buy may never land on a graduated curve inside this loop.
      if ((await launchAccount(run.launch as string)).value.status !== 0) throw stuck('the coin graduated without a confirmed graduation buy')
      await app.clearState()
      await asNewVisitor(browser)
      await useWallet(browser, buyer)
      const approvals = await approveSignatures(browser)
      await app.open(`/hooks/token/${mint}`)
      await connectWallet(screen, address)
      await screen.getByRole('tab', { name: 'Buy' }).tap()
      await screen.getByRole('group', { name: 'Buy amounts' }).getByRole('button', { name: 'Max' }).tap()
      await until('the panel to quote the Max buy', async () => (await screen.getByLabel('You pay').inputValue()) !== '')
      // What a first-time, not-signed-in buyer sees before signing: the graduation notice, exactly when this buy finishes it.
      const notice = screen.getByRole('status').filter({ hasText: 'This buy finishes the curve.' })
      const noticeText = (await notice.isVisible()) ? ((await notice.textContent()) ?? '').trim() : ''
      await startTrade(screen, 'buy', 'Max')
      const [op] = await finalizedOperations(address, 'native-buy', 1)
      last = op
      const tx = await receipt(op.signature as string)
      expect(tx.meta?.err).toBeNull(); verifySignatures(tx, address)
      const amount = -lamportDelta(tx, address) - BigInt(tx.meta!.fee) - lamportDelta(tx, holdingAddress(mint, address))
      expect(amount).toBe(BigInt(op.resolved_request.amountIn)) // the reviewed amount, exactly
      const accrued = one(events(tx), 'InclusiveCreatorFeeAccrued'), split = feeSplit(amount, BigInt(COIN.creatorFeeBps))
      expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
      expect(lamportDelta(tx, run.launch as string)).toBe(split.creator)
      expectSettlementIsReceipt(op, tx, split)
      expect((await control<Record<string, number>>('GET', '/rpc/sends'))[op.signature as string]).toBe(1)
      expect(await coinBalance(mint, address) <= cap).toBe(true) // never over the max per wallet before graduation
      expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
      await approvals.off()
      trades.push({ label: `fill ${round}`, signature: op.signature as string, deltas: allDeltas(tx), split })
      if ((await launchAccount(run.launch as string)).value.status === 1) { graduation = { op, buyer, noticeText }; break }
      // Strict progress, or fail now.
      const after = { quote: big((await poolAccount(run.pool as string)).value.quote_reserve), fill: finalFillLamports(await marketView(mint)) }
      if (!(after.quote > before.quote)) throw stuck(`the quote reserve did not grow (now ${after.quote})`)
      if (!(before.fill === null || (after.fill !== null && after.fill < before.fill))) throw stuck(`the remaining final fill did not shrink (now ${after.fill})`)
      expect(noticeText).toBe('') // no notice on a buy that does not graduate
      expect(after.quote < graduationQuote).toBe(true) // and no buy overshot or reached the threshold without graduating
    }
    if (!graduation) throw new Error(`no graduation within ${bound} rounds (planned ${planned}); last op ${last?.id} ${last?.status} ${last?.signature}`)
    const { op, buyer, noticeText } = graduation, address = buyer.publicKey.toBase58(), tx = await receipt(op.signature as string), list = events(tx)
    // The first-time buyer saw, before signing, that this buy finishes the curve and graduates the coin.
    expect(noticeText).toBe(`This buy finishes the curve. $${COIN.symbol} graduates in the same transaction: its liquidity is locked forever and the max per wallet lifts.`)
    // Confirmed only when all hold: the settled request asked to graduate; ONE transaction signed by the buyer alone runs
    // swap_v2 then graduate and carries the Graduated event; the pool on chain is graduated with quote reserve == graduationQuote.
    expect(op.resolved_request?.graduate).toBe(true)
    expect(op.first_finalized.graduated).toBe(true)
    expect(tx.transaction.message.header.numRequiredSignatures).toBe(1)
    expect(accountKeys(tx)[0]).toBe(address)
    expect(programInstructions(tx)).toEqual(['swap:swap_v2', 'launch:graduate'])
    expect(list.filter(e => e.name === 'Graduated').length).toBe(1)
    expect(one(list, 'Graduated').launch.toBase58()).toBe(run.launch)
    const launch = await launchAccount(run.launch as string), pool = await poolAccount(run.pool as string)
    expect(launch.value.status).toBe(1)
    expect(pool.value.curve).toBe(false)
    expect(big(op.first_finalized.quote.after.quoteReserve)).toBe(graduationQuote)
    expect(big(pool.value.quote_reserve)).toBe(graduationQuote)
    expect(launch.raw[FLAG.launch]).toBe(1); expect(pool.raw[FLAG.pool]).toBe(1)
    run.graduation = { signature: op.signature as string, slot: tx.slot, rounds: trades.filter(t => t.label.startsWith('fill')).length, planned }
    await expect(screen.getByText(new RegExp(`\\$${COIN.symbol} has graduated\\.`))).toBeVisible()
  })

  test('after graduation a fresh wallet buys above the old max per wallet, then sells, on the same native fee split', { timeout: 1_800_000 }, async ({ app, screen, browser }) => {
    const buyer = await freshWallet(400), address = buyer.publicKey.toBase58(), mint = run.mint as string, cap = SUPPLY * BigInt(COIN.capBps) / 10_000n
    await app.clearState()
    await asNewVisitor(browser)
    await useWallet(browser, buyer)
    const approvals = await approveSignatures(browser)
    await app.open(`/hooks/token/${mint}`)
    await connectWallet(screen, address)
    // Each buy is held to the 10% price-impact limit, so the wallet buys Max until it holds more than the old cap.
    for (let n = 1; await coinBalance(mint, address) <= cap; n++) {
      if (n > 8) throw new Error(`still at or under the old cap after ${n - 1} buys: ${await coinBalance(mint, address)} <= ${cap}`)
      const held = await coinBalance(mint, address)
      await startTrade(screen, 'buy', 'Max')
      const ops = await finalizedOperations(address, 'native-buy', n), op = ops[n - 1]
      const tx = await receipt(op.signature as string)
      expect(tx.meta?.err).toBeNull(); verifySignatures(tx, address)
      expect(events(tx).some(e => e.name === 'Graduated')).toBe(false)
      const rent = lamportDelta(tx, holdingAddress(mint, address)), amount = -lamportDelta(tx, address) - BigInt(tx.meta!.fee) - rent
      const accrued = one(events(tx), 'InclusiveCreatorFeeAccrued'), split = feeSplit(amount, BigInt(COIN.creatorFeeBps))
      expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
      expect(lamportDelta(tx, run.launch as string)).toBe(split.creator)
      expectSettlementIsReceipt(op, tx, split)
      expect(op.first_finalized.quote.capLifted).toBe(true)
      expect(await coinBalance(mint, address) > held).toBe(true)
      expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
      trades.push({ label: `post-graduation buy ${n}`, signature: op.signature as string, deltas: allDeltas(tx), split })
    }
    expect(await coinBalance(mint, address) > cap).toBe(true) // above the old max per wallet: the cap is lifted
    // Then it sells everything. Each sale is held to the same 10% price-impact limit: the panel refuses the whole position
    // in one sale (asserted once), so the wallet sells the largest share it accepts (50%, else 25%) until it holds nothing.
    await screen.getByRole('tab', { name: 'Sell' }).tap()
    await screen.getByRole('group', { name: 'Sell amounts' }).getByRole('button', { name: '100%' }).tap()
    await expect(screen.getByText('That moves the price more than 10%. Try a smaller amount.')).toBeVisible()
    await expect(screen.getByRole('button', { name: `Sell $${COIN.symbol}` })).toBeDisabled()
    for (let n = 1; await coinBalance(mint, address) > 0n; n++) {
      if (n > 12) throw new Error(`still holding ${await coinBalance(mint, address)} after ${n - 1} sales`)
      const held = await coinBalance(mint, address)
      await screen.getByRole('tab', { name: 'Sell' }).tap()
      const share = await largestAcceptedShare(screen)
      await startTrade(screen, 'sell', share)
      const ops = await finalizedOperations(address, 'native-sell', n), sellOp = ops[n - 1]
      const sellTx = await receipt(sellOp.signature as string)
      expect(sellTx.meta?.err).toBeNull(); verifySignatures(sellTx, address)
      const sold = one(events(sellTx), 'InclusiveCreatorFeeAccrued'), received = big(one(events(sellTx), 'SwappedNative').quote_lamports)
      const sellSplit = feeSplit(received + big(sold.gross_quote), BigInt(COIN.creatorFeeBps))
      expect([big(sold.gross_quote), big(sold.platform_quote), big(sold.creator_quote)]).toEqual([sellSplit.gross, sellSplit.platform, sellSplit.creator])
      expect(lamportDelta(sellTx, address)).toBe(received - BigInt(sellTx.meta!.fee))
      expect(lamportDelta(sellTx, run.launch as string)).toBe(sellSplit.creator)
      expect(lamportDelta(sellTx, run.pool as string)).toBe(-received - sellSplit.creator)
      expectSettlementIsReceipt(sellOp, sellTx, sellSplit)
      expect(BigInt(sellOp.resolved_request.amountIn)).toBe(held - await coinBalance(mint, address)) // exactly the reviewed coins left the wallet
      expect(await tradeResult(screen, 'sell')).toBe(`${sol(received, 6)} went straight to your wallet.`)
      expect((await control<Record<string, number>>('GET', '/rpc/sends'))[sellOp.signature as string]).toBe(1)
      trades.push({ label: `post-graduation sell ${n} (${share})`, signature: sellOp.signature as string, deltas: allDeltas(sellTx), split: sellSplit })
    }
    expect(await coinBalance(mint, address)).toBe(0n)
    await approvals.off()
  })
})

afterAll(() => {
  // The run's evidence: every trade's signature, chain lamport deltas and fee split, and the graduation transaction.
  const file = new URL('./.e2e/trades.json', import.meta.url)
  mkdirSync(new URL('./.e2e/', import.meta.url), { recursive: true })
  writeFileSync(file, JSON.stringify({ graduation: run.graduation ?? null, trades }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2))
})

const SUPPLY = 1_000_000_000_000_000n
const trades: { label: string; signature: string; deltas: Record<string, string>; split: { gross: bigint; platform: bigint; creator: bigint } }[] = []
/** The coin's market as the site reads it (the public market API). */
async function marketView(mint: string): Promise<any> {
  const response = await fetch(new URL(`/api/hook-lab/market/${mint}`, stack.origin), { headers: { 'x-forwarded-for': '198.19.0.1' } })
  if (!response.ok) throw new Error(`market ${mint}: HTTP ${response.status}`)
  return (await response.json()).market
}
/** How many fresh-wallet Max buys finish the curve: the panel's Max rule replayed on the site's curve model. */
function planFillRounds(market: any): number {
  let m = market
  for (let rounds = 1; rounds <= 400; rounds++) {
    const max = maxBuyLamports(m, 0n), fill = finalFillLamports(m)
    if (max === null) throw new Error('the curve cannot be bought')
    if (fill !== null && max === fill) return rounds
    const next = buyOnCurve(m, max * 98n / 100n)
    if (!next) throw new Error('the planned buy does not fit the curve')
    m = { ...m, pool: Object.fromEntries(Object.entries(next.pool).map(([k, v]) => [k, String(v)])) }
  }
  throw new Error('no graduation within 400 planned rounds')
}
// The site's own display formatting (app/lib/hooklab-trade-math.mjs), for the UI text checks only; amounts come from the chain.
const claimText = (lamports: bigint) => sol(lamports, lamports < 1_000_000n ? 9 : 6)

async function connectWallet(screen: any, address: string) {
  await screen.getByRole('button', { name: 'Connect wallet' }).first().tap()
  await screen.getByRole('dialog').getByRole('button', { name: new RegExp(WALLET_NAME) }).tap()
  await expect(screen.getByRole('button', { name: new RegExp(`^Wallet ${address.slice(0, 4)}`) })).toBeVisible()
}
/** Starts one trade through the coin page's panel: pick the side and amount, press the main button. Returns its label. */
async function startTrade(screen: any, side: 'buy' | 'sell', amount: string): Promise<string> {
  await screen.getByRole('tab', { name: side === 'buy' ? 'Buy' : 'Sell' }).tap()
  if (amount === 'Max' || amount.endsWith('%')) await screen.getByRole('group', { name: side === 'buy' ? 'Buy amounts' : 'Sell amounts' }).getByRole('button', { name: amount }).tap()
  else await screen.getByLabel(side === 'buy' ? 'You pay' : 'You sell').fill(amount)
  const main = screen.getByRole('button', { name: new RegExp(`^(Sign in and ${side}|${side === 'buy' ? 'Buy' : 'Sell'}( and graduate)?) \\$${COIN.symbol}$`) })
  await expect(main).toBeEnabled({ timeout: 30_000 })
  const label = ((await main.textContent()) ?? '').trim()
  await main.tap()
  return label
}
/** The panel's result line, read after the chain and database have confirmed the trade. */
async function tradeResult(screen: any, side: 'buy' | 'sell'): Promise<string> {
  const result = screen.getByText(side === 'buy' ? /^You bought / : / went straight to your wallet\.$/)
  await expect(result).toBeVisible({ timeout: 60_000 })
  return ((await result.textContent()) ?? '').trim()
}
/** One guided signature: tick the review box, sign in the wallet, let repo.ing add each remaining signature (one press per
 * server or owner signer; the owner agent's co-signature arrives through the owner-approval queue), then send it. */
async function signGuidedStage(screen: any, stage: 'preparation' | 'launch') {
  const accept = screen.getByLabel('I checked the amount and the coin details.')
  // A launch review waits for the owner agent's per-launch lookup table first.
  await expect(accept).toBeVisible({ timeout: 180_000 })
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
/** The largest sell share (100%, 50%, 25%) the panel accepts under its 10% price-impact limit. */
async function largestAcceptedShare(screen: any): Promise<string> {
  const main = screen.getByRole('button', { name: new RegExp(`^(Sign in and sell|Sell) \\$${COIN.symbol}$`) })
  const tooMuch = screen.getByText('That moves the price more than 10%. Try a smaller amount.')
  for (const share of ['100%', '50%', '25%']) {
    await screen.getByRole('group', { name: 'Sell amounts' }).getByRole('button', { name: share }).tap()
    const verdict = await until(`the panel to quote a ${share} sale`, async () => (await tooMuch.isVisible()) ? 'refused' : (await main.isEnabled()) ? 'ok' : null, { timeoutMs: 15_000 })
    if (verdict === 'ok') return share
  }
  throw new Error('the panel accepts no sell share under its price-impact limit')
}
