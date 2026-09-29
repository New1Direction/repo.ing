import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, getAssociatedTokenAddressSync,
  NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { normalizeFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { assertPreparedSwap, dammQuote, messageFingerprint, verifyDammSwapReceipt } from '../src/canonical-damm-trade.mjs'
import { assertPreparedDbcSwap } from '../src/canonical-trade.mjs'
import { assertWsolSetupTransaction, createWsolAtaInstruction, isCreateWsolAta, wsolAta } from '../src/wsol-account.mjs'
import { keptWsolRent } from '../src/referral.mjs'

const WSOL_ACCOUNT_RENT = 1488440n // mainnet rent-exempt minimum for 165 bytes at the time of writing

const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const accounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const amm = new CpAmm(new Connection('http://127.0.0.1:8909'))
const coder = amm._program.coder
const pool = new PublicKey(swaps.pool), mint = new PublicKey('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be')
const poolState = coder.accounts.decode('pool', Buffer.from(accounts.accounts.find(a => a.address === swaps.pool).data, 'base64'))
const currentPoint = new BN(1790666590)
const load = raw => normalizeFinalizedTransaction(structuredClone(raw), raw.transaction.signatures[0])

test('the kept-ATA instruction is exactly spl-token createAssociatedTokenAccountIdempotent for the wallet\'s WSOL ATA', () => {
  const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const ours = createWsolAtaInstruction(wallet)
  const reference = createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(NATIVE_MINT, wallet), wallet, NATIVE_MINT)
  assert.ok(ours.programId.equals(reference.programId))
  assert.deepEqual(ours.data, reference.data)
  assert.deepEqual(ours.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), reference.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]))
  assert.ok(wsolAta(wallet).equals(getAssociatedTokenAddressSync(NATIVE_MINT, wallet)))
  assert.ok(isCreateWsolAta(reference, wallet))
  assert.equal(isCreateWsolAta(reference, other), false)
  assert.equal(isCreateWsolAta(createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(NATIVE_MINT, other), other, NATIVE_MINT), wallet), false)
  assert.equal(isCreateWsolAta(createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(mint, wallet), wallet, mint), wallet), false)
})

test('payout setup transaction must be only the wallet creating its own WSOL ATA, paid by that wallet', () => {
  const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const tx = new Transaction().add(createWsolAtaInstruction(wallet))
  tx.feePayer = wallet
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58()
  const roundTrip = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
  assertWsolSetupTransaction(roundTrip, wallet)
  assert.throws(() => assertWsolSetupTransaction(roundTrip, other), /not the expected/)
  const extra = Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false }))
  extra.add(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: 1 }))
  assert.throws(() => assertWsolSetupTransaction(extra, wallet), /not the expected/)
  const foreign = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(NATIVE_MINT, other), other, NATIVE_MINT))
  foreign.feePayer = wallet
  assert.throws(() => assertWsolSetupTransaction(foreign, wallet), /not the expected/)
  const payer = new Transaction().add(createWsolAtaInstruction(wallet))
  payer.feePayer = other
  assert.throws(() => assertWsolSetupTransaction(payer, wallet), /not the expected/)
  assert.throws(() => assertWsolSetupTransaction(new Transaction(), wallet), /not the expected/)
})

test('keep is decided at prepare time only from an existing initialized WSOL ATA; RPC failure keeps old behavior', async () => {
  const wallet = Keypair.generate().publicKey
  assert.equal(await keptWsolRent({ getAccountInfo: async () => null }, wallet), null)
  assert.equal(await keptWsolRent({ getAccountInfo: async () => { throw Error('down') } }, wallet), null)
})

