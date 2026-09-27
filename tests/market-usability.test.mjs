import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DAMM_V2_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { orderMarkets } from '../app/lib/market-order.mjs'
import { walletTokenBalances, walletMarkets } from '../app/lib/wallet-overview.mjs'
import { quoteDisplay } from '../src/trade-quote-display.mjs'
import { curveProgress, verifiedMigrationDestination } from '../app/lib/bonding-status.mjs'

test('home and explore use exact volume ranking, with a separate newest ordering', () => {
  const rows = [{ mint: 'new', indexedAt: '2026-09-25', volume24hLamports: '2' },
    { mint: 'old', indexedAt: '2026-09-24', volume24hLamports: '9007199254740993' },
    { mint: 'middle', indexedAt: '2026-09-25', volume24hLamports: '9007199254740992' }]
  assert.deepEqual(orderMarkets(rows).map(m => m.mint), ['old', 'middle', 'new'])
  assert.equal(orderMarkets(rows, 'New').at(-1).mint, 'old')
  assert.equal(rows[0].mint, 'new')
})

test('wallet aggregates multiple token accounts exactly and rejects other owners', () => {
  const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  const account = amount => {
    const data = Buffer.alloc(72); mint.toBuffer().copy(data); owner.toBuffer().copy(data, 32); data.writeBigUInt64LE(amount, 64)
    return { account: { data } }
  }
  const accounts = [account(9_007_199_254_740_993n), account(7n)]
  assert.equal(walletTokenBalances(accounts, owner.toBase58()).get(mint.toBase58()), 9_007_199_254_741_000n)
  assert.throws(() => walletTokenBalances(accounts, Keypair.generate().publicKey.toBase58()), /owner mismatch/)
  assert.throws(() => walletTokenBalances([{ account: { data: Buffer.alloc(8) } }], owner.toBase58()), /Invalid/)
})

test('wallet rewards honor lifetime caps and settled payouts; failures never imply zero holdings', () => {
  const markets = [{ repoId: '1', mint: 'A', launcherWallet: 'me' }, { repoId: '2', mint: 'B', launcherWallet: 'someone' },
    { repoId: '3', mint: 'C', beneficiaryWallet: 'me', remaining: '10' }, { repoId: '4', mint: 'D', launcherWallet: 'someone' }]
  const rewards = [{ repoId: '1', partnerEarned: '4000000000', paid: '300000000' }]
  const rows = walletMarkets(markets, new Map([['B', 123n]]), 'me', rewards)
  assert.deepEqual(rows.map(m => m.mint), ['A', 'B', 'C'])
  assert.equal(rows[0].discovery.remaining, '700000000')
  assert.equal(rows[1].discovery, null)
  assert.equal(rows[2].builderAvailable, '10')
  assert.equal(walletMarkets(markets, null, 'me', rewards)[0].balanceBaseUnits, null)
  assert.throws(() => walletMarkets(markets, new Map(), 'me', [{ ...rewards[0], paid: '1000000001' }]), /review/)
})

test('quote impact excludes SOL trading fees on both buy and sell', () => {
  const sqrtPrice = 1n << 64n // one raw quote unit per raw base unit
  const quote = args => quoteDisplay({ sqrtPrice, ...args })
  assert.equal(quote({ direction: 'buy', input: 101n, output: 100n, fee: 1n }).priceImpactPercent, 0)
  assert.equal(quote({ direction: 'sell', input: 100n, output: 99n, fee: 1n }).priceImpactPercent, 0)
  assert.equal(quote({ direction: 'buy', input: 101n, output: 80n, fee: 1n }).priceImpactPercent, 25)
  assert.equal(quote({ direction: 'sell', input: 100n, output: 79n, fee: 1n }).priceImpactPercent, 20)
  assert.throws(() => quote({ direction: 'buy', input: 1n, output: 1n, fee: 2n }), /fee/)
  assert.equal(quote({ direction: 'buy', input: 10n ** 19n + 1n, output: 10n ** 19n, fee: 1n }).priceImpactPercent, 0)
})

test('bonding uses reserves, separates migration pending from graduated, and never exceeds 100%', () => {
  assert.equal(curveProgress('250', '1000').progressPercent, 25)
  assert.equal(curveProgress('249', '1000').progressPercent, 24.9)
  assert.equal(curveProgress('999', '1000').status, 'active')
  assert.equal(curveProgress('1000', '1000').status, 'migrating')
  assert.equal(curveProgress('1001', '1000').remainingLamports, '0')
  assert.equal(curveProgress('0', '1000', true).progressPercent, 100)
  assert.equal(curveProgress('0', '1000', true).status, 'graduated')
  assert.throws(() => curveProgress('1', '0'), /Invalid/)
})

test('migration links require the correct program, token pair, and enabled pool', () => {
  const address = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  const target = { tokenAMint: mint, tokenBMint: NATIVE_MINT, poolStatus: 0 }
  const verify = (owner, state) => verifiedMigrationDestination(address, owner, state, mint, NATIVE_MINT)
  assert.equal(verify(DAMM_V2_PROGRAM_ID, target).url, `https://app.meteora.ag/dammv2/${address}`)
  assert.equal(verify(SystemProgram.programId, target), null)
  assert.equal(verify(DAMM_V2_PROGRAM_ID, { ...target, poolStatus: 1 }), null)
  assert.equal(verify(DAMM_V2_PROGRAM_ID, { ...target, tokenAMint: Keypair.generate().publicKey }), null)
})
