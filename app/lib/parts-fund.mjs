import { PARTS_TOKENS, daysLeft, fundPercent, itemFill, linkDomain } from '../../src/parts-fund.mjs'
import { tipTokenPrices, tipUsdValue } from '../../src/tip-tokens.mjs'
import { database } from './server.mjs'
import { tipSigner, tipWalletAddress } from './tips.mjs'
import { ttlMemo } from './ttl-memo.mjs'

// Parts funds ride on the tip wallet: enabled exactly when tips are (TIP_WALLET_SECRET_KEY + database).
export const partsEnabled = () => Boolean(database() && tipSigner())
const REPO_ID = /^[1-9]\d{0,18}$/
const tokenMeta = mint => PARTS_TOKENS.find(t => t.mint === mint)

const FUND_COLUMNS = `id, github_repo_id::text as "repoId", revision, title, description, goal_cents::int as "goalCents", deadline, status,
  close_reason as "closeReason", payout_wallet as "payoutWallet", created_at as "createdAt", closed_at as "closedAt", settled_at as "settledAt"`

// Public view of a repository's current parts list (the unsettled one, else the most recent), or null.
export async function repoPartsFund(repoId, db = database(), now = Date.now()) {
  if (!db || !REPO_ID.test(String(repoId))) return null
  const { rows: [fund] } = await db.query(`select ${FUND_COLUMNS} from parts_funds where github_repo_id=$1
    order by (settled_at is null) desc, created_at desc limit 1`, [String(repoId)])
  return fund ? fundView(fund, db, now) : null
}

export async function partsFundById(id, db = database(), now = Date.now()) {
  if (!db || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const { rows: [fund] } = await db.query(`select ${FUND_COLUMNS} from parts_funds where id=$1`, [id])
  return fund ? fundView(fund, db, now) : null
}

// Server-only: the largest backers' wallets, used to look up linked X @handles (the API strips this field).
function topBackers(pledges, limit = 20) {
  const totals = new Map()
  for (const p of pledges) totals.set(p.donorWallet, (totals.get(p.donorWallet) ?? 0) + p.usdCents)
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([wallet]) => wallet)
}

async function fundView(fund, db, now) {
  const [{ rows: items }, { rows: pledges }, { rows: updates }, prices] = await Promise.all([
    db.query(`select id, position, name, url, unit_price_cents::int as "unitPriceCents", quantity from parts_fund_items where fund_id=$1 order by position`, [fund.id]),
    db.query(`select item_id as "itemId", usd_cents::int as "usdCents", donor_wallet as "donorWallet", mint, decimals, symbol,
      received_amount::text as amount, status from parts_pledges where fund_id=$1 and status in ('confirmed','paid','refunded')`, [fund.id]),
    db.query(`select id, body, images, created_at as "createdAt" from parts_updates where fund_id=$1 order by created_at desc limit 20`, [fund.id]),
    tipTokenPrices(),
  ])
  // Confirmed pledges, kept in the totals after they are paid out or refunded so a closed list shows what it raised.
  const counted = pledges
  const pledgedCents = counted.reduce((sum, p) => sum + p.usdCents, 0)
  // Holdings: what the tip wallet still holds for this list (confirmed, not yet paid out or refunded).
  const byToken = new Map()
  for (const p of counted.filter(p => p.status === 'confirmed')) {
    const row = byToken.get(p.mint) ?? { mint: p.mint, symbol: p.symbol, decimals: p.decimals, amount: 0n }
    row.amount += BigInt(p.amount)
    byToken.set(p.mint, row)
  }
  const holdings = [...byToken.values()].map(row => ({ ...row, amount: row.amount.toString(), name: tokenMeta(row.mint)?.name ?? row.symbol,
    usdToday: tipUsdValue(row, row.amount, prices[row.mint]) }))
  const fill = new Map(itemFill(items, counted).map(f => [f.id, f]))
  return {
    ...fund, deadline: new Date(fund.deadline).toISOString(), createdAt: new Date(fund.createdAt).toISOString(),
    closedAt: fund.closedAt ? new Date(fund.closedAt).toISOString() : null, settledAt: fund.settledAt ? new Date(fund.settledAt).toISOString() : null,
    items: items.map(item => ({ ...item, domain: item.url ? linkDomain(item.url) : null, ...fill.get(item.id) })),
    pledgedCents, percent: fundPercent(pledgedCents, fund.goalCents), goalMet: pledgedCents >= fund.goalCents,
    backers: new Set(counted.map(p => p.donorWallet)).size, backerWallets: topBackers(counted), daysLeft: daysLeft(fund.deadline, now),
    holdings, usdToday: holdings.every(h => h.usdToday === null) ? null : holdings.reduce((sum, h) => sum + (h.usdToday ?? 0), 0),
    updates: updates.map(u => ({ id: u.id, body: u.body, images: Array.isArray(u.images) ? u.images.length : 0, createdAt: new Date(u.createdAt).toISOString() })),
  }
}

