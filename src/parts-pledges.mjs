import { randomUUID } from 'node:crypto'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'
import { broadcastUntilSettled, withPriorityFee } from './trade-landing.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'
import { checkTipMint, isNativeTip, parseTipAmount } from './tip-tokens.mjs'
import { acceptSignedTip, repoAcceptsTips, tipDestination, tipInstructions, verifyTipReceipt } from './tips.mjs'
import { PARTS_DISABLED, PARTS_MAX_OPEN_PLEDGES, PARTS_PLEDGE_CUTOFF_MS, assertPledgeAmount, assertPledgeRoom, partsToken, pledgeMemo, validUuid } from './parts-fund.mjs'

// Pledges to a parts fund: the same prepare → wallet signs → submit → finalized-receipt path as tips (src/tips.mjs),
// into the same tip wallet, with the memo "repoing-parts:<pledgeId>" and its own ledger (parts_pledges). A pledge is
// a liability only once confirmed from the finalized receipt; its USD value is fixed at prepare time.

// Serializes the per-list and global cap checks with the insert (short transaction; no network inside).
export const PARTS_PLEDGE_LOCK = '7610611000000002'
const SUBMIT_WAIT_MS = 30_000
export const PLEDGE_COLUMNS = `id, fund_id as "fundId", github_repo_id::text as "githubRepoId", item_id as "itemId", donor_wallet as "donorWallet",
  tip_wallet as "tipWallet", mint, token_program as "tokenProgram", decimals, symbol, requested_amount::text as "requestedAmount",
  received_amount::text as "receivedAmount", usd_cents::int as "usdCents", status, message, transaction,
  last_valid_block_height::text as "lastValidBlockHeight", signature, signed_transaction as "signedTransaction", transfer_id as "transferId",
  created_at as "createdAt", confirmed_at as "confirmedAt"`

const friendlySimulation = (token, logs = []) => /insufficient (funds|lamports)/i.test(logs.join('\n'))
  ? `Your wallet does not hold enough ${token.symbol}${isNativeTip(token) ? '' : ' (and a little SOL for network fees)'}`
  : 'Pledge simulation failed. Check your balance and try again.'

// Checks the list can take this pledge right now. Run twice: before the network work, and inside the locked insert.
async function openFund(db, fundId, revision, now, lock = '') {
  const { rows: [fund] } = await db.query(`select id, github_repo_id::text as "githubRepoId", revision, status, goal_cents::int as "goalCents",
    deadline from parts_funds where id=$1${lock}`, [fundId])
  if (!fund) throw Error('Parts list not found')
  if (fund.status !== 'open') throw Error('This parts list is closed to new pledges')
  if (new Date(fund.deadline).getTime() - now() < PARTS_PLEDGE_CUTOFF_MS) throw Error('This parts list is closed to new pledges')
  // The backer reviewed a specific revision (items, goal, deadline); an edit in between must be reviewed again.
  if (Number(revision) !== fund.revision) throw Error('The parts list changed. Refresh and review it again.')
  return fund
}

