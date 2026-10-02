import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { BUYBACK_WALLETS, PLATFORM_FEE_WALLET } from '../app/lib/buyback-receipts.mjs'
import { CUSTODY_FUNDED_BY } from './platform-revenue.mjs'
import { allocationReview, platformFeeReview } from './platform-fee-operations.mjs'
import { createRetryCircuit, retryRpcRead } from './rpc-usage.mjs'

// One-command platform-fee sweep: claim every repo/phase, allocate under the active policy,
// move the partner wallet's surplus to the published custody wallet, report what to buy back.
// Dry run by default. Every step is exact or surplus-only, so a re-run never double-spends.

export const SWEEP_ACTOR = 'platform-sweep'
export const DUST_LAMPORTS = 1_000_000n
export const KEEP_LAMPORTS = 50_000_000n
export const MIN_TRANSFER_LAMPORTS = 10_000_000n
export const PARTNER_WALLET = PLATFORM_FEE_WALLET
export const CUSTODY_WALLET = BUYBACK_WALLETS.custody
// Markets are read (and claimed) one at a time with this pause between them, so a full sweep never bursts the RPC.
export const SWEEP_PACE_MS = 250
const STALE = /refresh and review again|indexing must catch up/i
const PERMILLE = 1000n
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
// An entry with the RPC retries spent on it in this step added to any it already carries.
const withRetries = (entry, retries) => (retries ? { ...entry, retries: (entry.retries ?? 0) + retries } : entry)

export function sol(lamports) {
  const value = BigInt(lamports), sign = value < 0n ? '-' : '', abs = value < 0n ? -value : value
  return `${sign}${abs / 1_000_000_000n}.${String(abs % 1_000_000_000n).padStart(9, '0')}`
}

// Claimable repo/phases from the shared listing, in the panel's order.
export function claimPlan(rows, { dbcEnabled }) {
  const plan = []
  for (const row of rows) for (const phase of ['DBC', 'DAMM']) {
    const entry = row[phase.toLowerCase()]
    if (!entry || entry.enrolled === false) continue
    const base = withRetries({ repoId: row.repoId, fullName: row.fullName, phase, receiver: entry.receiver || PARTNER_WALLET }, entry.retries)
    if (entry.error) { plan.push({ ...base, status: 'unreadable', error: entry.error }); continue }
    const available = BigInt(entry.available)
    if (available <= 0n) continue
    if (available < DUST_LAMPORTS) plan.push({ ...base, available: String(available), status: 'skipped-dust' })
    else if (phase === 'DBC' && !dbcEnabled) plan.push({ ...base, available: String(available), status: 'skipped-disabled' })
    else plan.push({ ...base, available: String(available), status: 'planned' })
  }
  return plan
}

// Fresh read immediately before each claim; one re-read and retry when the pool moved in between. With the sweep's
// `retry` policy, that read and every read the claim makes before it signs (its `retryRead`) are retried on a
// transient RPC error. Signing, the durable intent and the broadcast are never retried. Results carry the retries spent.
export async function claimOne(item, { feeService, partner, now = Date.now, retry = null }) {
  const service = feeService(item.phase)
  let retries = 0
  const retryRead = read => (retry ? retryRpcRead(read, { ...retry, onRetry: info => {
    retries++
    retry.onRetry?.({ ...info, repoId: item.repoId, fullName: item.fullName, phase: item.phase })
  } }) : read())
  const result = fields => withRetries({ ...item, ...fields }, retries)
  for (let attempt = 1; ; attempt++) {
    let data
    try { data = await retryRead(() => service.status(item.repoId)) }
    catch (error) { throw retries ? Object.assign(Error(error.message), { claim: result({}) }) : error }
    if (data.enrolled === false) return result({ status: 'skipped-unenrolled', attempts: attempt })
    if (BigInt(data.available) < DUST_LAMPORTS) return result({ available: data.available, status: 'skipped-dust', attempts: attempt })
    const review = platformFeeReview({ sessionId: SWEEP_ACTOR, repoId: item.repoId, phase: item.phase, data,
      partner: partner.publicKey, now: now() })
    try {
      const receipt = await service.claim({ review, retryRead })
      // The claim service skips a claim its priority-adjusted network fee would eat (under 20× the fee).
      if (receipt?.status === 'skipped-dust') return result({ available: data.available, status: 'skipped-dust',
        networkFee: receipt.networkFee, attempts: attempt })
      return result({ status: 'claimed', amount: String(receipt?.amount ?? data.available),
        signature: receipt?.signature ?? null, attempts: attempt })
    } catch (error) {
      if (attempt < 2 && STALE.test(error.message)) continue
      throw Object.assign(Error(`Claim ${item.phase} repo ${item.repoId} failed: ${error.message}`), { claim: result({ attempts: attempt }) })
    }
  }
}

