import { randomUUID } from 'node:crypto'
import { repoAcceptsTips } from './tips.mjs'
import { fundDeadline, validUuid, validateFundInput, validateUpdateInput } from './parts-fund.mjs'

// Maintainer actions on a parts fund. Same authority as builder claims and tip claims: a fresh (≤60s) GitHub admin
// check of the caller's session for this repository, and a bound payout wallet. `verifyAuthority` does the GitHub
// call (app/lib/github-session.mjs in production; a stub in tests).

export const PARTS_UPDATES_PER_DAY = 10
export const PARTS_MAX_UPDATES = 100
const REPO_ID = /^[1-9]\d{0,18}$/

export async function assertMaintainer({ githubRepoId, verifyAuthority, now = Date.now }) {
  const repoId = String(githubRepoId ?? '')
  if (!REPO_ID.test(repoId)) throw Error('Invalid repository')
  const github = await verifyAuthority({ githubRepoId: BigInt(repoId) })
  const checkedAt = new Date(github?.verifiedAt).getTime()
  if (github?.verified !== true || github.permission !== 'admin' || String(github.githubRepoId) !== repoId ||
    !Number.isFinite(checkedAt) || now() - checkedAt > 60_000) throw Error('Current GitHub admin authority required')
  return { repoId, actor: `github:${github.githubUserId ?? 'admin'}` }
}

async function inTransaction(pool, fn) {
  const db = await pool.connect()
  try {
    await db.query('begin')
    try { const result = await fn(db); await db.query('commit'); return result }
    catch (error) { await db.query('rollback').catch(() => null); throw error }
  } finally { db.release() }
}

async function lockFund(db, fundId, repoId) {
  if (!validUuid(fundId)) throw Error('Parts list not found')
  const { rows: [fund] } = await db.query(`select id, github_repo_id::text as "githubRepoId", status, revision, goal_cents::int as "goalCents",
    settled_at as "settledAt" from parts_funds where id=$1 for update`, [fundId])
  if (!fund || fund.githubRepoId !== repoId) throw Error('Parts list not found')
  return fund
}

