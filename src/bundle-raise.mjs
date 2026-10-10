import { createHmac, timingSafeEqual } from 'node:crypto'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Message, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, createCloseAccountInstruction } from '@solana/spl-token'
import { STATUS, bundleErrorName, claimBackerFeesInstruction, createBundleInstruction, depositInstruction, refundInstruction,
  tokenAccountOf } from './bundle-vault.mjs'
import { BUNDLE_DEFAULTS, BUNDLE_RAISE } from './bundle-launch.mjs'
import { TICKER_MESSAGE, validTicker } from './launch-symbols.mjs'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'
import { readTradeComputeBudget } from './trade-landing.mjs'
import { createWsolAtaInstruction } from './wsol-account.mjs'
import { formatUnits } from '../app/lib/format.mjs'

// The site's raise flow for Bundle launches (docs/BUNDLE_LAUNCH.md): what a request may ask for, the exact transactions the
// site builds (open a raise, deposit, refund, claim), and the checks a wallet-signed transaction passes before the site co-signs
// or relays it. No database and no RPC here (src/bundle-raise-chain.mjs reads the chain); every refusal is a BundleRaiseError
// whose message the page shows as it is.

export class BundleRaiseError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'BundleRaiseError'; this.status = status }
}

// Exact SOL in plain decimals: Number(lamports) / 1e9 printed 500 lamports as "5e-7 SOL".
const sol = lamports => `${formatUnits(lamports, 9)} SOL`
export const RAISE_REFUSALS = Object.freeze({
  target: `Choose a target from ${sol(BUNDLE_RAISE.minTargetLamports)} to ${sol(BUNDLE_RAISE.maxTargetLamports)}.`,
  deadline: `Choose a deadline of ${BUNDLE_RAISE.deadlineDays.join(', ')} days.`,
  token: 'Token name (1–32) and symbol (1–10) are required',
  tokenBytes: 'Token name must fit 32 bytes and symbol 10 bytes on Solana. Use fewer special characters.',
  tokenCharacters: 'Token name and symbol cannot contain control or invisible characters.',
  tokenSymbol: TICKER_MESSAGE,
  wallet: 'Invalid wallet address',
  amount: 'Enter a deposit amount in SOL.',
  repository: 'Group launches are for public GitHub repositories only.',
  market: 'This repository already has a market or a launch in progress.',
  live: 'This repository already has a group launch.',
  opening: 'This repository has a group launch waiting for its creator\'s wallet. If it is not signed, it expires within a few minutes.',
  creator: 'This wallet cannot open a group launch.',
  wallets: 'This wallet already has group launches waiting for its signature. Sign them, or open another in a few minutes.',
  expired: 'This review expired. Open the group launch again.',
  altered: 'Your wallet changed the transaction. Review it again.',
  unsigned: 'The wallet signature is missing or invalid. Review it again.',
})
const refuse = (key, status) => new BundleRaiseError(RAISE_REFUSALS[key], status)

// A raise's terms from a request: the target in lamports (digits) and a deadline in days, from `now` (ms). The minimum deposit
// is the site's; the last deposit may be smaller so that a raise can always be filled (the program allows it).
export function raiseTerms({ targetLamports, deadlineDays }, now = Date.now()) {
  const target = /^\d{1,20}$/.test(String(targetLamports ?? '')) ? BigInt(targetLamports) : -1n
  if (target < BUNDLE_RAISE.minTargetLamports || target > BUNDLE_RAISE.maxTargetLamports) throw refuse('target')
  const days = typeof deadlineDays === 'string' && /^\d{1,2}$/.test(deadlineDays) ? Number(deadlineDays) : deadlineDays
  if (!BUNDLE_RAISE.deadlineDays.includes(days)) throw refuse('deadline')
  return { targetLamports: target, minDepositLamports: BUNDLE_RAISE.minDepositLamports, deadline: Math.floor(now / 1000) + days * 86_400 }
}

// Control characters, and format characters: bidi overrides and isolates, zero-width spaces and joiners, the BOM. They could
// make a token's name read differently from what it is.
const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u

