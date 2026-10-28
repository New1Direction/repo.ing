// The revenue ledger of Hooks coins on our own stack: per market, every lamport repo.ing and the creator are owed or were
// paid, each tied to the transaction and event that moved it (src/hooklab-revenue-events.mjs), and reconciled against the
// chain's own counters. Read only and pure: the same history gives the same ledger.
//
// The chain keeps two running counters, which is what makes this exact (the idea Pump.fun's fee program uses for its
// vaults: cumulative totals beside every payout, so a reader can prove nothing was skipped):
//   - the pool's protocol_fees_quote, which every accrual reports after adding repo.ing's share (pendingAfter) and every
//     collection pays out whole and resets to zero;
//   - the launch's claimed_total, which every creator claim reports after adding what it paid.
// A history with a gap, a payment to anyone but the expected collector or creator, or an amount that did not arrive breaks
// one of them and is reported as a finding; nothing is guessed or skipped.
//
// Findings: { severity: 'error' | 'warning', code, signature?, detail }. An error means the market does not reconcile; the
// collection plan (src/hooklab-collection-plan.mjs) leaves such a market alone until it does.

const finding = (severity, code, detail, signature = null) => Object.freeze({ severity, code, detail, ...(signature ? { signature } : {}) })
const order = (a, b) => (a.slot - b.slot) || ((a.seq ?? 0) - (b.seq ?? 0)) || (a.eventIndex - b.eventIndex)
const sum = (entries, field) => entries.reduce((total, entry) => total + entry[field], 0n)

// The same transaction shows up in the pool's history and the launch's (a launch names both): one event, one entry.
export function dedupeEntries(entries) {
  const seen = new Map()
  for (const entry of entries) {
    const id = `${entry.signature}:${entry.eventIndex}`
    if (!seen.has(id)) seen.set(id, entry)
  }
  return { entries: [...seen.values()].sort(order), deduplicated: entries.length - seen.size }
}

function protocolSide(entries, expected, chain, findings) {
  let pending = 0n, collected = 0n
  for (const entry of entries) {
    if (entry.collector !== expected.collector) findings.push(finding('error', 'UNEXPECTED_COLLECTOR', `${entry.kind} names collector ${entry.collector}`, entry.signature))
    if (entry.kind === 'accrual') {
      if (pending + entry.protocol !== entry.pendingAfter) findings.push(finding('error', 'PROTOCOL_CHAIN_GAP',
        `expected ${pending + entry.protocol} pending after this trade, the chain reports ${entry.pendingAfter}`, entry.signature))
      pending = entry.pendingAfter
      continue
    }
    if (entry.amount !== pending) findings.push(finding('error', 'COLLECTION_AMOUNT_MISMATCH', `collected ${entry.amount}, ${pending} was pending`, entry.signature))
    if (entry.received !== null && entry.received !== entry.amount) findings.push(finding('error', 'COLLECTION_NOT_RECEIVED',
      `the collector received ${entry.received} of ${entry.amount}`, entry.signature))
    collected += entry.amount
    pending = 0n
  }
  if (chain.protocolFeesQuote !== undefined && chain.protocolFeesQuote !== pending) findings.push(finding('error', 'PROTOCOL_PENDING_MISMATCH',
    `the pool holds ${chain.protocolFeesQuote} for repo.ing, its history adds up to ${pending}`))
  const accruals = entries.filter(e => e.kind === 'accrual')
  return { accrued: sum(accruals, 'protocol'), collected, pending, lastCollectionAt: entries.filter(e => e.kind === 'collection').at(-1)?.at ?? null }
}

function creatorSide(accruals, claims, launch, chain, findings) {
  let claimedTotal = 0n
  for (const accrual of accruals) {
    if (launch && accrual.creator > 0n && accrual.creatorHolding !== launch.launch) findings.push(finding('error', 'CREATOR_HOLDING_MISMATCH',
      `the creator's fee went to ${accrual.creatorHolding}, not the launch account`, accrual.signature))
  }
  for (const claim of claims) {
    if (claim.claimedTotal !== claimedTotal + claim.amount) findings.push(finding('error', 'CREATOR_CLAIM_GAP',
      `expected claimed total ${claimedTotal + claim.amount}, the chain reports ${claim.claimedTotal}`, claim.signature))
    if (launch && claim.creator !== launch.creator) findings.push(finding('error', 'UNEXPECTED_CLAIMANT', `paid to ${claim.creator}`, claim.signature))
    if (claim.received !== null && claim.received !== claim.amount) findings.push(finding('error', 'CREATOR_CLAIM_NOT_RECEIVED',
      `the creator received ${claim.received} of ${claim.amount}`, claim.signature))
    claimedTotal = claim.claimedTotal
  }
  const accrued = sum(accruals, 'creator'), owed = accrued - claimedTotal
  if (owed < 0n) findings.push(finding('error', 'CREATOR_OVERPAID', `claimed ${claimedTotal}, accrued ${accrued}`))
  let holding = null
  // Compared only with what is genuinely owed: an overpaid creator (already reported) owes nothing back to the launch account.
  if (chain.launchLamports !== undefined && chain.launchRentExempt !== undefined) {
    holding = chain.launchLamports - chain.launchRentExempt
    const due = owed > 0n ? owed : 0n
    if (holding < due) findings.push(finding('error', 'CREATOR_HOLDING_SHORTFALL', `the launch account holds ${holding} above rent, the creator is owed ${due}`))
    if (holding > due) findings.push(finding('warning', 'CREATOR_HOLDING_SURPLUS', `the launch account holds ${holding - due} more than the creator's fees; the creator can claim it`))
  }
  return { accrued, claimed: claimedTotal, owed, holding }
}

