// E2: the native-SOL release's edges, on a second coin, real browser and real signatures, asserted from chain and
// database: exact fee rounding, refused or expired signatures, insufficient funds, reloads, lost and interrupted sends,
// the review-time races the security reviews found, one provider lying about lastValidBlockHeight, the owner agent
// refusing a substituted launch message, and the graduation boundaries. Nothing may spend twice or report a false success.
import { randomUUID } from 'node:crypto'
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { PublicKey, SystemProgram, TransactionMessage, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { connection, control, db, freshWallet, stack, until } from './support/stack.ts'
import { asNewVisitor, useWallet, approveSignatures, walletLog } from './support/wallets.ts'
import { finalizedOperations, operations, type OperationRow } from './support/db.ts'
import { PROGRAMS, createHoldingInstruction, big, events, feeSplit, holdingAddress, lamportDelta, lamports, one, receipt, verifySignatures } from './support/chain.ts'
import { expectSettlementIsReceipt } from './support/settlement.ts'
import { connectWallet, freshBuyerOnCoinPage, marketView, startTrade, tradeResult } from './support/flows.ts'
import { graduationBoundaries } from './support/boundaries.ts'
import { launchCoinViaUi, type Launched } from './support/launch.ts'
import { SiteClient } from './support/site-client.ts'

const COIN = { name: 'E2E Edge Coin', symbol: 'E2EEDG', capBps: 500, creatorFeeBps: 100 }
export const boundaryRefusals: string[] = []
const BPS = BigInt(COIN.creatorFeeBps)
let coin: Launched
const sends = () => control<Record<string, number>>('GET', '/rpc/sends')
const faults = (body: Record<string, unknown>) => control('POST', '/rpc/faults', body)
/** Checks one finalized native buy against the chain: the exact split, lamports, settlement and a single send. */
async function expectBuy(op: OperationRow, address: string, amount: bigint, rent: bigint | null = null) {
  const tx = await receipt(op.signature as string)
  expect(tx.meta?.err).toBeNull(); verifySignatures(tx, address)
  const split = feeSplit(amount, BPS), accrued = one(events(tx), 'InclusiveCreatorFeeAccrued')
  expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
  const holding = lamportDelta(tx, holdingAddress(coin.mint, address))
  if (rent !== null) expect(holding).toBe(rent)
  expect(lamportDelta(tx, address)).toBe(-(BigInt(tx.meta!.fee) + amount + holding))
  expect(lamportDelta(tx, coin.launch)).toBe(split.creator)
  expect(lamportDelta(tx, coin.pool)).toBe(amount - split.creator)
  expectSettlementIsReceipt(op, tx, split)
  expect((await sends())[op.signature as string]).toBe(1)
  return { tx, split }
}

describe('native-SOL release edges: refusals, races and recoveries never spend twice or report a false success', { serial: true }, () => {
  test('an edge-case coin launches; the owner agent refuses a launch message with a substituted account', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    let refused: { id: string; line: string } | null = null
    coin = await launchCoinViaUi({ app, screen, browser }, COIN, { beforeLaunchSign: async (launchReview, creator) => {
      // A compromised server queues a launch message whose instruction points one account at another key: the agent
      // derives every launch account itself and must refuse it, sign nothing, and decline it.
      const message = VersionedMessage.deserialize(Buffer.from(launchReview.review.messageBase64, 'base64'))
      const keys = message.staticAccountKeys.map(k => k.toBase58())
      const launch = message.compiledInstructions.find(ix => keys[ix.programIdIndex] === PROGRAMS.launch)
      if (!launch) throw new Error('no launch instruction in the review')
      launch.accountKeyIndexes[2] = launch.accountKeyIndexes[0] // the treasury slot now names the creator
      const bytes = Buffer.from(message.serialize()), sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
      const id = randomUUID(), r = launchReview.review, from = (await control<{ next: number }>('GET', '/owner/agent/log?from=0')).next
      await db.query(`insert into hook_lab_owner_sign_requests(id,signer_address,message_base64,message_sha256,context,valid_until_slot,last_valid_block_height,review_expires_at,status)
        values($1,$2,$3,$4,$5,$6,$7,to_timestamp($8::double precision/1000),'pending')`, [id, stack.roles.admin, bytes.toString('base64'), sha,
        JSON.stringify({ owner: creator, mint: launchReview.resolved_request?.mint ?? null, selectedConfig: launchReview.resolved_request?.selectedConfig ?? null, operation: r.operation, requiredSigners: r.requiredSigners }),
        r.validUntilSlot, r.lastValidBlockHeight, r.reviewExpiresAtMs])
      const line = await until('the owner agent to refuse the substituted message', async () =>
        (await control<{ lines: string[] }>('GET', `/owner/agent/log?from=${from}`)).lines.find(text => text.startsWith(`REFUSED sign request ${id}`)), { timeoutMs: 60_000 })
      const row = (await db.query('select status, signature from hook_lab_owner_sign_requests where id=$1', [id])).rows[0]
      expect(row).toEqual({ status: 'declined', signature: null })
      refused = { id, line }
    } })
    expect(refused).not.toBeNull()
    // The genuine launch still landed, co-signed by the admin exactly once.
    const signed = (await db.query("select count(*)::int n from hook_lab_owner_sign_requests where status='signed' and message_sha256=$1", [coin.launchOp.message_sha256])).rows[0].n
    expect(signed).toBe(1)
    expect((await receipt(coin.launchOp.signature as string)).meta?.err).toBeNull()
  })

  test('exact fee rounding: G = ceil(A*b/1e4), P = floor(G/4), N = G - P, at the rounding edges', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    // A*b/1e4 exact; one lamport over (rounds G up); and G = 3 mod 4 (P rounds down by 3).
    const cases = [{ text: '0.01', amount: 10_000_000n, g: 100_000n, p: 25_000n, n: 75_000n },
      { text: '0.010000001', amount: 10_000_001n, g: 100_001n, p: 25_000n, n: 75_001n },
      { text: '0.010000299', amount: 10_000_299n, g: 100_003n, p: 25_000n, n: 75_003n }]
    for (const [i, c] of cases.entries()) {
      await startTrade(screen, COIN.symbol, 'buy', c.text)
      const op = (await finalizedOperations(address, 'native-buy', i + 1))[i]
      const { split } = await expectBuy(op, address, c.amount, i === 0 ? null : 0n)
      expect([split.gross, split.platform, split.creator]).toEqual([c.g, c.p, c.n])
      expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
    }
    // A sale: X = R + G must satisfy G = ceil(X*b/1e4) exactly, with the platform's floor quarter staying in the pool.
    await startTrade(screen, COIN.symbol, 'sell', '100%')
    const [sell] = await finalizedOperations(address, 'native-sell', 1), tx = await receipt(sell.signature as string)
    const accrued = one(events(tx), 'InclusiveCreatorFeeAccrued'), received = big(one(events(tx), 'SwappedNative').quote_lamports)
    const split = feeSplit(received + big(accrued.gross_quote), BPS)
    expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
    expect(lamportDelta(tx, address)).toBe(received - BigInt(tx.meta!.fee))
    expectSettlementIsReceipt(sell, tx, split)
    await approvals.off()
  })

  test('a rejected wallet signature sends nothing and charges nothing; the retry then settles once', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    let rejectNext = true
    const off = await browser.onDialog(async dialog => {
      if (rejectNext && dialog.message.includes('Sign this transaction')) { rejectNext = false; await dialog.dismiss() } else await dialog.accept()
    })
    const before = await lamports(address)
    await startTrade(screen, COIN.symbol, 'buy', '0.02')
    await expect(screen.getByRole('alert').filter({ hasText: /rejected|cancel|declin/i })).toBeVisible({ timeout: 60_000 })
    const [abandoned] = await until('the refused review row', async () => { const rows = await operations(address, 'native-buy'); return rows.length === 1 ? rows : null })
    expect(abandoned.signature).toBeNull()
    expect(['reviewed']).toContain(abandoned.status)
    expect(await lamports(address)).toBe(before) // nothing charged, not even a fee
    expect((await walletLog(browser)).filter(e => e.kind === 'transaction')).toEqual([]) // the wallet produced no transaction signature
    // The retry: a fresh review, one approval, one send.
    await startTrade(screen, COIN.symbol, 'buy', '0.02')
    const ops = await until('the retried buy to settle', async () => { const rows = await operations(address, 'native-buy'); return rows.length === 2 && rows[1].status === 'finalized-success' ? rows : null }, { timeoutMs: 180_000 })
    await expectBuy(ops[1], address, 20_000_000n)
    expect((await operations(address, 'native-buy'))[0].status).toBe('reviewed') // the refused one stays unsigned
    expect(await tradeResult(screen, 'buy')).toMatch(/^You bought /)
    await off()
  })

  test('an expired review is never turned into a success: approving after the deadline spends nothing', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    let held = false
    const off = await browser.onDialog(async dialog => {
      if (!held && dialog.message.includes('Sign this transaction')) {
        held = true
        // Approve only once the reviewed deadline (review expiry, slot and blockhash height) has passed on chain.
        const [op] = await operations(address, 'native-buy'), r = op.review
        await until('the review to expire', async () => Date.now() > r.reviewExpiresAtMs + 2000 && await connection.getSlot('confirmed') > r.validUntilSlot
          && await connection.getBlockHeight('confirmed') > r.lastValidBlockHeight, { timeoutMs: 180_000, intervalMs: 1000 })
      }
      await dialog.accept()
    })
    const before = await lamports(address)
    await startTrade(screen, COIN.symbol, 'buy', '0.02')
    const [op] = await until('the expired buy to end', async () => {
      const rows = await operations(address, 'native-buy')
      return rows.length === 1 && held && !['reviewed', 'partial', 'signed', 'submission-claimed', 'submitted', 'outcome-unknown'].includes(rows[0].status) ? rows
        : rows.length === 1 && held && await screen.getByRole('alert').first().isVisible() ? rows : null
    }, { timeoutMs: 240_000, intervalMs: 1000 })
    expect(op.status).not.toBe('finalized-success')
    if (op.signature) {
      expect(await connection.getTransaction(op.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })).toBeNull()
      expect((await sends())[op.signature] ?? 0).toBe(0)
    }
    expect(await lamports(address)).toBe(before)
    expect(await screen.getByText(/^You bought /).isVisible()).toBe(false)
    await off()
  })

  test('insufficient funds is refused before any transaction signature, in the panel and by the server', async ({ app, screen, browser }) => {
    const { buyer, address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint, 0.003)
    const approvals = await approveSignatures(browser)
    const before = await lamports(address)
    await startTrade(screen, COIN.symbol, 'buy', '0.5')
    await expect(screen.getByText(/^You need about [0-9.,]+ SOL more SOL in your wallet for this buy and its network fee\.$/)).toBeVisible({ timeout: 60_000 })
    expect(await operations(address, 'native-buy')).toEqual([])
    expect((await walletLog(browser)).map(e => e.kind)).toEqual(['message']) // signed in, never asked to sign a transaction
    // A client that skips the panel's check: the server refuses the review itself.
    const client = new SiteClient(buyer)
    await client.signIn()
    const reply = await client.nativeQuote(await marketView(coin.mint), 'buy', 500_000_000n)
    expect(reply.status).toBe(409)
    expect(await operations(address, 'native-buy')).toEqual([])
    expect(await lamports(address)).toBe(before)
    await approvals.off()
  })

  test('a reload mid-operation finishes the same operation once; the earliest receipt of the run is still readable', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await faults({ holdNextSendMs: 8000 })
    await startTrade(screen, COIN.symbol, 'buy', '0.03')
    await until('the signed buy to be sent', async () => (await operations(address, 'native-buy'))[0]?.signature)
    await browser.reload()
    const [op] = await finalizedOperations(address, 'native-buy', 1)
    await expectBuy(op, address, 30_000_000n)
    expect((await walletLog(browser)).filter(e => e.kind === 'transaction').length).toBe(1)
    // Ledger retention: the edge coin's first receipt (its preparation) still reads.
    expect(await connection.getTransaction(coin.preparation.signature as string, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })).not.toBeNull()
    await approvals.off()
  })

  test('a lost send response is reconciled, never resent; a second submit is refused', async ({ app, screen, browser }) => {
    const { buyer, address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await faults({ loseNextSendResponse: true })
    await startTrade(screen, COIN.symbol, 'buy', '0.04')
    const [op] = await finalizedOperations(address, 'native-buy', 1)
    await expectBuy(op, address, 40_000_000n) // includes: exactly one send of that signature
    // A client asking to submit the same operation again cannot make a second send.
    const client = new SiteClient(buyer)
    await client.signIn()
    const again = await client.post('/api/hook-lab/inclusive-trade', { action: 'submit', signingId: op.id })
    expect(again.json?.operation?.status ?? again.status).not.toBe('submitted')
    expect((await sends())[op.signature as string]).toBe(1)
    await approvals.off()
  })

  test('a server restart around submit (interrupted operation) settles once after the page comes back', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const approvals = await approveSignatures(browser)
    await faults({ holdNextSendMs: 15000 })
    await startTrade(screen, COIN.symbol, 'buy', '0.05')
    await until('the signed buy to be claimed for sending', async () => (await operations(address, 'native-buy'))[0]?.signature)
    await control('POST', '/site/restart', { recollect: false })
    await app.open(`/hooks/token/${coin.mint}`)
    const [op] = await finalizedOperations(address, 'native-buy', 1)
    await expectBuy(op, address, 50_000_000n)
    expect((await walletLog(browser)).filter(e => e.kind === 'transaction').length).toBe(1)
    await approvals.off()
  })

  test('a holding created by someone else between review and landing: the buy settles with zero rent charged', async ({ app, screen, browser }) => {
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const other = await freshWallet(1)
    let raced = false
    const off = await browser.onDialog(async dialog => {
      if (!raced && dialog.message.includes('Sign this transaction')) {
        raced = true
        // Before the buyer approves the reviewed first buy (which reviewed a holding deposit), another wallet creates it.
        const ix = createHoldingInstruction(other.publicKey.toBase58(), coin.mint, address)
        const latest = await connection.getLatestBlockhash('finalized')
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: other.publicKey, recentBlockhash: latest.blockhash, instructions: [ix] }).compileToV0Message())
        tx.sign([other])
        const signature = await connection.sendRawTransaction(tx.serialize())
        await until('the competing create_holding to finalize', async () => (await connection.getSignatureStatuses([signature])).value[0]?.confirmationStatus === 'finalized')
      }
      await dialog.accept()
    })
    await startTrade(screen, COIN.symbol, 'buy', '0.02')
    const [op] = await finalizedOperations(address, 'native-buy', 1)
    expect(raced).toBe(true)
    const { tx } = await expectBuy(op, address, 20_000_000n, 0n)
    expect(lamportDelta(tx, address)).toBe(-(BigInt(tx.meta!.fee) + 20_000_000n)) // fee + amount, no deposit
    await off()
  })

  test('lamports sent to a wallet’s future holding first: the buy is still offered and pays only the rest of the deposit', async ({ app, screen, browser }) => {
    const buyer = await freshWallet(10), address = buyer.publicKey.toBase58(), donor = await freshWallet(1), prefund = 1_000_000n
    const holding = holdingAddress(coin.mint, address), rent = BigInt(await connection.getMinimumBalanceForRentExemption(204, 'finalized'))
    const latest = await connection.getLatestBlockhash('finalized')
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: donor.publicKey, recentBlockhash: latest.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: new PublicKey(holding), lamports: prefund })] }).compileToV0Message())
    tx.sign([donor])
    const sent = await connection.sendRawTransaction(tx.serialize())
    await until('the prefund to finalize', async () => (await connection.getSignatureStatuses([sent])).value[0]?.confirmationStatus === 'finalized')
    expect(await lamports(holding)).toBe(prefund)
    await app.clearState()
    await asNewVisitor(browser)
    await useWallet(browser, buyer)
    const approvals = await approveSignatures(browser)
    await app.open(`/hooks/token/${coin.mint}`)
    await connectWallet(screen, address)
    await startTrade(screen, COIN.symbol, 'buy', '0.02')
    const [op] = await finalizedOperations(address, 'native-buy', 1)
    await expectBuy(op, address, 20_000_000n, rent - prefund)
    expect(await lamports(holding)).toBe(rent)
    await approvals.off()
  })

  test('one provider reporting a lowered lastValidBlockHeight makes the review refuse at once, not hang', async ({ app, screen, browser }) => {
    const { buyer, address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint)
    const client = new SiteClient(buyer)
    await client.signIn()
    await faults({ lowerLastValidBlockHeight: { provider: 'local-a', by: 120 } })
    try {
      const started = Date.now(), reply = await client.nativeQuote(await marketView(coin.mint), 'buy', 20_000_000n)
      expect(reply.status).toBe(409)
      expect(Date.now() - started < 60_000).toBe(true)
      const rows = await operations(address, 'native-buy')
      expect(rows.every(row => row.signature === null && row.status !== 'finalized-success')).toBe(true)
    } finally { await faults({}) }
    // With honest providers the same wallet trades normally.
    const approvals = await approveSignatures(browser)
    await startTrade(screen, COIN.symbol, 'buy', '0.02')
    const ops = await until('the honest buy to settle', async () => (await operations(address, 'native-buy')).find(row => row.status === 'finalized-success'), { timeoutMs: 180_000 })
    await expectBuy(ops, address, 20_000_000n)
    await approvals.off()
  })

  test('graduation boundaries: an overshoot is refused, one lamport short does not graduate, the exact fill does', { timeout: 3_600_000 }, async ({ app, screen, browser }) => {
    boundaryRefusals.push(...await graduationBoundaries({ app, screen, browser }, { mint: coin.mint, launch: coin.launch, pool: coin.pool, symbol: COIN.symbol }, control))
  })
})