test('DAMM prepared swap allows exactly one trailing re-create of the wallet\'s WSOL ATA, only when expected', async () => {
  const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  for (const [direction, amountIn] of [['buy', 10_000_000n], ['sell', 10_000_000_000n]]) {
    const { minimumAmountOut } = dammQuote({ amm, poolState, direction, amountIn, currentPoint })
    const build = () => amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
      inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, outputTokenMint: direction === 'buy' ? mint : NATIVE_MINT,
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
      amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })
    const spec = { wallet, pool, poolState, direction, amountIn, minimumAmountOut }
    const kept = (await build()).add(createWsolAtaInstruction(wallet))
    assertPreparedSwap(kept, { ...spec, keepWsol: true })
    assert.throws(() => assertPreparedSwap(kept, spec), /after the WSOL close/)
    const bare = await build()
    assert.throws(() => assertPreparedSwap(bare, { ...spec, keepWsol: true }), /does not match the quote/)
    const twice = (await build()).add(createWsolAtaInstruction(wallet), createWsolAtaInstruction(wallet))
    assert.throws(() => assertPreparedSwap(twice, { ...spec, keepWsol: true }), /after the WSOL close/)
    const wrongAta = (await build()).add(createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(NATIVE_MINT, other), other, NATIVE_MINT))
    assert.throws(() => assertPreparedSwap(wrongAta, { ...spec, keepWsol: true }), /after the WSOL close/)
    const extra = (await build()).add(createWsolAtaInstruction(wallet), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: 1 }))
    assert.throws(() => assertPreparedSwap(extra, { ...spec, keepWsol: true }), /after the WSOL close/)
  }
})

test('DBC prepared swap allows exactly one trailing re-create of the wallet\'s WSOL ATA, only when expected', async () => {
  const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:8909'), 'confirmed')
  const wallet = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const config = Keypair.generate().publicKey, curve = Keypair.generate().publicKey
  const amountIn = 10_000_000n, minimumAmountOut = 123n, wsol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet)
  const swap = await dbc.pool.program.methods.swap({ amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })
    .accountsPartial({ baseMint: mint, quoteMint: NATIVE_MINT, pool: curve, baseVault: Keypair.generate().publicKey,
      quoteVault: Keypair.generate().publicKey, config, poolAuthority: Keypair.generate().publicKey, referralTokenAccount: null,
      inputTokenAccount: wsol, outputTokenAccount: getAssociatedTokenAddressSync(mint, wallet), payer: wallet,
      tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID }).instruction()
  const build = (...tail) => new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(wallet, getAssociatedTokenAddressSync(mint, wallet), wallet, mint),
    SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsol, lamports: amountIn }), swap,
    createCloseAccountInstruction(wsol, wallet, wallet), ...tail)
  const spec = { wallet, pool: curve, config, mint, amountIn, minimumAmountOut }
  assertPreparedDbcSwap(build(), spec)
  assertPreparedDbcSwap(build(createWsolAtaInstruction(wallet)), { ...spec, keepWsol: true })
  assert.throws(() => assertPreparedDbcSwap(build(createWsolAtaInstruction(wallet)), spec), /after the WSOL close/)
  assert.throws(() => assertPreparedDbcSwap(build(), { ...spec, keepWsol: true }), /after the WSOL close/)
  assert.throws(() => assertPreparedDbcSwap(build(createAssociatedTokenAccountIdempotentInstruction(wallet,
    getAssociatedTokenAddressSync(NATIVE_MINT, other), other, NATIVE_MINT)), { ...spec, keepWsol: true }), /after the WSOL close/)
  assert.throws(() => assertPreparedDbcSwap(build(createWsolAtaInstruction(wallet), SystemProgram.transfer({ fromPubkey: wallet,
    toPubkey: other, lamports: 1 })), { ...spec, keepWsol: true }), /after the WSOL close/)
  const foreignSetup = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(other, getAssociatedTokenAddressSync(mint, other), other, mint),
    swap, createCloseAccountInstruction(wsol, wallet, wallet))
  assert.throws(() => assertPreparedDbcSwap(foreignSetup, spec), /unexpected account setup/)
})

