import { PublicKey } from '@solana/web3.js'
import { rawTransaction } from './finalized-transaction.mjs'

// Funding-source links (docs/LAUNCH_TRANSPARENCY.md#linked-wallets): where a trading wallet's first SOL came from. A wallet's oldest
// transactions are read (only for wallets with a short history: a fresh wallet is what a sybil or wash-trading setup creates) and the
// first system transfer into it names its funder. Two links follow, used only to exclude activity from metrics and incentives:
//   shared funder   wallets funded by the same wallet, unless that funder looks like an exchange or another service, whose customers
//                   are unrelated: it funded serviceMinWallets or more of the wallets checked, or its own history is busy (historyLimit
//                   or more transactions);
//   direct funding  a trading wallet funded by another trading wallet of the same market.
// A link is evidence of a relationship, not proof of one controller; it never blocks anyone and is shown with its evidence.
export const FUNDING_LIMITS = Object.freeze({
  historyLimit: 1000,
  oldestChecked: 3,
  serviceMinWallets: 25,
  perRun: 20,
  recheckErrorMs: 24 * 3_600_000,
  minVolumeLamports: 100_000_000n,
  activeDays: 30,
})

const SYSTEM = '11111111111111111111111111111111'

// The first SOL transfer into `wallet` in one parsed transaction (top-level instructions, then inner ones, in order).
export function firstFunding(tx, wallet) {
  if (!tx || tx.meta?.err) return null
  const top = tx.transaction?.message?.instructions ?? []
  const inner = (tx.meta?.innerInstructions ?? []).flatMap(group => group.instructions ?? [])
  for (const ix of [...top, ...inner]) {
    const programId = ix.programId?.toBase58?.() ?? ix.programId
    if (programId !== SYSTEM || !ix.parsed?.info) continue
    const { type, info } = ix.parsed
    const into = type === 'createAccount' || type === 'createAccountWithSeed' ? info.newAccount : ['transfer', 'transferWithSeed'].includes(type) ? info.destination : null
    const from = info.source ?? info.from
    if (into === wallet && from && from !== wallet) return { funder: from, lamports: BigInt(info.lamports ?? 0) }
  }
  return null
}

// Reads and stores one wallet's funding. Returns the stored row's status.
export async function checkWalletFunding(db, connection, wallet, { limits = FUNDING_LIMITS, now = Date.now } = {}) {
  const store = (status, found = null) => db.query(`insert into wallet_funding (wallet, status, funder, funding_signature, funded_lamports, funded_at, funder_busy, checked_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (wallet) do update set status = excluded.status, funder = excluded.funder,
      funding_signature = excluded.funding_signature, funded_lamports = excluded.funded_lamports, funded_at = excluded.funded_at,
      funder_busy = excluded.funder_busy, checked_at = excluded.checked_at`,
  [wallet, status, found?.funder ?? null, found?.signature ?? null, found ? found.lamports.toString() : null, found?.at ?? null, found?.busy ?? null, new Date(now())]).then(() => status)
  // Whether a funder is busy is read once per funder: an earlier row that says so is reused.
  const funderBusy = async funder => {
    const { rows } = await db.query('select funder_busy as busy from wallet_funding where funder = $1 and funder_busy is not null limit 1', [funder])
    if (rows.length) return rows[0].busy
    return (await connection.getSignaturesForAddress(new PublicKey(funder), { limit: limits.historyLimit }, 'finalized')).length >= limits.historyLimit
  }
  try {
    const signatures = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: limits.historyLimit }, 'finalized')
    if (signatures.length >= limits.historyLimit) return store('long-history')
    for (const entry of signatures.slice(-limits.oldestChecked).reverse()) {
      if (entry.err) continue
      // Any version, parsed: web3.js rejects version 1 transactions, which would leave the wallet stored as an error forever.
      const tx = await rawTransaction(connection, entry.signature, { encoding: 'jsonParsed' })
      const found = firstFunding(tx, wallet)
      if (found && found.funder !== wallet) {
        return store('found', { ...found, signature: entry.signature, at: entry.blockTime ? new Date(entry.blockTime * 1000) : null, busy: await funderBusy(found.funder) })
      }
    }
    return store('none')
  } catch (error) {
    await store('error').catch(() => {})
    throw error
  }
}

// Wallets to check: traded at least minVolumeLamports in the last activeDays, never checked, or an error older than a day.
export async function dueFundingWallets(db, { limits = FUNDING_LIMITS, now = Date.now() } = {}) {
  const { rows } = await db.query(`with recent as (
      select trader, (case when direction = 'buy' then input_base_units else output_base_units end)::numeric as lamports
        from trade_events where trader is not null and traded_at >= $1
      union all
      select trader, quote_amount::numeric from damm_trade_events where trader is not null and traded_at >= $1)
    select r.trader as wallet from recent r left join wallet_funding f on f.wallet = r.trader
    where f.wallet is null or (f.status = 'error' and f.checked_at < $2)
    group by r.trader having sum(r.lamports) >= $3 order by sum(r.lamports) desc, r.trader limit $4`,
  [new Date(now - limits.activeDays * 86_400_000), new Date(now - limits.recheckErrorMs), limits.minVolumeLamports.toString(), limits.perRun])
  return rows.map(row => row.wallet)
}

// Links among the given wallets (one market's traders): shared funders that are not services, and wallets funded by another of them.
// ignoreFunders: wallets whose funding says nothing about control (repo.ing's own wallets).
export async function readFundingLinks(db, wallets, { limits = FUNDING_LIMITS, ignoreFunders = new Set() } = {}) {
  const list = [...new Set(wallets ?? [])]
  if (!list.length) return []
  let rows
  try {
    ;({ rows } = await db.query(`select f.wallet, f.funder, f.funding_signature as signature, coalesce(f.funder_busy, false) as busy,
        (select count(*) from wallet_funding g where g.funder = f.funder and g.status = 'found')::int as funded
      from wallet_funding f where f.wallet = any($1::text[]) and f.status = 'found'`, [list]))
  } catch (error) {
    if (error?.code === '42P01') return []
    throw error
  }
  const traders = new Set(list), links = [], byFunder = new Map()
  for (const row of rows) {
    if (ignoreFunders.has(row.funder)) continue
    if (traders.has(row.funder)) links.push({ a: row.funder, b: row.wallet, kind: 'funding', evidence: `funded by a trading wallet (${row.signature})` })
    if (row.busy || row.funded >= limits.serviceMinWallets) continue
    byFunder.set(row.funder, [...byFunder.get(row.funder) ?? [], row])
  }
  for (const [funder, funded] of byFunder) {
    const sorted = funded.sort((x, y) => x.wallet.localeCompare(y.wallet))
    for (const row of sorted.slice(1)) links.push({ a: sorted[0].wallet, b: row.wallet, kind: 'funding', evidence: `same funder ${funder} (${row.signature})` })
  }
  return links
}

// Link evidence counts by kind, for the report ("linked by 2 shared funders, 1 same transaction").
export function linkKinds(links) {
  const counts = {}
  for (const link of links ?? []) counts[link.kind] = (counts[link.kind] ?? 0) + 1
  return counts
}
