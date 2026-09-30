import { createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { validTipId } from './tips.mjs'

// Donor proof for a refund: the tip's own wallet signs this exact message (signMessage, same pattern as payout-wallet
// setup). The challenge terms travel sealed (HMAC) so no table is needed; the refund always goes to the recorded donor
// wallet, so the signature only proves the request came from that wallet.
export const REFUND_CHALLENGE_MS = 5 * 60 * 1000
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export const refundMessage = ({ wallet, tipIds, nonce, expiresAt }) => [
  'repo.ing tip refund v1',
  'Refund my unclaimed repo.ing tips to this wallet.',
  'Chain: Solana', `Wallet: ${wallet}`,
  ...tipIds.map(id => `Tip ID: ${id}`),
  `Nonce: ${nonce}`, `Expires: ${new Date(expiresAt).toISOString()}`,
  'This signature does not send a transaction.',
].join('\n')

export function refundChallenge({ wallet, tipIds, now = Date.now }) {
  const key = new PublicKey(wallet).toBase58()
  if (!Array.isArray(tipIds) || !tipIds.length || tipIds.length > 20 || new Set(tipIds).size !== tipIds.length || !tipIds.every(validTipId)) throw Error('Choose up to 20 tips to refund')
  const terms = { purpose: 'tip-refund', wallet: key, tipIds: [...tipIds].sort(), nonce: randomBytes(16).toString('hex'), expiresAt: now() + REFUND_CHALLENGE_MS }
  return { terms, message: refundMessage(terms) }
}

export function verifyRefundRequest(terms, signatureBase64, now = Date.now) {
  if (terms?.purpose !== 'tip-refund' || !Number.isFinite(terms.expiresAt) || terms.expiresAt <= now()) throw Error('Refund request expired. Try again.')
  const signature = Buffer.from(String(signatureBase64 ?? ''), 'base64')
  if (signature.length !== 64) throw Error('Invalid Solana wallet signature')
  const wallet = new PublicKey(terms.wallet)
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, wallet.toBuffer()]), format: 'der', type: 'spki' })
  if (!verifySignature(null, Buffer.from(refundMessage(terms), 'utf8'), publicKey, signature)) throw Error('Invalid Solana wallet signature')
  return { donorWallet: wallet.toBase58(), tipIds: terms.tipIds }
}
