import { STOCK_COLLECTION_SIGNER_ROLE, createStockCollectionExecutor } from './stock-collection-execution.mjs'
import { STOCK_PAYOUT_SIGNER_ROLE, createStockLauncherPayouts } from './stock-launcher-payouts.mjs'
import { STOCK_EXECUTION_ERRORS as E, errorResult, stockExecutionFlags } from './stock-execution.mjs'

// Stock-pair fee collections and launcher payouts (docs/STOCK_QUOTES.md, "Execution (off by default)").
// - The operator script (scripts/stock-execute.mjs) runs a whole pass: it first finishes pending rows (settle, rebroadcast or
//   abort), then collects every enabled source whose preview MATCHes, then pays every launcher whose payable reaches the
//   minimum, so a share collected in a pass can be paid in the same pass. Only with --execute does it sign, with Keychain keys,
//   each read (prepareSigner) outside any lock, just before the first transaction that needs it: a Keychain prompt never holds
//   up a market's lock, so trades' fee indexing and the reconciliation never wait on it.
// - The worker job (scripts/run-worker.mjs) only finishes pending rows: it never plans, signs or loads a key.

// The worker's recovery cadence: with nothing pending a run is one indexed query per kind and no chain read.
export const STOCK_EXECUTION_INTERVAL_MS = 60_000
// Statuses that need a person: they fail the worker run and the script, as the other stock jobs' ERRORs do. A preview MISMATCH
// is reported but not loud here: src/stock-reconcile.mjs raises the operator alert for mismatches that outlast indexing lag.
export const STOCK_EXECUTION_LOUD = Object.freeze(['ERROR', 'REVIEW'])
const QUIET = new Set(['EMPTY', 'NOTHING'])

// A collection preview's non-MATCH source as a report item. Held back on purpose (not enabled, below the floor) is not loud;
// anything the preview refused is.
function unmatched(item) {
  if (item.status === 'MISMATCH') return { ...item, status: 'NOT_COLLECTABLE' }
  if (item.status === 'PENDING') return { ...item, status: 'IN_FLIGHT' }
  if (['ERROR', 'NOT_ENABLED', 'BELOW_MINIMUM'].includes(item.status)) return item
  return { ...item, status: 'ERROR', reason: `${item.status}: ${item.reason ?? 'not collectable'}` }
}

// One execution; a refusal that only means "not now" (the terms moved since the plan, or a row went pending meanwhile) is
// reported as such, anything else as an ERROR.
async function attempt(base, work) {
  try { return { ...base, ...await work() } } catch (error) {
    if (error?.code === E.TERMS_CHANGED) return { ...base, status: 'TERMS_CHANGED', reason: error.message }
    if (error?.code === E.IN_FLIGHT) return { ...base, status: 'IN_FLIGHT', reason: error.message }
    return errorResult(base, error)
  }
}