// The real fixture swap, rewritten as if the wallet's WSOL ATA had been re-created after the close: the wallet pays the
// rent (its SOL drops by exactly that) and the ATA ends rent-exempt with 0 WSOL. The sum walletSwapSol is unchanged.
function recreated(raw, direction, { rent = WSOL_ACCOUNT_RENT, owner, amount = '0', drift = 0n } = {}) {
  const tx = load(raw), keys = tx.transaction.message.accountKeys
  const ix = tx.transaction.message.instructions.find(i => keys[i.programIdIndex].toBase58().startsWith('cpamdp'))
  const solAccount = direction === 'buy' ? ix.accounts[2] : ix.accounts[3]
  assert.equal(tx.meta.postBalances[solAccount], 0)
  tx.meta.postBalances[solAccount] = Number(rent + drift)
  tx.meta.postBalances[0] -= Number(rent)
  tx.meta.postTokenBalances.push({ accountIndex: solAccount, mint: NATIVE_MINT.toBase58(), owner: owner ?? keys[0].toBase58(),
    programId: TOKEN_PROGRAM_ID.toBase58(), uiTokenAmount: { amount, decimals: 9, uiAmount: 0, uiAmountString: '0' } })
  return tx
}
function expectation(raw, direction) {
  const tx = load(raw), keys = tx.transaction.message.accountKeys
  const ix = tx.transaction.message.instructions.find(i => keys[i.programIdIndex].toBase58().startsWith('cpamdp'))
  const data = Buffer.from(bs58.decode(ix.data))
  return { signature: raw.transaction.signatures[0], fingerprint: messageFingerprint(tx.transaction.message), wallet: keys[0], pool, mint,
    tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, direction, amountIn: data.readBigUInt64LE(8), minimumAmountOut: data.readBigUInt64LE(16) }
}

test('receipt accepts a kept WSOL ATA (rent-exempt, 0 WSOL) with the exact lamport math, only when expected', () => {
  for (const direction of ['buy', 'sell']) {
    const raw = swaps[direction], expected = expectation(raw, direction)
    const plain = verifyDammSwapReceipt(load(raw), expected, coder)
    const kept = verifyDammSwapReceipt(recreated(raw, direction), { ...expected, wsolRent: WSOL_ACCOUNT_RENT }, coder)
    assert.equal(kept.solDelta, plain.solDelta - WSOL_ACCOUNT_RENT)
    assert.equal(kept.quoteAmount, plain.quoteAmount)
    assert.throws(() => verifyDammSwapReceipt(recreated(raw, direction), expected, coder), /settle to the user wallet/)
    assert.throws(() => verifyDammSwapReceipt(load(raw), { ...expected, wsolRent: WSOL_ACCOUNT_RENT }, coder), /settle to the user wallet/)
    assert.throws(() => verifyDammSwapReceipt(recreated(raw, direction, { owner: Keypair.generate().publicKey.toBase58() }), { ...expected, wsolRent: WSOL_ACCOUNT_RENT }, coder), /settle to the user wallet/)
    assert.throws(() => verifyDammSwapReceipt(recreated(raw, direction, { amount: '1' }), { ...expected, wsolRent: WSOL_ACCOUNT_RENT }, coder), /settle to the user wallet/)
    // One lamport too many in the kept ATA (taken from nowhere) is not rent-exempt-exact.
    assert.throws(() => verifyDammSwapReceipt(recreated(raw, direction, { drift: 1n }), { ...expected, wsolRent: WSOL_ACCOUNT_RENT }, coder), /settle to the user wallet/)
    if (direction !== "sell") continue
    // A sell whose wallet paid more than the rent no longer receives at least min-out.
    const overpaid = recreated(raw, direction)
    overpaid.meta.postBalances[0] -= 20_000_000
    assert.throws(() => verifyDammSwapReceipt(overpaid, { ...expected, wsolRent: WSOL_ACCOUNT_RENT }, coder), /balances/)
  }
})
