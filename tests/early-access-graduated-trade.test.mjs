import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CpAmm, CP_AMM_PROGRAM_ID, SwapMode } from '@meteora-ag/cp-amm-sdk'
import { assertPreparedSwap, assertTradablePool, createDammTrader, dammQuote } from '../src/canonical-damm-trade.mjs'
import { EARLY_ACCESS_NOT_TRADABLE } from '../src/early-access.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID } from '../src/early-access-hook.mjs'

// Step 7b (docs/EARLY_ACCESS.md): a graduated contributor early access market trades on its DAMM v2 pool, whose token A is
// Token-2022. The pool account is the real $REPOING one with its token flag set as such a pool has it; no RPC is touched.
const swaps = JSON.parse(readFileSync(new URL('./fixtures/repoing-damm-swaps.json', import.meta.url), 'utf8'))
const accounts = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url), 'utf8'))
const amm = new CpAmm(new Connection('http://127.0.0.1:8909'))
const pool = new PublicKey(swaps.pool), mint = new PublicKey('59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be')
const splPool = amm._program.coder.accounts.decode('pool', Buffer.from(accounts.accounts.find(a => a.address === swaps.pool).data, 'base64'))
const poolState = { ...splPool, tokenAFlag: 1 }
const currentPoint = new BN(1790666590)
const wallet = Keypair.generate().publicKey

const build = ({ direction, amountIn, minimumAmountOut, tokenAProgram = TOKEN_2022_PROGRAM_ID, referral = null }) => amm.swap2({ payer: wallet, pool, poolState,
  swapMode: SwapMode.ExactIn, inputTokenMint: direction === 'buy' ? NATIVE_MINT : mint, outputTokenMint: direction === 'buy' ? mint : NATIVE_MINT,
  tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
  tokenAProgram, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: referral,
  amountIn: new BN(String(amountIn)), minimumAmountOut: new BN(String(minimumAmountOut)) })

// One instruction's account replaced, flags kept: what a drifted SDK or a tampered builder could hand back.
const withKey = (tx, find, index, pubkey) => {
  const at = tx.instructions.findIndex(find)
  assert.ok(at >= 0)
  const ix = tx.instructions[at]
  tx.instructions[at] = new TransactionInstruction({ programId: ix.programId, data: ix.data,
    keys: ix.keys.map((key, i) => i === index ? { ...key, pubkey } : key) })
  return tx
}
const isSwap = ix => ix.programId.equals(CP_AMM_PROGRAM_ID)
const isTokenSetup = ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[3]?.pubkey.equals(mint)

test('the graduated pool of an early access market is tradable only as Token-2022, and a SOL market\'s only as SPL', () => {
  assertTradablePool(poolState, pool, mint, { token2022: true })
  assertTradablePool(splPool, pool, mint)
  assert.throws(() => assertTradablePool(poolState, pool, mint), /not tradable/, 'a Token-2022 pool for a SOL market')
  assert.throws(() => assertTradablePool(splPool, pool, mint, { token2022: true }), /not tradable/, 'an SPL pool for an early access market')
  for (const patch of [{ poolStatus: 1 }, { collectFeeMode: 0 }, { tokenBFlag: 1 }, { tokenAVault: Keypair.generate().publicKey }]) {
    assert.throws(() => assertTradablePool({ ...poolState, ...patch }, pool, mint, { token2022: true }), /not tradable/)
  }
})

test('the SDK\'s Token-2022 swap2 passes the structural check; the SPL shape and every token program change fail closed', async () => {
  for (const direction of ['buy', 'sell']) {
    const amountIn = direction === 'buy' ? 10_000_000n : 10_000_000_000n
    const { minimumAmountOut } = dammQuote({ amm, poolState, direction, amountIn, currentPoint })
    const spec = { wallet, pool, poolState, direction, amountIn, minimumAmountOut, tokenProgram: TOKEN_2022_PROGRAM_ID }
    const tx = await build({ direction, amountIn, minimumAmountOut })
    const setup = tx.instructions.find(isTokenSetup)
    assert.ok(setup.keys[1].pubkey.equals(getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID)), 'the wallet\'s Token-2022 account')
    assertPreparedSwap(tx, spec)
    assert.throws(() => assertPreparedSwap(tx, { ...spec, tokenProgram: TOKEN_PROGRAM_ID }), /unexpected account setup/, 'read as a SOL market')
    // The SOL market's SPL swap is refused for an early access market, and the reverse.
    const spl = await build({ direction, amountIn, minimumAmountOut, tokenAProgram: TOKEN_PROGRAM_ID })
    assert.throws(() => assertPreparedSwap(spl, spec), /unexpected account setup/)
    assertPreparedSwap(spl, { ...spec, poolState: splPool, tokenProgram: TOKEN_PROGRAM_ID })
    // The swap's token A and token B programs, and the setup's token program, each checked.
    for (const [index, other] of [[9, TOKEN_PROGRAM_ID], [10, TOKEN_2022_PROGRAM_ID]]) {
      const changed = await build({ direction, amountIn, minimumAmountOut })
      assert.throws(() => assertPreparedSwap(withKey(changed, isSwap, index, other), spec), /does not match the quote/, `swap account ${index}`)
    }
    const changed = await build({ direction, amountIn, minimumAmountOut })
    assert.throws(() => assertPreparedSwap(withKey(changed, isTokenSetup, 5, TOKEN_PROGRAM_ID), spec), /unexpected account setup/, 'the setup\'s program')
    const wsol = await build({ direction, amountIn, minimumAmountOut })
    const isWsolSetup = ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys[3]?.pubkey.equals(NATIVE_MINT)
    assert.throws(() => assertPreparedSwap(withKey(wsol, isWsolSetup, 5, TOKEN_2022_PROGRAM_ID), spec), /unexpected account setup/, 'the WSOL setup\'s program')
  }
})

test('the graduated trader takes an early access market only with EARLY_ACCESS_DBC_CONFIG, and then only once proven graduated', async () => {
  const config = Keypair.generate().publicKey
  const market = { id: 1, githubRepoId: 7n, mint: mint.toBase58(), pool: Keypair.generate().publicKey.toBase58(), earlyAccessEnd: new Date(),
    transferHookProgram: EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58(), status: 'confirmed', indexedAt: new Date(), launchFinality: 'finalized' }
  const loadMarket = async () => market, request = { githubRepoId: '7', amountLamports: '1000', wallet: wallet.toBase58() }
  const asked = []
  const graduatedFees = { destination: async forMarket => { asked.push(forMarket.id); return null } }
  const offline = new Connection('http://127.0.0.1:1')
  const without = createDammTrader({ pool: {}, connection: offline, config: config.toBase58(), loadMarket, earlyAccess: null, graduatedFees, stockGraduation: {} })
  for (const call of [() => without.isMigrated('7'), () => without.quoteBuy(request), () => without.prepareSell({ ...request, amountBaseUnits: '1' })]) {
    await assert.rejects(call(), { message: EARLY_ACCESS_NOT_TRADABLE })
  }
  assert.deepEqual(asked, [], 'refused before the migration proof is read')
  // With the setting the pool comes only from the finalized migration proof (src/graduated-fees.mjs, earlyAccessGraduated).
  const opted = createDammTrader({ pool: {}, connection: offline, config: config.toBase58(), loadMarket, earlyAccess: Keypair.generate().publicKey.toBase58(),
    graduatedFees, stockGraduation: {} })
  await assert.rejects(opted.quoteBuy(request), /has not graduated/)
  assert.deepEqual(asked, [1])
})
