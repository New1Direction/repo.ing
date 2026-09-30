import { createPublicKey, verify as verifySignature } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'

// Launcher (discovery) reward claims are authorized by a signed plain-text message, never a wallet transaction: the
// server builds, signs (partner + temporary WSOL authority) and pays for the payout. The message binds everything the
// payout depends on; the server stores it byte for byte at prepare time and verifies the signature against that copy.
export const DISCOVERY_CLAIM_MESSAGE_MS = 5 * 60 * 1000
// Below this the reward stays accrued: it keeps a payout well above the platform-paid network fee and above the
// rent-exempt minimum of a brand-new (empty) launcher wallet, which a smaller SOL transfer could not fund.
export const MIN_DISCOVERY_CLAIM_LAMPORTS = 2_000_000n
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LAMPORTS_PER_SOL = 1_000_000_000n

export const isClaimId = value => typeof value === 'string' && UUID.test(value)

export function formatLamportsAsSol(lamports) {
  const value = BigInt(lamports)
  if (value < 0n) throw Error('Negative amount')
  const fraction = (value % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '')
  return `${value / LAMPORTS_PER_SOL}${fraction ? `.${fraction}` : ''}`
}

export function discoveryClaimMessage({ repoId, market, wallet, amount, claimId, genesis, expiresAt }) {
  if (!/^[1-9]\d*$/.test(String(repoId))) throw Error('Valid repository ID required')
  if (typeof market !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(market)) throw Error('Valid market name required')
  if (!isClaimId(claimId)) throw Error('Valid claim ID required')
  if (typeof genesis !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(genesis)) throw Error('Valid genesis hash required')
  const lamports = BigInt(amount)
  if (lamports <= 0n) throw Error('Positive amount required')
  const expiry = new Date(expiresAt)
  if (!Number.isFinite(expiry.getTime())) throw Error('Valid expiry required')
  return [
    'repo.ing wants you to confirm a launcher reward claim.',
    '',
    `Repository ID: ${repoId}`,
    `Market: ${market}`,
    `Wallet: ${new PublicKey(wallet).toBase58()}`,
    `Amount: ${formatLamportsAsSol(lamports)} SOL (${lamports} lamports)`,
    `Claim: ${claimId}`,
    `Chain: Solana ${genesis === SOLANA_MAINNET_GENESIS ? 'mainnet' : 'cluster'} ${genesis}`,
    `Expires: ${expiry.toISOString()}`,
    '',
    'This does not authorize any transaction from your wallet.',
  ].join('\n')
}

// True only for a valid ed25519 signature by `wallet` over exactly `message` (UTF-8). Malformed input is false.
export function verifyDiscoveryClaimSignature({ message, signature, wallet }) {
  if (typeof message !== 'string' || typeof signature !== 'string' || signature.length > 100) return false
  let bytes, key
  try {
    bytes = Buffer.from(bs58.decode(signature))
    key = new PublicKey(wallet).toBuffer()
  } catch { return false }
  if (bytes.length !== 64 || key.length !== 32) return false
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, key]), format: 'der', type: 'spki' })
  try { return verifySignature(null, Buffer.from(message, 'utf8'), publicKey, bytes) } catch { return false }
}
