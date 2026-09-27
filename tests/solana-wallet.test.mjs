import assert from 'node:assert/strict'
import test from 'node:test'
import { findSolanaWallet, walletSignatureBytes } from '../app/lib/solana-wallet.mjs'

const wallet = (address = null) => ({
  connect() {}, signTransaction() {}, signMessage() {},
  publicKey: address ? { toBase58: () => address } : null,
})

test('Backpack works when it is the injected Solana wallet', () => {
  const backpack = wallet()
  assert.equal(findSolanaWallet({ backpack }), backpack)
  assert.equal(findSolanaWallet({ solana: { connect() {} }, backpack }), backpack)
})

test('an already-connected wallet wins when several providers are injected', () => {
  const phantom = wallet()
  const backpack = wallet('BackpackAddress')
  assert.equal(findSolanaWallet({ solana: phantom, backpack }), backpack)
  const connectedPhantom = wallet('PhantomAddress')
  assert.equal(findSolanaWallet({ solana: connectedPhantom, backpack }), connectedPhantom)
})

test('message signatures accept raw bytes or the wallet response object', () => {
  const bytes = new Uint8Array([1, 2, 3])
  assert.equal(walletSignatureBytes(bytes), bytes)
  assert.equal(walletSignatureBytes({ signature: bytes }), bytes)
  assert.throws(() => walletSignatureBytes({}), /invalid message signature/)
})

test('wallet choices include supported Wallet Standard wallets and deduplicate injected providers', async () => {
  const { listSolanaWallets, SOLANA_MAINNET_CHAIN } = await import('../app/lib/solana-wallet.mjs')
  const phantom = wallet()
  phantom.isPhantom = true
  const standard = { name: 'Phantom', chains: [SOLANA_MAINNET_CHAIN], features: {
    'standard:connect': { connect() {} }, 'solana:signTransaction': { signTransaction() {} },
    'solana:signMessage': { signMessage() {} },
  } }
  const choices = listSolanaWallets([standard], { phantom: { solana: phantom }, solana: phantom, backpack: wallet() })
  assert.deepEqual(choices.map(choice => choice.name), ['Phantom', 'Backpack'])
})

test('Wallet Standard adapter requests Solana mainnet signatures and returns transaction bytes', async () => {
  const { createWalletProvider, SOLANA_MAINNET_CHAIN } = await import('../app/lib/solana-wallet.mjs')
  const { Keypair, SystemProgram, Transaction } = await import('@solana/web3.js')
  const signer = Keypair.generate()
  const account = { address: signer.publicKey.toBase58(), chains: [SOLANA_MAINNET_CHAIN] }
  let signedForChain = null
  const standard = { name: 'MetaMask', features: {
    'standard:connect': { async connect() { return { accounts: [account] } } },
    'solana:signTransaction': { async signTransaction(input) {
      signedForChain = input.chain
      const tx = Transaction.from(input.transaction)
      tx.partialSign(signer)
      return [{ signedTransaction: tx.serialize() }]
    } },
    'solana:signMessage': { async signMessage(input) { return [{ signature: new Uint8Array([1, 2, 3]), account: input.account }] } },
  } }
  const provider = createWalletProvider({ standard })
  assert.equal(provider.publicKey, null)
  assert.equal((await provider.connect()).publicKey.toBase58(), account.address)
  assert.equal(provider.publicKey.toBase58(), account.address, 'separate liquidity approval can verify the active account')
  const transaction = new Transaction({ recentBlockhash: Keypair.generate().publicKey.toBase58(), feePayer: signer.publicKey })
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  const signed = await provider.signTransaction(transaction)
  assert.equal(signedForChain, SOLANA_MAINNET_CHAIN)
  assert.equal(signed.signatures[0].publicKey.toBase58(), account.address)
  assert.deepEqual(await provider.signMessage(new Uint8Array([4])), new Uint8Array([1, 2, 3]))
  await provider.disconnect()
  assert.equal(provider.publicKey, null)
})

test('remembered Wallet Standard connection is silent and follows account changes', async () => {
  const { createWalletProvider, SOLANA_MAINNET_CHAIN } = await import('../app/lib/solana-wallet.mjs')
  const first = { address: 'first', chains: [SOLANA_MAINNET_CHAIN] }
  const second = { address: 'second', chains: [SOLANA_MAINNET_CHAIN] }
  let connectInput, change, signedBy, unsubscribed = false
  const standard = { name: 'Test wallet', features: {
    'standard:connect': { async connect(input) { connectInput = input; return { accounts: [first] } } },
    'standard:events': { on(_event, listener) { change = listener; return () => { unsubscribed = true } } },
    'solana:signTransaction': { signTransaction() {} },
    'solana:signMessage': { async signMessage(input) { signedBy = input.account.address; return [{ signature: new Uint8Array([1]) }] } },
  } }
  const provider = createWalletProvider({ standard })
  assert.equal((await provider.connect({ silent: true })).publicKey.toBase58(), 'first')
  assert.deepEqual(connectInput, { silent: true })
  const addresses = []
  const off = provider.subscribe(address => addresses.push(address))
  change({ accounts: [second] })
  assert.equal(provider.publicKey.toBase58(), 'second')
  await provider.signMessage(new Uint8Array([2]))
  assert.equal(signedBy, 'second')
  change({ accounts: [] })
  assert.equal(provider.publicKey, null)
  assert.deepEqual(addresses, ['second', null])
  await assert.rejects(provider.signMessage(new Uint8Array([3])), /Connect wallet before signing/)
  off()
  assert.equal(unsubscribed, true)
})

test('legacy wallet restore never requests a new connection without a trusted session', async () => {
  const { createWalletProvider } = await import('../app/lib/solana-wallet.mjs')
  let calls = 0, options = null
  const backpack = { connect() { calls++ }, signTransaction() {}, signMessage() {} }
  assert.equal(await createWalletProvider({ legacy: backpack }).connect({ silent: true }), null)
  assert.equal(calls, 0)
  const phantom = { isPhantom: true, connect(input) { options = input; return { publicKey: wallet('PhantomAddress').publicKey } },
    signTransaction() {}, signMessage() {} }
  assert.equal((await createWalletProvider({ legacy: phantom }).connect({ silent: true })).publicKey.toBase58(), 'PhantomAddress')
  assert.deepEqual(options, { onlyIfTrusted: true })
})
