// Public deterministic LOCAL TEST identity. Never load a production wallet here.
// This adapter signs only; it deliberately has no transaction submission API.
let choice
export function localHookWalletChoice(browserWindow = globalThis.window) {
  if (process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_HOOK_LOCAL_TEST_WALLET !== 'true' ||
    !browserWindow || !['localhost', '127.0.0.1', '[::1]'].includes(browserWindow.location.hostname)) return null
  if (choice) return choice
  let identity, connected = false
  async function keys() {
    identity ??= (async () => {
      const { Keypair } = await import('@solana/web3.js')
      const seed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('repo.ing hooks local acceptance wallet v1')))
      const pair = Keypair.fromSeed(seed)
      const der = new Uint8Array(48)
      der.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
      der.set(seed, 16)
      const messageKey = await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign'])
      seed.fill(0); der.fill(0)
      return { pair, messageKey }
    })()
    return identity
  }
  async function consent(description) {
    if (!connected) throw Error('Connect the local test wallet first')
    if (!browserWindow.confirm(`LOCAL TEST WALLET ONLY\n${description}\n\nApprove this signature? Cancel rejects it. No real funds are available to this wallet.`)) {
      const error = new Error('Local test wallet rejected the signature')
      error.code = 4001
      throw error
    }
  }
  const provider = {
    get isConnected() { return connected },
    publicKey: null,
    async connect() {
      const { pair } = await keys()
      provider.publicKey = pair.publicKey; connected = true
      return { publicKey: pair.publicKey }
    },
    async disconnect() { connected = false; provider.publicKey = null },
    async signMessage(message) {
      await consent(`Sign this wallet identity message:\n${new TextDecoder().decode(message)}`)
      const { messageKey } = await keys()
      return new Uint8Array(await crypto.subtle.sign('Ed25519', messageKey, message))
    },
    async signTransaction(transaction) {
      const { VersionedTransaction } = await import('@solana/web3.js')
      if (!(transaction instanceof VersionedTransaction)) throw Error('Local hooks wallet accepts reviewed versioned transactions only')
      const bytes = transaction.message.serialize()
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
      await consent(`Sign the reviewed local transaction.\nMessage SHA-256: ${digest}\nThis wallet does not broadcast transactions.`)
      const { pair } = await keys()
      const signed = VersionedTransaction.deserialize(transaction.serialize())
      signed.sign([pair])
      return signed
    },
  }
  choice = { id: 'local:hooklab-synthetic', name: 'Local hooks test wallet · synthetic funds only', legacy: provider }
  return choice
}
