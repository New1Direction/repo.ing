// The legacy stack, preserved: what mainnet runs today (bundle-2 launch and swap at E73/B2, the max-wallet gate BdAa,
// token 2XoE, the production bridge CtLk and bridged SOL A49o, loaded from a public mainnet snapshot). A bridged coin
// launched through the site keeps working for an existing holder: they bought with Add SOL, and after a deploy they can
// still sell (the proceeds go back to their wallet) and withdraw whatever SOL is left in Hook Lab. Real browser, real
// signatures, every step asserted from the receipts, the bridge vault and the persisted operations.
import { describe, expect } from 'e2e'
import { test } from '@e2e-dev/web'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { connection, control, freshWallet, stack, until } from './support/stack.ts'
import { approveSignatures } from './support/wallets.ts'
import { finalizedOperations, operations, type OperationRow } from './support/db.ts'
import { FLAG, big, coinBalance, events, feeSplit, holdingAddress, lamportDelta, lamports, launchAccount, one, poolAccount, receipt, verifySignatures } from './support/chain.ts'
import { expectSettlementIsReceipt } from './support/settlement.ts'
import { freshBuyerOnCoinPage, startTrade } from './support/flows.ts'
import { launchCoinViaUi, type Launched } from './support/launch.ts'
import { LEGACY_PROGRAMS, LEGACY_QUOTE_MINT, invokedPrograms } from './support/stack-separation.ts'
import { PROGRAMS as LEGACY_IDS, QUOTE_MINT as LEGACY_MINT, derivedAddresses } from '../../../src/hooklab-owner-driver/pins.mjs'

const COIN = { name: 'E2E Legacy Coin', symbol: 'E2ELEG', capBps: 500, creatorFeeBps: 100 }
const { bridgeSolVault: VAULT, bridgeNativeWrapper: WRAPPER } = derivedAddresses(LEGACY_IDS, LEGACY_MINT)
const bridgeCoder = new BorshCoder(JSON.parse(readFileSync(new URL('../../../vendor/hooklab-production-candidate/idl/bordrless_bridge.json', import.meta.url), 'utf8')))
/** Lamports the vault holds above its own rent beyond everything wrapped (negative: under-backed by the site's rule). */
async function backing(): Promise<bigint> {
  const [vaultInfo, wrapper] = await connection.getMultipleAccountsInfo([new PublicKey(VAULT), new PublicKey(WRAPPER)], 'finalized')
  const rent = BigInt(await connection.getMinimumBalanceForRentExemption(vaultInfo!.data.length, 'finalized'))
  return BigInt(vaultInfo!.lamports) - rent - BigInt(bridgeCoder.accounts.decode('Wrapper', Buffer.from(wrapper!.data)).total_wrapped.toString())
}
let coin: Launched, holder: { address: string } | null = null
const sends = () => control<Record<string, number>>('GET', '/rpc/sends')
const vault = async () => BigInt(await connection.getBalance(new PublicKey(VAULT), 'finalized'))
/** A finalized bridged operation, sent once, signed by the wallet, its settlement exactly the receipt; returns the receipt. */
async function settled(op: OperationRow, wallet: string) {
  const tx = await receipt(op.signature as string)
  expect(tx.meta?.err).toBeNull(); verifySignatures(tx, wallet)
  expectSettlementIsReceipt(op, tx)
  expect((await sends())[op.signature as string]).toBe(1)
  return tx
}
/** The holder's bridged SOL in Hook Lab (their A49o holding's amount). */
const bridged = (address: string) => coinBalance(LEGACY_QUOTE_MINT, address)