// The token the launch will create, with the standard launch's limits (src/launch-coordinator.mjs) and Metaplex's byte caps (name
// 32 bytes, symbol 10, in UTF-8), without hidden characters. The image is checked by validateTokenImage (src/token-image.mjs) in
// the route, as for a standard launch.
export function tokenFields({ tokenName, tokenSymbol }) {
  if (typeof tokenName !== 'string' || typeof tokenSymbol !== 'string' || !tokenName || tokenName.length > 32 || !tokenSymbol ||
    tokenSymbol.length > 10) throw refuse('token')
  if (HIDDEN_CHARACTERS.test(tokenName) || HIDDEN_CHARACTERS.test(tokenSymbol)) throw refuse('tokenCharacters')
  if (Buffer.byteLength(tokenName, 'utf8') > 32 || Buffer.byteLength(tokenSymbol, 'utf8') > 10) throw refuse('tokenBytes')
  // The same ticker rule as every launch (src/launch-symbols.mjs): one ticker per market cannot be dodged with lookalikes.
  if (!validTicker(tokenSymbol)) throw refuse('tokenSymbol')
  return { tokenName, tokenSymbol }
}

// A bundle id from a path or a body: digits within the program's u64 and Postgres's bigint (at most 2^63 - 1), else null.
const MAX_BUNDLE_ID = (1n << 63n) - 1n
export function bundleIdFrom(value) {
  if (!/^[1-9]\d{0,18}$/.test(String(value ?? ''))) return null
  const id = BigInt(value)
  return id <= MAX_BUNDLE_ID ? id : null
}

// A wallet address as a canonical, on-curve base58 key (a PDA cannot sign).
export function walletKey(value) {
  if (typeof value !== 'string' || value.length > 44) throw refuse('wallet')
  try {
    const key = new PublicKey(value)
    if (key.toBase58() !== value || !PublicKey.isOnCurve(key.toBytes())) throw Error()
    return key
  } catch { throw refuse('wallet') }
}

// Lamports as digits, above zero.
export function lamportsOf(value) {
  if (!/^\d{1,20}$/.test(String(value ?? '')) || BigInt(value) <= 0n) throw refuse('amount')
  return BigInt(value)
}

// ------------------------------------------------------------------------------------------------------------- open

const unixSeconds = value => Math.floor(new Date(value).getTime() / 1000)

// create_bundle exactly as a bundles row records it (src/bundle-raise-store.mjs): the row is the server's copy of what was
// prepared, so the signed transaction is checked against it and never against what the client sends.
export const createInstructionFor = (row, admin) => createBundleInstruction({ creator: new PublicKey(row.creatorWallet), admin,
  id: BigInt(row.bundleId), repoId: BigInt(row.githubRepoId), target: BigInt(row.targetLamports), minDeposit: BigInt(row.minDepositLamports),
  deadline: unixSeconds(row.deadline), policy: BUNDLE_DEFAULTS.policy })

// The Bundle account on chain is the one the row prepared (the same creator, repository and terms).
export const bundleMatchesRow = (bundle, row) => bundle.id === BigInt(row.bundleId) && bundle.repoId === BigInt(row.githubRepoId) &&
  bundle.creator.toBase58() === row.creatorWallet && bundle.target === BigInt(row.targetLamports) &&
  bundle.minDeposit === BigInt(row.minDepositLamports) && bundle.deadline === unixSeconds(row.deadline)

// The compact-u16 count that starts a transaction's wire form, and its length in bytes.
function shortVec(bytes) {
  let value = 0
  for (let index = 0; index < 3; index++) {
    const byte = bytes[index]
    if (byte === undefined) throw Error('Short transaction')
    value |= (byte & 0x7f) << (7 * index)
    if (!(byte & 0x80)) return [value, index + 1]
  }
  throw Error('Bad transaction length')
}

// A signed transaction from base64, with exactly as many signature slots on the wire as its message requires: an extra or a
// missing slot is refused before any signature is checked.
function signedTransaction(base64) {
  try {
    const bytes = Buffer.from(String(base64 ?? ''), 'base64')
    const [count, length] = shortVec(bytes)
    const message = Message.from(bytes.subarray(length + count * 64))
    const signed = Transaction.from(bytes)
    if (count !== message.header.numRequiredSignatures || signed.signatures.length !== count) throw Error('Signature count')
    return signed
  } catch { throw refuse('altered') }
}

// The compute budget a prepared transaction carries ahead of everything else: one unit limit and one unit price, within the
// trades' bounds (src/trade-landing.mjs). Rebuilt from the values so only the canonical encoding can match.
function preparedBudget(signed) {
  let budget
  try { budget = readTradeComputeBudget(signed.instructions) } catch { throw refuse('altered') }
  if (budget.count !== 2 || budget.limit === null) throw refuse('altered')
  return { blockhash: signed.recentBlockhash, units: budget.limit, microLamports: budget.microLamports }
}
const budgetInstructions = ({ units, microLamports }) => [ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(microLamports) })]

