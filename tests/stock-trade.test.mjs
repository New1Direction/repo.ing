import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { readFileSync } from 'node:fs'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { assertPreparedStockDbcSwap, assertStockDbcSettlement } from '../src/canonical-trade.mjs'
import { preparedFromRecord, readTradeRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { tradeResultFields } from '../app/lib/trade-status.mjs'
import { amountRoundedUp, associatedAccountLength } from '../src/trade-costs.mjs'
import { STOCK_PAIR_ACTIONS_UNAVAILABLE, handleBuyGet, handleBuyPost } from '../app/lib/solana-actions.mjs'

const METAX = new PublicKey('Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu')
const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed')
const wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, config = Keypair.generate().publicKey
const pool = Keypair.generate().publicKey, amountIn = 50_000_000n, minimumAmountOut = 123n
const spec = { direction: 'buy', wallet, pool, config, mint, quoteMint: METAX, amountIn, minimumAmountOut }

// A METAx-quoted DBC buy built by the program's own coder, as dbc.pool.swap builds it: the stock in, the market token out.
async function swapInstruction({ quoteMint = METAX, referralTokenAccount = null, amount = amountIn, direction = 'buy', quoteProgram = TOKEN_2022_PROGRAM_ID } = {}) {
  const stockAccount = getAssociatedTokenAddressSync(quoteMint, wallet, false, TOKEN_2022_PROGRAM_ID), tokenAccount = getAssociatedTokenAddressSync(mint, wallet)
  return dbc.pool.program.methods.swap({ amountIn: new BN(String(amount)), minimumAmountOut: new BN(String(minimumAmountOut)) }).accountsPartial({
    baseMint: mint, quoteMint, pool, baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey, config,
    poolAuthority: Keypair.generate().publicKey, referralTokenAccount,
    inputTokenAccount: direction === 'sell' ? tokenAccount : stockAccount, outputTokenAccount: direction === 'sell' ? stockAccount : tokenAccount,
    payer: wallet, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: quoteProgram }).instruction()
}
const budget = () => [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })]
const ownAccount = (forMint, program = TOKEN_PROGRAM_ID, payer = wallet, owner = wallet) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, getAssociatedTokenAddressSync(forMint, owner, false, program), owner, forMint, program)

test('a stock-paired swap: the one DBC swap with the stock as quote, the wallet\'s own accounts and the budget, nothing else', async () => {
  const swap = await swapInstruction()
  assertPreparedStockDbcSwap(new Transaction().add(...budget(), ownAccount(mint), ownAccount(METAX, TOKEN_2022_PROGRAM_ID), swap), spec)
  assertPreparedStockDbcSwap(new Transaction().add(...budget(), swap), spec)
  const refused = async (instructions, pattern, overrides = {}) =>
    assert.throws(() => assertPreparedStockDbcSwap(new Transaction().add(...instructions), { ...spec, ...overrides }), pattern)
  await refused([...budget(), await swapInstruction({ quoteMint: new PublicKey('So11111111111111111111111111111111111111112') })], /does not match the quote/)
  await refused([...budget(), await swapInstruction({ referralTokenAccount: Keypair.generate().publicKey })], /does not match the quote/)
  await refused([...budget(), await swapInstruction({ amount: amountIn + 1n })], /does not match the quote/)
  await refused([...budget(), swap], /does not match the quote/, { minimumAmountOut: minimumAmountOut + 1n })
  await refused([...budget(), swap, swap], /does not match the quote/)
  // Nothing is wrapped or closed, nothing else is paid, and only the wallet's own accounts for these two mints are created.
  await refused([...budget(), swap, createCloseAccountInstruction(getAssociatedTokenAddressSync(METAX, wallet, false, TOKEN_2022_PROGRAM_ID), wallet, wallet, [], TOKEN_2022_PROGRAM_ID)], /unexpected instruction/)
  await refused([...budget(), swap, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: Keypair.generate().publicKey, lamports: 1 })], /unexpected instruction/)
  await refused([...budget(), ownAccount(mint, TOKEN_PROGRAM_ID, Keypair.generate().publicKey), swap], /unexpected instruction/)
  await refused([...budget(), ownAccount(mint, TOKEN_PROGRAM_ID, wallet, Keypair.generate().publicKey), swap], /unexpected instruction/)
  await refused([...budget(), ownAccount(Keypair.generate().publicKey), swap], /unexpected instruction/)
  assert.ok(swap.keys[12].pubkey.equals(DBC_PROGRAM), 'no referral account')
  // Pinned: the swap's own accounts and programs, and account setup only as CreateIdempotent under each mint's program.
  const sell = await swapInstruction({ direction: 'sell' })
  assertPreparedStockDbcSwap(new Transaction().add(...budget(), ownAccount(METAX, TOKEN_2022_PROGRAM_ID), sell), { ...spec, direction: 'sell' })
  await refused([...budget(), sell], /does not match the quote/)
  await refused([...budget(), swap], /does not match the quote/, { direction: 'sell' })
  await refused([...budget(), await swapInstruction({ quoteProgram: TOKEN_PROGRAM_ID })], /does not match the quote/)
  await refused([...budget(), swap], /does not match the quote/, { direction: 'swap' })
  await refused([...budget(), ownAccount(METAX, TOKEN_PROGRAM_ID), swap], /unexpected instruction/)
  await refused([...budget(), ownAccount(mint, TOKEN_2022_PROGRAM_ID), swap], /unexpected instruction/)
  await refused([...budget(), createAssociatedTokenAccountInstruction(wallet, getAssociatedTokenAddressSync(mint, wallet), wallet, mint), swap], /unexpected instruction/)
})

