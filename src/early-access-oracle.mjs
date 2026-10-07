import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, MAX_ALLOW_LIST, MAX_WALLETS_PER_CALL, addWalletsInstruction, closeAllowListInstruction, decodeAllowList,
  decodeMintConfig, decodePlatform, earlyAccessAddresses, hookErrorName, platformAddress, removeWalletsInstruction } from './early-access-hook.mjs'

// The oracle's upkeep of contributor early access allow lists (docs/EARLY_ACCESS.md, step 5f; owner decision 2026-10-07). While a
// market's window is open, its list is kept equal to the linked wallets of the repository's contributors: the snapshot taken when the
// launch was prepared (early_access_contributors) joined with github_wallet_links. So a contributor who links a wallet during the
// window is added at the next run, and a wallet that is no longer linked (its account unlinked it or linked another) is removed: one
// account does not keep two places. Nothing is added in the window's last 30 seconds (the chain may already be past it). After the
// window the list is closed: the launch's payer gets its deposit back and the oracle what it paid for the list to grow.
// Removals are guarded against a bad read of the links: a wallet leaves only when two runs in a row find it unlinked, and a run that
// would take more than half of a list of more than four wallets holds them all and logs it.
// Each change is simulated first and sent only if it passes; the oracle signs and pays. One run at a time (advisory lock).

const ADD_MARGIN_MS = 30_000
const CLOSE_AFTER_MS = 60_000
// Lists of windows that ended more than this long ago are not read again (a list that could not be closed is logged until then).
const CLOSE_WITHIN_MS = 7 * 24 * 3_600_000
const COMPUTE_UNITS = 200_000
const LOCK_KEY = 'early-access-oracle'
const READ_BATCH = 100
// A run stops sending after this long (the next run, a minute later, goes on), so one slow market never holds the others.
const RUN_BUDGET_MS = 45_000
// Below this the oracle adds nothing (removals and closes, which cost a fee and may refund it, go on).
export const MIN_ORACLE_LAMPORTS = 5_000_000
const HOLD_ABOVE = 4

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, index * size + size))
// A wallet as base58, or null for anything that is not a public key (one bad row never stops a market's upkeep).
const canonical = wallet => { try { return new PublicKey(wallet).toBase58() === wallet ? wallet : null } catch { return null } }

// The wallets a market's list should hold now, and how many accounts its contributor snapshot holds.
async function linkedContributorWallets(db, repoId) {
  const { rows: [count] } = await db.query('select count(*)::int as snapshot from early_access_contributors where github_repo_id = $1', [repoId])
  const { rows } = await db.query(`select l.wallet from early_access_contributors c join github_wallet_links l on l.github_user_id = c.github_user_id
    where c.github_repo_id = $1 order by l.wallet`, [repoId])
  return { wallets: rows.map(row => canonical(row.wallet)).filter(Boolean), snapshot: count.snapshot }
}

// What one market needs now. While the window is open: { add, remove, unlinked, held, overflow }, where unlinked are the listed wallets
// that are not linked now (removed only if the previous run found them unlinked too: `pending`); after it, { close: true }.
export function plannedChange({ list, desired, snapshot, end, now, pending = new Set() }) {
  if (now < end - ADD_MARGIN_MS) {
    if (!list) return { missing: true }
    const listed = new Set(list), wanted = new Set(desired)
    // A market whose snapshot is gone never loses its list: an empty snapshot is not "nobody is a contributor".
    const unlinked = snapshot > 0 ? list.filter(wallet => !wanted.has(wallet)) : []
    const held = list.length > HOLD_ABOVE && unlinked.length * 2 > list.length ? unlinked.length : 0
    const remove = held ? [] : unlinked.filter(wallet => pending.has(wallet))
    // Adds go first, so the room is what the list has now.
    const room = Math.max(0, MAX_ALLOW_LIST - list.length), missing = desired.filter(wallet => !listed.has(wallet))
    return { add: missing.slice(0, room), remove, unlinked, held, overflow: Math.max(0, missing.length - room) }
  }
  if (now >= end + CLOSE_AFTER_MS && list) return { close: true }
  return {}
}

