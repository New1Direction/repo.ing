// The self-serve launch flow's pure parts: the review screen's figures and the one guided signing step's next action.
// No network, wallet or React here, so the server, the client component and the tests share them.
import { DEFAULT_CREATOR_FEE_BPS, DEFAULT_WALLET_CAP_BPS, percent } from '../../src/hooklab-launch-menus.mjs'
import { FEE_SHARE_TOTAL, MAX_TOTAL_FEE_BPS, checkFeeSplit, describeFeeSplit, splitFee } from '../../src/hooklab-fee-split.mjs'
import { formatSol, formatUsd, launchValues } from '../../src/hooklab-launch-pricing.mjs'
import { launchHookInput } from './hooklab-native-launch-form.mjs'

export const SELECTED_HOOK_NOTE = 'Custom-hook launches must be approved for this release before you can sign. You review hook setup, coin settings and opening trading separately, with three wallet approvals. Your chosen hook and settings stay fixed throughout the launch. Token fees are checked on your transaction before approval.'
export const THREE_APPROVALS = 'Your wallet will ask you to approve three times: hook setup, launch configuration, then opening trading.'

// Recovery must retain the exact hook identity, not reinterpret cap 0 as a gate default.
export function sameLaunchHook(left, right) {
  try {
    const a = launchHookInput(left), b = launchHookInput(right)
    const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
    return a.capBps === b.capBps && a.selectedHook?.program === b.selectedHook?.program && a.selectedHook?.flags === b.selectedHook?.flags
      && JSON.stringify(canonical(a.hookPublication ?? null)) === JSON.stringify(canonical(b.hookPublication ?? null))
      && ['quoteCut', 'authorShareBps', 'rules'].every(k => JSON.stringify(canonical(a[k] ?? null)) === JSON.stringify(canonical(b[k] ?? null)))
  } catch { return false }
}

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
export const openMenus = openCreation => ({ creatorFeeBps: openCreation?.creatorFeeBps ?? [], capBps: openCreation?.capBps ?? [], maxCreatorFeeBps: openCreation?.maxCreatorFeeBps,
  continuousCreatorFee: openCreation?.continuousCreatorFee === true, burnEnabled: openCreation?.burnEnabled === true,
  maxBurnBps: openCreation?.maxBurnBps, maxRulesFeeBps: openCreation?.maxRulesFeeBps, maxHolderFeeBps: openCreation?.maxHolderFeeBps })

// The fee form with Burn on (owner design 2026-10-27): one total fee and the burn's share of it (in basis points of 100%);
// the creator takes the rest. What the coin carries (creatorFeeBps, rules), the most the total may be, the plain lines the
// creator reads, and why the chain would refuse the split ('' when it would not).
export const BURN_DESCRIPTION = 'Burn: a share of every trade’s coins is burned (destroyed), shrinking supply.'
export function openFeeSplit(openCreation, { totalBps, burnShareBps }) {
  const maxTotalBps = Math.min(MAX_TOTAL_FEE_BPS, Number.isInteger(openCreation?.maxRulesFeeBps) ? openCreation.maxRulesFeeBps : MAX_TOTAL_FEE_BPS)
  let split
  try { split = splitFee({ totalBps, shares: { creator: FEE_SHARE_TOTAL - burnShareBps, burn: burnShareBps } }) }
  catch { return { maxTotalBps, creatorFeeBps: null, burnBps: null, rules: undefined, lines: null, problem: `Enter a total fee from 0% to ${percent(maxTotalBps)}.` } }
  return { maxTotalBps, creatorFeeBps: split.creatorFeeBps, burnBps: split.burnBps, rules: split.burnBps ? { burnBuyBps: split.burnBps, burnSellBps: split.burnBps } : undefined,
    lines: describeFeeSplit(split), problem: checkFeeSplit(split, openCreation ?? {}) }
}
// A stored coin back into the fee form: the burn's share is the smallest that rounds down to its burn.
export function feeFormOf({ creatorFeeBps, rules }) {
  const burnBps = rules && rules !== 'none' ? rules.burnBuyBps : 0, feeTotalBps = creatorFeeBps + burnBps
  return { feeTotalBps, burnShareBps: feeTotalBps ? Math.ceil(burnBps * FEE_SHARE_TOTAL / feeTotalBps) : 0 }
}
// A continuous fee (no fee menu on chain): the current one when it is within the ceiling, else the ceiling.
export const continuousFeeChoice = (openCreation, current) => Math.min(Number.isInteger(current) && current >= 0 ? current : DEFAULT_CREATOR_FEE_BPS, openCreation.maxCreatorFeeBps)
export const defaultOpenChoices = openCreation => ({ creatorFeeBps: openCreation?.continuousCreatorFee ? continuousFeeChoice(openCreation, DEFAULT_CREATOR_FEE_BPS)
    : menuChoice(openCreation?.creatorFeeBps, DEFAULT_CREATOR_FEE_BPS, DEFAULT_CREATOR_FEE_BPS),
  capBps: menuChoice(openCreation?.capBps, DEFAULT_WALLET_CAP_BPS, DEFAULT_WALLET_CAP_BPS) })

