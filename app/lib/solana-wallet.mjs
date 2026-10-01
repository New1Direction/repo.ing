export const SOLANA_MAINNET_CHAIN = 'solana:mainnet'

const supportsSigning = provider => provider?.connect && provider?.signTransaction && provider?.signMessage

export function listSolanaWallets(standardWallets, browserWindow) {
  const choices = standardWallets.filter(wallet =>
    wallet?.features?.['standard:connect'] && wallet.features['solana:signTransaction'] &&
    wallet.features['solana:signMessage'] && (!wallet.chains?.length || wallet.chains.includes(SOLANA_MAINNET_CHAIN)))
    .map(wallet => ({ id: `standard:${wallet.name}`, name: wallet.name, icon: wallet.icon, standard: wallet }))
  const existingNames = new Set(choices.map(choice => choice.name.toLowerCase()))
  for (const [name, provider] of [['Phantom', browserWindow.phantom?.solana], ['Backpack', browserWindow.backpack], ['Solana wallet', browserWindow.solana]]) {
    if (!supportsSigning(provider) || (name !== 'Solana wallet' && existingNames.has(name.toLowerCase()))) continue
    if (choices.some(choice => choice.legacy === provider)) continue
    if (name === 'Solana wallet' && (provider.isPhantom || provider.isBackpack)) continue
    choices.push({ id: `legacy:${name}`, name, legacy: provider })
  }
  const rank = name => {
    const normalized = name.toLowerCase()
    if (normalized.includes('phantom')) return 0
    if (normalized.includes('backpack')) return 1
    if (normalized.includes('metamask')) return 2
    return 3
  }
  return choices.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
}

export function createWalletProvider(choice) {
  if (choice.legacy) {
    const legacy = choice.legacy
    return {
      get publicKey() { return legacy.publicKey },
      async connect({ silent = false } = {}) {
        if (!silent) return legacy.connect()
        if (legacy.isConnected && legacy.publicKey) return { publicKey: legacy.publicKey }
        if (legacy.isPhantom) return legacy.connect({ onlyIfTrusted: true })
        return null
      },
      async disconnect() { await legacy.disconnect?.() },
      signTransaction(transaction) { return legacy.signTransaction(transaction) },
      signMessage(message) { return legacy.signMessage(message) },
      subscribe(onAccount) {
        if (typeof legacy.on !== 'function') return () => {}
        const accountChanged = key => onAccount(key?.toBase58?.() ?? null)
        const disconnected = () => onAccount(null)
        legacy.on('accountChanged', accountChanged)
        legacy.on('disconnect', disconnected)
        return () => {
          legacy.removeListener?.('accountChanged', accountChanged)
          legacy.removeListener?.('disconnect', disconnected)
        }
      },
    }
  }
  const wallet = choice.standard
  let account = null
  const mainnetAccount = accounts => accounts?.find(item => item.chains?.includes(SOLANA_MAINNET_CHAIN)) ?? null
  return {
    get publicKey() { return account?.address ? { toBase58: () => account.address } : null },
    async connect({ silent = false } = {}) {
      const result = await wallet.features['standard:connect'].connect(silent ? { silent: true } : undefined)
      account = mainnetAccount(result.accounts)
      if (!account?.address) throw new Error(`${wallet.name} did not return a Solana address`)
      return { publicKey: { toBase58: () => account.address } }
    },
    async disconnect() {
      await wallet.features['standard:disconnect']?.disconnect?.()
      account = null
    },
    subscribe(onAccount) {
      const events = wallet.features['standard:events']
      if (!events) return () => {}
      return events.on('change', changes => {
        if (!changes.accounts) return
        account = mainnetAccount(changes.accounts)
        onAccount(account?.address ?? null)
      })
    },
    async signTransaction(transaction) {
      if (!account) throw new Error('Connect wallet before signing')
      const { Transaction } = await import('@solana/web3.js')
      const bytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
      const [result] = await wallet.features['solana:signTransaction'].signTransaction({
        account, transaction: bytes, chain: SOLANA_MAINNET_CHAIN,
      })
      if (!(result?.signedTransaction instanceof Uint8Array)) throw new Error('Wallet returned an invalid transaction')
      return Transaction.from(result.signedTransaction)
    },
    async signMessage(message) {
      if (!account) throw new Error('Connect wallet before signing')
      const [result] = await wallet.features['solana:signMessage'].signMessage({ account, message })
      return result?.signature
    },
  }
}

export function findSolanaWallet(browserWindow) {
  const candidates = [browserWindow.solana, browserWindow.phantom?.solana, browserWindow.backpack]
    .filter(supportsSigning)
  return candidates.find(candidate => candidate.publicKey) ?? candidates[0] ?? null
}

// Phone browsers (Safari, Chrome) have no injected wallet. These universal links reopen the page inside the wallet
// app's own browser, where the wallet is injected and connects normally.
const WALLET_BROWSE_LINKS = [
  ['Phantom', 'https://phantom.app/ul/browse/'],
  ['Solflare', 'https://solflare.com/ul/v1/browse/'],
  ['Backpack', 'https://backpack.app/ul/v1/browse/'],
]

export function walletBrowseLinks(pageUrl) {
  const { href, origin } = new URL(pageUrl)
  return WALLET_BROWSE_LINKS.map(([name, base]) =>
    ({ name, href: `${base}${encodeURIComponent(href)}?ref=${encodeURIComponent(origin)}` }))
}

export function isPhoneBrowser(browserWindow) {
  const nav = browserWindow?.navigator
  if (!nav) return false
  if (nav.userAgentData?.mobile) return true
  // iPadOS Safari reports a desktop Mac user agent; only the touch points give it away
  return /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? '') || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

// Inside Phantom, Solflare or Backpack's own browser the wallet is already listed, so no app link is needed
export const hasWalletAppBrowser = choices => choices.some(choice => /phantom|solflare|backpack/i.test(choice.name))

export function walletSignatureBytes(result) {
  const signature = result?.signature ?? result
  if (!(signature instanceof Uint8Array)) throw new Error('Wallet returned an invalid message signature')
  return signature
}
