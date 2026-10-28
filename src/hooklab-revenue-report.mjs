// The Hooks revenue report: every pool on our swap program, its launch, and their finalized histories, read from the chain
// and turned into market ledgers (src/hooklab-revenue-ledger.mjs), an unsigned collection plan
// (src/hooklab-collection-plan.mjs). Hooks revenue is tracked and reconciled only: it is not part of the platform revenue
// policy (owner, 2026-10-28; Hooks keep the inclusive 75/25 creator/repo.ing split and the launch fee). Read only: it
// asks the RPC for accounts, signatures and transactions, nothing else, and holds no key.
import { BorshCoder } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import { decodeRevenueEvents } from './hooklab-revenue-events.mjs'
import { buildMarketLedger, revenueTotals, reconcilePayments, ledgerJson } from './hooklab-revenue-ledger.mjs'
import { planCollections } from './hooklab-collection-plan.mjs'

export const MAX_SIGNATURES_PER_ADDRESS = 20_000
const PAGE = 1000, READ_ATTEMPTS = 4
const check = (ok, code) => { if (!ok) throw Object.assign(Error(code), { code }) }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// A read with bounded retries (a provider's transient failure is not a finding); the last failure is thrown.
async function read(load, { attempts = READ_ATTEMPTS, delayMs = 500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await load() } catch (error) { if (attempt >= attempts) throw error; await wait(delayMs * 2 ** (attempt - 1)) }
  }
}

async function history(connection, address, limit, retry) {
  const all = []
  for (let before; ;) {
    const page = await read(() => connection.getSignaturesForAddress(new PublicKey(address), { limit: PAGE, ...(before ? { before } : {}) }, 'finalized'), retry)
    all.push(...page)
    check(all.length <= limit, 'HOOK_REVENUE_HISTORY_TOO_LONG')
    if (page.length < PAGE) return all
    before = page.at(-1).signature
  }
}

// Every pool and its launch: { pool, mint, feeModel, chain, entries }. Entries carry seq, their transaction's place in the
// combined chronological history (getSignaturesForAddress lists newest first). retry: { attempts, delayMs } for each read.
export async function loadHooksMarkets({ connection, programs, idls, treasury, maxSignatures = MAX_SIGNATURES_PER_ADDRESS, retry = {} }) {
  const coder = new BorshCoder(idls.swap), disc = Buffer.from(idls.swap.accounts.find(a => a.name === 'Pool').discriminator)
  const accounts = await read(() => connection.getProgramAccounts(new PublicKey(programs.swap), { commitment: 'finalized',
    filters: [{ memcmp: { offset: 0, bytes: disc.toString('base64'), encoding: 'base64' } }] }), retry)
  const rent = new Map(), markets = []
  for (const { pubkey, account } of accounts) {
    const pool = pubkey.toBase58(), state = coder.accounts.decode('Pool', Buffer.from(account.data)), mint = state.base_mint.toBase58()
    const launch = PublicKey.findProgramAddressSync([Buffer.from('launch'), new PublicKey(mint).toBuffer()], new PublicKey(programs.launch))[0]
    const launchAccount = await read(() => connection.getAccountInfo(launch, 'finalized'), retry)
    const size = launchAccount?.data.length
    if (launchAccount && !rent.has(size)) rent.set(size, BigInt(await read(() => connection.getMinimumBalanceForRentExemption(size, 'finalized'), retry)))
    // Each history oldest first, then all of it by slot (a stable sort keeps an address's own order within a slot).
    const listed = new Map()
    for (const address of [pool, launch.toBase58()]) {
      for (const item of (await history(connection, address, maxSignatures, retry)).reverse()) if (!listed.has(item.signature)) listed.set(item.signature, item)
    }
    const chronological = [...listed.values()].sort((a, b) => a.slot - b.slot)
    const entries = []
    for (const [seq, item] of chronological.entries()) {
      if (item.err !== null) continue
      const tx = await read(() => connection.getTransaction(item.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }), retry)
      check(tx && tx.slot === item.slot, 'HOOK_REVENUE_TRANSACTION_MISSING')
      entries.push(...decodeRevenueEvents(tx, { signature: item.signature, programs, idls, treasury }).map(entry => ({ ...entry, seq })))
    }
    markets.push({ pool, mint, feeModel: state.fee_model, entries, chain: { protocolFeesQuote: BigInt(state.protocol_fees_quote.toString()),
      ...(launchAccount ? { launchLamports: BigInt(launchAccount.lamports), launchRentExempt: rent.get(size) } : {}) } })
  }
  return markets
}

// markets: loadHooksMarkets(). expected: { collector, treasury }. records: our own books'
// payment records to reconcile (optional).
export function buildHooksRevenueReport({ markets, expected, records = null, now = Date.now(), collectionPolicy = {}, instructions = null }) {
  const ledgers = markets.map(m => buildMarketLedger({ pool: m.pool, entries: m.entries, chain: m.chain, expected }))
  const totals = revenueTotals(ledgers)
  const plan = planCollections({ ledgers, pools: Object.fromEntries(markets.map(m => [m.pool, { feeModel: m.feeModel }])), collector: expected.collector,
    policy: collectionPolicy, now, instructions })
  const payments = records ? reconcilePayments({ entries: markets.flatMap(m => m.entries), records }) : null
  return ledgerJson({ asOf: new Date(now).toISOString(), totals, markets: ledgers.map(({ entries, ...ledger }) => ({ ...ledger, events: entries.length })),
    plan, ...(payments ? { payments } : {}) })
}
