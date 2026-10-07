import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, MAX_ALLOW_LIST, MAX_WALLETS_PER_CALL, RULES, addWalletsInstruction, closeAllowListInstruction, decodeAllowList,
  decodeMintConfig, decodePlatform, earlyAccessAddresses, hookErrorName, platformAddress, removeWalletsInstruction, reportStarsInstruction,
  starBonusBps } from './early-access-hook.mjs'
import { readRepositoryStars } from './github.mjs'

// The oracle's upkeep of contributor early access allow lists (docs/EARLY_ACCESS.md, step 5f; owner decision 2026-10-07). While a
// market's window is open, its list is kept equal to the linked wallets of the repository's contributors: the snapshot taken when the
// launch was prepared (early_access_contributors) joined with github_wallet_links. So a contributor who links a wallet during the
// window is added at the next run, and a wallet that is no longer linked (its account unlinked it or linked another) is removed: one
// account does not keep two places. Nothing is added in the window's last 30 seconds (the chain may already be past it). After the
// window the list is closed: the launch's payer gets its deposit back and the oracle what it paid for the list to grow.
// Removals are guarded against a bad read of the links: a wallet leaves only when two runs in a row find it unlinked, and a run that
// would take more than half of a list of more than four wallets holds them all and logs it.
// Star unlocks (docs/EARLY_ACCESS.md): until a star-unlock market's curve migrates (the fair ramp's limits apply only on the curve), the
// oracle reads the repository's GitHub star count every 15 minutes and reports it when the bonus it gives changes (it may go down
// as well as up: stars taken back are not gained). A repository GitHub no longer serves publicly keeps its last report. Star
// reports are their own step after the lists' upkeep (a failure there never stops it), wait while the oracle's balance is low,
// and stop for the run at GitHub's rate limit.
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
const STAR_READ_MS = 15 * 60_000
const STAR_READS_PER_RUN = 20

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

// Whether a star count read now changes a mint config's bonus (the report the oracle would send).
export const starReportNeeded = (config, stars) => starBonusBps(config.ramp, stars) !== starBonusBps(config.ramp, config.starsNow)