export async function preparePledge({ pool, connection, tipWallet, prices, fundId, revision, itemId = null, wallet, mint, amountBaseUnits,
  now = Date.now, fetcher, log }) {
  if (!tipWallet) throw Error(PARTS_DISABLED)
  if (!validUuid(fundId)) throw Error('Parts list not found')
  if (itemId !== null && itemId !== undefined && itemId !== '' && !validUuid(itemId)) throw Error('Choose a part from this list')
  const earmark = itemId || null
  let donor
  try { donor = new PublicKey(wallet) } catch { throw Error('Connect a Solana wallet to pledge') }
  if (!PublicKey.isOnCurve(donor.toBytes())) throw Error('Connect a Solana wallet to pledge')
  if (donor.equals(tipWallet)) throw Error('The tip wallet cannot pledge')
  const token = partsToken(mint)
  const amount = parseTipAmount(amountBaseUnits)
  const price = prices?.[token.mint]
  const usdCents = assertPledgeAmount(token, amount, price)
  const fund = await openFund(pool, fundId, revision, now)
  if (earmark) {
    const { rowCount } = await pool.query('select 1 from parts_fund_items where id=$1 and fund_id=$2', [earmark, fundId])
    if (!rowCount) throw Error('Choose a part from this list')
  }
  if (!await repoAcceptsTips(pool, fund.githubRepoId)) throw Error('This repository has no market on repo.ing yet')
  await checkTipMint(connection, token)
  const id = randomUUID()
  const latest = await connection.getLatestBlockhash('confirmed')
  const destination = tipDestination(token, tipWallet)
  const base = new Transaction({ feePayer: donor, recentBlockhash: latest.blockhash })
    .add(...tipInstructions({ token, donor, tipWallet, amount, id, memo: pledgeMemo(id) }))
  const { transaction } = await withPriorityFee(connection, base, { feePayer: donor, blockhash: latest.blockhash, writableAccounts: [donor, destination], fetcher, log })
  const unsignedBytes = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(unsignedBytes), { sigVerify: false, commitment: 'confirmed' }).catch(() => null)
  if (!simulation) throw Error('Pledge simulation is unavailable. Try again shortly.')
  if (simulation.value.err) throw Error(friendlySimulation(token, simulation.value.logs ?? []))
  const message = Buffer.from(transaction.serializeMessage()).toString('base64')
  const unsigned = unsignedBytes.toString('base64')
  const db = await pool.connect()
  try {
    await db.query('begin')
    try {
      await db.query('select pg_advisory_xact_lock($1::bigint)', [PARTS_PLEDGE_LOCK])
      const locked = await openFund(db, fundId, revision, now, ' for update')
      const { rows: [held] } = await db.query(`select
          coalesce(sum(usd_cents) filter (where fund_id=$1),0)::bigint::text as list,
          coalesce(sum(usd_cents),0)::bigint::text as global,
          count(*) filter (where fund_id=$1 and donor_wallet=$2 and status in ('prepared','submitted'))::int as "openByWallet"
        from parts_pledges where status in ('prepared','submitted','confirmed')`, [fundId, donor.toBase58()])
      if (held.openByWallet >= PARTS_MAX_OPEN_PLEDGES) throw Error('Finish or wait out your pending pledge first')
      assertPledgeRoom({ goalCents: locked.goalCents, held: Number(held.list), cents: usdCents, globalHeld: Number(held.global) })
      await db.query(`insert into parts_pledges(id, fund_id, github_repo_id, item_id, donor_wallet, tip_wallet, mint, token_program, decimals, symbol,
          requested_amount, usd_cents, usd_price, status, message, transaction, last_valid_block_height, created_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'prepared',$14,$15,$16,$17)`,
      [id, fundId, locked.githubRepoId, earmark, donor.toBase58(), tipWallet.toBase58(), token.mint, token.program, token.decimals, token.symbol,
        amount.toString(), usdCents, price, message, unsigned, latest.lastValidBlockHeight, new Date(now())])
      await db.query('commit')
    } catch (error) { await db.query('rollback'); throw error }
  } finally { db.release() }
  return { id, transaction: unsigned, lastValidBlockHeight: latest.lastValidBlockHeight, amountBaseUnits: amount.toString(), usdCents,
    symbol: token.symbol, decimals: token.decimals, mint: token.mint, tipWallet: tipWallet.toBase58() }
}

export async function loadPledge(db, id) {
  if (!validUuid(id)) return null
  const { rows: [pledge] } = await db.query(`select ${PLEDGE_COLUMNS} from parts_pledges where id=$1`, [id])
  return pledge ?? null
}

async function markExpired(db, pledge, reason) {
  await db.query(`update parts_pledges set status='expired', resolved_at=now() where id=$1 and status in ('prepared','submitted')
    and (signature is null or signature=$2)`, [pledge.id, pledge.signature ?? null])
  return { state: 'expired', reason }
}