// /stats: every parts list's outcome, and the latest pledge, payout and refund receipts.
export async function partsStats(db = database()) {
  const wallet = tipWalletAddress()
  if (!db || !wallet) return null
  const [{ rows: [totals] }, { rows: recent }] = await Promise.all([
    db.query(`select count(*) filter (where f.status='open')::int as "activeLists",
        count(*) filter (where f.status='funded')::int as "fundedLists",
        count(*) filter (where f.status in ('failed','cancelled'))::int as "refundedLists",
        coalesce(sum(p.cents) filter (where f.status='open'),0)::bigint::text as "activeCents",
        coalesce(sum(p.cents) filter (where f.status='funded'),0)::bigint::text as "fundedCents",
        coalesce(sum(p.cents) filter (where f.status in ('failed','cancelled')),0)::bigint::text as "refundedCents"
      from parts_funds f left join lateral (select sum(usd_cents) as cents from parts_pledges where fund_id=f.id and status in ('confirmed','paid','refunded')) p on true`),
    db.query(`(select 'pledge' as kind, p.signature, p.received_amount::text as amount, p.mint, p.symbol, p.decimals, p.confirmed_at as at, r.full_name as "fullName", m.mint as "marketMint"
        from parts_pledges p join repositories r on r.github_repo_id=p.github_repo_id left join markets m on m.github_repo_id=p.github_repo_id
        where p.tip_wallet=$1 and p.status in ('confirmed','paid','refunded') order by p.confirmed_at desc limit 12)
      union all
      (select x.kind, x.signature, x.amount::text, x.mint, null, x.decimals, x.settled_at, r.full_name, m.mint
        from parts_transfers x join repositories r on r.github_repo_id=x.github_repo_id left join markets m on m.github_repo_id=x.github_repo_id
        where x.source_wallet=$1 and x.status='settled' order by x.settled_at desc limit 12)
      order by at desc limit 12`, [wallet]),
  ])
  return { ...totals, recent: recent.map(row => ({ ...row, symbol: row.symbol ?? tokenMeta(row.mint)?.symbol ?? '' })) }
}

// Operator health: open lists, lists overdue for a decision or waiting on transfers, and in-flight parts transfers.
export async function partsHealth(db = database()) {
  const { rows: [row] } = await db.query(`select
      (select count(*)::int from parts_funds where status='open') as "openLists",
      (select count(*)::int from parts_funds where status='open' and deadline < now() - interval '15 minutes') as "overdueLists",
      (select count(*)::int from parts_funds where status <> 'open' and settled_at is null) as "closingLists",
      (select count(*)::int from parts_funds where status <> 'open' and settled_at is null and closed_at < now() - interval '1 hour') as "stuckLists",
      (select count(*)::int from parts_transfers where status='pending') as "pendingTransfers",
      (select count(*)::int from parts_pledges where status in ('prepared','submitted')) as "openPledges",
      (select coalesce(sum(usd_cents),0)::bigint::text from parts_pledges where status='confirmed') as "heldCents"`)
  return row
}

// ---------- /parts: every market's parts lists, browsed like an issue list (Open · Funded · Closed) ----------
export const PARTS_TABS = Object.freeze(['open', 'funded', 'closed'])
const BROWSE_LIMIT = 300
const BROWSE_TTL_MS = 30_000
const DAY = 24 * 60 * 60_000

// ?state=… → a tab; anything else (missing, repeated, unknown) is the default "open".
export const partsTabParam = value => PARTS_TABS.includes(value) ? value : 'open'
// failed (missed its goal) and cancelled lists share the Closed tab.
export const partsTab = status => status === 'open' || status === 'funded' ? status : 'closed'