function assertWallets(signer, destination) {
  if (signer.publicKey.toBase58() !== PARTNER_WALLET) throw Error(`Refusing transfer: signer is not the partner wallet ${PARTNER_WALLET}`)
  if (destination !== BUYBACK_WALLETS.custody || CUSTODY_FUNDED_BY[PARTNER_WALLET] !== destination)
    throw Error(`Refusing transfer: destination is not the custody wallet ${BUYBACK_WALLETS.custody}`)
}

// Surplus above KEEP_LAMPORTS (after the network fee) from the partner wallet to custody, capped at capLamports
// (the buyback share still owed) so the liquidity and treasury shares stay in the partner wallet.
export async function transferSurplus({ connection, signer, destination = CUSTODY_WALLET, execute, extraLamports = 0n, capLamports = null }) {
  assertWallets(signer, destination)
  const to = new PublicKey(destination)
  const balance = BigInt(await connection.getBalance(signer.publicKey, 'confirmed'))
  const build = (lamports, blockhash) => {
    const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash })
    return tx.add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: to, lamports }))
  }
  const latest = await connection.getLatestBlockhash('confirmed')
  const fee = (await connection.getFeeForMessage(build(0n, latest.blockhash).compileMessage(), 'confirmed')).value
  if (fee == null) throw Error('Could not price the transfer network fee')
  const surplus = balance + BigInt(extraLamports) - KEEP_LAMPORTS - BigInt(fee)
  const amount = capLamports != null && BigInt(capLamports) < surplus ? BigInt(capLamports) : surplus
  const base = { from: PARTNER_WALLET, to: destination, balance: sol(balance), keep: sol(KEEP_LAMPORTS), fee: String(fee) }
  if (amount < MIN_TRANSFER_LAMPORTS) return { ...base, status: 'skipped-below-minimum', amount: sol(amount > 0n ? amount : 0n) }
  if (!execute) return { ...base, status: 'planned', amount: sol(amount), estimated: extraLamports > 0n }
  const tx = build(amount, latest.blockhash)
  tx.sign(signer)
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
  const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
  if (confirmation?.value?.err) throw Error(`Transfer ${signature} failed: ${JSON.stringify(confirmation.value.err)}`)
  return { ...base, status: 'sent', amount: sol(amount), signature }
}

const splitOf = (amount, policy) => {
  const buyback = amount * BigInt(policy.buybackPermille) / PERMILLE
  const liquidity = amount * BigInt(policy.liquidityPermille) / PERMILLE
  return { buyback, liquidity, treasury: amount - buyback - liquidity }
}
// '1.234000000' -> 1234000000n (inverse of sol()).
const toLamports = value => { const [w, f = ''] = String(value).split('.'); return BigInt(w) * 1_000_000_000n + BigInt(f.padEnd(9, '0').slice(0, 9)) }
const asSol = split => Object.fromEntries(Object.entries(split).map(([k, v]) => [k, sol(v)]))

