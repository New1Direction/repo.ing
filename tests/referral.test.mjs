import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, AccountState, createCloseAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { parseReferrer, resolveReferral } from '../src/referral.mjs'
import { assertPreparedSwap, dammQuote } from '../src/canonical-damm-trade.mjs'
import { assertPreparedDbcSwap } from '../src/canonical-trade.mjs'
import { captureReferral, referralLink, REFERRAL_TTL_MS, storedReferral } from '../app/lib/referral.mjs'

const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const accounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const amm = new CpAmm(new Connection('http://127.0.0.1:8909'))
const pool = new PublicKey(swaps.pool), mint = new PublicKey('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be')
const poolState = amm._program.coder.accounts.decode('pool', Buffer.from(accounts.accounts.find(a => a.address === swaps.pool).data, 'base64'))
const currentPoint = new BN(1790666590)
const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

function tokenAccount({ owner, tokenMint = NATIVE_MINT, state = AccountState.Initialized }) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode({ mint: tokenMint, owner, amount: 0n, delegateOption: 0, delegate: PublicKey.default, state,
    isNativeOption: 1, isNative: 2039280n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
  return { data, owner: TOKEN_PROGRAM_ID, lamports: 2039280, executable: false }
}
const connectionWith = accountFor => ({ getAccountInfo: async key => accountFor(key) })

test('referrer must be a canonical on-curve wallet address; anything else is ignored', () => {
  const wallet = Keypair.generate().publicKey
  assert.ok(parseReferrer(wallet.toBase58()).equals(wallet))
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('x')], DBC_PROGRAM)
  for (const value of [pda.toBase58(), undefined, null, 42, '', 'not-a-key', `${wallet.toBase58()}x`, { toString: () => wallet.toBase58() }]) {
    assert.equal(parseReferrer(value), null)
  }
})

test('referral resolves only to the referrer\'s own existing, initialized wrapped-SOL ATA', async () => {
  const referrer = Keypair.generate().publicKey, trader = Keypair.generate().publicKey
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, referrer)
  const ok = connectionWith(key => key.equals(ata) ? tokenAccount({ owner: referrer }) : null)
  assert.ok((await resolveReferral(ok, referrer.toBase58(), trader)).equals(ata))
  // Self-referral, missing account, wrong mint, foreign owner, frozen, non-token owner, RPC failure: no referral.
  assert.equal(await resolveReferral(ok, referrer.toBase58(), referrer), null)
  assert.equal(await resolveReferral(connectionWith(() => null), referrer.toBase58(), trader), null)
  assert.equal(await resolveReferral(connectionWith(() => tokenAccount({ owner: referrer, tokenMint: mint })), referrer.toBase58(), trader), null)
  assert.equal(await resolveReferral(connectionWith(() => tokenAccount({ owner: trader })), referrer.toBase58(), trader), null)
  assert.equal(await resolveReferral(connectionWith(() => tokenAccount({ owner: referrer, state: AccountState.Frozen })), referrer.toBase58(), trader), null)
  assert.equal(await resolveReferral(connectionWith(() => ({ ...tokenAccount({ owner: referrer }), owner: Keypair.generate().publicKey })), referrer.toBase58(), trader), null)
  assert.equal(await resolveReferral({ getAccountInfo: async () => { throw Error('rpc down') } }, referrer.toBase58(), trader), null)
  assert.equal(await resolveReferral(ok, 'garbage', trader), null)
  assert.equal(await resolveReferral(ok, null, trader), null)
})

test('browser referral is last-touch, expires after 30 days, and never refers the trader to themselves', () => {
  const store = new Map(), storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) }
  const first = Keypair.generate().publicKey.toBase58(), second = Keypair.generate().publicKey.toBase58(), trader = Keypair.generate().publicKey.toBase58()
  assert.equal(captureReferral('?ref=nonsense', storage, 1000), null)
  assert.equal(storedReferral(storage, trader, 1000), null)
  assert.equal(captureReferral(`?ref=${first}`, storage, 1000), first)
  assert.equal(captureReferral('?utm=x', storage, 2000), null)
  assert.equal(storedReferral(storage, trader, 2000), first)
  captureReferral(`?ref=${second}`, storage, 3000)
  assert.equal(storedReferral(storage, trader, 3000), second)
  assert.equal(storedReferral(storage, second, 3000), null)
  assert.equal(storedReferral(storage, trader, 3000 + REFERRAL_TTL_MS), second)
  assert.equal(storedReferral(storage, trader, 3001 + REFERRAL_TTL_MS), null)
  store.set('repoing:referrer', '{broken')
  assert.equal(storedReferral(storage, trader, 3000), null)
  assert.equal(storedReferral({ getItem: () => { throw Error('blocked') } }, trader, 3000), null)
  assert.equal(referralLink('https://repo.ing', mint.toBase58(), first), `https://repo.ing/token/${mint.toBase58()}?ref=${first}`)
})

