import test from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { prepareLaunchSigning, DefinitiveLaunchError } from '../src/meteora-launch.mjs'
import { createWalletProvider, SOLANA_MAINNET_CHAIN } from '../app/lib/solana-wallet.mjs'
import { estimateLaunchCosts } from '../src/launch-costs.mjs'

function fixture() {
  const payer = Keypair.generate(), creator = Keypair.generate(), mint = Keypair.generate()
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
    .add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: 1461600, space: 82, programId: TOKEN_PROGRAM_ID }))
    .add(SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: payer.publicKey, lamports: 1 }))
  let cosigns = 0
  const track = key => ({ publicKey: key.publicKey, get secretKey() { cosigns++; return key.secretKey } })
  return { tx, payer, creator, mint, cosigns: () => cosigns,
    sign: prepareLaunchSigning(tx, payer.publicKey, track(creator), track(mint)) }
}
const transport = tx => Transaction.from(tx.serialize({ requireAllSignatures: false, verifySignatures: true }))

for (const adapter of ['legacy', 'standard']) test(`${adapter}: wallet signs first; server co-signs unchanged message after partial-signature transport`, async () => {
  const f = fixture(), message = Buffer.from(f.tx.serializeMessage())
  const walletSign = tx => {
    assert.equal(f.cosigns(), 0)
    assert.ok(tx.signatures.every(entry => entry.signature === null))
    tx.partialSign(f.payer)
    return tx
  }
  let provider
  if (adapter === 'legacy') provider = createWalletProvider({ legacy: { signTransaction: walletSign } })
  else {
    const account = { address: f.payer.publicKey.toBase58(), chains: [SOLANA_MAINNET_CHAIN] }
    provider = createWalletProvider({ standard: { features: {
      'standard:connect': { connect: async () => ({ accounts: [account] }) },
      'solana:signTransaction': { signTransaction: async ({ transaction }) => [{
        signedTransaction: walletSign(Transaction.from(transaction)).serialize({ requireAllSignatures: false, verifySignatures: true }),
      }] },
    } } })
    await provider.connect()
  }
  let userSignature
  const result = await f.sign(async tx => {
    const signed = await provider.signTransaction(transport(tx))
    userSignature = Buffer.from(signed.signature)
    assert.equal(signed.verifySignatures(), false)
    return transport(signed)
  })
  const final = Transaction.from(result.raw)
  assert.ok(final.verifySignatures())
  assert.equal(f.cosigns(), 2)
  assert.deepEqual(final.serializeMessage(), message)
  assert.deepEqual(final.signature, userSignature)
})

for (const mutation of ['instruction', 'blockhash', 'payer', 'missing signature', 'invalid signature']) {
  test(`${mutation} is rejected before server co-signing`, async () => {
    const f = fixture()
    await assert.rejects(f.sign(async tx => {
      const returned = transport(tx)
      if (mutation === 'instruction') returned.instructions[0].data[0] ^= 1
      if (mutation === 'blockhash') returned.recentBlockhash = Keypair.generate().publicKey.toBase58()
      if (mutation === 'payer') returned.feePayer = f.creator.publicKey
      if (mutation !== 'missing signature') returned.partialSign(f.payer)
      if (mutation === 'invalid signature') returned.signatures.find(s => s.publicKey.equals(f.payer.publicKey)).signature[0] ^= 1
      return returned
    }), DefinitiveLaunchError)
    assert.equal(f.cosigns(), 0)
  })
}

test('wallet cancellation never releases server signatures', async () => {
  const f = fixture()
  await assert.rejects(f.sign(async () => { throw Error('User rejected the request') }), /User rejected/)
  assert.equal(f.cosigns(), 0)
})

test('unsigned three-signer transaction still gets an exact pre-wallet simulation', async () => {
  const f = fixture()
  const rpc = {
    getBalanceAndContext: async () => ({ context: { slot: 123 }, value: 100000000 }),
    simulateTransaction: async (tx, options) => {
      assert.equal(options.sigVerify, false)
      assert.equal(options.minContextSlot, 123)
      assert.ok(tx.signatures.every(signature => signature.every(byte => byte === 0)))
      assert.equal(tx.message.header.numRequiredSignatures, 3)
      return { value: { err: null, accounts: [{ lamports: 97985000 }] } }
    },
    getFeeForMessage: async () => ({ value: 15000 }),
  }
  assert.equal((await estimateLaunchCosts(rpc, f.tx, '0')).networkFee, '15000')
  assert.equal(f.cosigns(), 0)
})