describe('legacy stack preserved: an existing holder of a bridged coin can still sell and withdraw', { serial: true }, () => {
  test('a bridged coin launches through the site on the unchanged legacy programs', { timeout: 900_000 }, async ({ app, screen, browser }) => {
    expect(stack.mode).toBe('legacy')
    coin = await launchCoinViaUi({ app, screen, browser }, COIN)
    const tx = await receipt(coin.launchOp.signature as string), ran = invokedPrograms(tx)
    // Legacy positive control: the launch ran the legacy launch, swap and token programs, and the pool trades bridged SOL.
    for (const id of [LEGACY_PROGRAMS.launch, LEGACY_PROGRAMS.swap, LEGACY_PROGRAMS.token]) expect(ran.has(id)).toBe(true)
    const launch = await launchAccount(coin.launch), pool = await poolAccount(coin.pool)
    expect(pool.value.quote_mint.toBase58()).toBe(LEGACY_QUOTE_MINT)
    expect([launch.raw[FLAG.launch], pool.raw[FLAG.pool]]).toEqual([0, 0]) // not native-SOL
  })

  test('on the bridge state mainnet holds today, Add SOL is refused before any signature: the vault does not cover its rent plus everything wrapped', async ({ app, screen, browser }) => {
    // Finding (2026-10-19 snapshot, slot in tests/e2e/hooks-native/snapshot/bridge.json): vault 17,314,116,599 lamports,
    // total wrapped 17,313,456,599, vault rent 890,880, so the site's solvency rule (vault - rent >= wrapped) fails by 230,880.
    const shortfall = -(await backing())
    expect(shortfall > 0n).toBe(true)
    const { address } = await freshBuyerOnCoinPage({ app, screen, browser }, coin.mint, 5)
    holder = { address }
    const approvals = await approveSignatures(browser), before = await lamports(address)
    await startTrade(screen, COIN.symbol, 'buy', '0.04')
    await expect(screen.getByRole('alert').filter({ hasText: 'Adding SOL to Hook Lab is unavailable right now. Withdrawals still work.' })).toBeVisible({ timeout: 60_000 })
    expect((await operations(address)).filter(op => op.signature !== null)).toEqual([])
    expect(await lamports(address)).toBe(before)
    await approvals.off()
    // The fix the owner can make on mainnet: anyone may send lamports to the vault. Exactly the shortfall restores the rule.
    const donor = await freshWallet(1), latest = await connection.getLatestBlockhash('finalized')
    const topUp = new VersionedTransaction(new TransactionMessage({ payerKey: donor.publicKey, recentBlockhash: latest.blockhash,
      instructions: [SystemProgram.transfer({ fromPubkey: donor.publicKey, toPubkey: new PublicKey(VAULT), lamports: shortfall })] }).compileToV0Message())
    topUp.sign([donor])
    const sent = await connection.sendRawTransaction(topUp.serialize())
    await until('the vault top-up to finalize', async () => (await connection.getSignatureStatuses([sent])).value[0]?.confirmationStatus === 'finalized')
    expect(await backing()).toBe(0n)
  })

  test('a holder buys with Add SOL: SOL moves into the bridge vault exactly, then the buy spends it', async ({ app, screen, browser }) => {
    const address = holder!.address
    const approvals = await approveSignatures(browser), amount = 40_000_000n // under the 5% cap at the standard 1 SOL opening quote
    const vaultBefore = await vault()
    await app.open(`/hooks/token/${coin.mint}`)
    await startTrade(screen, COIN.symbol, 'buy', '0.04')
    const [fund] = await finalizedOperations(address, 'wallet-fund', 1), [buy] = await finalizedOperations(address, 'inclusive-buy', 1)
    const fundTx = await settled(fund, address), buyTx = await settled(buy, address)
    // Add SOL: exactly the buy amount into the vault; the wallet pays it, the network fee and the two new holdings' rent.
    expect(lamportDelta(fundTx, VAULT)).toBe(amount)
    const rent = lamportDelta(fundTx, holdingAddress(LEGACY_QUOTE_MINT, address)) + lamportDelta(fundTx, holdingAddress(coin.mint, address))
    expect(lamportDelta(fundTx, address)).toBe(-(BigInt(fundTx.meta!.fee) + amount + rent))
    // The buy: the inclusive split on the bridged amount, the whole bridged balance spent, coins received.
    const split = feeSplit(amount, BigInt(COIN.creatorFeeBps)), accrued = one(events(buyTx), 'InclusiveCreatorFeeAccrued')
    expect([big(accrued.gross_quote), big(accrued.platform_quote), big(accrued.creator_quote)]).toEqual([split.gross, split.platform, split.creator])
    expect(lamportDelta(buyTx, address)).toBe(-BigInt(buyTx.meta!.fee))
    expect(await bridged(address)).toBe(0n)
    expect(await coinBalance(coin.mint, address) > 0n).toBe(true)
    expect(await vault() - vaultBefore).toBe(amount)
    await expect(screen.getByText(/^You bought /)).toBeVisible({ timeout: 60_000 })
    await approvals.off()
  })

  test('after a deploy the holder sells half: the proceeds come back to the wallet, the vault pays exactly that', async ({ app, screen, browser }) => {
    await control('POST', '/site/restart', { recollect: true })
    const address = holder!.address, approvals = await approveSignatures(browser), held = await coinBalance(coin.mint, address)
    await app.open(`/hooks/token/${coin.mint}`)
    const vaultBefore = await vault()
    await startTrade(screen, COIN.symbol, 'sell', '50%')
    const [sell] = await finalizedOperations(address, 'inclusive-sell', 1), [withdraw] = await finalizedOperations(address, 'wallet-withdraw', 1)
    await settled(sell, address)
    const withdrawTx = await settled(withdraw, address), out = -lamportDelta(withdrawTx, VAULT)
    expect(out > 0n).toBe(true)
    expect(lamportDelta(withdrawTx, address)).toBe(out - BigInt(withdrawTx.meta!.fee))
    expect(await vault()).toBe(vaultBefore - out)
    expect(await bridged(address)).toBe(0n)
    expect(await coinBalance(coin.mint, address)).toBe(held - held / 2n)
    await expect(screen.getByText(/ is back in your wallet\.$/)).toBeVisible({ timeout: 60_000 })
    await approvals.off()
  })

  test('the holder sells the rest but refuses the withdrawal in the wallet; the Withdraw button returns every lamport', async ({ app, screen, browser }) => {
    const address = holder!.address
    let refused = false, transactions = 0
    const off = await browser.onDialog(async dialog => {
      // The sale's own approval (the first transaction prompt) goes through; the automatic withdrawal after it is refused.
      if (dialog.message.includes('Sign this transaction:') && ++transactions === 2 && !refused) { refused = true; await dialog.dismiss() }
      else await dialog.accept()
    })
    await app.open(`/hooks/token/${coin.mint}`)
    await startTrade(screen, COIN.symbol, 'sell', '100%')
    await finalizedOperations(address, 'inclusive-sell', 2)
    await expect(screen.getByRole('alert').filter({ hasText: /use Withdraw below/ })).toBeVisible({ timeout: 120_000 })
    expect(refused).toBe(true)
    const left = await bridged(address)
    expect(left > 0n).toBe(true)
    expect((await operations(address, 'wallet-withdraw')).filter(op => op.signature !== null).length).toBe(1) // nothing more was sent
    const vaultBefore = await vault()
    await screen.getByRole('button', { name: 'Withdraw', exact: true }).tap()
    const withdrawals = await until('the second withdrawal to settle', async () => {
      const rows = (await operations(address, 'wallet-withdraw')).filter(op => op.signature !== null)
      return rows.length === 2 && rows[1].status === 'finalized-success' ? rows : null
    }, { timeoutMs: 180_000 })
    const tx = await settled(withdrawals[1], address)
    expect(-lamportDelta(tx, VAULT)).toBe(left)
    expect(lamportDelta(tx, address)).toBe(left - BigInt(tx.meta!.fee))
    expect(await vault()).toBe(vaultBefore - left)
    expect([await bridged(address), await coinBalance(coin.mint, address)]).toEqual([0n, 0n])
    await off()
  })
})

