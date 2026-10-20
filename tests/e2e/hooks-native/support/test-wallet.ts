// A Wallet Standard wallet for the e2e suite, installed into the page by an init script before the site's own code.
//
// It REALLY signs: the disposable ed25519 key (generated in Node per test, funded by a local airdrop) is imported into
// WebCrypto and every signature is produced in the page over the exact bytes the site hands it. Nothing is mocked, and the
// wallet never broadcasts (the site sends through its own server, as with any wallet). It is not Phantom's UI: approval is
// a plain window.confirm per signature, which the test accepts (or, in E2, rejects) through browser.onDialog.
//
// Several tests in one serial group share the page: each test adds this script again with its own key, and the wallet
// always reads the LATEST key at connect, so the chooser shows one wallet and a later test signs with its own key.
//
// This function is serialized into the page, so it must not close over anything outside its body.
export interface TestWalletArg {
  /** base64 of the 32-byte ed25519 seed (the first half of a 64-byte Solana secret key). */
  readonly seedBase64: string
  /** base58 of the public key, for a self-check after the seed is imported. */
  readonly address: string
  /** Shown in the chooser and in each approval prompt. */
  readonly name: string
}

export function installTestWallet(arg: TestWalletArg): void {
  const w = window as any
  w.__e2eWalletKeys = [...(w.__e2eWalletKeys ?? []), arg]
  if (w.__e2eWalletInstalled) return
  w.__e2eWalletInstalled = true
  // Every signature the wallet produced, for the test to verify in Node and find on chain. Kept in sessionStorage too,
  // so it survives the page reloads a flow makes.
  const LOG_KEY = '__e2eWalletLog'
  try { w.__e2eWalletLog = JSON.parse(sessionStorage.getItem(LOG_KEY) ?? '[]') } catch { w.__e2eWalletLog = [] }
  const record = (entry: Record<string, string>) => { w.__e2eWalletLog.push(entry); try { sessionStorage.setItem(LOG_KEY, JSON.stringify(w.__e2eWalletLog)) } catch { /* storage off */ } }

  const CHAIN = 'solana:mainnet'
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  const base58 = (bytes: Uint8Array): string => {
    let zeros = 0
    while (zeros < bytes.length && bytes[zeros] === 0) zeros++
    const digits: number[] = []
    for (const byte of bytes) {
      let carry = byte
      for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0 }
      while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0 }
    }
    return '1'.repeat(zeros) + digits.reverse().map(d => ALPHABET[d]).join('')
  }
  const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), c => c.charCodeAt(0))
  const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('')
  const reject = (what: string): Error => Object.assign(new Error(`E2E test wallet: the ${what} was rejected`), { code: 4001 })

  type Key = { address: string; publicKey: Uint8Array; signer: CryptoKey }
  let current: Key | null = null
  let connected = false
  const listeners = new Set<(change: { accounts?: unknown[] }) => void>()

  async function loadKey(): Promise<Key> {
    const latest = w.__e2eWalletKeys[w.__e2eWalletKeys.length - 1] as TestWalletArg
    if (current?.address === latest.address) return current
    const seed = fromBase64(latest.seedBase64)
    if (seed.length !== 32) throw new Error('E2E test wallet: the seed must be 32 bytes')
    // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
    const der = new Uint8Array(48)
    der.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
    der.set(seed, 16)
    const signer = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign'])
    const jwk = await crypto.subtle.exportKey('jwk', signer)
    const publicKey = fromBase64((jwk.x as string).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (jwk.x as string).length % 4) % 4))
    const address = base58(publicKey)
    if (address !== latest.address) throw new Error('E2E test wallet: the seed does not match its address')
    current = { address, publicKey, signer }
    return current
  }
  const account = (key: Key) => Object.freeze({ address: key.address, publicKey: key.publicKey, chains: [CHAIN],
    features: ['solana:signTransaction', 'solana:signMessage'], label: 'E2E disposable key' })
  const approve = (what: string, details: string): boolean =>
    window.confirm(`E2E TEST WALLET · disposable key on a local validator\n${what}\n${details}\n\nApprove this signature?`)
  const sign = async (key: Key, bytes: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key.signer, bytes))

  // Wire format: shortvec signature count, the signatures, then the message (legacy, or 0x80|version then the same header).
  function shortvec(bytes: Uint8Array, at: number): [number, number] {
    let value = 0, size = 0
    for (;;) {
      const byte = bytes[at + size]
      value |= (byte & 0x7f) << (7 * size)
      size++
      if ((byte & 0x80) === 0) return [value, size]
      if (size > 3) throw new Error('E2E test wallet: bad shortvec')
    }
  }
  async function signWire(key: Key, wire: Uint8Array): Promise<{ signed: Uint8Array; signature: Uint8Array; message: Uint8Array }> {
    const [count, countSize] = shortvec(wire, 0)
    const messageAt = countSize + 64 * count
    const message = wire.subarray(messageAt)
    let at = (message[0] & 0x80) ? 1 : 0
    const required = message[at]
    at += 3
    const [keys, keysSize] = shortvec(message, at)
    at += keysSize
    let index = -1
    for (let i = 0; i < Math.min(required, keys); i++) {
      const candidate = message.subarray(at + 32 * i, at + 32 * i + 32)
      if (candidate.every((b, j) => b === key.publicKey[j])) { index = i; break }
    }
    if (index < 0 || index >= count) throw new Error('E2E test wallet: this transaction does not ask for this wallet\'s signature')
    const signature = await sign(key, message)
    const signed = new Uint8Array(wire)
    signed.set(signature, countSize + 64 * index)
    return { signed, signature, message }
  }

  const wallet = {
    version: '1.0.0' as const,
    name: arg.name,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=' as const,
    chains: [CHAIN],
    get accounts() { return connected && current ? [account(current)] : [] },
    features: {
      'standard:connect': { version: '1.0.0', async connect() {
        const key = await loadKey(); connected = true
        for (const listener of listeners) listener({ accounts: [account(key)] })
        return { accounts: [account(key)] }
      } },
      'standard:disconnect': { version: '1.0.0', async disconnect() { connected = false; for (const listener of listeners) listener({ accounts: [] }) } },
      'standard:events': { version: '1.0.0', on(event: string, listener: (change: { accounts?: unknown[] }) => void) {
        if (event !== 'change') return () => {}
        listeners.add(listener); return () => { listeners.delete(listener) }
      } },
      'solana:signMessage': { version: '1.0.0', async signMessage(...inputs: { account: { address: string }; message: Uint8Array }[]) {
        const key = await loadKey(), out = []
        for (const input of inputs) {
          if (!connected || input.account.address !== key.address) throw new Error('E2E test wallet: not connected as this account')
          const text = new TextDecoder().decode(input.message)
          if (!approve('Sign this message:', text)) throw reject('message signature')
          const signature = await sign(key, input.message)
          record({ kind: 'message', address: key.address, signature: base58(signature), messageBase64: btoa(String.fromCharCode(...input.message)) })
          out.push({ signedMessage: input.message, signature })
        }
        return out
      } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], async signTransaction(...inputs: { account: { address: string }; transaction: Uint8Array; chain?: string }[]) {
        const key = await loadKey(), out = []
        for (const input of inputs) {
          if (!connected || input.account.address !== key.address) throw new Error('E2E test wallet: not connected as this account')
          if (input.chain !== undefined && input.chain !== CHAIN) throw new Error(`E2E test wallet: unexpected chain ${input.chain}`)
          const digest = hex(await crypto.subtle.digest('SHA-256', (await signWireParts(input.transaction)).message))
          if (!approve('Sign this transaction:', `Message SHA-256: ${digest}`)) throw reject('transaction signature')
          const { signed, signature, message } = await signWire(key, input.transaction)
          record({ kind: 'transaction', address: key.address, signature: base58(signature), messageSha256: hex(await crypto.subtle.digest('SHA-256', message)) })
          out.push({ signedTransaction: signed })
        }
        return out
      } },
    },
  }
  // The message part only (no signing), for the approval prompt's digest.
  async function signWireParts(wire: Uint8Array): Promise<{ message: Uint8Array }> {
    const [count, countSize] = shortvec(wire, 0)
    return { message: wire.subarray(countSize + 64 * count) }
  }

  const register = ({ register: add }: { register: (wallet: unknown) => void }) => add(wallet)
  window.addEventListener('wallet-standard:app-ready', (event: Event) => register((event as CustomEvent).detail))
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
}
