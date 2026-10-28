// Unsigned collection plans for repo.ing's Hooks trade share. A plan names which pools to collect and the exact amount each
// must pay the collector; it signs nothing and holds no key. collect_protocol_fees_native is permissionless: whoever sends
// it pays only the network fee and the program pays the pool's protocol_fees_quote to the policy's collector (the treasury),
// so an executor (scripts/hooks-fee-collector.mjs) never needs withdrawal authority.
//
// From Pump.fun's fee program's buyback sweeps: a claim rate limit (cooldown) per vault, and a sweep that only ever takes what
// is there. Added here: a market is planned only when its ledger reconciles (src/hooklab-revenue-ledger.mjs), each item pins
// the amount the ledger and the chain agree on (an executor refuses a pool whose amount moved), a review cap above which a
// collection waits for a person, a network-fee budget, and an id derived from the state it was made from, so the same state
// always gives the same plan and an executor can refuse a plan it already ran.
import { createHash } from 'node:crypto'
import { DEFAULT_THRESHOLD_LAMPORTS, collectInstruction } from './hooklab-fee-collector.mjs'

export const PLAN_VERSION = 1
export const BASE_NETWORK_FEE_LAMPORTS = 5000n
export const DEFAULT_COLLECTION_POLICY = Object.freeze({
  thresholdLamports: DEFAULT_THRESHOLD_LAMPORTS,
  // One collection a day per pool at most (the timer runs daily); a re-run inside the window plans nothing new.
  cooldownSeconds: 20 * 3600,
  // Above this one pool waits for a person: far beyond today's pools, so it only trips on something unusual.
  reviewCapLamports: 5_000_000_000n,
  maxNetworkFeeLamports: 250_000n,
})

const check = (ok, message) => { if (!ok) throw Error(message) }

function validPolicy(policy) {
  const p = { ...DEFAULT_COLLECTION_POLICY, ...policy }
  for (const field of ['thresholdLamports', 'reviewCapLamports', 'maxNetworkFeeLamports']) check(typeof p[field] === 'bigint' && p[field] >= 0n, `Invalid ${field}`)
  check(Number.isSafeInteger(p.cooldownSeconds) && p.cooldownSeconds >= 0, 'Invalid cooldownSeconds')
  check(p.reviewCapLamports >= p.thresholdLamports, 'reviewCapLamports must be at least thresholdLamports')
  return p
}

const skip = (ledger, reason) => Object.freeze({ pool: ledger.pool, amount: ledger.protocol.pending, reason })

// ledgers: market ledgers (src/hooklab-revenue-ledger.mjs) built from a finalized history and the chain's current accounts.
// pools: { [pool]: { feeModel } } from the Pool accounts. now: ms. Returns { id, version, collector, items, skipped, totals };
// items are largest first. instructions: { swap, idl, cranker } to attach each item's unsigned instruction for review.
export function planCollections({ ledgers, pools, collector, policy = {}, now = Date.now(), instructions = null }) {
  const p = validPolicy(policy), items = [], skipped = []
  const maxItems = p.maxNetworkFeeLamports / BASE_NETWORK_FEE_LAMPORTS
  const candidates = [...ledgers].sort((a, b) => (b.protocol.pending > a.protocol.pending ? 1 : b.protocol.pending < a.protocol.pending ? -1 : a.pool.localeCompare(b.pool)))
  for (const ledger of candidates) {
    const pending = ledger.protocol.pending, last = ledger.protocol.lastCollectionAt
    if (!ledger.reconciled) { skipped.push(skip(ledger, 'unreconciled')); continue }
    if (pending < p.thresholdLamports) { skipped.push(skip(ledger, 'below-threshold')); continue }
    if (last && now - Date.parse(last) < p.cooldownSeconds * 1000) { skipped.push(skip(ledger, 'cooldown')); continue }
    if (pending > p.reviewCapLamports) { skipped.push(skip(ledger, 'needs-review')); continue }
    if (BigInt(items.length) >= maxItems) { skipped.push(skip(ledger, 'network-fee-budget')); continue }
    const feeModel = pools[ledger.pool]?.feeModel
    if (feeModel !== 2) { skipped.push(skip(ledger, 'unsupported-fee-model')); continue }
    const item = { pool: ledger.pool, mint: ledger.mint, amount: pending, feeModel, after: ledger.entries.at(-1)?.signature ?? null }
    if (instructions) {
      const ix = collectInstruction({ swap: instructions.swap, pool: ledger.pool, collector, cranker: instructions.cranker, feeModel, idl: instructions.idl })
      item.instruction = { programId: ix.programId.toBase58(), data: Buffer.from(ix.data).toString('base64'),
        keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })) }
    }
    items.push(Object.freeze(item))
  }
  const state = JSON.stringify([PLAN_VERSION, collector, items.map(i => [i.pool, String(i.amount), i.after])])
  const total = items.reduce((t, i) => t + i.amount, 0n)
  return Object.freeze({ id: createHash('sha256').update(state).digest('hex').slice(0, 32), version: PLAN_VERSION, collector, items, skipped,
    totals: Object.freeze({ pools: items.length, lamports: total, networkFeeLamports: BigInt(items.length) * BASE_NETWORK_FEE_LAMPORTS }) })
}

// An executor's last check before sending an item: the pool still holds exactly the planned amount, for the planned collector.
export function itemStillValid(item, { protocolFeesQuote, collector }, plan) {
  return protocolFeesQuote === item.amount && collector === plan.collector
}
