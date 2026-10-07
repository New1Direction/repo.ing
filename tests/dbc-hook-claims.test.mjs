import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createTransferInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAuthority, deriveDbcTokenVaultAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { transferHookAccounts } from '../src/early-access-hook.mjs'
import { assertHookClaimInstructions } from '../src/dbc-hook-claims.mjs'

// Step 6 (docs/EARLY_ACCESS.md): claim_creator_trading_fee2 / claim_trading_fee2 on an early access (Token-2022 hook) pool. The check
// against instructions the DBC program's own IDL coder encodes; on chain: tests/early-access-launch-chain.test.mjs.
const program = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:1'), 'confirmed').state.getProgram()
const key = () => Keypair.generate().publicKey
const pool = key(), mint = key(), config = key(), authority = key(), receiver = key(), temporary = key(), other = key()
const MAX = 1_234_567n
const SLICE = { accountsType: { transferHookBase: {} }, length: 5 }

// The four instructions as hookClaimInstructions builds them; change() edits the pieces first.
async function claim({ kind = 'creator', change = parts => parts } = {}) {
  const tokenA = getAssociatedTokenAddressSync(mint, receiver, true, TOKEN_2022_PROGRAM_ID)
  const tokenB = getAssociatedTokenAddressSync(NATIVE_MINT, temporary, true, TOKEN_PROGRAM_ID)
  const baseVault = deriveDbcTokenVaultAddress(pool, mint)
  const parts = change({ maxBase: 0n, maxQuote: MAX, slices: [SLICE], remaining: transferHookAccounts(mint, baseVault),
    accounts: { poolAuthority: deriveDbcPoolAuthority(), pool, tokenAAccount: tokenA, tokenBAccount: tokenB, baseVault,
      quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT), baseMint: mint, quoteMint: NATIVE_MINT, tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
      tokenQuoteProgram: TOKEN_PROGRAM_ID, ...kind === 'creator' ? { creator: authority } : { config, feeClaimer: authority } },
    before: [createAssociatedTokenAccountIdempotentInstruction(authority, tokenA, receiver, mint, TOKEN_2022_PROGRAM_ID),
      createAssociatedTokenAccountIdempotentInstruction(authority, tokenB, temporary, NATIVE_MINT, TOKEN_PROGRAM_ID)],
    after: [createCloseAccountInstruction(tokenB, receiver, temporary)] })
  const method = kind === 'creator' ? 'claimCreatorTradingFee2' : 'claimTradingFee2'
  const ix = await program.methods[method](new BN(String(parts.maxBase)), new BN(String(parts.maxQuote)), { slices: parts.slices })
    .accountsPartial(parts.accounts).remainingAccounts(parts.remaining).instruction()
  return [...parts.before, ...(parts.claim ? parts.claim(ix) : [ix]), ...parts.after]
}
const expected = (kind = 'creator', extra = {}) => ({ kind, authority, payer: authority, pool, config, mint, maxQuoteAmount: MAX, receiver, temporary, ...extra })
const flags = (ix, index, change) => new TransactionInstruction({ ...ix, keys: ix.keys.map((meta, i) => i === index ? { ...meta, ...change } : meta) })
const flagsAt = flags

test('the creator\'s and the partner\'s hook claims as the IDL encodes them pass; so does one without hook accounts (hook revoked)', async () => {
  for (const kind of ['creator', 'partner']) {
    assertHookClaimInstructions(await claim({ kind }), expected(kind))
    assertHookClaimInstructions(await claim({ kind, change: p => ({ ...p, slices: [], remaining: [] }) }), expected(kind))
  }
})