// The message the wallet reviewed: [unit limit, unit price, ...instructions] with `budget`'s blockhash and prices (the prepared
// ones, else the signed transaction's own, which a wallet-only transaction may carry); the wallet may only append constrained
// Lighthouse assertions to it (src/launch-wallet-assertions.mjs). assertionsOn: the one account those assertions may name.
function matchesPrepared(signed, feePayer, instructions, { budget = preparedBudget(signed), assertionsOn = null } = {}) {
  if (!signed.feePayer?.equals(feePayer) || signed.recentBlockhash !== budget.blockhash) return false
  const reviewed = new Transaction({ feePayer, recentBlockhash: budget.blockhash }).add(...budgetInstructions(budget), ...instructions)
  if (!matchesReviewedTransaction(Buffer.from(reviewed.serializeMessage()), signed)) return false
  return !assertionsOn || signed.instructions.slice(reviewed.instructions.length).every(ix => ix.keys.every(key => key.pubkey.equals(assertionsOn)))
}

function walletSigned(signed, wallet) {
  const entry = signed.signatures.find(item => item.publicKey.equals(wallet))
  if (!entry?.signature || !signed.verifySignatures(false)) throw refuse('unsigned')
}

// The opening's review, sealed by the server at prepare and handed back with the signed transaction: the blockhash, its last valid
// block height and the compute budget the server chose. The client cannot change them (HMAC with a key only the server holds,
// derived from the admin key as launch sessions derive theirs, src/launch-sessions.mjs), so submit co-signs exactly the prepared
// message, and sends it only while that blockhash can land.
export function bundleReviewKey(secretKey) {
  if (!secretKey?.length) throw Error('Admin key required for bundle reviews')
  return createHmac('sha256', Buffer.from(secretKey)).update('repo.ing bundle review v1').digest()
}
const reviewMac = (key, payload) => createHmac('sha256', key).update(`bundle-review:v1:${payload}`).digest()

export function sealBundleReview(key, { bundleId, blockhash, lastValidBlockHeight, units, microLamports }) {
  const payload = Buffer.from(JSON.stringify({ id: String(bundleId), blockhash, lastValidBlockHeight, units, microLamports: String(microLamports) })).toString('base64url')
  return `${payload}.${reviewMac(key, payload).toString('base64url')}`
}

// The review of this bundle, or a refusal (an expired or altered review reads the same).
export function openBundleReview(key, sealed, bundleId) {
  const [payload, mac, extra] = String(sealed ?? '').split('.')
  const given = Buffer.from(mac ?? '', 'base64url'), expected = payload ? reviewMac(key, payload) : null
  if (extra !== undefined || !expected || given.length !== expected.length || !timingSafeEqual(given, expected)) throw refuse('expired')
  let review
  try { review = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw refuse('expired') }
  if (review?.id !== String(bundleId) || !Number.isSafeInteger(review.lastValidBlockHeight) || !Number.isSafeInteger(review.units) ||
    !/^\d{1,20}$/.test(review.microLamports) || typeof review.blockhash !== 'string') throw refuse('expired')
  return review
}

// The opening transaction after the creator's wallet signed it: exactly [unit limit, unit price, create_bundle(row)] with the
// review's blockhash and budget, paid by the creator, plus at most the wallet's own assertions on the creator's account (never on
// the admin's). Only then does repo.ing's admin co-sign (the wallet signs first, as for a standard launch: a wallet that appends
// assertions would void an earlier co-signature). Returns the bytes to send.
export function acceptSignedCreate(row, admin, transactionBase64, review) {
  const signed = signedTransaction(transactionBase64), creator = new PublicKey(row.creatorWallet)
  if (creator.equals(admin.publicKey)) throw refuse('creator')
  if (!matchesPrepared(signed, creator, [createInstructionFor(row, admin.publicKey)], { budget: review, assertionsOn: creator })) throw refuse('altered')
  walletSigned(signed, creator)
  signed.partialSign(admin)
  if (!signed.verifySignatures()) throw refuse('unsigned')
  return { raw: signed.serialize(), signature: bs58.encode(signed.signature), blockhash: signed.recentBlockhash }
}

// ------------------------------------------------------------------------------------------------- wallet actions

export const BUNDLE_ACTIONS = Object.freeze(['deposit', 'refund', 'claim'])

