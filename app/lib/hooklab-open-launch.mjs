// The self-serve launch flow's pure parts: the review screen's figures and the one guided signing step's next action.
// No network, wallet or React here, so the server, the client component and the tests share them.
import { DEFAULT_CREATOR_FEE_BPS, DEFAULT_WALLET_CAP_BPS } from '../../src/hooklab-launch-menus.mjs'
import { formatSol, formatUsd, launchValues } from '../../src/hooklab-launch-pricing.mjs'

// The owner's required wording, shown on the review screen before anything is signed.
export const OPEN_LAUNCH_NOTE = 'Anyone can launch a Hooks coin. repo.ing doesn\'t review or vouch for coins. Check the mint address, creator and links before you buy.'
export const OPEN_LAUNCH_STEPS = Object.freeze(['Your coin', 'Review', 'Sign', 'Live'])
export const TWO_APPROVALS = 'Your wallet will ask you to approve twice: once to set up your coin, then once to open trading.'

// The signatures each transaction carries (setup: the creator, the coin address and its launch settings; launch: the
// creator and the coin address) and the compute budget each asks for.
const SIGNATURES = Object.freeze({ setup: 3n, launch: 2n }), LAMPORTS_PER_SIGNATURE = 5000n, COMPUTE_UNIT_LIMIT = 1_400_000n
// The network fee both launch transactions pay together, at the server's priority price (micro-lamports per unit).
export function openLaunchNetworkFee(priorityMicroLamports = '0') {
  const priority = /^(0|[1-9][0-9]{0,6})$/.test(String(priorityMicroLamports)) ? BigInt(priorityMicroLamports) : 0n
  const budget = (COMPUTE_UNIT_LIMIT * priority + 999_999n) / 1_000_000n
  return String(Object.values(SIGNATURES).reduce((sum, signatures) => sum + signatures * LAMPORTS_PER_SIGNATURE + budget, 0n))
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
// An estimate in SOL: at least 4 decimals, more for a small amount so its first digit shows (25,000 lamports is
// "≈0.00003 SOL", 27,604,720 is "≈0.0276 SOL").
export function approxSol(value) {
  const v = BigInt(value), decimals = Math.max(4, v > 0n ? 10 - String(v).length : 4), unit = 10n ** BigInt(9 - decimals)
  const rounded = (v + unit / 2n) / unit, whole = rounded / 10n ** BigInt(decimals), fraction = String(rounded % 10n ** BigInt(decimals)).padStart(decimals, '0').replace(/0+$/, '')
  return `≈${whole}${fraction ? `.${fraction}` : ''} SOL`
}
// What the creator pays, every figure read from the chain or the server at review time (never a literal here). costs:
// the launch-requests response's { networkFeeLamports }; openCreation: { launchFeeLamports, poolCreationFeeLamports?,
// rentLamports? } (the rent of every account the launch creates, at the chain's current rate). A figure the server did
// not send stays null and reads as "shown in your wallet". Each row reads "<label> <amount> <note>", e.g.
// "Creation fee 0.02 SOL (to repo.ing)".
export function openLaunchCosts(openCreation, costs = {}) {
  const row = (key, label, value, note, exact = false) => ({ key, label, lamports: value, note, amount: value === null ? null : exact ? formatSol(value, 9) : approxSol(value) })
  const rows = [
    row('creation', 'Creation fee', lamports(openCreation?.launchFeeLamports), '(to repo.ing)', true),
    ...(lamports(openCreation?.poolCreationFeeLamports) > 0n ? [row('pool', 'Pool fee', lamports(openCreation.poolCreationFeeLamports), '(opens your coin’s market)', true)] : []),
    row('rent', 'Account rent', lamports(openCreation?.rentLamports), '(stays in the coin’s accounts)'),
    row('network', 'Network fees', lamports(costs?.networkFeeLamports), ''),
  ]
  const known = rows.every(r => r.lamports !== null), totalLamports = known ? rows.reduce((sum, r) => sum + r.lamports, 0n) : null
  return { rows, totalLamports, total: totalLamports === null ? null : approxSol(totalLamports) }
}
export const solOrWallet = value => value === null ? 'Shown in your wallet' : formatSol(value, 6)

// The opening price and the graduation target, in SOL and USD (null without a SOL price). price: { solUsdMicros,
// virtualQuote } (today's estimate from the server, or the price fixed when the launch was reserved), or null.
export function openLaunchPrice(price) {
  if (!price?.virtualQuote) return null
  const v = launchValues(price.virtualQuote, price.solUsdMicros ?? null), usd = micros => micros === null ? null : `≈${formatUsd(micros)}`
  return { opening: { sol: formatSol(v.openingLamports), usd: usd(v.openingUsdMicros) }, graduation: { sol: formatSol(v.graduationLamports), usd: usd(v.graduationUsdMicros) },
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
