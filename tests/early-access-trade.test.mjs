import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSyncNativeInstruction, createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, earlyAccessAddresses, transferHookAccounts } from '../src/early-access-hook.mjs'
import { EARLY_ACCESS_TRANSFER_REFUSED, EARLY_ACCESS_WALLET_LIMIT, assertListedDuringWindow, assertPreparedDbcHookSwap, contributorsOnly, hookRefusal }
  from '../src/early-access-trade.mjs'
import { EARLY_ACCESS_NOT_TRADABLE, tradingEarlyAccessConfig } from '../src/early-access.mjs'
import { estimateTradeCosts } from '../src/trade-costs.mjs'
import { createCanonicalTrader } from '../src/canonical-trade.mjs'
import { createDammTrader } from '../src/canonical-damm-trade.mjs'
import { createWsolAtaInstruction, wsolAta } from '../src/wsol-account.mjs'

// Step 5d (docs/EARLY_ACCESS.md): the curve trade of a contributor early access market. The swap2WithTransferHook check against the
// instruction the DBC program's own IDL encodes, the window's allow-list check before a buy, the hook's refusals in words, and the
// switch that keeps these markets refused while EARLY_ACCESS_DBC_CONFIG is unset. On chain: tests/early-access-launch-chain.test.mjs.
const offline = new Connection('http://127.0.0.1:1', 'confirmed')
const program = new DynamicBondingCurveClient(offline, 'confirmed').state.getProgram()
const key = () => Keypair.generate().publicKey
const wallet = key(), mint = key(), pool = key(), config = key()
const AMOUNT_IN = 20_000_000n, MINIMUM_OUT = 123_456n

// A transaction shaped as the SDK's swap2WithTransferHook builds it (account setup, the wrap for a buy, the swap, the WSOL close),
// with the swap encoded by the program's IDL coder; change() edits the pieces before they are put together.
async function hookSwap({ direction = 'buy', sysvar = false, keepWsol = false, change = parts => parts } = {}) {
  const token = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID), wsol = wsolAta(wallet)
  const [input, output] = direction === 'buy' ? [wsol, token] : [token, wsol]
  const baseVault = deriveDbcTokenVaultAddress(pool, mint)
  const parts = change({ amount0: AMOUNT_IN, amount1: MINIMUM_OUT, swapMode: 0, slices: [{ accountsType: { transferHookBase: {} }, length: 5 }],
    accounts: { baseMint: mint, quoteMint: NATIVE_MINT, pool, baseVault, quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT), config,
      poolAuthority: deriveDbcPoolAuthority(), referralTokenAccount: null, inputTokenAccount: input, outputTokenAccount: output, payer: wallet,
      tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID },
    remaining: [...sysvar ? [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }] : [], ...transferHookAccounts(mint, baseVault)],
    before: [createAssociatedTokenAccountIdempotentInstruction(wallet, wsol, wallet, NATIVE_MINT, TOKEN_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(wallet, token, wallet, mint, TOKEN_2022_PROGRAM_ID),
      ...direction === 'buy' ? [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsol, lamports: AMOUNT_IN }), createSyncNativeInstruction(wsol)] : []],
    after: [createCloseAccountInstruction(wsol, wallet, wallet), ...keepWsol ? [createWsolAtaInstruction(wallet)] : []] })
  const swap = await program.methods.swap2WithTransferHook({ amount0: new BN(String(parts.amount0)), amount1: new BN(String(parts.amount1)), swapMode: parts.swapMode },
    { slices: parts.slices }).accountsPartial(parts.accounts).remainingAccounts(parts.remaining).instruction()
  const tx = new Transaction({ feePayer: wallet, recentBlockhash: key().toBase58() })
  return tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ...parts.before, ...(parts.swap ? parts.swap(swap) : [swap]), ...parts.after)
}
const expected = (direction = 'buy', extra = {}) => ({ direction, wallet, pool, config, mint, amountIn: AMOUNT_IN, minimumAmountOut: MINIMUM_OUT, ...extra })

test('a swap2WithTransferHook buy or sell as the SDK builds it passes; with the Instructions sysvar or a kept WSOL account too', async () => {
  for (const direction of ['buy', 'sell']) {
    assertPreparedDbcHookSwap(await hookSwap({ direction }), expected(direction))
    assertPreparedDbcHookSwap(await hookSwap({ direction, sysvar: true }), expected(direction))
    assertPreparedDbcHookSwap(await hookSwap({ direction, keepWsol: true }), expected(direction, { keepWsol: true }))
    // Without its setup (both accounts already exist) a sell is only the swap and the close.
    assertPreparedDbcHookSwap(await hookSwap({ direction, change: p => ({ ...p, before: direction === 'buy' ? p.before.slice(2) : [] }) }), expected(direction))
  }
})

