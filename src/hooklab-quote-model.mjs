// Isolated, hypothetical model of the pinned launch share-fee pool. No RPC or SDK imports.
// This is NOT a live quote, instruction builder, wallet authorization, or enforceable debit cap.
import { createHash } from 'node:crypto'

export const QUOTE_PIN = Object.freeze({
  delivery: '9b3473e001a9abc73bf644d4206e47abc95a815b',
  abi: 'ee7234cb7a32781fecba5470f24f43233cf94167',
  manifestSha256: '3e904e1030f581d8b79879aaf43a5f3c9d20f63979008c2e4b0799581e14e403',
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  quoteMint: '9815kDrx6sNiXCnD2CvB8LKNJjbdKWmQYXzH5gYKABSq',
})
// Proposed consumer policy, not an on-chain deadline or a producer default.
export const QUOTE_TTL_MS = 15_000
export const QUOTE_MAX_SLOT_AGE = 32
const U64 = (1n << 64n) - 1n
const U128 = (1n << 128n) - 1n
const BPS = 10_000n
const requireThat = (condition, code) => { if (!condition) throw new Error(code) }
const amount = (n) => {
  requireThat(typeof n === 'bigint' && n >= 0n && n <= U64, 'INVALID_U64')
  return n
}
const integer = (n) => requireThat(Number.isSafeInteger(n) && n >= 0, 'INVALID_INTEGER')
const boolean = (b) => requireThat(typeof b === 'boolean', 'MISSING_BOOLEAN')
const text = (s) => requireThat(typeof s === 'string' && s.length > 0, 'MISSING_IDENTITY')
const bps = (n) => { integer(n); requireThat(n <= 10_000, 'INVALID_BPS') }
const ceil = (n, d) => n / d + (n % d === 0n ? 0n : 1n)
const fee = (n, rate) => amount(ceil(n * BigInt(rate), BPS))
const burn = (n, rate) => { const b = n * BigInt(rate) / BPS; return b < n ? b : 0n }
const positive = (n, code) => { requireThat(n > 0n, code); return amount(n) }

function canonical(value) {
  if (typeof value === 'bigint') return `bigint:${value}`
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  requireThat(value !== undefined, 'MISSING_STATE')
  return JSON.stringify(value)
}

function binding(input) {
  // Observation metadata may advance, but any account bytes, chain time or intent change requotes.
  const { observedAtMs, slot, ...state } = input.snapshot
  return createHash('sha256').update(canonical({ state, request: input.request, budget: input.budget })).digest('hex')
}

function fresh(snapshot, current) {
  for (const n of [snapshot.slot, snapshot.observedAtMs, snapshot.chainTime, current.slot, current.nowMs]) integer(n)
  requireThat(current.nowMs >= snapshot.observedAtMs && current.slot >= snapshot.slot, 'FUTURE_SNAPSHOT')
  requireThat(current.nowMs - snapshot.observedAtMs < QUOTE_TTL_MS, 'QUOTE_EXPIRED')
  requireThat(current.slot - snapshot.slot <= QUOTE_MAX_SLOT_AGE, 'STALE_SLOT')
}

function curve(net, r, buy) {
  const x = buy ? r.quoteReserve + r.virtualQuote : r.baseReserve + r.virtualBase
  const y = buy ? r.baseReserve + r.virtualBase : r.quoteReserve + r.virtualQuote
  requireThat(x > 0n && y > 0n && net * y <= U128, 'INVALID_CURVE')
  const out = positive(net * y / (x + net), 'INSUFFICIENT_LIQUIDITY')
  requireThat(out <= (buy ? r.baseReserve : r.quoteReserve), 'INSUFFICIENT_LIQUIDITY')
  return { out, x, y }
}

function launchFees(n, creatorBps, holderBps, eligible, threshold) {
  const creator = fee(n, creatorBps)
  const holder = eligible >= threshold ? fee(n, holderBps) : 0n
  return creator + holder < n ? [creator, holder] : [0n, 0n]
}

