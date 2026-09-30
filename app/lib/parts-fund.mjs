import { PARTS_TOKENS, daysLeft, fundPercent, itemFill, linkDomain } from '../../src/parts-fund.mjs'
import { tipTokenPrices, tipUsdValue } from '../../src/tip-tokens.mjs'
import { database } from './server.mjs'
import { tipSigner, tipWalletAddress } from './tips.mjs'

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