// "today", "yesterday", "3 days ago", then a calendar date once it is a month old (GitHub-style).
export function relativeDay(value, now = Date.now()) {
  const at = new Date(value).getTime()
  if (!Number.isFinite(at)) return ''
  const days = Math.floor((now - at) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return `on ${new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
}

// One row of the /parts query → the public row (wallets stay server-side under backerWallets / maintainerWallet).
export function partsBrowseRow(row, now = Date.now()) {
  const pledgedCents = Number(row.pledgedCents ?? 0), goalCents = Number(row.goalCents)
  return {
    id: row.id, repoId: row.repoId, fullName: row.fullName, mint: row.mint, symbol: row.symbol, title: row.title,
    status: row.status, tab: partsTab(row.status), goalCents, pledgedCents, percent: fundPercent(pledgedCents, goalCents),
    daysLeft: row.status === 'open' ? daysLeft(row.deadline, now) : null,
    parts: Number(row.parts ?? 0), backers: Number(row.backers ?? 0), openedBy: row.openedBy ?? null,
    createdAt: new Date(row.createdAt).toISOString(), closedAt: row.closedAt ? new Date(row.closedAt).toISOString() : null,
    settledAt: row.settledAt ? new Date(row.settledAt).toISOString() : null,
    maintainerWallet: row.maintainerWallet ?? null, backerWallets: Array.isArray(row.backerWallets) ? row.backerWallets : [],
  }
}

// Newest first within a tab: open lists by when they opened, funded/closed ones by when they closed.
const sortKey = row => new Date(row.tab === 'open' ? row.createdAt : row.closedAt ?? row.createdAt).getTime()

// Rows → { state, counts per tab, lists in the selected tab }.
export function partsBrowseView(rows, state = 'open', now = Date.now()) {
  const tab = partsTabParam(state)
  const all = rows.map(row => partsBrowseRow(row, now))
  const counts = Object.fromEntries(PARTS_TABS.map(name => [name, all.filter(row => row.tab === name).length]))
  const lists = all.filter(row => row.tab === tab).sort((a, b) => sortKey(b) - sortKey(a))
  return { state: tab, counts, lists }
}

// One read for every list: repository, token, verified opener, parts count, and pledge totals (no per-list queries).
// Only lists whose market is live (the same markets that accept tips and pledges) are listed.
export const PARTS_BROWSE_SQL = `select f.id, f.github_repo_id::text as "repoId", f.title, f.status, f.goal_cents::int as "goalCents", f.deadline,
    f.created_at as "createdAt", f.closed_at as "closedAt", f.settled_at as "settledAt",
    r.full_name as "fullName", m.mint, m.token_symbol as symbol, v.github_login as "openedBy", b.wallet as "maintainerWallet",
    coalesce(i.parts, 0)::int as parts, coalesce(p.cents, 0)::bigint::text as "pledgedCents", coalesce(p.backers, 0)::int as backers,
    coalesce(p.wallets, '{}') as "backerWallets"
  from parts_funds f
  join repositories r on r.github_repo_id = f.github_repo_id
  join markets m on m.github_repo_id = f.github_repo_id and m.status = 'confirmed' and m.indexed_at is not null and m.launch_finality = 'finalized'
  left join repo_beneficiaries b on b.github_repo_id = f.github_repo_id
  left join lateral (select github_login from repo_verifications where github_repo_id = f.github_repo_id
    and f.created_by = 'github:' || github_user_id::text order by verified_at desc limit 1) v on true
  left join lateral (select count(*) as parts from parts_fund_items where fund_id = f.id) i on true
  left join lateral (select sum(d.cents) as cents, count(*) as backers, (array_agg(d.donor_wallet order by d.cents desc, d.donor_wallet))[1:5] as wallets
    from (select donor_wallet, sum(usd_cents) as cents from parts_pledges where fund_id = f.id and status in ('confirmed','paid','refunded')
      group by donor_wallet) d) p on true
  order by f.created_at desc limit ${BROWSE_LIMIT}`

export async function loadPartsLists(db = database()) {
  if (!db) return { rows: [], unavailable: 'Parts lists are temporarily unavailable.' }
  try {
    return { rows: (await db.query(PARTS_BROWSE_SQL)).rows }
  } catch (error) {
    // Before migration 0033 runs there are simply no lists yet.
    if (error?.code === '42P01') return { rows: [] }
    console.error('parts lists unavailable', { error: error.message })
    return { rows: [], unavailable: 'Parts lists are temporarily unavailable.' }
  }
}

// /parts renders per request; share one read per 30 s (like /explore's market list).
export const partsLists = ttlMemo(() => loadPartsLists(), BROWSE_TTL_MS, { keep: result => !result.unavailable })