// `listFees(options)` lists every repo/phase (listPlatformFees) with the sweep's pacing and retry options. A dry run
// reads exactly as an execute does. `retry` tunes the retryRpcRead backoff; `sleep` paces markets and retry waits.
export async function runPlatformSweep({ execute = false, dbcEnabled, listFees, feeService, summary, allocate,
  connection, signer, balanceOf, now = Date.now, log = () => {}, retry = {}, paceMs = SWEEP_PACE_MS, sleep = pause }) {
  const report = { mode: execute ? 'execute' : 'dry-run', startedAt: new Date(now()).toISOString(),
    claims: [], claimedTotal: '0.000000000', rpcRetries: 0, allocation: null, transfer: null, buyback: null, ok: false, error: null }
  // Every retry (listing or claim) is logged and counted for the whole run; entries carry their own count. When the
  // RPC stays limited read after read (down or out of credits, not bursting), the circuit stops paying for retries.
  const circuit = createRetryCircuit({ onOpen: ({ breakAfter }) =>
    log(`retries paused: ${breakAfter} reads in a row stayed limited; reads get one try until one succeeds`) })
  const retryPolicy = { ...retry, sleep, circuit, onRetry: ({ attempt, attempts, delayMs, reason, phase, fullName, repoId }) => {
    report.rpcRetries++
    log(`retry ${attempt} of ${attempts - 1}: ${phase} ${fullName ?? repoId} in ${(delayMs / 1000).toFixed(1)}s after ${reason}`)
  } }
  let claimed = 0n
  try {
    // Transfer guards run first so a misconfigured signer stops the sweep before anything moves.
    assertWallets(signer, CUSTODY_WALLET)
    const plan = claimPlan(await listFees({ concurrency: 1, paceMs, retry: retryPolicy, sleep }), { dbcEnabled })
    let claimsStarted = 0
    for (const item of plan) {
      if (item.status !== 'planned' || !execute) { report.claims.push(item); continue }
      if (claimsStarted++ && paceMs > 0) await sleep(paceMs)
      log(`claiming ${item.phase} ${item.fullName} (${sol(item.available)} SOL)`)
      try {
        const result = await claimOne(item, { feeService, partner: signer, now, retry: retryPolicy })
        report.claims.push(result)
        if (result.status === 'claimed') claimed += BigInt(result.amount)
      // One repo's failed claim (expired, busy pool) must not block the others, allocation or the transfer; an
      // expired claim moved nothing and the recovery job resolves any pending one.
      } catch (error) { report.claims.push({ ...(error.claim ?? item), status: 'failed', error: error.message }); report.claimErrors = (report.claimErrors ?? 0) + 1 }
    }
    const planned = report.claims.filter(c => c.status === 'planned').reduce((sum, c) => sum + BigInt(c.available), 0n)
    report.claimedTotal = sol(execute ? claimed : planned)

    const before = await summary()
    const unallocated = BigInt(before.available) + (execute ? 0n : planned)
    const policy = before.activePolicy
    if (unallocated <= 0n) report.allocation = { status: 'nothing-to-allocate' }
    else if (!policy) report.allocation = { status: 'skipped-no-policy', unallocated: sol(unallocated) }
    else if (!execute) report.allocation = { status: 'planned', policyVersion: policy.version, amount: sol(unallocated),
      split: asSol(splitOf(unallocated, policy)), estimated: true }
    else {
      const result = await allocate({ review: allocationReview({ sessionId: SWEEP_ACTOR, policyVersion: policy.version, now: now() }),
        createdBy: SWEEP_ACTOR })
      const after = await summary()
      const delta = key => BigInt(after.allocated[key]) - BigInt(before.allocated[key])
      report.allocation = { status: 'allocated', group: result.group, policyVersion: result.policyVersion,
        claims: result.claims, amount: sol(result.claimedAmount),
        split: asSol({ buyback: delta('buyback'), liquidity: delta('liquidity'), treasury: delta('treasury') }) }
    }

    const landsInPartner = execute ? 0n : report.claims.filter(c => c.status === 'planned' && c.receiver === PARTNER_WALLET)
      .reduce((sum, c) => sum + BigInt(c.available), 0n)
    // Move only the buyback share of what THIS run allocated: earlier shares were already sent to custody (possibly
    // not yet spent), so capping at the total still owed would send them twice. Never more than is still owed.
    const latest = await summary()
    const owed = BigInt(latest.buybackReserve) + (execute || !policy || unallocated <= 0n ? 0n : splitOf(unallocated, policy).buyback)
    const allocatedNow = !policy || unallocated <= 0n ? 0n
      : execute ? BigInt(report.allocation?.status === 'allocated' ? toLamports(report.allocation.split.buyback) : 0n)
      : splitOf(unallocated, policy).buyback
    const cap = allocatedNow < owed ? allocatedNow : owed
    report.transfer = await transferSurplus({ connection, signer, execute, extraLamports: landsInPartner, capLamports: cap > 0n ? cap : 0n })
    report.ok = true
  } catch (error) { report.error = error.message }
  try {
    const current = await summary()
    report.buyback = { reserve: sol(current.buybackReserve), ahead: sol(current.buybackAhead),
      custodyWallet: CUSTODY_WALLET, custodyBalance: sol(await balanceOf(CUSTODY_WALLET)) }
  } catch (error) {
    report.ok = false
    report.error = [report.error, `Report read failed: ${error.message}`].filter(Boolean).join('; ')
  }
  return report
}

export function sweepHeadline(report) {
  const claimed = report.claims.filter(c => c.status === (report.mode === 'execute' ? 'claimed' : 'planned')).length
  const unreadable = report.claims.filter(c => c.status === 'unreadable')
  const parts = [`${report.mode === 'execute' ? 'Claimed' : 'Would claim'} ${claimed} repo/phase(s), ${report.claimedTotal} SOL`]
  if (report.allocation?.split) parts.push(`allocation buyback ${report.allocation.split.buyback} / liquidity ${report.allocation.split.liquidity} / treasury ${report.allocation.split.treasury} SOL`)
  else if (report.allocation) parts.push(`allocation ${report.allocation.status}`)
  if (report.transfer) parts.push(report.transfer.signature ? `sent ${report.transfer.amount} SOL to custody (${report.transfer.signature})`
    : `transfer ${report.transfer.status} ${report.transfer.amount} SOL`)
  if (unreadable.length) {
    const spent = unreadable.reduce((sum, c) => sum + (c.retries ?? 0), 0)
    parts.push(`${unreadable.length} repo/phase(s) unreadable${spent ? ` after ${spent} retries` : ''}, see claims`)
  }
  if (report.rpcRetries) parts.push(`${report.rpcRetries} RPC retries`)
  const lines = [parts.join('; ')]
  if (report.buyback) lines.push(`BUY BACK: ${report.buyback.reserve} SOL of $REPOING from ${report.buyback.custodyWallet} (custody balance ${report.buyback.custodyBalance} SOL)`)
  for (const c of report.claims.filter(c => c.status === 'failed')) lines.push(`SKIPPED ${c.phase ?? ''} ${c.fullName ?? c.repoId ?? ''}: ${c.error}`)
  if (report.error) lines.push(`STOPPED: ${report.error}`)
  return lines.join('\n')
}