test('a referral re-splits only the protocol fee: DAMM output and min-out are unchanged', () => {
  for (const [direction, amountIn] of [['buy', 10_000_000n], ['sell', 10_000_000_000n]]) {
    const plain = dammQuote({ amm, poolState, direction, amountIn, currentPoint })
    const withReferral = amm.getQuote2({ inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, poolState, currentPoint,
      amountIn: new BN(String(amountIn)), slippage: 100, swapMode: SwapMode.ExactIn, tokenADecimal: 6, tokenBDecimal: 9, hasReferral: true })
    assert.equal(BigInt(withReferral.outputAmount.toString()), plain.outputAmount)
    assert.ok(BigInt(withReferral.referralFee.toString()) > 0n)
    assert.equal(BigInt(withReferral.claimingFee.toString()) + BigInt(withReferral.compoundingFee.toString()) +
      BigInt(withReferral.protocolFee.toString()) + BigInt(withReferral.referralFee.toString()), plain.fee)
  }
})

test('DAMM prepared-swap check accepts exactly the resolved referral account and rejects a swapped one', async () => {
  const wallet = Keypair.generate().publicKey, referral = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const direction = 'buy', amountIn = 10_000_000n
  const { minimumAmountOut } = dammQuote({ amm, poolState, direction, amountIn, currentPoint })
  const build = referralTokenAccount => amm.swap2({ payer: wallet, pool, poolState, swapMode: SwapMode.ExactIn,
    inputTokenMint: NATIVE_MINT, outputTokenMint: mint, tokenAMint: mint, tokenBMint: NATIVE_MINT,
    tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount, amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })
  const spec = { wallet, pool, poolState, direction, amountIn, minimumAmountOut }
  const referred = await build(referral), plain = await build(null)
  assertPreparedSwap(referred, { ...spec, referral })
  assertPreparedSwap(plain, spec)
  assert.throws(() => assertPreparedSwap(referred, spec), /does not match the quote/)
  assert.throws(() => assertPreparedSwap(referred, { ...spec, referral: other }), /does not match the quote/)
  assert.throws(() => assertPreparedSwap(plain, { ...spec, referral }), /does not match the quote/)
})

test('DBC prepared-swap check accepts exactly the resolved referral account and rejects a swapped or extra use', async () => {
  const dbc = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:8909'), 'confirmed')
  const wallet = Keypair.generate().publicKey, config = Keypair.generate().publicKey, curve = Keypair.generate().publicKey
  const referral = Keypair.generate().publicKey, other = Keypair.generate().publicKey
  const amountIn = 10_000_000n, minimumAmountOut = 123n
  const build = async referralTokenAccount => new Transaction().add(await dbc.pool.program.methods.swap({ amountIn: new BN(String(amountIn)),
    minimumAmountOut: new BN(String(minimumAmountOut)) }).accountsPartial({ baseMint: mint, quoteMint: NATIVE_MINT, pool: curve,
    baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey, config, poolAuthority: Keypair.generate().publicKey,
    referralTokenAccount, inputTokenAccount: getAssociatedTokenAddressSync(NATIVE_MINT, wallet),
    outputTokenAccount: getAssociatedTokenAddressSync(mint, wallet), payer: wallet,
    tokenBaseProgram: TOKEN_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID }).instruction(),
    createCloseAccountInstruction(getAssociatedTokenAddressSync(NATIVE_MINT, wallet), wallet, wallet))
  const spec = { wallet, pool: curve, config, mint, amountIn, minimumAmountOut }
  const referred = await build(referral), plain = await build(null)
  assert.ok(plain.instructions[0].keys[12].pubkey.equals(DBC_PROGRAM))
  assert.ok(referred.instructions[0].keys[12].isWritable)
  assertPreparedDbcSwap(referred, { ...spec, referral })
  assertPreparedDbcSwap(plain, spec)
  assert.throws(() => assertPreparedDbcSwap(referred, spec), /does not match the quote/)
  assert.throws(() => assertPreparedDbcSwap(referred, { ...spec, referral: other }), /does not match the quote/)
  assert.throws(() => assertPreparedDbcSwap(plain, { ...spec, referral }), /does not match the quote/)
  assert.throws(() => assertPreparedDbcSwap(plain, { ...spec, minimumAmountOut: minimumAmountOut + 1n }), /does not match the quote/)
  const extra = await build(referral)
  extra.add({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: referral, isSigner: false, isWritable: true }], data: Buffer.from([17]) })
  assert.throws(() => assertPreparedDbcSwap(extra, { ...spec, referral }), /does not match the quote/)
})