// One step of a pledge's state machine against the chain; safe to repeat from any replica or the worker. A pledge
// that lands after its list closed is still recorded: the settlement pays or refunds it with the rest.
export async function refreshPledge(db, connection, pledge) {
  if (!pledge) return { state: 'missing' }
  if (['confirmed', 'paid', 'refunded', 'failed'].includes(pledge.status)) return { state: pledge.status }
  if (!pledge.signature) {
    const height = BigInt(await connection.getBlockHeight('finalized'))
    return height > BigInt(pledge.lastValidBlockHeight) ? markExpired(db, pledge, 'Not submitted before the blockhash expired') : { state: pledge.status }
  }
  const tx = await connection.getTransaction(pledge.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (tx?.meta?.err) {
    await db.query(`update parts_pledges set status='failed', resolved_at=now() where id=$1 and signature=$2 and status in ('submitted','expired')`, [pledge.id, pledge.signature])
    return { state: 'failed' }
  }
  if (tx) {
    const { received } = verifyTipReceipt(tx, pledge, pledgeMemo(pledge.id))
    const { rowCount } = await db.query(`update parts_pledges set status='confirmed', received_amount=$3, confirmed_at=now(), resolved_at=null
      where id=$1 and signature=$2 and status in ('submitted','expired')`, [pledge.id, pledge.signature, received.toString()])
    return { state: rowCount || pledge.status === 'confirmed' ? 'confirmed' : pledge.status, received: received.toString() }
  }
  if (pledge.status === 'expired') return { state: 'expired' }
  const status = (await connection.getSignatureStatuses([pledge.signature], { searchTransactionHistory: true })).value[0]
  if (status?.err) return { state: 'pending' }
  if (!status && await provablyExpiredUnlanded(connection, pledge.signature, pledge.lastValidBlockHeight)) return markExpired(db, pledge, 'Blockhash expired without chain evidence')
  return { state: 'pending', confirmation: status?.confirmationStatus ?? null }
}

export async function submitPledge({ pool, connection, id, transaction, waitMs = SUBMIT_WAIT_MS, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, landing = {} }) {
  const pledge = await loadPledge(pool, id)
  if (!pledge) throw Error('Pledge was not prepared')
  if (!['prepared', 'submitted', 'expired'].includes(pledge.status)) return { id, state: pledge.status, signature: pledge.signature }
  let accepted
  try { accepted = acceptSignedTip(pledge, transaction) }
  catch (error) { throw Error(error.message.replace(/tip/g, 'pledge')) }
  const { signed, signature } = accepted
  const raw = signed.serialize()
  const { rows: [row] } = await pool.query(`update parts_pledges set status=case when status='expired' then 'expired' else 'submitted' end,
      signature=$2, signed_transaction=$3, submitted_at=coalesce(submitted_at, now())
    where id=$1 and status in ('prepared','submitted','expired') and (signature is null or signature=$2) returning ${PLEDGE_COLUMNS}`,
  [id, signature, raw.toString('base64')])
  if (!row) throw Error('This pledge already has a different signed transaction')
  if (row.status !== 'expired') {
    try { await broadcastUntilSettled(connection, raw, { ...landing, signature, lastValidBlockHeight: Number(row.lastValidBlockHeight) }) }
    catch { /* A refused first send is resolved below from chain state, never assumed. */ }
  }
  const deadline = now() + waitMs
  let result = await refreshPledge(pool, connection, await loadPledge(pool, id))
  while (result.state === 'pending' && now() < deadline) {
    await sleep(2000)
    result = await refreshPledge(pool, connection, await loadPledge(pool, id))
  }
  return { id, signature, ...result }
}

export async function pledgeStatus({ pool, connection, id }) {
  const pledge = await loadPledge(pool, id)
  if (!pledge) throw Error('Pledge was not prepared')
  return { id, signature: pledge.signature, ...await refreshPledge(pool, connection, pledge) }
}

// Worker: resolves pledges a client abandoned (never submitted, or submitted without a final answer).
export function createPledgeExpiry({ pool, connection, limit = 200 }) {
  return { async runOnce() {
    const { rows } = await pool.query(`select ${PLEDGE_COLUMNS} from parts_pledges where status in ('prepared','submitted')
      and created_at < now() - interval '1 minute' order by created_at limit $1`, [limit])
    const results = []
    for (const pledge of rows) {
      try { const r = await refreshPledge(pool, connection, pledge); if (r.state !== pledge.status) results.push({ id: pledge.id, state: r.state }) }
      catch (error) {
        console.error('pledge needs review', { id: pledge.id, error: error.message })
        await pool.query(`insert into graduation_alerts(event_key,kind,detail) values($1,'PARTS_PLEDGE_REVIEW',$2) on conflict(event_key) do nothing`,
          [`parts-pledge-review:${pledge.id}`, JSON.stringify({ id: pledge.id, signature: pledge.signature, mint: pledge.mint, error: error.message })]).catch(() => null)
        results.push({ id: pledge.id, state: 'review' })
      }
    }
    return results
  } }
}