test('every change to the claim, its accounts or the instructions around it is refused', async () => {
  const signerAt = { creator: 8, partner: 9 }
  const cases = [
    ['a base amount', {}, p => ({ ...p, maxBase: 1n })],
    ['another maximum', {}, p => ({ ...p, maxQuote: MAX + 1n })],
    ['the referral slice type', {}, p => ({ ...p, slices: [{ accountsType: { transferHookBaseReferral: {} }, length: 5 }] })],
    ['two slices', {}, p => ({ ...p, slices: [SLICE, SLICE], remaining: [...p.remaining, ...p.remaining] })],
    ['a slice but no hook accounts', {}, p => ({ ...p, remaining: [] })],
    ['hook accounts but no slice', {}, p => ({ ...p, slices: [] })],
    ['a hook account changed', {}, p => ({ ...p, remaining: [...p.remaining.slice(0, 4), { pubkey: other, isSigner: false, isWritable: false }] })],
    ['a hook account writable', {}, p => ({ ...p, remaining: p.remaining.map((m, i) => i === 2 ? { ...m, isWritable: true } : m) })],
    ['someone else\'s token account', {}, p => ({ ...p, accounts: { ...p.accounts, tokenAAccount: getAssociatedTokenAddressSync(mint, other, true, TOKEN_2022_PROGRAM_ID) } })],
    ['the SPL Token account for the token', {}, p => ({ ...p, accounts: { ...p.accounts, tokenAAccount: getAssociatedTokenAddressSync(mint, receiver, true) } })],
    ['the authority\'s own WSOL account', {}, p => ({ ...p, accounts: { ...p.accounts, tokenBAccount: getAssociatedTokenAddressSync(NATIVE_MINT, authority, true) } })],
    ['another base vault', {}, p => ({ ...p, accounts: { ...p.accounts, baseVault: other } })],
    ['the token programs swapped', {}, p => ({ ...p, accounts: { ...p.accounts, tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_2022_PROGRAM_ID } })],
    ['the authority not signing', {}, null, ix => [flags(ix, signerAt.creator, { isSigner: false })]],
    ['the pool not writable', {}, null, ix => [flags(ix, 1, { isWritable: false })]],
    ['the mint writable', {}, null, ix => [flags(ix, 6, { isWritable: true })]],
    ['a second claim', {}, null, ix => [ix, ix]],
    ['another discriminator', {}, null, ix => [new TransactionInstruction({ ...ix, data: Buffer.concat([Buffer.from('a2ba5fc5ab2b8a38', 'hex'), ix.data.subarray(8, 24)]) })]],
    ['the close paying someone else', {}, p => ({ ...p, after: [createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, temporary, true), other, temporary)] })],
    ['no close', {}, p => ({ ...p, after: [] })],
    ['anything after the close', {}, p => ({ ...p, after: [...p.after, SystemProgram.transfer({ fromPubkey: authority, toPubkey: other, lamports: 1 })] })],
    ['a token transfer before the claim', {}, p => ({ ...p, before: [createTransferInstruction(other, other, receiver, 1n), ...p.before] })],
    ['the token account for someone else', {}, p => ({ ...p, before: [createAssociatedTokenAccountIdempotentInstruction(authority,
      getAssociatedTokenAddressSync(mint, other, true, TOKEN_2022_PROGRAM_ID), other, mint, TOKEN_2022_PROGRAM_ID), p.before[1]] })],
    ['the WSOL account for the authority', {}, p => ({ ...p, before: [p.before[0], createAssociatedTokenAccountIdempotentInstruction(authority,
      getAssociatedTokenAddressSync(NATIVE_MINT, authority, true), authority, NATIVE_MINT, TOKEN_PROGRAM_ID)] })],
    ['the partner\'s discriminator on the creator\'s claim', {}, null, ix => [new TransactionInstruction({ ...ix,
      data: Buffer.concat([Buffer.from('54bf473209a237c1', 'hex'), ix.data.subarray(8)]) })]],
    ['an empty second slice', {}, p => ({ ...p, slices: [SLICE, { accountsType: { transferHookBase: {} }, length: 0 }] })],
    ['the token account\'s address changed', {}, p => ({ ...p, before: [flagsAt(p.before[0], 1, { pubkey: other }), p.before[1]] })],
    ['the token account\'s owner changed', {}, p => ({ ...p, before: [flagsAt(p.before[0], 2, { pubkey: other }), p.before[1]] })],
    ['the token account under SPL Token', {}, p => ({ ...p, before: [flagsAt(p.before[0], 5, { pubkey: TOKEN_PROGRAM_ID }), p.before[1]] })],
    ['the WSOL account\'s address changed', {}, p => ({ ...p, before: [p.before[0], flagsAt(p.before[1], 1, { pubkey: other })] })],
    ['the payer not signing the token account', {}, p => ({ ...p, before: [flagsAt(p.before[0], 0, { isSigner: false }), p.before[1]] })],
    ['the WSOL account not writable', {}, p => ({ ...p, before: [p.before[0], flagsAt(p.before[1], 1, { isWritable: false })] })],
    ['the close not signed by the one-time authority', {}, p => ({ ...p, after: [flagsAt(p.after[0], 2, { isSigner: false })] })],
    ['the close\'s receiver not writable', {}, p => ({ ...p, after: [flagsAt(p.after[0], 1, { isWritable: false })] })],
    ['another receiver expected', { receiver: other }],
    ['another pool expected', { pool: other }],
    ['another authority expected', { authority: other }],
    ['the partner\'s claim for a creator claim', { kind: 'partner' }],
  ]
  for (const [label, expect, change = null, swapClaim = null] of cases) {
    const instructions = await claim({ change: parts => ({ ...(change ? change(parts) : parts), ...swapClaim ? { claim: swapClaim } : {} }) })
    assert.throws(() => assertHookClaimInstructions(instructions, expected(expect.kind ?? 'creator', expect)), /does not match the expected claim/, label)
  }
  // The partner's claim: its config in place, and its fee claimer the one signer.
  const otherConfig = await claim({ kind: 'partner', change: p => ({ ...p, accounts: { ...p.accounts, config: other } }) })
  assert.throws(() => assertHookClaimInstructions(otherConfig, expected('partner')), /does not match/, 'another config')
  const unsigned = await claim({ kind: 'partner', change: p => ({ ...p, claim: ix => [flags(ix, signerAt.partner, { isSigner: false })] }) })
  assert.throws(() => assertHookClaimInstructions(unsigned, expected('partner')), /does not match/, 'the fee claimer not signing')
})