test('every change to the swap, its accounts or what surrounds it is refused', async () => {
  const swapRefused = /swap does not match the quote/, extra = /unexpected instruction/
  const other = key()
  const cases = [
    ['a different input amount', {}, expected('buy', { amountIn: AMOUNT_IN + 1n }), swapRefused],
    ['a different minimum', { change: p => ({ ...p, amount1: MINIMUM_OUT - 1n }) }, expected(), swapRefused],
    ['partial fill', { change: p => ({ ...p, swapMode: 1 }) }, expected(), swapRefused],
    ['exact out', { change: p => ({ ...p, swapMode: 2 }) }, expected(), swapRefused],
    ['the referral slice type', { change: p => ({ ...p, slices: [{ accountsType: { transferHookBaseReferral: {} }, length: 5 }] }) }, expected(), swapRefused],
    ['two slices', { change: p => ({ ...p, slices: [...p.slices, ...p.slices] }) }, expected(), swapRefused],
    ['a slice length that is not the hook\'s', { change: p => ({ ...p, slices: [{ accountsType: { transferHookBase: {} }, length: 4 }] }) }, expected(), swapRefused],
    ['a referral account', { change: p => ({ ...p, accounts: { ...p.accounts, referralTokenAccount: other } }) }, expected(), swapRefused],
    ['someone else\'s output account', { change: p => ({ ...p, accounts: { ...p.accounts, outputTokenAccount: getAssociatedTokenAddressSync(mint, other, false, TOKEN_2022_PROGRAM_ID) } }) },
      expected(), swapRefused],
    ['the SPL Token account for the token', { change: p => ({ ...p, accounts: { ...p.accounts, outputTokenAccount: getAssociatedTokenAddressSync(mint, wallet) } }) }, expected(), swapRefused],
    ['another base vault', { change: p => ({ ...p, accounts: { ...p.accounts, baseVault: other } }) }, expected(), swapRefused],
    ['another config', {}, expected('buy', { config: other }), swapRefused],
    ['another pool', {}, expected('buy', { pool: other }), swapRefused],
    ['the token program swapped', { change: p => ({ ...p, accounts: { ...p.accounts, tokenBaseProgram: TOKEN_PROGRAM_ID } }) }, expected(), swapRefused],
    ['a hook account changed', { change: p => ({ ...p, remaining: [...p.remaining.slice(0, 4), { pubkey: other, isSigner: false, isWritable: false }] }) }, expected(), swapRefused],
    ['a hook account writable', { change: p => ({ ...p, remaining: p.remaining.map((m, i) => i === 1 ? { ...m, isWritable: true } : m) }) }, expected(), swapRefused],
    ['a hook account missing', { change: p => ({ ...p, remaining: p.remaining.slice(0, 4) }) }, expected(), swapRefused],
    ['an extra remaining account', { change: p => ({ ...p, remaining: [...p.remaining, { pubkey: other, isSigner: false, isWritable: false }] }) }, expected(), swapRefused],
    ['another hook program', {}, expected('buy', { hookProgram: other }), swapRefused],
    ['the wallet not signing', { change: p => ({ ...p, swap: ix => [new TransactionInstruction({ ...ix, keys: ix.keys.map((m, i) => i === 9 ? { ...m, isSigner: false } : m) })] }) },
      expected(), swapRefused],
    ['the config writable', { change: p => ({ ...p, swap: ix => [new TransactionInstruction({ ...ix, keys: ix.keys.map((m, i) => i === 1 ? { ...m, isWritable: true } : m) })] }) },
      expected(), swapRefused],
    ['the Instructions sysvar writable', { sysvar: true, change: p => ({ ...p, remaining: p.remaining.map((m, i) => i === 0 ? { ...m, isWritable: true } : m) }) },
      expected(), swapRefused],
    ['a second signer in the swap', { change: p => ({ ...p, swap: ix => [new TransactionInstruction({ ...ix, keys: ix.keys.map((m, i) => i === 3 ? { ...m, isSigner: true } : m) })] }) },
      expected(), swapRefused],
    ['two swaps', { change: p => ({ ...p, swap: ix => [ix, ix] }) }, expected(), swapRefused],
    ['the plain swap\'s data', { change: p => ({ ...p, swap: ix => [new TransactionInstruction({ ...ix, data: Buffer.concat([Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]),
      ix.data.subarray(8, 24)]) })] }) }, expected(), swapRefused],
    ['a wrap of another amount', { change: p => ({ ...p, before: [...p.before.slice(0, 2), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta(wallet), lamports: AMOUNT_IN + 1n }),
      p.before[3]] }) }, expected(), extra],
    ['a transfer elsewhere', { change: p => ({ ...p, before: [...p.before, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: 1 })] }) }, expected(), extra],
    ['a buy without its wrap', { change: p => ({ ...p, before: p.before.slice(0, 2) }) }, expected(), extra],
    ['a wrap in a sell', { direction: 'sell', change: p => ({ ...p, before: [...p.before, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta(wallet), lamports: AMOUNT_IN })] }) },
      expected('sell'), extra],
    ['a Token-2022 transfer', { direction: 'sell', change: p => ({ ...p, before: [...p.before, createTransferInstruction(getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID),
      other, wallet, 1n, [], TOKEN_2022_PROGRAM_ID)] }) }, expected('sell'), extra],
    ['an account created for someone else', { change: p => ({ ...p, before: [createAssociatedTokenAccountIdempotentInstruction(wallet,
      getAssociatedTokenAddressSync(mint, other, false, TOKEN_2022_PROGRAM_ID), other, mint, TOKEN_2022_PROGRAM_ID), ...p.before.slice(1)] }) }, expected(), extra],
    ['the same account created twice', { change: p => ({ ...p, before: [p.before[1], ...p.before] }) }, expected(), extra],
    ['no WSOL close', { change: p => ({ ...p, after: [] }) }, expected(), swapRefused],
    ['the close paying someone else', { change: p => ({ ...p, after: [createCloseAccountInstruction(wsolAta(wallet), other, wallet)] }) }, expected(), swapRefused],
    ['anything after the close', { change: p => ({ ...p, after: [...p.after, SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: 1 })] }) }, expected(),
      /after the WSOL close/],
    ['a kept account not re-created', {}, expected('buy', { keepWsol: true }), /after the WSOL close/],
    ['a direction that is neither', { direction: 'sell' }, expected('swap'), swapRefused],
    ['the wrap sent elsewhere', { change: p => ({ ...p, before: [...p.before.slice(0, 2), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: AMOUNT_IN }),
      p.before[3]] }) }, expected(), extra],
    ['the token account created at another address', { change: p => ({ ...p, before: [p.before[0], new TransactionInstruction({ ...p.before[1],
      keys: p.before[1].keys.map((m, i) => i === 1 ? { ...m, pubkey: other } : m) }), ...p.before.slice(2)] }) }, expected(), extra],
  ]
  for (const [label, shape, expect, error] of cases) {
    const tx = await hookSwap(shape)
    assert.throws(() => assertPreparedDbcHookSwap(tx, expect), error, label)
  }
})

