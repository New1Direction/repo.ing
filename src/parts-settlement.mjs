import { randomUUID } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { PARTS_LEDGER, assertTipWalletCovers, recordTipReview, settleTransfer, signTipWalletTransfer, withTipWalletLock, MAX_TIPS_PER_TRANSFER } from './tip-transfers.mjs'
import { createPledgeExpiry } from './parts-pledges.mjs'
import { PARTS_DISABLED } from './parts-fund.mjs'

// All-or-nothing settlement. At the deadline a list is decided from confirmed pledges only (USD at pledge time):
// goal met → 'funded' (pinned to the payout wallet bound then); otherwise → 'failed'. A maintainer can also cancel
// ('cancelled') or, once the goal is met, close & collect early ('funded'). Closed lists then pay every confirmed
// pledge to the pinned payout wallet (one transfer per token) or refund each backer (one transfer per backer and
// token). Every transfer is persisted with its signed bytes and its reserved pledges BEFORE broadcast, under the tip
// wallet lock, after the combined tips + pledges coverage guard; recovery (createTipTransferRecovery, PARTS_LEDGER)
// settles or aborts it. A list is settled once nothing is in flight, confirmed or reserved.

export const PARTS_RETRY_MS = 5 * 60_000
export const partsTransferMemo = (kind, id) => `repoing-parts-${kind}:${id}`
const PLEDGE_ROW = `id, donor_wallet as "donorWallet", mint, token_program as "tokenProgram", decimals, received_amount::text as "receivedAmount"`

// Keyless: closes open lists whose deadline passed once none of their pledges is still in flight.
export async function decideDueFunds({ pool, fundId = null, now = Date.now }) {
  const { rows } = await pool.query(`select f.id from parts_funds f where f.status='open' and f.deadline <= $1 and ($2::uuid is null or f.id=$2)
    and not exists (select 1 from parts_pledges p where p.fund_id=f.id and p.status in ('prepared','submitted')) order by f.deadline limit 50`,
  [new Date(now()), fundId])
  const results = []
  for (const { id } of rows) {
    const db = await pool.connect()
    try {
      await db.query('begin')
      try {
        const { rows: [fund] } = await db.query(`select id, github_repo_id::text as "githubRepoId", goal_cents::int as "goalCents", status, deadline
          from parts_funds where id=$1 for update`, [id])
        // Re-checked under the row lock: a pledge prepare holds the same lock while it inserts.
        const { rows: [live] } = await db.query(`select coalesce(sum(usd_cents) filter (where status='confirmed'),0)::bigint::text as pledged,
          count(*) filter (where status in ('prepared','submitted'))::int as "inFlight" from parts_pledges where fund_id=$1`, [id])
        if (fund.status !== 'open' || new Date(fund.deadline).getTime() > now() || live.inFlight) { await db.query('rollback'); continue }
        let outcome
        if (Number(live.pledged) >= fund.goalCents) {
          const { rows: [beneficiary] } = await db.query('select wallet from repo_beneficiaries where github_repo_id=$1', [fund.githubRepoId])
          if (!beneficiary) {
            await db.query('rollback')
            await recordTipReview(pool, 'PARTS_FUND_REVIEW', id, { id, reason: 'Goal met but the repository has no payout wallet' }, now)
            results.push({ id, status: 'review' })
            continue
          }
          await db.query(`update parts_funds set status='funded', close_reason='deadline_met', payout_wallet=$2, closed_at=$3, updated_at=$3 where id=$1`,
            [id, beneficiary.wallet, new Date(now())])
          outcome = 'funded'
        } else {
          await db.query(`update parts_funds set status='failed', close_reason='deadline_missed', closed_at=$2, updated_at=$2 where id=$1`, [id, new Date(now())])
          outcome = 'failed'
        }
        await db.query('commit')
        results.push({ id, status: outcome })
      } catch (error) { await db.query('rollback').catch(() => null); throw error }
    } finally { db.release() }
  }
  return results
}

