import bs58 from 'bs58'
import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js'
import { NATIVE_MINT, createCloseAccountInstruction } from '@solana/spl-token'
import { STATUS, bundleErrorName, claimBackerFeesInstruction, createBundleInstruction, depositInstruction, refundInstruction,
  tokenAccountOf } from './bundle-vault.mjs'
import { BUNDLE_DEFAULTS, BUNDLE_RAISE } from './bundle-launch.mjs'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'
import { readTradeComputeBudget } from './trade-landing.mjs'
import { createWsolAtaInstruction } from './wsol-account.mjs'

// The site's raise flow for Bundle launches (docs/BUNDLE_LAUNCH.md): what a request may ask for, the exact transactions the
// site builds (open a raise, deposit, refund, claim), and the checks a wallet-signed transaction passes before the site co-signs
// or relays it. No database and no RPC here (src/bundle-raise-chain.mjs reads the chain); every refusal is a BundleRaiseError
// whose message the page shows as it is.

export class BundleRaiseError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'BundleRaiseError'; this.status = status }
}

const sol = lamports => `${Number(lamports) / 1e9} SOL`
export const RAISE_REFUSALS = Object.freeze({
  target: `Choose a target from ${sol(BUNDLE_RAISE.minTargetLamports)} to ${sol(BUNDLE_RAISE.maxTargetLamports)}.`,
  deadline: `Choose a deadline of ${BUNDLE_RAISE.deadlineDays.join(', ')} days.`,
  token: 'Token name (1–32) and symbol (1–10) are required',
  wallet: 'Invalid wallet address',
  amount: 'Enter a deposit amount in SOL.',
  repository: 'Bundle launches are for public GitHub repositories only.',
  market: 'This repository already has a market or a launch in progress.',
  live: 'This repository already has a bundle.',
  opening: 'This repository has a bundle waiting for its creator\'s wallet. If it is not signed, it expires within a few minutes.',
  creator: 'This wallet cannot open a bundle.',
  expired: 'This bundle review expired. Open the bundle again.',
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

// The token the launch will create, with the standard launch's limits (src/launch-coordinator.mjs). The image is checked by
// validateTokenImage (src/token-image.mjs) in the route, as for a standard launch.
export function tokenFields({ tokenName, tokenSymbol }) {
  if (typeof tokenName !== 'string' || typeof tokenSymbol !== 'string' || !tokenName || tokenName.length > 32 || !tokenSymbol ||
    tokenSymbol.length > 10) throw refuse('token')
  return { tokenName, tokenSymbol }
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

function signedTransaction(base64) {
  try { return Transaction.from(Buffer.from(String(base64 ?? ''), 'base64')) } catch { throw refuse('altered') }
}

// The compute budget a prepared transaction carries ahead of everything else: one unit limit and one unit price, within the
// trades' bounds (src/trade-landing.mjs). Rebuilt from the values so only the canonical encoding can match.
function preparedBudget(signed) {
  let budget
  try { budget = readTradeComputeBudget(signed.instructions) } catch { throw refuse('altered') }
  if (budget.count !== 2 || budget.limit === null) throw refuse('altered')
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: budget.limit }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: budget.microLamports })]
}

// The message the wallet reviewed, for `instructions` after the signed transaction's own budget and blockhash; the wallet may
// only append constrained Lighthouse assertions to it (src/launch-wallet-assertions.mjs).
function matchesPrepared(signed, feePayer, instructions) {
  if (!signed.feePayer?.equals(feePayer)) return false
  const reviewed = new Transaction({ feePayer, recentBlockhash: signed.recentBlockhash }).add(...preparedBudget(signed), ...instructions)
  return matchesReviewedTransaction(Buffer.from(reviewed.serializeMessage()), signed)
}

function walletSigned(signed, wallet) {
  const entry = signed.signatures.find(item => item.publicKey.equals(wallet))
  if (!entry?.signature || !signed.verifySignatures(false)) throw refuse('unsigned')
}

// The opening transaction after the creator's wallet signed it: exactly [unit limit, unit price, create_bundle(row)], paid by the
// creator, plus at most the wallet's own assertions. Only then does repo.ing's admin co-sign (the wallet signs first, as for a
// standard launch: a wallet that appends assertions would void an earlier co-signature). Returns the bytes to send.
export function acceptSignedCreate(row, admin, transactionBase64) {
  const signed = signedTransaction(transactionBase64), creator = new PublicKey(row.creatorWallet)
  if (!matchesPrepared(signed, creator, [createInstructionFor(row, admin.publicKey)])) throw refuse('altered')
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
  NotBacker: 'This wallet has no deposit in this bundle.',
  NothingToClaim: 'There is nothing to claim yet.',
  BadDestination: 'Your wrapped SOL account cannot receive this claim.',
  BadRaise: 'Solana refused these raise terms. Open the bundle again.',
  NotAdmin: 'repo.ing cannot open bundles right now.',
  PolicyTooLoose: 'repo.ing cannot open bundles right now.',
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
