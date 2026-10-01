// Pure computations behind the token page trust panel: the launcher's indexed position, top-holder concentration
// from on-chain token accounts, and mint facts. Facts only: no verdicts. All amounts are token base units (bigint).

// Every repo.ing market mints one billion tokens with six decimals (see src/launch-buy.mjs).
export const FIXED_SUPPLY_BASE_UNITS = 1_000_000_000_000_000n
export const TOKEN_DECIMALS = 6
export const TOP_HOLDERS = 10

// Owners of the bonding-curve and graduated-pool token vaults (Meteora DBC and DAMM v2 pool authorities).
export const DBC_POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'
export const DAMM_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC'
// Token lock programs: a token account whose owner is an escrow account of one of these programs is locked.
export const LOCK_PROGRAMS = Object.freeze({
  LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: 'Jupiter Lock',
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: 'Streamflow',
})

const big = value => {
  try { return typeof value === 'bigint' ? value : BigInt(value ?? 0) } catch { return null }
}

// Share of `total` as a percentage (a Number, ten decimal places of precision), or null when total is not positive.
export function sharePercent(amount, total) {
  const a = big(amount), t = big(total)
  if (a === null || t === null || t <= 0n) return null
  return Number((a < 0n ? 0n : a) * 1_000_000_000_000n / t) / 10_000_000_000
}

// "12.3%", "4.56%", "<0.01%", "0%". Never rounds a nonzero share down to 0.
export function percentLabel(percent) {
  if (percent === null || percent === undefined || !Number.isFinite(percent)) return '—'
  if (percent <= 0) return '0%'
  if (percent < 0.01) return '<0.01%'
  const digits = percent >= 10 ? 1 : 2
  return `${Number(percent.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })}%`
}

// Maintainer row: verified once a GitHub admin verified the repository or a payout wallet is bound.
export function maintainerStatus(market = {}) {
  const verified = Boolean(market.wasVerified || market.beneficiaryWallet)
  return { verified, payoutWallet: market.beneficiaryWallet ?? null }
}

// Launcher row from per-launcher sums of indexed swaps (readLauncherTrades). label: { kind, label } when the launcher
// is a known platform or builder wallet. Tokens moved by transfer are not visible here, so "held" is net bought.
export function launcherPosition(row, { supply = FIXED_SUPPLY_BASE_UNITS } = {}) {
  const bought = big(row?.boughtBaseUnits), sold = big(row?.soldBaseUnits), launchBuy = big(row?.launchBuyBaseUnits)
  if (bought === null || sold === null || launchBuy === null || bought < 0n || sold < 0n) return null
  const net = bought - sold
  const held = net > 0n ? net : 0n
  const state = bought === 0n ? (sold > 0n ? 'sold-unbought' : 'no-trades')
    : sold === 0n ? 'holding' : sold >= bought ? 'sold-all' : 'sold-some'
  return {
    boughtBaseUnits: bought.toString(), soldBaseUnits: sold.toString(), launchBuyBaseUnits: launchBuy.toString(),
    heldBaseUnits: held.toString(),
    heldPercent: sharePercent(held, supply),
    launchBuyPercent: sharePercent(launchBuy, supply),
    // Of what the launcher bought here, how much they sold (capped at 100: transfers in can make sells exceed buys).
    soldPercentOfBought: bought > 0n ? Math.min(100, sharePercent(sold, bought)) : null,
    state,
  }
}

// Display lines for the launcher row: { title, launch, sold }. Neutral facts from indexed swaps only.
export function launcherLines(position) {
  if (!position) return null
  const title = position.state === 'no-trades' ? 'Launcher has no trades on repo.ing'
    : `Launcher holds ${percentLabel(position.heldPercent)} of supply`
  const launch = position.launchBuyPercent ? `Bought ${percentLabel(position.launchBuyPercent)} at launch` : 'No buy at launch'
  const sold = {
    'no-trades': 'No sells',
    'sold-unbought': 'Sold tokens not bought here',
    holding: "Hasn't sold",
    'sold-all': 'Sold all of what they bought',
    'sold-some': `Sold ${percentLabel(position.soldPercentOfBought)} of what they bought`,
  }[position.state]
  return { title, launch, sold }
}

// SPL mint account (82 bytes): mint authority option at 0, supply u64 at 36, decimals at 44, freeze authority option at 46.
export function parseMintAccount(data) {
  if (!data || data.length < 82) throw new Error('Unexpected SPL mint account data')
  return { mintAuthorityRevoked: data.readUInt32LE(0) === 0, supplyBaseUnits: data.readBigUInt64LE(36),
    decimals: data[44], initialized: data[45] === 1, freezeAuthorityRevoked: data.readUInt32LE(46) === 0 }
}

// SPL token account (165 bytes): mint at 0, owner at 32, amount u64 at 64. Returns the raw owner bytes and amount.
export function parseTokenAccount(data) {
  if (!data || data.length < 72) throw new Error('Unexpected SPL token account data')
  return { mint: data.subarray(0, 32), owner: data.subarray(32, 64), amount: data.readBigUInt64LE(64) }
}

