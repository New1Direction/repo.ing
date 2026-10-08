import test from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { DEFAULT_DAILY_FREE_SETUPS, assertSponsoredSetup, freeSetupMessage, freeSetupSettings } from '../src/referral-sponsorship.mjs'
import { assertWsolSetupTransaction, createWsolAtaInstruction, isCreateWsolAta, wsolAta } from '../src/wsol-account.mjs'
import { SOLANA_MAINNET_GENESIS } from '../src/discovery-claim-message.mjs'

// Free referral payout setup (src/referral-sponsorship.mjs): the switch, the message a wallet signs and the only
// transaction the partner wallet signs for it. The database and chain flow is in referral-sponsorship-chain.test.mjs.

test('the switch: on by default with 50 a day; off, 0 or a malformed limit', () => {
  assert.deepEqual(freeSetupSettings({}), { enabled: true, daily: DEFAULT_DAILY_FREE_SETUPS })
  assert.equal(DEFAULT_DAILY_FREE_SETUPS, 50)
  assert.deepEqual(freeSetupSettings({ REFERRAL_FREE_SETUP: 'off' }), { enabled: false, daily: 50 })
  assert.deepEqual(freeSetupSettings({ REFERRAL_FREE_SETUP: ' OFF ' }).enabled, false)
  assert.deepEqual(freeSetupSettings({ REFERRAL_FREE_SETUP_DAILY: '10' }), { enabled: true, daily: 10 })
  assert.equal(freeSetupSettings({ REFERRAL_FREE_SETUP_DAILY: '0' }).enabled, false)
  for (const bad of ['-1', '1001', '2.5', 'many']) assert.throws(() => freeSetupSettings({ REFERRAL_FREE_SETUP_DAILY: bad }), /0 to 1000/)
})

test('the message names the wallet, its payout account, who pays, the request, the chain and the expiry; it allows no transaction', () => {
  const wallet = Keypair.generate().publicKey, sponsor = Keypair.generate().publicKey
  const id = '2f8fad5b-d9cb-469f-a165-70867728950e', expiresAt = new Date('2026-10-08T12:05:00Z')
  const message = freeSetupMessage({ wallet: wallet.toBase58(), sponsor, id, genesis: SOLANA_MAINNET_GENESIS, expiresAt })
  assert.equal(message, [
    'repo.ing wants you to confirm free referral payouts.', '',
    `Wallet: ${wallet.toBase58()}`,
    `Payout account: ${wsolAta(wallet).toBase58()} (wrapped SOL)`,
    `Paid by: repo.ing ${sponsor.toBase58()}`,
    `Request: ${id}`,
    `Chain: Solana mainnet ${SOLANA_MAINNET_GENESIS}`,
    'Expires: 2026-10-08T12:05:00.000Z', '',
    'This does not authorize any transaction from your wallet.'].join('\n'))
  assert.match(freeSetupMessage({ wallet, sponsor, id, genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', expiresAt }), /Chain: Solana cluster /)
  assert.throws(() => freeSetupMessage({ wallet, sponsor, id: 'nope', genesis: SOLANA_MAINNET_GENESIS, expiresAt }), /request ID/)
})

test('the partner wallet signs only the creation of this wallet\'s payout account, with itself as payer and the wallet as no signer', () => {
  const wallet = Keypair.generate().publicKey, sponsor = Keypair.generate(), other = Keypair.generate().publicKey
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })]
  const sponsored = (...instructions) => { const tx = new Transaction().add(...instructions); tx.feePayer = sponsor.publicKey; return tx }
  const create = createWsolAtaInstruction(wallet, sponsor.publicKey)
  // The same bytes as spl-token's idempotent ATA creation with the sponsor as payer.
  const reference = createAssociatedTokenAccountIdempotentInstruction(sponsor.publicKey, getAssociatedTokenAddressSync(NATIVE_MINT, wallet), wallet, NATIVE_MINT)
  assert.deepEqual([create.data, create.keys], [reference.data, reference.keys])
  assert.ok(isCreateWsolAta(create, wallet, sponsor.publicKey))
  assert.equal(isCreateWsolAta(create, wallet), false, 'not the wallet-paid form')
  assert.doesNotThrow(() => assertSponsoredSetup(sponsored(...budget, create), wallet, sponsor.publicKey))
  const refused = [
    ['the wallet pays the fee', (() => { const tx = sponsored(...budget, create); tx.feePayer = wallet; return tx })()],
    ['another wallet\'s account', sponsored(...budget, createWsolAtaInstruction(other, sponsor.publicKey))],
    ['the wallet pays the rent', sponsored(...budget, createWsolAtaInstruction(wallet))],
    ['an extra transfer', sponsored(...budget, create, SystemProgram.transfer({ fromPubkey: sponsor.publicKey, toPubkey: wallet, lamports: 1 }))],
    ['two creations', sponsored(create, create)],
    ['nothing', sponsored(...budget)],
  ]
  for (const [name, tx] of refused) assert.throws(() => assertSponsoredSetup(tx, wallet, sponsor.publicKey), /not the expected account creation/, name)
  const signer = sponsored(...budget, create)
  signer.signatures.push({ publicKey: wallet, signature: null })
  assert.throws(() => assertSponsoredSetup(signer, wallet, sponsor.publicKey), /not the expected/, 'the wallet as a signer')
  // The paid setup keeps refusing anything but the wallet paying for its own account.
  const paidShape = new Transaction().add(create); paidShape.feePayer = wallet
  assert.throws(() => assertWsolSetupTransaction(paidShape, wallet), /not the expected account creation/)
})