const insertItems = (db, fundId, items) => Promise.all(items.map(item => db.query(`insert into parts_fund_items(id, fund_id, position, name, url,
  unit_price_cents, quantity) values($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), fundId, item.position, item.name, item.url, item.unitPriceCents, item.quantity])))

export async function createFund({ pool, githubRepoId, input, verifyAuthority, now = Date.now }) {
  const fund = validateFundInput(input)
  const { repoId, actor } = await assertMaintainer({ githubRepoId, verifyAuthority, now })
  const { rowCount } = await pool.query('select 1 from repo_beneficiaries where github_repo_id=$1', [repoId])
  if (!rowCount) throw Error('Set a payout wallet before starting a parts fund')
  if (!await repoAcceptsTips(pool, repoId)) throw Error('This repository has no market on repo.ing yet')
  const id = randomUUID(), at = new Date(now())
  try {
    await inTransaction(pool, async db => {
      await db.query(`insert into parts_funds(id, github_repo_id, title, description, goal_cents, deadline, status, created_by, created_at, updated_at)
        values($1,$2,$3,$4,$5,$6,'open',$7,$8,$8)`, [id, repoId, fund.title, fund.description, fund.goalCents, fundDeadline(fund.durationDays, now()), actor, at])
      await insertItems(db, id, fund.items)
    })
  } catch (error) {
    if (error?.code === '23505') throw Error('This repository already has an active parts list')
    throw error
  }
  return { id, goalCents: fund.goalCents }
}

// Only before the first pledge: any prepared, submitted or confirmed pledge (or a paid/refunded one) locks the list.
export async function editFund({ pool, fundId, githubRepoId, input, verifyAuthority, now = Date.now }) {
  const fund = validateFundInput(input)
  const { repoId } = await assertMaintainer({ githubRepoId, verifyAuthority, now })
  return inTransaction(pool, async db => {
    const current = await lockFund(db, fundId, repoId)
    if (current.status !== 'open') throw Error('This parts list is closed')
    const { rowCount } = await db.query(`select 1 from parts_pledges where fund_id=$1 and status in ('prepared','submitted','confirmed','paid','refunded') limit 1`, [fundId])
    if (rowCount) throw Error('Parts lists cannot be edited after the first pledge')
    await db.query('delete from parts_fund_items where fund_id=$1', [fundId])
    await insertItems(db, fundId, fund.items)
    const { rows: [row] } = await db.query(`update parts_funds set title=$2, description=$3, goal_cents=$4, deadline=$5, revision=revision+1, updated_at=$6
      where id=$1 returning revision`, [fundId, fund.title, fund.description, fund.goalCents, fundDeadline(fund.durationDays, now()), new Date(now())])
    return { id: fundId, revision: row.revision, goalCents: fund.goalCents }
  })
}

// Cancel → every confirmed pledge is refunded (in-flight ones too, once they land). Refunds are sent by the caller.
export async function cancelFund({ pool, fundId, githubRepoId, verifyAuthority, now = Date.now }) {
  const { repoId } = await assertMaintainer({ githubRepoId, verifyAuthority, now })
  return inTransaction(pool, async db => {
    const fund = await lockFund(db, fundId, repoId)
    if (fund.status !== 'open') throw Error('This parts list is closed')
    await db.query(`update parts_funds set status='cancelled', close_reason='cancelled', closed_at=$2, updated_at=$2 where id=$1`, [fundId, new Date(now())])
    return { id: fundId, status: 'cancelled' }
  })
}

// Close & collect: only once confirmed pledges (USD at pledge time) meet the goal, and only to the payout wallet the
// maintainer reviewed (pinned wallet + bound_at, like tip claims). Payouts are sent by the caller.
export async function collectFund({ pool, fundId, githubRepoId, review, verifyAuthority, now = Date.now }) {
  const { repoId } = await assertMaintainer({ githubRepoId, verifyAuthority, now })
  if (review?.repoId !== repoId || review?.fundId !== fundId) throw Error('Collect review expired. Refresh and review again.')
  return inTransaction(pool, async db => {
    const fund = await lockFund(db, fundId, repoId)
    if (fund.status === 'funded' && !fund.settledAt) return { id: fundId, status: 'funded', resumed: true }
    if (fund.status !== 'open') throw Error('This parts list is closed')
    const { rows: [pledged] } = await db.query(`select coalesce(sum(usd_cents),0)::bigint::text as cents from parts_pledges where fund_id=$1 and status='confirmed'`, [fundId])
    if (Number(pledged.cents) < fund.goalCents) throw Error('Close & collect opens once confirmed pledges reach the goal')
    const { rows: [beneficiary] } = await db.query('select wallet, bound_at as "boundAt" from repo_beneficiaries where github_repo_id=$1', [repoId])
    if (!beneficiary) throw Error('Set a payout wallet before collecting')
    if (beneficiary.wallet !== review.wallet || new Date(beneficiary.boundAt).toISOString() !== review.boundAt) throw Error('Payout wallet changed; review again')
    await db.query(`update parts_funds set status='funded', close_reason='collected', payout_wallet=$2, closed_at=$3, updated_at=$3 where id=$1`,
      [fundId, beneficiary.wallet, new Date(now())])
    return { id: fundId, status: 'funded' }
  })
}

// Build updates: plain text (rendered as text, never HTML) plus up to 4 GitHub/Imgur image links, after funding.
export async function postUpdate({ pool, fundId, githubRepoId, input, verifyAuthority, now = Date.now }) {
  const update = validateUpdateInput(input)
  const { repoId, actor } = await assertMaintainer({ githubRepoId, verifyAuthority, now })
  return inTransaction(pool, async db => {
    const fund = await lockFund(db, fundId, repoId)
    if (fund.status !== 'funded') throw Error('Build updates open once the parts list is funded')
    const { rows: [count] } = await db.query(`select count(*)::int as total, count(*) filter (where created_at > $2::timestamptz - interval '1 day')::int as today
      from parts_updates where fund_id=$1`, [fundId, new Date(now())])
    if (count.total >= PARTS_MAX_UPDATES || count.today >= PARTS_UPDATES_PER_DAY) throw Error('Update limit reached. Try again tomorrow.')
    const id = randomUUID()
    await db.query(`insert into parts_updates(id, fund_id, github_repo_id, body, images, created_by, created_at) values($1,$2,$3,$4,$5,$6,$7)`,
      [id, fundId, repoId, update.body, JSON.stringify(update.images), actor, new Date(now())])
    return { id }
  })
}