// Where a large token account's tokens sit. accounts: [{ address, owner, amount }] (base58 strings, bigint amount).
// ownerPrograms: Map owner → program that owns the owner account (null for wallets with no account data / unknown).
export function classifyAccount({ address, owner }, { curveVault = null, ownerPrograms = new Map() } = {}) {
  if (address === curveVault || owner === DBC_POOL_AUTHORITY) return { kind: 'curve' }
  if (owner === DAMM_POOL_AUTHORITY) return { kind: 'pool' }
  const program = ownerPrograms.get(owner)
  if (program && LOCK_PROGRAMS[program]) return { kind: 'lock', label: LOCK_PROGRAMS[program] }
  return { kind: 'holder' }
}

// Top holders' share of supply from the largest token accounts. Curve and pool vaults and lock escrows are reported
// separately and never counted as holders; several token accounts of one owner count as one holder.
export function holderConcentration({ supply, accounts = [], curveVault = null, ownerPrograms = new Map(), labels = new Map(), top = TOP_HOLDERS }) {
  const total = big(supply)
  if (total === null || total <= 0n) return null
  let curve = 0n, pool = 0n, locked = 0n
  const holders = new Map()
  for (const account of accounts) {
    const amount = big(account.amount)
    if (!amount || amount <= 0n) continue
    const { kind } = classifyAccount(account, { curveVault, ownerPrograms })
    if (kind === 'curve') curve += amount
    else if (kind === 'pool') pool += amount
    else if (kind === 'lock') locked += amount
    else holders.set(account.owner, (holders.get(account.owner) ?? 0n) + amount)
  }
  const ranked = [...holders].map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : a.owner.localeCompare(b.owner))).slice(0, top)
  const topAmount = ranked.reduce((sum, holder) => sum + holder.amount, 0n)
  return {
    supplyBaseUnits: total.toString(),
    topCount: ranked.length,
    topPercent: sharePercent(topAmount, total),
    largestPercent: ranked.length ? sharePercent(ranked[0].amount, total) : null,
    curvePercent: curve ? sharePercent(curve, total) : 0,
    poolPercent: pool ? sharePercent(pool, total) : 0,
    lockedPercent: locked ? sharePercent(locked, total) : 0,
    top: ranked.map(holder => ({ owner: holder.owner, amountBaseUnits: holder.amount.toString(),
      percent: sharePercent(holder.amount, total), label: labels.get(holder.owner)?.label ?? null })),
  }
}

// Mint facts row: fixed supply and revoked authorities, straight from the mint account.
export function mintFacts(mint) {
  if (!mint) return null
  const supply = big(mint.supplyBaseUnits)
  return { fixedSupply: supply === FIXED_SUPPLY_BASE_UNITS && mint.decimals === TOKEN_DECIMALS,
    supplyBaseUnits: supply?.toString() ?? null, burnedBaseUnits: supply !== null && supply < FIXED_SUPPLY_BASE_UNITS ? (FIXED_SUPPLY_BASE_UNITS - supply).toString() : '0',
    mintAuthorityRevoked: Boolean(mint.mintAuthorityRevoked), freezeAuthorityRevoked: Boolean(mint.freezeAuthorityRevoked) }
}

// Graduation status from the public market row stats (marketRowStats: graduated, bondingPercent).
export function graduationLabel(market = {}) {
  if (market.graduated) return 'Graduated to the DAMM pool'
  return Number.isFinite(market.bondingPercent) ? `Bonding curve · ${Math.floor(market.bondingPercent)}% to graduation` : 'On the bonding curve'
}

// Per-launcher sums over the launcher's attributed swaps in one market (DBC curve trades by pool, post-graduation DAMM
// trades by repository; same sources as Backers). launchBuyBaseUnits: tokens bought in the launch transaction itself.
export async function readLauncherTrades(db, mint) {
  const { rows } = await db.query(`with m as (
      select pool, github_repo_id, launcher_wallet, launch_signature from markets where mint = $1 limit 1),
    ev as (
      select t.signature, t.direction,
        (case when t.direction = 'buy' then t.output_base_units else t.input_base_units end)::numeric as tokens
      from trade_events t join m on t.pool = m.pool and t.trader = m.launcher_wallet
      union all
      select d.signature, d.direction, d.base_amount::numeric
      from damm_trade_events d join m on d.github_repo_id = m.github_repo_id and d.trader = m.launcher_wallet
      where d.base_amount is not null)
    select (select launcher_wallet from m) as wallet,
      coalesce(sum(tokens) filter (where direction = 'buy'), 0)::text as "boughtBaseUnits",
      coalesce(sum(tokens) filter (where direction = 'sell'), 0)::text as "soldBaseUnits",
      coalesce(sum(tokens) filter (where direction = 'buy' and signature = (select launch_signature from m)), 0)::text as "launchBuyBaseUnits",
      count(*)::int as trades
    from ev`, [mint])
  return rows[0]?.wallet ? rows[0] : null
}
