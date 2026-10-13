import { PublicKey } from '@solana/web3.js'

// Wallets repo.ing will not trade or launch for (docs/PRODUCTION.md, "Blocked wallets"). BLOCKED_WALLETS on web holds their
// base58 addresses, separated by commas, spaces or new lines: a private Railway variable, so the list is never in this public
// repository. Refused: preparing a trade (site and Blinks, src/trade-prepare.mjs), a launch review (src/launch-coordinator.mjs),
// and opening or funding a Group launch raise (app/lib/bundle-api.mjs). A Group launch refund or claim still works: it only
// returns the wallet's own money. Only repo.ing's own transactions are refused; the markets are public Meteora pools, so a
// blocked wallet can still trade them through other apps.
export const WALLET_BLOCKED = 'WALLET_BLOCKED'
export const BLOCKED_WALLET_MESSAGE = 'This wallet cannot trade or launch on repo.ing.'

export class BlockedWalletError extends Error {
  constructor() {
    super(BLOCKED_WALLET_MESSAGE)
    this.name = 'BlockedWalletError'
    this.code = WALLET_BLOCKED
  }
}

const canonical = value => {
  try {
    const key = new PublicKey(value)
    return key.toBase58() === String(value) ? key.toBase58() : null
  } catch { return null }
}

let parsed = { source: null, wallets: new Set(), invalid: 0 }
// The list from the variable, read again only when it changes. An entry that is not a canonical address is left out and
// counted, never matched.
export function blockedWallets(env = process.env) {
  const source = env.BLOCKED_WALLETS ?? ''
  if (parsed.source === source) return parsed
  const entries = source.split(/[\s,]+/).filter(Boolean)
  const wallets = new Set(entries.map(canonical).filter(Boolean))
  const invalid = entries.length - entries.filter(canonical).length
  if (invalid > 0) console.warn('blocked_wallets_invalid_entries', { invalid })
  parsed = { source, wallets, invalid }
  return parsed
}

// wallet: a base58 string or a PublicKey.
export function isBlockedWallet(wallet, env = process.env) {
  const { wallets } = blockedWallets(env)
  if (wallets.size === 0 || wallet === null || wallet === undefined) return false
  return wallets.has(typeof wallet === 'string' ? wallet : wallet.toBase58?.() ?? String(wallet))
}

export function assertWalletAllowed(wallet, env = process.env) {
  if (isBlockedWallet(wallet, env)) throw new BlockedWalletError()
}