// One transfer of a group of confirmed pledges of one closed list: its payout (to the pinned payout wallet) or one
// backer's refund. Caller holds the tip wallet lock on `db`.
async function sendPledgeGroup(db, { connection, signer, fund, kind, group, recipient, requestedBy, now, fetcher, log }) {
  const amount = group.pledges.reduce((sum, p) => sum + BigInt(p.receivedAmount), 0n)
  if (amount <= 0n) throw Error('No confirmed pledges to send')
  const wallet = signer.publicKey
  if (kind === 'refund' && group.pledges.some(p => p.donorWallet !== recipient.toBase58())) throw Error('Refunds go only to the wallet that pledged')
  if (kind === 'payout' && recipient.toBase58() !== fund.payoutWallet) throw Error('Payout recipient differs from the pinned payout wallet')
  // Guard 1: never more than this list's confirmed, unreserved pledges for this mint (and this backer, for refunds).
  const { rows: [open] } = await db.query(`select coalesce(sum(received_amount),0)::text as amount from parts_pledges
    where fund_id=$1 and mint=$2 and tip_wallet=$3 and status='confirmed' and transfer_id is null and ($4::text is null or donor_wallet=$4)`,
  [fund.id, group.mint, wallet.toBase58(), kind === 'refund' ? recipient.toBase58() : null])
  if (amount > BigInt(open.amount)) throw Error('Parts transfer exceeds confirmed unpaid pledges')
  // Guard 2: every confirmed tip and pledge of this mint stays covered, with SOL left for costs.
  await assertTipWalletCovers(db, connection, wallet, group, now)
  const id = randomUUID()
  const { latest, raw, signature } = await signTipWalletTransfer(connection, signer, { kind, id, recipient, group, amount,
    memo: partsTransferMemo(kind, id), fetcher, log })
  const signedTransaction = raw.toString('base64')
  await db.query('begin')
  try {
    await db.query(`insert into parts_transfers(id, kind, fund_id, github_repo_id, mint, token_program, decimals, source_wallet, recipient, amount,
        pledge_count, requested_by, status, signature, signed_transaction, last_valid_block_height)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',$13,$14,$15)`, [id, kind, fund.id, fund.githubRepoId, group.mint, group.tokenProgram,
      group.decimals, wallet.toBase58(), recipient.toBase58(), amount.toString(), group.pledges.length, requestedBy, signature, signedTransaction,
      String(latest.lastValidBlockHeight)])
    const { rowCount } = await db.query(`update parts_pledges set transfer_id=$1 where id = any($2::uuid[]) and fund_id=$3 and mint=$4
      and tip_wallet=$5 and status='confirmed' and transfer_id is null`, [id, group.pledges.map(p => p.id), fund.id, group.mint, wallet.toBase58()])
    if (rowCount !== group.pledges.length) throw Error('Pledges changed while preparing the transfer; try again')
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  // One send; recovery rebroadcasts the same bytes until they land or provably expire, then settles or aborts.
  await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }).catch(() => null)
  const transfer = { id, kind, mint: group.mint, tokenProgram: group.tokenProgram, sourceWallet: wallet.toBase58(), recipient: recipient.toBase58(),
    amount: amount.toString(), tipCount: group.pledges.length, signature, signedTransaction }
  const settled = await settleTransfer(db, connection, transfer, PARTS_LEDGER).catch(() => null)
  return settled ?? { id, kind, status: 'pending', signature, amount: amount.toString(), mint: group.mint, recipient: recipient.toBase58() }
}