// Why the creator cannot launch right now, in plain words, or ''.
export function openCreationProblem(openCreation, coin = null) {
  if (!openCreation) return 'Launching isn’t available right now. Try again in a minute.'
  if (!openCreation.native || !openCreation.open || openCreation.paused) return 'Launches are paused right now. Try again later.'
  if (coin?.selectedHook || coin?.hookKind === 'selected' || openCreation.continuousCreatorFee) {
    if (!Number.isInteger(openCreation.maxCreatorFeeBps) || openCreation.maxCreatorFeeBps < 0) return 'The current chain fee ceiling is unavailable. Try again in a minute.'
    if (openCreation.continuousCreatorFee && !coin?.selectedHook && coin?.hookKind !== 'selected' && !openCreation.capBps?.length) return 'Launching isn’t available right now. Try again in a minute.'
  } else if (!openCreation.creatorFeeBps?.length || !openCreation.capBps?.length) return 'Launching isn’t available right now. Try again in a minute.'
  const burnBps = !coin?.selectedHook && coin?.rules && coin.rules !== 'none' ? coin.rules.burnBuyBps : 0
  if (burnBps && !openCreation.burnEnabled) return 'Burn is not available yet. Launch without a burn.'
  if (burnBps) return checkFeeSplit({ creatorFeeBps: coin.creatorFeeBps, burnBps, holderFeeBps: 0 }, openCreation)
  return ''
}

const lamports = value => value === null || value === undefined || value === '' ? null : BigInt(value)
// An estimate in SOL: at least 4 decimals, more for a small amount so its first digit shows (25,000 lamports is
// "≈0.00003 SOL", 27,604,720 is "≈0.0276 SOL").
// up: round up instead (for an amount the wallet must hold at least).
export function approxSol(value, { up = false, prefix = '≈' } = {}) {
  const v = BigInt(value), decimals = Math.max(4, v > 0n ? 10 - String(v).length : 4), unit = 10n ** BigInt(9 - decimals)
  const rounded = up ? (v + unit - 1n) / unit : (v + unit / 2n) / unit, whole = rounded / 10n ** BigInt(decimals)
  const fraction = String(rounded % 10n ** BigInt(decimals)).padStart(decimals, '0').replace(/0+$/, '')
  return `${prefix}${whole}${fraction ? `.${fraction}` : ''} SOL`
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
  // What the wallet must hold at the start: the setup's rent, then the launch's signed bound (the creation and pool fees
  // and the program's rent guard, which counts the launch account twice), and both network fees. The difference from the
  // total comes back: the guard only checks it.
  const parts = [openCreation?.preparationRentLamports, openCreation?.guardRentLamports, openCreation?.launchFeeLamports, openCreation?.poolCreationFeeLamports ?? '0', costs?.networkFeeLamports].map(lamports)
  const needLamports = parts.every(part => part !== null) ? parts.reduce((sum, part) => sum + part, 0n) : null
  return { rows, totalLamports, total: totalLamports === null ? null : approxSol(totalLamports),
    needLamports, need: needLamports === null ? null : approxSol(needLamports, { up: true, prefix: '' }) }
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
  if (status === 'finalized-success') return operation.stage === 'hook-setup' ? 'preparation' : operation.stage === 'preparation' ? 'launch' : 'live'
  return PENDING.has(status) ? 'reconcile' : 'stop'
}
// What the creator reads while the guided step runs.
export function openLaunchStatus(operation, action) {
  const second = operation?.stage === 'launch'
  const custom = !!operation?.request?.selectedHook || operation?.review?.operation === 'selected-hook-preparation'
  if (operation?.stage === 'hook-setup') return action === 'sign' ? 'Review and approve hook setup in your wallet (1 of 3)' : action === 'preparation' ? 'Hook setup is confirmed. Preparing your coin settings…' : 'Setting up your selected hook on Solana…'
  if (action === 'sign') return `Approve in your wallet (${custom ? second ? 3 : 2 : second ? 2 : 1} of ${custom ? 3 : 2})`
  if (action === 'reconcile' || action === 'submit' || action === 'cosign' || action === 'wait') return second ? 'Opening trading on Solana…' : 'Setting up your coin on Solana…'
  if (action === 'launch') return custom ? 'Your coin settings are confirmed. Preparing the third approval…' : 'Your coin is set up. Preparing the second approval…'
  if (action === 'live') return 'Your coin is live.'
  return ''
}