test('during the window a buy needs the wallet on the mint\'s allow list; after it nothing is read', async () => {
  const end = Date.parse('2026-10-07T12:15:00Z'), market = { mint: mint.toBase58(), earlyAccessEnd: new Date(end) }
  const { allowList } = earlyAccessAddresses(mint)
  const list = wallets => Buffer.concat([Buffer.from('ea-allow'), mint.toBuffer(), Buffer.from(Uint32Array.of(wallets.length).buffer), ...wallets.map(w => w.toBuffer())])
  const reads = []
  const chain = account => ({ getAccountInfo: async address => { reads.push(address.toBase58()); return account } })
  const open = end - 60_000
  await assertListedDuringWindow({ connection: chain({ owner: HOOK, data: list([key(), wallet]) }), market, wallet, now: open })
  assert.deepEqual(reads, [allowList.toBase58()])
  const refusal = 'Contributor early access: only this repository\'s linked contributors can buy until 2026-10-07 12:15 UTC.'
  for (const [label, account] of [['not listed', { owner: HOOK, data: list([key()]) }], ['no list', null], ['a list owned by another program', { owner: key(), data: list([wallet]) }],
    ['another mint\'s list', { owner: HOOK, data: Buffer.concat([Buffer.from('ea-allow'), key().toBuffer(), Buffer.from(Uint32Array.of(1).buffer), wallet.toBuffer()]) }],
    ['unreadable', { owner: HOOK, data: Buffer.from('ea-allow') }]]) {
    await assert.rejects(assertListedDuringWindow({ connection: chain(account), market, wallet, now: open }), { message: refusal }, label)
  }
  reads.length = 0
  await assertListedDuringWindow({ connection: chain(null), market, wallet, now: end - 10_000 })
  await assertListedDuringWindow({ connection: chain(null), market, wallet, now: end })
  await assertListedDuringWindow({ connection: chain(null), market: { ...market, earlyAccessEnd: null }, wallet, now: open })
  assert.deepEqual(reads, [], 'in its last 30 seconds, after it or without one, nothing is read (the hook decides)')
})