/** See docs/HOOK_LAB_QUOTES.md for the complete normalized input contract and limitations. */
export function modelHookLabQuote(input, current) {
  const { snapshot: s, request: q, budget: b } = input
  fresh(s, current)
  requireThat(s.manifestSha256 === QUOTE_PIN.manifestSha256 && s.genesisHash === QUOTE_PIN.genesisHash && s.quoteMint === QUOTE_PIN.quoteMint, 'PIN_MISMATCH')
  requireThat(/^[a-f0-9]{64}$/.test(s.accountsHash), 'MISSING_ACCOUNTS_HASH')
  for (const id of [s.poolId, s.mint, s.wallet.owner, s.wallet.recipient, s.launch.creator]) text(id)
  requireThat(s.pool.feeModel === 'launch-share', 'UNSUPPORTED_POOL')
  requireThat(s.quoteHook === 'none', 'UNSUPPORTED_QUOTE_HOOK')
  requireThat(['none', 'kit', 'half-life'].includes(s.hook.kind), 'UNSUPPORTED_TOKEN_HOOK')
  for (const flag of [s.paused, s.wallet.ordinaryWallet, s.wallet.recipientAllowed, s.wallet.recipientOnCurve, s.launch.creatorBought]) boolean(flag)
  requireThat(!s.paused, 'PAUSED')
  requireThat(s.wallet.ordinaryWallet && s.wallet.recipientAllowed, 'WALLET_INELIGIBLE')
  const buy = q.side === 'buy'
  requireThat(buy || q.side === 'sell', 'INVALID_SIDE')
  const A = positive(amount(q.amountIn), 'ZERO_INPUT')
  amount(q.maxInput); amount(q.maxNativeDebitLamports)
  requireThat(A <= q.maxInput, 'INPUT_CAP_EXCEEDED')
  bps(q.slippageBps); bps(q.maxPriceImpactBps)
  requireThat(q.slippageBps < 10_000, 'INVALID_SLIPPAGE')
  for (const key of ['baseReserve', 'quoteReserve', 'virtualBase', 'virtualQuote']) amount(s.pool[key])
  bps(s.pool.protocolShareBps)
  const l = s.launch
  for (const key of ['lpFeeBps', 'sniperStartBps', 'creatorFeeBps', 'holderBuyBps', 'holderSellBps', 'burnBuyBps', 'burnSellBps']) bps(l[key])
  integer(l.createdAt); integer(l.sniperWindowSecs)
  for (const key of ['baseBalance', 'recipientBaseBalance', 'quoteBalance', 'nativeLamports']) amount(s.wallet[key])
  if (s.wallet.owner === s.wallet.recipient) requireThat(s.wallet.baseBalance === s.wallet.recipientBaseBalance, 'INCONSISTENT_BALANCE')
  requireThat(buy || s.wallet.baseBalance >= A, 'INSUFFICIENT_BASE')
  requireThat(s.hook.kind === 'kit' || (l.holderBuyBps === 0 && l.holderSellBps === 0), 'HOLDER_FEE_REQUIRES_KIT')

  let eligible = 0n
  let threshold = 1n
  let lockedUntil = null
  const h = s.hook
  if (h.kind === 'kit') {
    for (const key of ['eligible', 'minEligible', 'maxWalletAmount', 'earlyLocked']) amount(h[key])
    for (const key of ['creatorUnlockAt', 'earlyWindowEnd', 'earlyUnlockAt']) integer(h[key])
    for (const key of ['rewardsOn', 'graduated', 'maxWalletOn', 'creatorLockOn', 'earlyLockOn']) boolean(h[key])
    requireThat(!(l.holderBuyBps || l.holderSellBps) || h.rewardsOn, 'INCONSISTENT_KIT')
    eligible = h.eligible
    threshold = h.minEligible
    if (buy) {
      requireThat(!h.rewardsOn || s.wallet.recipientOnCurve, 'DESTINATION_NOT_ON_CURVE')
      if (h.earlyLockOn && s.chainTime < h.earlyWindowEnd) lockedUntil = h.earlyUnlockAt
    } else {
      requireThat(!h.creatorLockOn || s.wallet.owner !== l.creator || s.chainTime >= h.creatorUnlockAt, 'CREATOR_LOCKED')
      requireThat(!h.earlyLockOn || s.chainTime >= h.earlyUnlockAt || s.wallet.baseBalance - A >= h.earlyLocked, 'EARLY_LOCKED')
      // Both the burn and transfer leave eligible supply before the sell's after_swap callback.
      eligible = amount(eligible - A)
    }
  }

  const elapsed = Math.max(0, s.chainTime - l.createdAt)
  const inWindow = elapsed < l.sniperWindowSecs
  const ownFirst = buy && s.wallet.owner === l.creator && s.wallet.recipient === l.creator && !l.creatorBought && s.chainTime < l.createdAt + l.sniperWindowSecs
  const lpBps = ownFirst || !inWindow || l.sniperStartBps <= l.lpFeeBps
    ? l.lpFeeBps
    : l.sniperStartBps - Number(BigInt(l.sniperStartBps - l.lpFeeBps) * BigInt(elapsed) / BigInt(l.sniperWindowSecs))
  let [creator, holder] = buy ? launchFees(A, l.creatorFeeBps, l.holderBuyBps, eligible, threshold) : [0n, 0n]
  let burned = buy ? 0n : burn(A, l.burnSellBps)
  let tokenHookCut = 0n
  let halfLifePpm = 0
  if (h.kind === 'half-life') {
    boolean(h.furnaceLit); boolean(h.poolRecognized)
    requireThat(h.poolRecognized, 'HALF_LIFE_POOL_UNKNOWN')
    if (h.sourceSince !== null) integer(h.sourceSince)
    if (!buy) {
      const age = h.sourceSince === null ? 0 : Math.max(0, s.chainTime - h.sourceSince)
      const halves = Math.floor(age / 21_600)
      if (halves < 8) {
        const hi = 200_000 >> halves
        const lo = 200_000 >> (halves + 1)
        halfLifePpm = hi - Math.floor((hi - lo) * (age % 21_600) / 21_600)
      }
      tokenHookCut = (A - burned) * BigInt(halfLifePpm) / 1_000_000n
      requireThat(tokenHookCut === 0n || h.furnaceLit, 'FURNACE_NOT_LIT')
    }
  }
  const received = positive(A - creator - holder - burned - tokenHookCut, 'NOTHING_RECEIVED')
  let lp = buy ? fee(received, lpBps) : 0n
  let protocolIn = buy ? fee(creator + holder, s.pool.protocolShareBps) : 0n
  const netIn = positive(received - lp - protocolIn, 'FEES_EXCEED_INPUT')
  const { out: gross, x, y } = curve(netIn, s.pool, buy)
  let protocolOut = 0n
  if (buy) {
    burned = burn(gross, l.burnBuyBps)
  } else {
    lp = fee(gross, lpBps)
    const hookQuoteValue = amount(ceil(tokenHookCut * gross, netIn))
    protocolIn = fee(hookQuoteValue, s.pool.protocolShareBps)
    const afterProtocol = positive(gross - lp - protocolIn, 'FEES_EXCEED_OUTPUT')
    ;[creator, holder] = launchFees(afterProtocol, l.creatorFeeBps, l.holderSellBps, eligible, threshold)
    protocolOut = fee(creator + holder, s.pool.protocolShareBps)
  }
  const delivered = positive(buy ? gross - burned : gross - lp - protocolIn - creator - holder - protocolOut, 'FEES_EXCEED_OUTPUT')
  const minOut = positive(delivered * BigInt(10_000 - q.slippageBps) / BPS, 'ZERO_MIN_OUT')
  const priceImpactBps = Number(ceil(netIn * BPS, x + netIn))
  requireThat(priceImpactBps <= q.maxPriceImpactBps, 'PRICE_IMPACT_LIMIT')
  // All-in loss against pretrade marginal spot, including fees, burn and output rounding.
  const allInLossBps = Number(ceil((A * y - delivered * x) * BPS, A * y))
  if (buy && h.kind === 'kit') {
    requireThat(!h.maxWalletOn || h.graduated || s.wallet.recipientBaseBalance + delivered <= h.maxWalletAmount, 'MAX_WALLET_EXCEEDED')
  }
  const reservesAfter = {
    baseReserve: amount(buy ? s.pool.baseReserve - gross : s.pool.baseReserve + netIn),
    quoteReserve: amount(buy ? s.pool.quoteReserve + netIn : s.pool.quoteReserve - gross),
  }
  amount(s.wallet.recipientBaseBalance + (buy ? delivered : 0n))
  const wrapLamports = buy && A > s.wallet.quoteBalance ? A - s.wallet.quoteBalance : 0n
  for (const key of ['rentLamports', 'networkFeeLamports', 'priorityFeeLamports', 'reserveLamports']) amount(b[key])
  const nativeDebit = amount(wrapLamports + b.rentLamports + b.networkFeeLamports + b.priorityFeeLamports)
  requireThat(nativeDebit <= q.maxNativeDebitLamports, 'NATIVE_CAP_EXCEEDED')
  requireThat(nativeDebit + b.reserveLamports <= s.wallet.nativeLamports, 'INSUFFICIENT_NATIVE_RESERVE')
  return Object.freeze({
    kind: 'hypothetical-hooklab-quote/v1', executable: false, liveReady: false, capEnforced: false,
    binding: binding(input), observedSlot: s.slot, expiresAtMs: s.observedAtMs + QUOTE_TTL_MS,
    amountIn: A, received, netIn, grossOutput: gross, netOutput: delivered, minOutput: minOut,
    outputAsset: buy ? s.mint : s.quoteMint, priceImpactBps, allInLossBps, lockedUntil,
    fees: Object.freeze({ creatorQuote: creator, holderQuote: holder, lpAndSniperQuote: lp,
      protocolInputShareQuote: protocolIn, protocolOutputShareQuote: protocolOut,
      totalProtocolQuote: amount(lp + protocolIn + protocolOut), burnBase: burned, tokenHookBase: tokenHookCut,
      effectiveLpBps: lpBps, halfLifePpm, creatorFirstBuyExemption: ownFirst }),
    debit: Object.freeze({ inputAsset: buy ? s.quoteMint : s.mint, exactInput: A,
      existingQuoteUsed: buy ? A - wrapLamports : 0n, wrapLamports, nativeDebitLamports: nativeDebit,
      rentLamports: b.rentLamports, networkFeeLamports: b.networkFeeLamports,
      priorityFeeLamports: b.priorityFeeLamports, retainedReserveLamports: b.reserveLamports }),
    reservesAfter: Object.freeze(reservesAfter),
  })
}

/** Re-evaluate the same hypothetical intent; this never upgrades a model result to live readiness. */
export function revalidateHookLabQuote(quote, input, current) {
  requireThat(quote.kind === 'hypothetical-hooklab-quote/v1' && quote.executable === false, 'INVALID_QUOTE')
  requireThat(current.nowMs < quote.expiresAtMs, 'QUOTE_EXPIRED')
  requireThat(current.slot >= quote.observedSlot && current.slot - quote.observedSlot <= QUOTE_MAX_SLOT_AGE, 'STALE_SLOT')
  requireThat(binding(input) === quote.binding, 'STALE_STATE')
  const next = modelHookLabQuote(input, current)
  return Object.freeze({ ...next, observedSlot: quote.observedSlot, expiresAtMs: quote.expiresAtMs })
}