export function pledgeGroups(fund, pledges) {
  const groups = new Map()
  for (const p of pledges) {
    const key = fund.status === 'funded' ? p.mint : `${p.donorWallet}:${p.mint}`
    const group = groups.get(key) ?? { mint: p.mint, tokenProgram: p.tokenProgram, decimals: p.decimals, donor: p.donorWallet, pledges: [] }
    if (group.tokenProgram !== p.tokenProgram || group.decimals !== p.decimals) throw Error('Pledge ledger token program mismatch')
    group.pledges.push(p)
    groups.set(key, group)
  }
  return [...groups.values()].map(g => ({ ...g, pledges: g.pledges.slice(0, MAX_TIPS_PER_TRANSFER) }))
}

// Sends payouts/refunds for closed, unsettled lists (or one list). Bounded per call; a failing list backs off.
export async function sendFundTransfers({ pool, connection, signer, fundId = null, maxTransfers = 10, requestedBy = 'worker', now = Date.now, fetcher, log }) {
  if (!signer) throw Error(PARTS_DISABLED)
  return withTipWalletLock(pool, async db => {
    const { rows: funds } = await db.query(`select id, github_repo_id::text as "githubRepoId", status, payout_wallet as "payoutWallet" from parts_funds
      where status in ('funded','failed','cancelled') and settled_at is null and ($1::uuid is null or id=$1)
      and ($1::uuid is not null or next_attempt_at is null or next_attempt_at <= $2) order by closed_at limit 20`, [fundId, new Date(now())])
    const results = []
    for (const fund of funds) {
      const { rows: pledges } = await db.query(`select ${PLEDGE_ROW} from parts_pledges where fund_id=$1 and tip_wallet=$2 and status='confirmed'
        and transfer_id is null order by confirmed_at, id`, [fund.id, signer.publicKey.toBase58()])
      let failed = false
      for (const group of pledgeGroups(fund, pledges)) {
        if (results.filter(r => r.status !== 'failed').length >= maxTransfers) return results
        const kind = fund.status === 'funded' ? 'payout' : 'refund'
        try {
          const recipient = new PublicKey(kind === 'payout' ? fund.payoutWallet : group.donor)
          results.push({ fundId: fund.id, ...await sendPledgeGroup(db, { connection, signer, fund, kind, group, recipient, requestedBy, now, fetcher, log }) })
        } catch (error) {
          failed = true
          console.error('parts transfer not sent', { fund: fund.id, mint: group.mint, error: error.message })
          await recordTipReview(pool, 'PARTS_TRANSFER_FAILED', `${fund.id}:${group.mint}`, { fund: fund.id, kind, mint: group.mint, error: error.message }, now)
          results.push({ fundId: fund.id, mint: group.mint, kind, status: 'failed', error: error.message })
        }
      }
      if (failed) await db.query('update parts_funds set next_attempt_at=$2 where id=$1', [fund.id, new Date(now() + PARTS_RETRY_MS)])
    }
    return results
  })
}

// Keyless: a closed list is settled once no pledge is in flight, confirmed-unsent or reserved by a pending transfer.
export async function finalizeFunds({ pool, now = Date.now }) {
  const { rows } = await pool.query(`update parts_funds f set settled_at=$1, next_attempt_at=null where f.status in ('funded','failed','cancelled')
    and f.settled_at is null and not exists (select 1 from parts_pledges p where p.fund_id=f.id and p.status in ('prepared','submitted','confirmed'))
    and not exists (select 1 from parts_transfers t where t.fund_id=f.id and t.status='pending') returning f.id, f.status`, [new Date(now())])
  return rows
}

// Worker: expire abandoned pledges, decide due lists, send (only with the tip wallet key), then mark settled lists.
export function createPartsFundJobs({ pool, connection, signer = null, now = Date.now, maxTransfers = 10, fetcher, log }) {
  const expiry = createPledgeExpiry({ pool, connection })
  return { async runOnce() {
    const result = { pledges: await expiry.runOnce(), decided: await decideDueFunds({ pool, now }) }
    if (signer) result.transfers = await sendFundTransfers({ pool, connection, signer, maxTransfers, now, fetcher, log })
    result.settled = await finalizeFunds({ pool, now })
    return result
  } }
}
