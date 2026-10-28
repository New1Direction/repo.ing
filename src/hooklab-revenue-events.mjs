// The money events of a Hooks coin on our own stack, from finalized transactions, for the revenue ledger
// (src/hooklab-revenue-ledger.mjs). Read only. Each entry is one event the launch or swap program emitted about itself
// (src/hooklab-trade-events.mjs programEvents), named for good by (signature, eventIndex):
//
//   launch       LaunchCreated: the coin's launch fee, which the launch program pays to the treasury.
//   accrual      InclusiveCreatorFeeAccrued: one trade's fee; `protocol` is repo.ing's share (held in the pool's
//                protocol_fees_quote, now `pendingAfter`), `creator` the creator's (held by the launch account).
//   collection   ProtocolFeesCollected: the pool's whole protocol_fees_quote paid to the collector.
//   creator-claim CreatorFeesClaimedSol: the creator took the launch account's lamports above rent; `claimedTotal` is the
//                launch's running total of everything claimed.
//
// balance: the lamports the transaction moved for an address that matters to the entry (the treasury for a launch fee, the
// collector for a collection, the creator for a claim), from the transaction's own pre/post balances, so the ledger can
// check that what the event says was paid is what arrived.
import { programEvents } from './hooklab-trade-events.mjs'

const fail = code => { throw Object.assign(Error(code), { code }) }
const check = (ok, code) => { if (!ok) fail(code) }

export const SWAP_REVENUE_EVENTS = Object.freeze(['InclusiveCreatorFeeAccrued', 'ProtocolFeesCollected'])
export const LAUNCH_REVENUE_EVENTS = Object.freeze(['LaunchCreated', 'CreatorFeesClaimedSol'])
const U64_LIMIT = 1n << 64n
const u64 = value => { const n = BigInt(value.toString()); check(n >= 0n && n < U64_LIMIT, 'HOOK_REVENUE_AMOUNT_INVALID'); return n }
const key = value => value.toBase58()

// The lamports `address` gained (negative: lost) in the transaction, before the network fee when it paid it (key 0), or null
// when it is not one of the transaction's keys.
function balanceChange(tx, keys, address) {
  const at = keys.indexOf(address)
  if (at < 0) return null
  const before = tx.meta.preBalances?.[at], after = tx.meta.postBalances?.[at], fee = at === 0 ? tx.meta.fee : 0
  check(Number.isSafeInteger(before) && Number.isSafeInteger(after) && Number.isSafeInteger(fee), 'HOOK_REVENUE_BALANCES_MISSING')
  return BigInt(after) - BigInt(before) + BigInt(fee)
}

const ENTRY = {
  InclusiveCreatorFeeAccrued: (data) => {
    const gross = u64(data.gross_quote), protocol = u64(data.platform_quote), creator = u64(data.creator_quote)
    check(protocol + creator === gross, 'HOOK_REVENUE_ACCRUAL_SPLIT')
    return { kind: 'accrual', pool: key(data.pool), gross, protocol, creator, collector: key(data.platform_collector),
      creatorHolding: key(data.creator_holding), pendingAfter: u64(data.protocol_fees_quote_after) }
  },
  ProtocolFeesCollected: (data, tx, keys) => ({ kind: 'collection', pool: key(data.pool), amount: u64(data.quote_amount),
    collector: key(data.collector), received: balanceChange(tx, keys, key(data.collector)) }),
  LaunchCreated: (data, tx, keys, { treasury }) => ({ kind: 'launch', pool: key(data.pool), mint: key(data.mint), launch: key(data.launch),
    creator: key(data.creator), launchFee: u64(data.launch_fee_lamports), received: treasury ? balanceChange(tx, keys, treasury) : null }),
  CreatorFeesClaimedSol: (data, tx, keys) => ({ kind: 'creator-claim', launch: key(data.launch), mint: key(data.mint), creator: key(data.creator),
    amount: u64(data.lamports), claimedTotal: u64(data.claimed_total), received: balanceChange(tx, keys, key(data.creator)) }),
}

// One finalized transaction (web3.js getTransaction, maxSupportedTransactionVersion 0): its revenue entries, in event
// order. programs: { launch, swap }; idls: the stack's pinned { launch, swap } IDLs; treasury: the launch config's treasury
// (to read what a launch fee delivered). A failed transaction has none.
export function decodeRevenueEvents(tx, { signature, programs, idls, treasury = null }) {
  check(typeof programs?.launch === 'string' && typeof programs?.swap === 'string', 'HOOK_REVENUE_PROGRAMS_MISSING')
  check(idls?.launch && idls?.swap, 'HOOK_REVENUE_IDLS_MISSING')
  check(tx?.meta && Number.isSafeInteger(tx.slot) && tx.slot > 0, 'HOOK_REVENUE_EVIDENCE_MISSING')
  check(tx.transaction?.signatures?.[0] === signature, 'HOOK_REVENUE_SIGNATURE_MISMATCH')
  if (tx.meta.err !== null) return []
  const swap = programEvents(tx, { program: programs.swap, idl: idls.swap, names: SWAP_REVENUE_EVENTS })
  const launch = programEvents(tx, { program: programs.launch, idl: idls.launch, names: LAUNCH_REVENUE_EVENTS })
  const at = Number.isSafeInteger(tx.blockTime) ? new Date(tx.blockTime * 1000).toISOString() : null
  return [...swap.events, ...launch.events].sort((a, b) => a.ordinal - b.ordinal)
    .map(event => ({ signature, slot: tx.slot, at, eventIndex: event.ordinal, ...ENTRY[event.name](event.data, tx, swap.keys, { treasury }) }))
}