// What each action's transaction holds after its compute budget. A claim pays wrapped SOL, so it creates the wallet's wrapped
// SOL account (idempotent), claims into it and closes it to the wallet, which unwraps everything in it to SOL. keepWrapped:
// the account existed before the claim (it is also the referral payout account, src/referral.mjs), so it is created again
// after the close, as trades keep it.
export function actionInstructions(action, { wallet, id, lamports = null, keepWrapped = false }) {
  const owner = new PublicKey(wallet)
  if (action === 'deposit') return [depositInstruction({ wallet: owner, id, lamports: lamportsOf(lamports) })]
  if (action === 'refund') return [refundInstruction({ wallet: owner, id })]
  if (action !== 'claim') throw new BundleRaiseError('Unsupported bundle action')
  const wrapped = tokenAccountOf(owner, NATIVE_MINT)
  return [createWsolAtaInstruction(owner), claimBackerFeesInstruction({ wallet: owner, id, destination: wrapped }),
    createCloseAccountInstruction(wrapped, owner, owner), ...keepWrapped ? [createWsolAtaInstruction(owner)] : []]
}

// A deposit's amount as its signed instruction states it (the first after the budget), so the expected deposit can be rebuilt.
const depositLamports = signed => {
  const data = signed.instructions[2]?.data
  return data?.length === 16 ? data.readBigUInt64LE(8) : 0n
}

// A wallet-signed action before the site relays it: one of the transactions this site builds for this wallet and bundle,
// exactly (the wallet may only append its assertions), paid and signed by the wallet. Returns the action and the bytes to send.
export function acceptSignedAction({ id, wallet, transactionBase64 }) {
  const signed = signedTransaction(transactionBase64), owner = walletKey(wallet)
  const lamports = depositLamports(signed)
  const candidates = [['refund', {}], ['claim', { keepWrapped: false }], ['claim', { keepWrapped: true }],
    ...lamports > 0n ? [['deposit', { lamports }]] : []]
  const match = candidates.find(([action, options]) => matchesPrepared(signed, owner, actionInstructions(action, { wallet: owner, id, ...options })))
  if (!match) throw refuse('altered')
  walletSigned(signed, owner)
  if (!signed.verifySignatures()) throw refuse('unsigned')
  return { action: match[0], raw: signed.serialize(), signature: bs58.encode(signed.signature) }
}

// ------------------------------------------------------------------------------------------------- chain state

export const STATUS_NAMES = Object.freeze({ [STATUS.RAISING]: 'raising', [STATUS.LAUNCHED]: 'launched', [STATUS.FAILED]: 'failed' })

// Why a deposit of `lamports` cannot go in now (the program's own rules, checked first so the page explains them), else null.
export function depositRefusal(bundle, lamports, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (bundle.status !== STATUS.RAISING) return 'This raise is not taking deposits.'
  if (nowSeconds > bundle.deadline) return 'This raise passed its deadline.'
  const remaining = bundle.target - bundle.raised
  if (remaining <= 0n) return 'This raise is full.'
  if (lamports > remaining) return `This raise needs only ${sol(remaining)} more.`
  if (lamports < bundle.minDeposit && lamports !== remaining) return `Deposits start at ${sol(bundle.minDeposit)}; only the deposit that fills the raise may be smaller.`
  return null
}

// The program's errors a wallet can meet in this flow, in plain words.
const PROGRAM_MESSAGES = Object.freeze({
  NotRaising: 'This raise is not taking deposits.',
  RaiseClosed: 'This raise passed its deadline.',
  OverTarget: 'That is more than this raise still needs.',
  BelowMinimum: 'That deposit is below this raise\'s minimum.',
  NotFailed: 'Refunds open only after a raise fails.',
  NotBacker: 'This wallet has no deposit in this group launch.',
  NothingToClaim: 'There is nothing to claim yet.',
  BadDestination: 'Your wrapped SOL account cannot receive this claim.',
  BadRaise: 'Solana refused these raise terms. Open the group launch again.',
  NotAdmin: 'repo.ing cannot open group launches right now.',
  PolicyTooLoose: 'repo.ing cannot open group launches right now.',
})

// A failed simulation's logs as the message the page shows.
export function simulationFailure(logs, fallback = 'This transaction would fail on Solana. Refresh and try again.') {
  const text = (Array.isArray(logs) ? logs : []).join('\n')
  const name = bundleErrorName(text)
  if (name && PROGRAM_MESSAGES[name]) return PROGRAM_MESSAGES[name]
  if (/insufficient (lamports|funds)|Attempt to debit an account but found no record of a prior credit/i.test(text)) {
    return 'Your wallet does not have enough SOL for this and its network fee.'
  }
  return fallback
}