// One market. entries: its decoded revenue entries from the pool's and the launch's histories (any order, overlaps fine);
// each may carry `seq`, its position in chronological history, to order transactions within a slot. chain: what the
// accounts hold now ({ protocolFeesQuote, launchLamports, launchRentExempt }, each optional). expected: { collector,
// treasury } from the swap and launch configs.
export function buildMarketLedger({ pool, entries, chain = {}, expected }) {
  const { entries: all, deduplicated } = dedupeEntries(entries)
  const launches = all.filter(e => e.kind === 'launch' && e.pool === pool), launch = launches[0] ?? null
  const mine = all.filter(e => e.pool === pool || (launch && e.kind === 'creator-claim' && e.launch === launch.launch))
  const findings = []
  if (!launch) findings.push(finding('warning', 'LAUNCH_MISSING', 'no launch in this history: launch fee and creator checks are partial'))
  if (launches.length > 1) findings.push(finding('error', 'LAUNCH_DUPLICATE', `${launches.length} launches name this pool`))
  if (launch && launch.received !== null && launch.received !== launch.launchFee) findings.push(finding('error', 'LAUNCH_FEE_NOT_RECEIVED',
    `the treasury received ${launch.received} of the ${launch.launchFee} launch fee`, launch.signature))
  const protocol = protocolSide(mine.filter(e => e.kind === 'accrual' || e.kind === 'collection'), expected, chain, findings)
  const creator = creatorSide(mine.filter(e => e.kind === 'accrual'), mine.filter(e => e.kind === 'creator-claim'), launch, chain, findings)
  return Object.freeze({ pool, mint: launch?.mint ?? null, launch: launch?.launch ?? null, creatorWallet: launch?.creator ?? null,
    launchFee: launch?.launchFee ?? 0n, protocol, creator, entries: mine, deduplicated, findings,
    reconciled: !findings.some(f => f.severity === 'error') })
}

// Every market together: what repo.ing earned (launch fees and its trade share), collected and is still owed, and what
// creators earned, claimed and are still owed.
export function revenueTotals(ledgers) {
  const add = pick => ledgers.reduce((total, ledger) => total + pick(ledger), 0n)
  return Object.freeze({ markets: ledgers.length, reconciled: ledgers.filter(l => l.reconciled).length,
    launchFees: add(l => l.launchFee), protocolAccrued: add(l => l.protocol.accrued), protocolCollected: add(l => l.protocol.collected),
    protocolPending: add(l => l.protocol.pending), creatorAccrued: add(l => l.creator.accrued), creatorClaimed: add(l => l.creator.claimed),
    creatorOwed: add(l => l.creator.owed), errors: add(l => BigInt(l.findings.filter(f => f.severity === 'error').length)) })
}

// External records of payments (what our own books say happened: { signature, kind, amount, pool? }) against the chain's
// entries. Reports each record the chain does not show (unexpected), each chain payment no record covers (unrecorded),
// records listed twice (duplicate) and amounts that differ (mismatch). Accruals are not payments and are left out.
export const PAYMENT_KINDS = Object.freeze(['launch', 'collection', 'creator-claim'])
const paid = entry => entry.kind === 'launch' ? entry.launchFee : entry.amount
export function reconcilePayments({ entries, records }) {
  const chain = new Map(dedupeEntries(entries).entries.filter(e => PAYMENT_KINDS.includes(e.kind)).map(e => [`${e.signature}:${e.kind}`, e]))
  const findings = [], seen = new Set()
  for (const record of records) {
    const id = `${record.signature}:${record.kind}`
    if (seen.has(id)) { findings.push(finding('error', 'DUPLICATE_PAYMENT_RECORD', `${record.kind} recorded more than once`, record.signature)); continue }
    seen.add(id)
    const entry = chain.get(id)
    if (!entry) { findings.push(finding('error', 'UNEXPECTED_PAYMENT_RECORD', `no ${record.kind} on chain for this record`, record.signature)); continue }
    if (BigInt(record.amount) !== paid(entry)) findings.push(finding('error', 'PAYMENT_AMOUNT_MISMATCH', `recorded ${record.amount}, the chain paid ${paid(entry)}`, record.signature))
  }
  for (const [id, entry] of chain) if (!seen.has(id)) findings.push(finding('warning', 'UNRECORDED_PAYMENT', `${entry.kind} of ${paid(entry)} has no record`, entry.signature))
  return findings
}

// JSON with amounts as decimal strings.
export const ledgerJson = value => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v))