export function createEarlyAccessOracle({ pool, connection, oracle, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, now = () => Date.now(),
  clock = () => Date.now(), readStars = readRepositoryStars, log = record => console.log(JSON.stringify({ earlyAccessOracle: record })) }) {
  const program = new PublicKey(hookProgram)
  // Per mint, the wallets the previous run found unlinked (kept in memory: a restart only delays a removal by one run).
  const pendingRemovals = new Map()
  // Per star-unlock mint, when its repository's stars were last read (in memory: a restart reads them once more); and after
  // GitHub's rate limit, when reads may start again.
  const starsReadAt = new Map()
  let starsPausedUntil = 0

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
  // Whether this process has checked the platform's oracle yet: checked once even while no window is open, so a wrong key shows in
  // the worker's log before launches open (docs/EARLY_ACCESS.md, runbook step 6).
  let platformChecked = false
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

  async function reportStars(market, info) {
    const mint = new PublicKey(market.mint)
    if (!info?.owner.equals(program)) return { mint: market.mint, error: 'NO_MINT_CONFIG' }
    const config = decodeMintConfig(info.data)
    if (!config.mint.equals(mint) || config.repoId !== market.repoId || !(config.rules & RULES.STAR_UNLOCKS)) {
      return { mint: market.mint, error: 'MINT_CONFIG_MISMATCH' }
    }
    const stars = await readStars(market.repoId)
    if (stars === null) return { mint: market.mint, error: 'STARS_UNREADABLE' }
    if (!starReportNeeded(config, stars)) return { mint: market.mint, stars }
    const sent = await send(reportStarsInstruction({ oracle: oracle.publicKey, mint, stars, programId: program }))
    return { mint: market.mint, stars, ...sent.sent ? { reported: true } : { error: sent.reason }, ...sent.signature ? { signature: sent.signature } : {} }
  }

  // The star-unlock markets whose repository is due a read, least recently read first.
  function starsDue(markets) {
    const at = clock()
    if (at < starsPausedUntil) return []
    return markets.filter(market => at - (starsReadAt.get(market.mint) ?? -Infinity) >= STAR_READ_MS)
      .sort((a, b) => (starsReadAt.get(a.mint) ?? -Infinity) - (starsReadAt.get(b.mint) ?? -Infinity)).slice(0, STAR_READS_PER_RUN)
  }

  // due: the markets starsDue picked. GitHub's rate limit ends the run's reads and pauses them for 15 minutes; a 429 without its
  // headers ends the run's reads.
  async function starReports(due, deadline) {
    const results = []
    if (!due.length) return results
    let configs
    try { configs = await connection.getMultipleAccountsInfo(due.map(market => earlyAccessAddresses(market.mint, program).config), 'confirmed') }
    catch { const result = { error: 'STAR_CONFIGS_UNAVAILABLE' }; log({ stars: result }); return [result] }
    for (const [index, market] of due.entries()) {
      if (clock() > deadline) break
      // Marked before the read, so a failing repository waits its turn like the others.
      starsReadAt.set(market.mint, clock())
      let result
      try { result = await reportStars(market, configs[index]) } catch (error) {
        result = { mint: market.mint, error: /^(GITHUB_REPOSITORY_HTTP_\d{3}|GITHUB_RATE_LIMITED)$/.test(error?.message) ? error.message : error?.name ?? 'Error' }
      }
      if (result.reported || result.error) log({ stars: result })
      results.push(result)
      if (result.error === 'GITHUB_RATE_LIMITED') starsPausedUntil = clock() + STAR_READ_MS
      if (result.error === 'GITHUB_RATE_LIMITED' || result.error === 'GITHUB_REPOSITORY_HTTP_429') break
    }
    return results
  }

  // The star-unlock markets due a read, or [] when their query fails (logged once until it works again).
  let starsQueryFailed = false
  async function dueStarMarkets(client) {
    try {
      const { rows } = await client.query(`select m.github_repo_id::text as "repoId", m.mint from markets m
        where (m.hook_rules & $2) <> 0 and m.transfer_hook_program = $1 and m.status = 'confirmed' and m.mint is not null
          and m.indexed_at is not null and not exists (select 1 from graduation_events g where g.github_repo_id = m.github_repo_id)
        order by m.github_repo_id`, [program.toBase58(), RULES.STAR_UNLOCKS])
      starsQueryFailed = false
      return starsDue(rows)
    } catch (error) {
      if (!starsQueryFailed) log({ stars: { error: error?.code === '42703' ? 'STARS_NOT_MIGRATED' : 'STARS_UNAVAILABLE' } })
      starsQueryFailed = true
      return []
    }
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
        const starMarkets = await dueStarMarkets(client)
        if (!markets.length && !starMarkets.length) {
          if (!platformChecked) { platformChecked = true; if (!await oracleMatches()) log({ error: 'ORACLE_NOT_PLATFORM_ORACLE' }) }
          return { status: 'IDLE' }
        }
        platformChecked = true
        if (!await oracleMatches()) { log({ error: 'ORACLE_NOT_PLATFORM_ORACLE' }); return { status: 'ORACLE_MISMATCH' } }
        const balance = await connection.getBalance(oracle.publicKey, 'confirmed')
        const lowBalance = balance < MIN_ORACLE_LAMPORTS
        if (lowBalance) log({ error: 'ORACLE_LOW_BALANCE', lamports: balance })
        const lists = [], deadline = clock() + RUN_BUDGET_MS, results = []
        for (const batch of chunks(markets, READ_BATCH)) {
          lists.push(...await connection.getMultipleAccountsInfo(batch.map(market => earlyAccessAddresses(market.mint, program).allowList), 'confirmed'))
        }
        for (const [index, market] of markets.entries()) {
          let result
          try { result = await upkeep(market, lists[index], { lowBalance, deadline }) } catch (error) { result = { mint: market.mint, error: error?.name ?? 'Error' } }
          if (result.added || result.removed || result.closed || result.error || result.overflow || result.held || result.waiting) log(result)
          results.push(result)
        }
        const stars = lowBalance ? [] : await starReports(starMarkets, deadline)
        return { status: 'OK', results, ...stars.length ? { stars } : {} }
      } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [LOCK_KEY]) }
    } finally { client.release() }
  }
  return { runOnce }
}
