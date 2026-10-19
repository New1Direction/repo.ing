// The self-serve launch flow's pure parts: the review screen's figures and the one guided signing step's next action.
// No network, wallet or React here, so the server, the client component and the tests share them.
import { DEFAULT_CREATOR_FEE_BPS, DEFAULT_WALLET_CAP_BPS } from '../../src/hooklab-launch-menus.mjs'
import { formatSol, formatUsd, launchValues } from '../../src/hooklab-launch-pricing.mjs'

// The owner's required wording, shown on the review screen before anything is signed.
export const OPEN_LAUNCH_NOTE = 'Anyone can launch a Hooks coin. repo.ing doesn\'t review or vouch for coins. Check the mint address, creator and links before you buy.'
export const OPEN_LAUNCH_STEPS = Object.freeze(['Your coin', 'Review', 'Sign', 'Live'])
export const TWO_APPROVALS = 'Your wallet will ask you to approve twice: once to set up your coin, then once to open trading.'

// Signatures on each of the two transactions (the creator's and the coin address's) and the compute budget each asks for.
const SIGNATURES_PER_TRANSACTION = 2n, LAMPORTS_PER_SIGNATURE = 5000n, COMPUTE_UNIT_LIMIT = 1_400_000n
// The network fee both launch transactions pay together, at the server's priority price (micro-lamports per unit).
export function openLaunchNetworkFee(priorityMicroLamports = '0') {
  const priority = /^(0|[1-9][0-9]{0,6})$/.test(String(priorityMicroLamports)) ? BigInt(priorityMicroLamports) : 0n
  const perTransaction = SIGNATURES_PER_TRANSACTION * LAMPORTS_PER_SIGNATURE + (COMPUTE_UNIT_LIMIT * priority + 999_999n) / 1_000_000n
  return String(2n * perTransaction)
}

// A menu choice that is still offered: the current one, else the usual default, else the menu's first.
export function menuChoice(menu, current, fallback) {
  if (!Array.isArray(menu) || !menu.length) return current
  return menu.includes(current) ? current : menu.includes(fallback) ? fallback : menu[0]
}
export const openMenus = openCreation => ({ creatorFeeBps: openCreation?.creatorFeeBps ?? [], capBps: openCreation?.capBps ?? [] })
export const defaultOpenChoices = openCreation => ({ creatorFeeBps: menuChoice(openCreation?.creatorFeeBps, DEFAULT_CREATOR_FEE_BPS, DEFAULT_CREATOR_FEE_BPS),
  capBps: menuChoice(openCreation?.capBps, DEFAULT_WALLET_CAP_BPS, DEFAULT_WALLET_CAP_BPS) })

// Why the creator cannot launch right now, in plain words, or ''.
export function openCreationProblem(openCreation) {
  if (!openCreation) return 'Launching isn’t available right now. Try again in a minute.'
  if (!openCreation.native || !openCreation.open || openCreation.paused) return 'Launches are paused right now. Try again later.'
  if (!openCreation.creatorFeeBps?.length || !openCreation.capBps?.length) return 'Launching isn’t available right now. Try again in a minute.'
  return ''
}

const lamports = value => value === null || value === undefined || value === '' ? null : BigInt(value)
// What the creator pays, every figure read from the chain or the server (never a literal here). costs: the launch-requests
// response's { networkFeeLamports }; openCreation: { launchFeeLamports, poolCreationFeeLamports?, rentLamports? }.
// A figure the server did not send stays null and reads as "shown in your wallet".
export function openLaunchCosts(openCreation, costs = {}) {
  const rows = [
    { key: 'creation', label: 'Creation fee (to repo.ing treasury)', about: 'Paid once, when your coin launches', lamports: lamports(openCreation?.launchFeeLamports) },
    ...(lamports(openCreation?.poolCreationFeeLamports) > 0n ? [{ key: 'pool', label: 'Pool fee', about: 'Paid once, to open your coin’s market', lamports: lamports(openCreation.poolCreationFeeLamports) }] : []),
    { key: 'rent', label: 'Rent', about: 'Deposits that keep your coin’s accounts on Solana', lamports: lamports(openCreation?.rentLamports) },
    { key: 'network', label: 'Network fee', about: 'Two transactions on Solana', lamports: lamports(costs?.networkFeeLamports) },
  ]
  const known = rows.every(row => row.lamports !== null)
  return { rows, totalLamports: known ? rows.reduce((sum, row) => sum + row.lamports, 0n) : null }
}
export const solOrWallet = value => value === null ? 'Shown in your wallet' : formatSol(value, 6)

// The opening price and the graduation target, in SOL and USD. price: { solUsdMicros, virtualQuote } (today's estimate
// from the server, or the price fixed when the launch was reserved), or null when no SOL price is known.
export function openLaunchPrice(price) {
  if (!price?.virtualQuote) return null
  const v = launchValues(price.virtualQuote, price.solUsdMicros ?? null), usd = micros => micros === null ? '' : ` (≈${formatUsd(micros)})`
  return { opening: `${formatSol(v.openingLamports)}${usd(v.openingUsdMicros)}`, graduation: `${formatSol(v.graduationLamports)}${usd(v.graduationUsdMicros)}`,
    raise: formatSol(v.raiseLamports) }
}

const PENDING = new Set(['submission-claimed', 'submitted', 'outcome-unknown'])
const CLOSABLE = new Set(['reviewed', 'partial', 'signed', 'signing-claimed', 'signing-unknown'])
// The guided step's next move for an operation the server returned (stage 'preparation' then 'launch'):
// sign (the wallet's approval), cosign (the coin address's signature, from the server), submit, reconcile (waiting for
// Solana), refresh (an unsigned review expired before the wallet saw it), close (an expired attempt that was never sent:
// the server checks the chain, then closes it), fresh (start the same stage again), launch (preparation is done: review
// the launch), live, wait (the server is mid-step), or stop (a person has to look: nothing more is signed).
export function nextOpenLaunchAction(operation, { wallet, now = Date.now() } = {}) {
  if (!operation) return 'reserve'
  const expired = now >= Number(operation.review?.reviewExpiresAtMs ?? 0), status = operation.status
  if (expired && CLOSABLE.has(status) && !operation.signature) return status === 'reviewed' && !operation.walletRequestIssued ? 'refresh' : 'close'
  if (status === 'reviewed') return 'sign'
  if (status === 'partial') return operation.signedBy?.includes(wallet) ? 'cosign' : 'sign'
  if (status === 'signed') return 'submit'
  if (status === 'signing-claimed' || status === 'signing-unknown') return 'wait'
  if (status === 'expired') return 'fresh'
  if (status === 'finalized-success') return operation.stage === 'preparation' ? 'launch' : 'live'
  return PENDING.has(status) ? 'reconcile' : 'stop'
}
// What the creator reads while the guided step runs.
export function openLaunchStatus(operation, action) {
  const second = operation?.stage === 'launch'
  if (action === 'sign') return `Approve in your wallet (${second ? 2 : 1} of 2)`
  if (action === 'reconcile' || action === 'submit' || action === 'cosign' || action === 'wait') return second ? 'Opening trading on Solana…' : 'Setting up your coin on Solana…'
  if (action === 'launch') return 'Your coin is set up. Preparing the second approval…'
  if (action === 'live') return 'Your coin is live.'
  return ''
}