test('the stock account is rented at the size Token-2022 creates it: 179 bytes for METAx, not every extension the mint has', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/metax-mint.json', import.meta.url), 'utf8'))
  const metax = unpackMint(METAX, { data: Buffer.from(fixture.data, 'base64'), owner: TOKEN_2022_PROGRAM_ID, lamports: 1, executable: false }, TOKEN_2022_PROGRAM_ID)
  assert.equal(associatedAccountLength(metax), 179)
})

test('a shortfall is shown rounded up, never as zero', () => {
  assert.equal(amountRoundedUp(1n, 8), '0.000001')
  assert.equal(amountRoundedUp(100n, 8), '0.000001')
  assert.equal(amountRoundedUp(101n, 8), '0.000002')
  assert.equal(amountRoundedUp(10_000_000n, 8), '0.100000')
  assert.equal(amountRoundedUp(12_345_678n, 8), '0.123457')
  assert.equal(amountRoundedUp(5n, 6), '0.000005')
  assert.equal(amountRoundedUp(7n, 0), '7')
})

test('Blinks never offer a stock-paired market: the card and the transaction are refused with the reason', async () => {
  const MINT = mint.toBase58()
  const loadMarket = async () => ({ repoId: '94911145', mint: MINT, symbol: 'DOCUSAURUS', fullName: 'facebook/docusaurus', description: null,
    quoteMint: METAX.toBase58() })
  let prepared = 0
  const get = await handleBuyGet(MINT, { loadMarket })
  assert.equal(get.status, 404)
  assert.equal((await get.json()).message, STOCK_PAIR_ACTIONS_UNAVAILABLE)
  const post = await handleBuyPost(new Request(`https://repo.ing/api/actions/buy/${MINT}?amount=0.1`, { method: 'POST',
    body: JSON.stringify({ account: wallet.toBase58() }) }), MINT, { loadMarket, prepareBuy: async () => { prepared++; return {} } })
  assert.equal(post.status, 404)
  assert.equal((await post.json()).message, STOCK_PAIR_ACTIONS_UNAVAILABLE)
  assert.equal(prepared, 0, 'nothing is prepared')
})

test('stock-paired settlement: exact input spent, at least the minimum received, the pool vault moving the other way', () => {
  const buy = { direction: 'buy', amountIn, minimumAmountOut, tokenDelta: 200n, quoteDelta: -amountIn, quoteVaultDelta: amountIn }
  assertStockDbcSettlement(buy)
  for (const patch of [{ tokenDelta: 122n }, { quoteDelta: -amountIn - 1n }, { quoteDelta: -amountIn + 1n }, { quoteVaultDelta: 0n }]) {
    assert.throws(() => assertStockDbcSettlement({ ...buy, ...patch }), /Buy balances/, JSON.stringify(patch, (_, v) => String(v)))
  }
  const sell = { direction: 'sell', amountIn, minimumAmountOut, tokenDelta: -amountIn, quoteDelta: 123n, quoteVaultDelta: -123n }
  assertStockDbcSettlement(sell)
  for (const patch of [{ tokenDelta: -amountIn + 1n }, { quoteDelta: 122n }, { quoteVaultDelta: 0n }]) {
    assert.throws(() => assertStockDbcSettlement({ ...sell, ...patch }), /Sell balances/, JSON.stringify(patch, (_, v) => String(v)))
  }
})

test('trade records carry the stock mint; a stock trade can never carry a referral or a kept WSOL account', () => {
  const payer = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash })
    .add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 10 }))
  const record = { v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: payer.publicKey.toBase58(), marketId: 1, githubRepoId: '94911145',
    mint: mint.toBase58(), pool: pool.toBase58(), referral: null, wsolRent: null, amountIn: '50000000', minimumAmountOut: '1',
    message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx), blockhash, lastValidBlockHeight: 100,
    slippageBps: 100, priorityFee: null, quoteMint: METAX.toBase58() }
  assert.ok(readTradeRecord(record, 'curve').quoteMint.equals(METAX))
  assert.equal(preparedFromRecord(record).quoteMint, METAX.toBase58())
  const { quoteMint, ...sol } = record
  assert.equal(readTradeRecord(sol, 'curve').quoteMint, null, 'a record without a quote mint is SOL, as every earlier record')
  assert.equal(preparedFromRecord({ ...record, quoteMint: null }).quoteMint, null)
  for (const patch of [{ referral: Keypair.generate().publicKey.toBase58() }, { wsolRent: '2039280' }, { quoteMint: 'not a key' }]) {
    assert.throws(() => readTradeRecord({ ...record, ...patch }, 'curve'), /not prepared by this trader/, JSON.stringify(patch))
  }
})

test('trade results add the stock\'s own change only for a stock-paired trade', () => {
  assert.deepEqual(tradeResultFields({ tokenDelta: 5n, solDelta: -10n }), { tokenDelta: '5', solDelta: '-10' })
  assert.deepEqual(tradeResultFields({ tokenDelta: 5n, solDelta: -10n, quoteDelta: -50000000n, quoteMint: METAX.toBase58() }),
    { tokenDelta: '5', solDelta: '-10', quoteDelta: '-50000000', quoteMint: METAX.toBase58() })
})