test('the hook\'s refusals in a failed simulation are named; the same number from another program is not', () => {
  const failed = (program, code) => [`Program ${program} invoke [2]`, `Program ${program} failed: custom program error: 0x${code.toString(16)}`]
  assert.equal(hookRefusal(failed(HOOK.toBase58(), 6010)), contributorsOnly())
  assert.equal(contributorsOnly(), 'Contributor early access: only this repository\'s linked contributors can buy until the early access window ends.')
  assert.equal(hookRefusal(failed(HOOK.toBase58(), 6013)), EARLY_ACCESS_WALLET_LIMIT)
  assert.equal(hookRefusal(failed(HOOK.toBase58(), 6005)), EARLY_ACCESS_TRANSFER_REFUSED)
  assert.equal(hookRefusal(failed('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', 6010)), null)
  assert.equal(hookRefusal(null), null)
  for (const message of [contributorsOnly(), EARLY_ACCESS_WALLET_LIMIT, EARLY_ACCESS_TRANSFER_REFUSED]) assert.match(message, /^Contributor early access: /, 'shown by /api/trade')
})

test('while EARLY_ACCESS_DBC_CONFIG is unset an early access market is refused by name, before any chain read', async () => {
  const market = { id: 1, githubRepoId: 7n, mint: mint.toBase58(), pool: pool.toBase58(), earlyAccessEnd: new Date(), transferHookProgram: HOOK.toBase58(),
    status: 'confirmed', indexedAt: new Date(), launchFinality: 'finalized' }
  const loadMarket = async () => market, request = { githubRepoId: '7', amountLamports: '1000', wallet: wallet.toBase58() }
  const curve = createCanonicalTrader({ pool: {}, connection: offline, config: config.toBase58(), loadMarket, earlyAccess: null })
  await assert.rejects(curve.quoteBuy(request), { message: EARLY_ACCESS_NOT_TRADABLE })
  await assert.rejects(curve.prepareBuy(request), { message: EARLY_ACCESS_NOT_TRADABLE })
  await assert.rejects(curve.buyDepth('7'), { message: EARLY_ACCESS_NOT_TRADABLE })
  const graduated = createDammTrader({ pool: {}, connection: offline, config: config.toBase58(), loadMarket, earlyAccess: null, graduatedFees: {}, stockGraduation: {} })
  await assert.rejects(graduated.isMigrated('7'), { message: EARLY_ACCESS_NOT_TRADABLE }, 'the router refuses it')
  await assert.rejects(graduated.quoteBuy(request), { message: EARLY_ACCESS_NOT_TRADABLE })
  // With the setting routing reads the curve (tests/early-access-launch-chain.test.mjs) and a graduated pool trades (step 7b,
  // tests/early-access-graduated-trade.test.mjs).
})

test('a malformed EARLY_ACCESS_DBC_CONFIG refuses early access markets only: the traders still build', () => {
  const logged = [], log = message => logged.push(message)
  assert.equal(tradingEarlyAccessConfig({}, log), null)
  assert.ok(tradingEarlyAccessConfig({ EARLY_ACCESS_DBC_CONFIG: config.toBase58() }, log).equals(config))
  assert.equal(tradingEarlyAccessConfig({ EARLY_ACCESS_DBC_CONFIG: 'not-a-key' }, log), null)
  assert.deepEqual(logged, ['EARLY_ACCESS_DBC_CONFIG must be a base58 public key; early access markets are not tradable'])
  const saved = process.env.EARLY_ACCESS_DBC_CONFIG, error = console.error
  try {
    process.env.EARLY_ACCESS_DBC_CONFIG = 'not-a-key'
    console.error = () => {}
    assert.doesNotThrow(() => createCanonicalTrader({ pool: {}, connection: offline, config: config.toBase58() }))
    assert.doesNotThrow(() => createDammTrader({ pool: {}, connection: offline, config: config.toBase58(), graduatedFees: {}, stockGraduation: {} }))
  } finally {
    saved === undefined ? delete process.env.EARLY_ACCESS_DBC_CONFIG : process.env.EARLY_ACCESS_DBC_CONFIG = saved
    console.error = error
  }
})

test('costs: a Token-2022 account for a market mint that is not a Token-2022 mint is refused', async () => {
  const splMint = key()
  const tx = new Transaction({ feePayer: wallet, recentBlockhash: key().toBase58() }).add(
    createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(splMint, wallet, false, TOKEN_2022_PROGRAM_ID), wallet, splMint, TOKEN_2022_PROGRAM_ID))
  const connection = { getBalance: async () => 1e9, getFeeForMessage: async () => ({ value: 5000 }), getMinimumBalanceForRentExemption: async () => 2_039_280,
    getMultipleAccountsInfo: async keys => keys.map(() => null), getAccountInfo: async () => ({ owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(82), lamports: 1 }) }
  await assert.rejects(estimateTradeCosts(connection, { transaction: tx, direction: 'buy', amountIn: '1', mint: splMint.toBase58() }), /Account setup estimate unavailable/)
  // Another mint's Token-2022 account is refused before anything is read.
  await assert.rejects(estimateTradeCosts(connection, { transaction: tx, direction: 'buy', amountIn: '1', mint: key().toBase58() }), /Account setup estimate unavailable/)
})