// One pass. execute=false is a dry run: plans and recovery checks only (statuses WOULD_COLLECT, WOULD_PAY, WOULD_SETTLE,
// WOULD_REBROADCAST, WOULD_ABORT), with no key loaded and nothing signed, sent or written. verbose keeps the EMPTY and NOTHING
// items the worker leaves out of its log. prepareSigner(role) reads a key (keychainSigners' prepare): it is called with no lock
// held, only for a collection that MATCHes or a payout that is PAYABLE, right before it runs; a failure is that item's ERROR.
export async function runStockExecution({ collections = null, payouts = null, listMarkets, execute = false, assetId = null, repoId = null, verbose = false,
  prepareSigner = null }) {
  const report = { collections: [], payouts: [] }
  if (!collections && !payouts) return report
  const markets = await listMarkets({ assetId, repoId })
  const filtered = assetId != null || repoId != null
  // Recovery covers every pending row, unless the pass is narrowed to some markets.
  const recover = async executor => {
    if (!filtered) return executor.recover({ dryRun: !execute })
    const results = []
    for (const market of markets) results.push(...await executor.recover({ repoId: market.repoId, dryRun: !execute }))
    return results
  }
  const keep = item => verbose || !QUIET.has(item.status)
  if (collections) {
    report.collections.push(...await recover(collections))
    for (const market of markets) {
      let planned
      try { planned = await collections.plan(market) } catch (error) { report.collections.push(errorResult({ kind: 'collection', repoId: market.repoId }, error)); continue }
      for (const item of planned) {
        if (item.status !== 'MATCH') { if (keep(item)) report.collections.push(QUIET.has(item.status) ? item : unmatched(item)); continue }
        if (!execute) { report.collections.push({ ...item, status: 'WOULD_COLLECT' }); continue }
        report.collections.push(await attempt({ kind: 'collection', repoId: item.repoId, source: item.source }, async () => {
          await prepareSigner?.(STOCK_COLLECTION_SIGNER_ROLE[item.source])
          return collections.collect({ repoId: item.repoId, source: item.source, termsHash: item.termsHash })
        }))
      }
    }
  }
  if (payouts) {
    report.payouts.push(...await recover(payouts))
    for (const market of markets) {
      let decision
      try { decision = await payouts.plan(market) } catch (error) { report.payouts.push(errorResult({ kind: 'payout', repoId: market.repoId }, error)); continue }
      if (decision.status !== 'PAYABLE') { if (keep(decision)) report.payouts.push(decision); continue }
      if (!execute) { report.payouts.push({ ...decision, status: 'WOULD_PAY' }); continue }
      report.payouts.push(await attempt({ kind: 'payout', repoId: market.repoId }, async () => {
        await prepareSigner?.(STOCK_PAYOUT_SIGNER_ROLE)
        return payouts.pay({ repoId: market.repoId })
      }))
    }
  }
  return report
}

export const stockExecutionLoud = report => [...report.collections, ...report.payouts].some(item => STOCK_EXECUTION_LOUD.includes(item.status))

// Recovery only, for every pending row of the enabled kinds: settle a finalized transaction, rebroadcast stored bytes while their
// blockhash is valid, abort once it has expired beyond doubt. No key: only bytes the operator's script already signed are sent.
export async function recoverStockExecution({ collections = null, payouts = null }) {
  return { collections: collections ? await collections.recover() : [], payouts: payouts ? await payouts.recover() : [] }
}

// The worker job: null, so it constructs, reads and loads nothing (connect() is not even called), unless
// STOCK_COLLECTIONS_EXECUTION_ENABLED or STOCK_LAUNCHER_PAYOUTS_ENABLED is 'true'; then it recovers the kinds whose flag is on.
// It is keyless by construction: its executors have no signer, so they can recover but never collect or pay. connect() returns
// { connection, verification }.
export function createStockExecutionJob({ pool, connect, config, env = process.env, ...options }) {
  if ('loadSigner' in options) throw Error('The worker never signs: stock collections and payouts run from scripts/stock-execute.mjs')
  const flags = stockExecutionFlags(env)
  if (!flags.collections && !flags.payouts) return null
  const { connection, verification = null } = connect()
  const shared = { pool, connection, verification, env, ...options }
  const collections = flags.collections ? createStockCollectionExecutor({ ...shared, config }) : null
  const payouts = flags.payouts ? createStockLauncherPayouts(shared) : null
  return { flags, runOnce: () => recoverStockExecution({ collections, payouts }) }
}

// Plain-English lines for the operator script.
export function describeStockExecution(report, { execute }) {
  const line = item => `  ${item.kind} ${item.repoId}${item.source ? ` ${item.source}` : ''}: ${item.status}` +
    `${item.amount ? `, ${item.amount} raw units` : item.payable ? `, payable ${item.payable} raw units (minimum ${item.minimum})` : ''}` +
    `${item.wallet ? ` to ${item.wallet}` : ''}${item.termsHash ? `, terms ${item.termsHash}` : ''}${item.signature ? `, ${item.signature}` : ''}` +
    `${item.reason ? ` (${item.reason})` : ''}`
  const lines = ['Collections:', ...(report.collections.length ? report.collections.map(line) : ['  none']),
    'Launcher payouts:', ...(report.payouts.length ? report.payouts.map(line) : ['  none'])]
  lines.push(execute ? 'Executed: every transaction above was recorded pending before it was sent.' : 'Dry run: no key was loaded and nothing was signed, sent or written.')
  return lines
}