export function createEarlyAccessOracle({ pool, connection, oracle, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, now = () => Date.now(),
  clock = () => Date.now(), log = record => console.log(JSON.stringify({ earlyAccessOracle: record })) }) {
  const program = new PublicKey(hookProgram)
  // Per mint, the wallets the previous run found unlinked (kept in memory: a restart only delays a removal by one run).
  const pendingRemovals = new Map()

  // Simulated first (a refusal costs nothing), then sent and confirmed against the blockhash it was built with; the oracle pays.
  async function send(instruction) {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNITS }), instruction)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    tx.feePayer = oracle.publicKey
    tx.recentBlockhash = blockhash
    tx.sign(oracle)
    const simulated = await connection.simulateTransaction(tx)
    if (simulated.value.err) return { sent: false, reason: hookErrorName((simulated.value.logs ?? []).join('\n'), program) ?? JSON.stringify(simulated.value.err) }
    const signature = await connection.sendRawTransaction(tx.serialize())
    const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    if (confirmed.value.err) return { sent: false, reason: JSON.stringify(confirmed.value.err), signature }
    return { sent: true, signature }
  }

  // The platform must name this key as its oracle, or every instruction would be refused.
  async function oracleMatches() {
    const info = await connection.getAccountInfo(platformAddress(program), 'confirmed')
    if (!info?.owner.equals(program)) return false
    try { return decodePlatform(info.data).oracle.equals(oracle.publicKey) } catch { return false }
  }

  async function upkeep(market, info, { lowBalance, deadline }) {
    const mint = new PublicKey(market.mint), end = new Date(market.earlyAccessEnd).getTime(), at = now()
    let list = null
    if (info?.owner.equals(program)) {
      const decoded = decodeAllowList(info.data)
      if (!decoded.mint.equals(mint)) return { mint: market.mint, error: 'LIST_MINT_MISMATCH' }
      list = decoded.wallets.map(wallet => wallet.toBase58())
    }
    const { wallets: desired, snapshot } = at < end - ADD_MARGIN_MS ? await linkedContributorWallets(pool, market.repoId) : { wallets: [], snapshot: 0 }
    const plan = plannedChange({ list, desired, snapshot, end, now: at, pending: pendingRemovals.get(market.mint) })
    if (plan.unlinked) pendingRemovals.set(market.mint, new Set(plan.unlinked))
    else pendingRemovals.delete(market.mint)
    if (plan.missing) return { mint: market.mint, error: 'NO_ALLOW_LIST' }
    const result = { mint: market.mint, added: 0, removed: 0, closed: false, ...plan.overflow ? { overflow: plan.overflow } : {},
      ...plan.held ? { held: plan.held } : {}, ...lowBalance && plan.add?.length ? { waiting: plan.add.length } : {} }
    const signatures = []
    const done = (extra = {}) => ({ ...result, ...signatures.length ? { signatures } : {}, ...extra })
    if (plan.close) {
      const config = await connection.getAccountInfo(earlyAccessAddresses(mint, program).config, 'confirmed')
      if (!config?.owner.equals(program)) return done({ error: 'NO_MINT_CONFIG' })
      const sent = await send(closeAllowListInstruction({ mint, rentReceiver: decodeMintConfig(config.data).rentReceiver, oracle: oracle.publicKey, programId: program }))
      if (sent.signature) signatures.push(sent.signature)
      return sent.sent ? done({ closed: true }) : done({ error: sent.reason })
    }
    // Adds first: a re-linked account's new wallet joins before its old one leaves (a run later).
    for (const [kind, wallets, build] of [['added', lowBalance ? [] : plan.add ?? [], batch => addWalletsInstruction({ oracle: oracle.publicKey, mint,
      wallets: batch, programId: program })], ['removed', plan.remove ?? [], batch => removeWalletsInstruction({ authority: oracle.publicKey, mint, wallets: batch,
      programId: program })]]) {
      for (const batch of chunks(wallets, MAX_WALLETS_PER_CALL)) {
        if (clock() > deadline) return done({ error: 'RUN_BUDGET' })
        const sent = await send(build(batch.map(wallet => new PublicKey(wallet))))
        if (sent.signature) signatures.push(sent.signature)
        if (!sent.sent) return done({ error: sent.reason })
        result[kind] += batch.length
      }
    }
    return done()
  }

  async function runOnce() {
    const client = await pool.connect()
    try {
      const { rows: [lock] } = await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [LOCK_KEY])
      if (!lock.locked) return { status: 'BUSY' }
      try {
        const { rows: markets } = await client.query(`select m.github_repo_id::text as "repoId", m.mint, m.early_access_end as "earlyAccessEnd"
          from markets m where m.early_access_end is not null and m.transfer_hook_program = $1 and m.status = 'confirmed' and m.mint is not null
            and m.early_access_end > $2 order by m.early_access_end`, [program.toBase58(), new Date(now() - CLOSE_WITHIN_MS)])
        if (!markets.length) return { status: 'IDLE' }
        if (!await oracleMatches()) { log({ error: 'ORACLE_NOT_PLATFORM_ORACLE' }); return { status: 'ORACLE_MISMATCH' } }
        const balance = await connection.getBalance(oracle.publicKey, 'confirmed')
        const lowBalance = balance < MIN_ORACLE_LAMPORTS
        if (lowBalance) log({ error: 'ORACLE_LOW_BALANCE', lamports: balance })
        const lists = []
        for (const batch of chunks(markets, READ_BATCH)) {
          lists.push(...await connection.getMultipleAccountsInfo(batch.map(market => earlyAccessAddresses(market.mint, program).allowList), 'confirmed'))
        }
        const deadline = clock() + RUN_BUDGET_MS, results = []
        for (const [index, market] of markets.entries()) {
          let result
          try { result = await upkeep(market, lists[index], { lowBalance, deadline }) } catch (error) { result = { mint: market.mint, error: error?.name ?? 'Error' } }
          if (result.added || result.removed || result.closed || result.error || result.overflow || result.held || result.waiting) log(result)
          results.push(result)
        }
        return { status: 'OK', results }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY]) }
    } finally { client.release() }
  }
  return { runOnce }
}
