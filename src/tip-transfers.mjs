import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { broadcastUntilSettled, withPriorityFee } from './trade-landing.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'
import { SYSTEM_PROGRAM, TIP_TOKENS, checkTipMint } from './tip-tokens.mjs'
import { MEMO_PROGRAM, TIPS_DISABLED, validTipId } from './tips.mjs'

// Tip-wallet-signed transfers: payouts of a repository's confirmed tips to its verified payout wallet, and refunds of a
// donor's own unclaimed tips after refund_after. Same trust model as builder-fee claims: the signed transaction and the
// reserved tips are durable (tip_transfers row, repo_tips.transfer_id) BEFORE broadcast; the finalized receipt settles
// it, a failed or provably expired one releases the tips. Every send runs under one advisory lock for the tip wallet, so
// the balance-vs-liability guard and the reservations can never interleave.

export const TIP_WALLET_LOCK = '7610611000000001'
// SOL the tip wallet must keep beyond SOL tip liabilities: network fees, recipient token-account rent and its own
// rent-exempt minimum. Below this, payouts pause instead of spending donors' SOL on fees.
export const TIP_OPERATING_RESERVE_LAMPORTS = 10_000_000n
export const MAX_TIPS_PER_TRANSFER = 500
export const transferMemo = (kind, id) => `repoing-tip-${kind}:${id}`
const native = row => row.tokenProgram === SYSTEM_PROGRAM
const symbolFor = mint => TIP_TOKENS.find(t => t.mint === mint)?.symbol ?? `${mint.slice(0, 4)}…`

export function transferInstructions({ kind, id, source, recipient, mint, tokenProgram, decimals, amount }) {
  const memo = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(transferMemo(kind, id), 'utf8') })
  if (tokenProgram === SYSTEM_PROGRAM) return [SystemProgram.transfer({ fromPubkey: source, toPubkey: recipient, lamports: amount }), memo]
  const program = new PublicKey(tokenProgram), mintKey = new PublicKey(mint)
  const from = getAssociatedTokenAddressSync(mintKey, source, false, program)
  const to = getAssociatedTokenAddressSync(mintKey, recipient, false, program)
  return [createAssociatedTokenAccountIdempotentInstruction(source, to, recipient, mintKey, program),
    createTransferCheckedInstruction(from, mintKey, to, source, amount, decimals, [], program), memo]
}

// On-chain holdings of one mint at the tip wallet: lamports for SOL, else the tip wallet's ATA (0 when absent).
export async function tipWalletBalance(connection, wallet, { mint, tokenProgram }, commitment = 'confirmed') {
  if (tokenProgram === SYSTEM_PROGRAM) return BigInt(await connection.getBalance(wallet, commitment))
  const program = new PublicKey(tokenProgram)
  const address = getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, program)
  const info = await connection.getAccountInfo(address, commitment)
  if (!info) return 0n
  const account = unpackAccount(address, info, program)
  if (!account.owner.equals(wallet) || account.mint.toBase58() !== mint) throw Error('Tip wallet token account mismatch')
  return account.amount
}

// Confirmed tips are liabilities until a settled transfer marks them paid or refunded (a pending transfer's tips still
// count: their tokens have not left yet).
export async function tipLiabilities(db, wallet) {
  const { rows } = await db.query(`select mint, token_program as "tokenProgram", decimals, coalesce(sum(received_amount),0)::text as amount,
    count(*)::int as tips from repo_tips where tip_wallet=$1 and status='confirmed' group by mint, token_program, decimals`, [wallet])
  return rows
}

// Balance vs liability per mint (every allowlisted mint, plus any mint still owed). short = the wallet cannot cover it.
export async function tipWalletCoverage(db, connection, wallet) {
  const key = new PublicKey(wallet)
  const owed = new Map((await tipLiabilities(db, key.toBase58())).map(row => [row.mint, row]))
  const mints = new Map(TIP_TOKENS.map(t => [t.mint, { mint: t.mint, tokenProgram: t.program, decimals: t.decimals, symbol: t.symbol }]))
  for (const row of owed.values()) if (!mints.has(row.mint)) mints.set(row.mint, { ...row, symbol: symbolFor(row.mint) })
  return Promise.all([...mints.values()].map(async m => {
    const liability = BigInt(owed.get(m.mint)?.amount ?? 0), tips = owed.get(m.mint)?.tips ?? 0
    try {
      const balance = await tipWalletBalance(connection, key, m)
      return { ...m, liability: liability.toString(), tips, balance: balance.toString(), short: balance < liability,
        surplus: (balance > liability ? balance - liability : 0n).toString() }
    } catch { return { ...m, liability: liability.toString(), tips, balance: null, short: null, surplus: null } }
  }))
}

export async function recordTipShortfall(db, wallet, rows, now = Date.now) {
  const short = rows.filter(r => r.short)
  if (!short.length) return 0
  const day = new Date(now()).toISOString().slice(0, 10)
  for (const row of short) {
    const detail = { wallet, mint: row.mint, symbol: row.symbol, balance: row.balance, liability: row.liability, observedAt: new Date(now()).toISOString() }
    await db.query(`insert into graduation_alerts(event_key,kind,detail) values($1,'TIP_WALLET_SHORTFALL',$2) on conflict(event_key) do nothing`,
      [`tip-wallet-short:${wallet}:${row.mint}:${day}`, JSON.stringify(detail)])
  }
  return short.length
}

// Session-level lock: if the unlock fails the connection is destroyed, never returned to the pool still holding it.
async function withTipWalletLock(pool, fn) {
  const db = await pool.connect()
  let broken = false
  try {
    await db.query('select pg_advisory_lock($1::bigint)', [TIP_WALLET_LOCK])
    try { return await fn(db) }
    finally { await db.query('select pg_advisory_unlock($1::bigint)', [TIP_WALLET_LOCK]).catch(error => { broken = true; throw error }) }
  } finally { db.release(broken || undefined) }
}

// Durable operator alert (daily dedup) for money that needs a human: a landed tip or transfer whose receipt does not
// reconcile. Nothing is aborted or re-sent automatically in that state.
export async function recordTipReview(db, kind, key, detail, now = Date.now) {
  const at = new Date(now()).toISOString()
  await db.query(`insert into graduation_alerts(event_key,kind,detail) values($1,$2,$3) on conflict(event_key) do nothing`,
    [`${kind.toLowerCase()}:${key}:${at.slice(0, 10)}`, kind, JSON.stringify({ ...detail, observedAt: at })]).catch(() => null)
}

const groupTips = rows => {
  const groups = new Map()
  for (const row of rows) {
    const key = `${row.githubRepoId}:${row.mint}`
    const group = groups.get(key) ?? { githubRepoId: row.githubRepoId, mint: row.mint, tokenProgram: row.tokenProgram, decimals: row.decimals, tips: [] }
    if (group.tokenProgram !== row.tokenProgram || group.decimals !== row.decimals) throw Error('Tip ledger token program mismatch')
    group.tips.push(row)
    groups.set(key, group)
  }
  return [...groups.values()].map(g => ({ ...g, tips: g.tips.slice(0, MAX_TIPS_PER_TRANSFER) }))
}

async function abortTransfer(db, id, reason) {
  await db.query('begin')
  try {
    const { rowCount } = await db.query(`update tip_transfers set status='aborted', resolved_at=now(), resolution_reason=$2
      where id=$1 and status='pending'`, [id, reason])
    if (rowCount) await db.query(`update repo_tips set transfer_id=null where transfer_id=$1 and status='confirmed'`, [id])
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  return { id, status: 'aborted', reason }
}

// Finalized receipt check: the exact signed message, and the exact amount leaving the tip wallet for the recipient.
export function verifyTransferReceipt(tx, transfer) {
  if (!tx?.meta) throw Error('Tip transfer receipt is unavailable')
  if (tx.transaction.signatures[0] !== transfer.signature) throw Error('Tip transfer receipt signature mismatch')
  const signed = Transaction.from(Buffer.from(transfer.signedTransaction, 'base64'))
  if (!Buffer.from(signed.serializeMessage()).equals(Buffer.from(tx.transaction.message.serialize()))) throw Error('Tip transfer receipt differs from the signed intent')
  const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys
  const index = key => keys.findIndex(k => k.equals(key))
  const amount = BigInt(transfer.amount), fee = BigInt(tx.meta.fee)
  const source = new PublicKey(transfer.sourceWallet), recipient = new PublicKey(transfer.recipient)
  if (index(source) !== 0) throw Error('Tip transfer was not paid by the tip wallet')
  if (native(transfer)) {
    const s = index(source), r = index(recipient)
    if (r < 0) throw Error('Tip transfer recipient missing from receipt')
    const received = BigInt(tx.meta.postBalances[r]) - BigInt(tx.meta.preBalances[r])
    const sent = BigInt(tx.meta.preBalances[s]) - BigInt(tx.meta.postBalances[s])
    if (received !== amount || sent !== amount + fee) throw Error('Tip transfer SOL delta mismatch')
  } else {
    const program = new PublicKey(transfer.tokenProgram), mint = new PublicKey(transfer.mint)
    const delta = (owner) => {
      const i = index(getAssociatedTokenAddressSync(mint, owner, false, program))
      if (i < 0) throw Error('Tip transfer token account missing from receipt')
      const pick = list => (list ?? []).find(b => b.accountIndex === i)
      const post = pick(tx.meta.postTokenBalances), pre = pick(tx.meta.preTokenBalances)
      if (!post || post.mint !== transfer.mint || post.owner !== owner.toBase58()) throw Error('Tip transfer token balance missing from receipt')
      return BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0')
    }
    if (delta(recipient) !== amount || delta(source) !== -amount) throw Error('Tip transfer token delta mismatch')
  }
  return { signature: transfer.signature, slot: tx.slot, amount: amount.toString(), networkFee: fee.toString() }
}

const TRANSFER_COLUMNS = `id, kind, github_repo_id::text as "githubRepoId", mint, token_program as "tokenProgram", decimals, source_wallet as "sourceWallet",
  recipient, amount::text, tip_count as "tipCount", status, signature, signed_transaction as "signedTransaction",
  last_valid_block_height::text as "lastValidBlockHeight", created_at as "createdAt", settled_at as "settledAt"`

export async function settleTransfer(db, connection, transfer) {
  const tx = await connection.getTransaction(transfer.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (!tx) return null
  if (tx.meta?.err) return abortTransfer(db, transfer.id, 'Finalized transaction failed')
  const receipt = verifyTransferReceipt(tx, transfer)
  await db.query('begin')
  try {
    const { rowCount } = await db.query(`update tip_transfers set status='settled', settled_at=now(), receipt=$2 where id=$1 and status='pending'`,
      [transfer.id, JSON.stringify(receipt)])
    if (rowCount) {
      const { rows: [paid] } = await db.query(`with t as (update repo_tips set status=$2, resolved_at=now() where transfer_id=$1 and status='confirmed'
        returning received_amount) select count(*)::int as count, coalesce(sum(received_amount),0)::text as amount from t`,
      [transfer.id, transfer.kind === 'refund' ? 'refunded' : 'paid'])
      if (paid.count !== transfer.tipCount || paid.amount !== String(transfer.amount)) throw Error('Settled tip transfer does not match its reserved tips')
    }
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  return { id: transfer.id, status: 'settled', mint: transfer.mint, kind: transfer.kind, ...receipt }
}

// Builds, guards, signs, persists (with its reservation) and broadcasts one transfer of a group of confirmed tips.
async function sendGroup(db, { connection, signer, kind, group, recipient, requestedBy, now, fetcher, log, landing = {} }) {
  const amount = group.tips.reduce((sum, tip) => sum + BigInt(tip.receivedAmount), 0n)
  if (amount <= 0n) throw Error('No confirmed tips to send')
  const wallet = signer.publicKey
  if (recipient.equals(wallet)) throw Error('Tips cannot be sent to the tip wallet')
  if (!PublicKey.isOnCurve(recipient.toBytes())) throw Error('Recipient must be a normal Solana wallet')
  // Guard 1: never more than this repository's confirmed, unreserved tips for this mint.
  const { rows: [open] } = await db.query(`select coalesce(sum(received_amount),0)::text as amount from repo_tips
    where github_repo_id=$1 and mint=$2 and tip_wallet=$3 and status='confirmed' and transfer_id is null`, [group.githubRepoId, group.mint, wallet.toBase58()])
  if (amount > BigInt(open.amount)) throw Error('Tip transfer exceeds confirmed unpaid tips')
  // Guard 2: the wallet must hold every confirmed liability for this mint (all repositories), and SOL for costs.
  const liabilities = await tipLiabilities(db, wallet.toBase58())
  const owed = mint => BigInt(liabilities.find(l => l.mint === mint)?.amount ?? 0)
  const balance = await tipWalletBalance(connection, wallet, group)
  if (balance < owed(group.mint)) {
    await recordTipShortfall(db, wallet.toBase58(), [{ mint: group.mint, symbol: symbolFor(group.mint), balance: balance.toString(), liability: owed(group.mint).toString(), short: true }], now)
    throw Error('Tip wallet balance is below confirmed tips; payouts are paused for review')
  }
  const lamports = BigInt(await connection.getBalance(wallet, 'confirmed'))
  if (lamports < owed(TIP_TOKENS[0].mint) + TIP_OPERATING_RESERVE_LAMPORTS) throw Error('Tip payouts are paused while network funds are replenished')
  if (group.tokenProgram !== SYSTEM_PROGRAM) await checkTipMint(connection, { mint: group.mint, program: group.tokenProgram, decimals: group.decimals })
  const id = randomUUID()
  const latest = await connection.getLatestBlockhash('confirmed')
  const base = new Transaction({ feePayer: wallet, recentBlockhash: latest.blockhash })
    .add(...transferInstructions({ kind, id, source: wallet, recipient, mint: group.mint, tokenProgram: group.tokenProgram, decimals: group.decimals, amount }))
  const { transaction } = await withPriorityFee(connection, base, { feePayer: wallet, blockhash: latest.blockhash,
    writableAccounts: base.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey)), fetcher, log })
  transaction.sign(signer)
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(transaction.serialize()), { sigVerify: true, commitment: 'confirmed' })
  if (simulation.value.err) throw Error(`Tip ${kind} preflight failed: ${JSON.stringify(simulation.value.err)}`)
  const signature = bs58.encode(transaction.signature), raw = transaction.serialize()
  const transfer = { id, kind, githubRepoId: group.githubRepoId, mint: group.mint, tokenProgram: group.tokenProgram, decimals: group.decimals,
    sourceWallet: wallet.toBase58(), recipient: recipient.toBase58(), amount: amount.toString(), tipCount: group.tips.length, status: 'pending',
    signature, signedTransaction: raw.toString('base64'), lastValidBlockHeight: String(latest.lastValidBlockHeight) }
  await db.query('begin')
  try {
    await db.query(`insert into tip_transfers(id, kind, github_repo_id, mint, token_program, decimals, source_wallet, recipient, amount, tip_count,
        requested_by, status, signature, signed_transaction, last_valid_block_height)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,$14)`, [id, kind, group.githubRepoId, group.mint, group.tokenProgram, group.decimals,
      transfer.sourceWallet, transfer.recipient, transfer.amount, transfer.tipCount, requestedBy, signature, transfer.signedTransaction, transfer.lastValidBlockHeight])
    const { rowCount } = await db.query(`update repo_tips set transfer_id=$1 where id = any($2::uuid[]) and github_repo_id=$3 and mint=$4
      and tip_wallet=$5 and status='confirmed' and transfer_id is null`, [id, group.tips.map(t => t.id), group.githubRepoId, group.mint, transfer.sourceWallet])
    if (rowCount !== group.tips.length) throw Error('Tips changed while preparing the transfer; refresh and try again')
    await db.query('commit')
  } catch (error) { await db.query('rollback'); throw error }
  await broadcastUntilSettled(connection, raw, { ...landing, signature, lastValidBlockHeight: latest.lastValidBlockHeight }).catch(() => null)
  const confirmed = await connection.confirmTransaction({ signature, ...latest }, 'finalized').catch(() => null)
  const settled = confirmed ? await settleTransfer(db, connection, transfer) : null
  return settled ?? { id, status: 'pending', signature, amount: transfer.amount, mint: group.mint }
}

const TIP_ROW = `id, github_repo_id::text as "githubRepoId", mint, token_program as "tokenProgram", decimals, received_amount::text as "receivedAmount"`

// Claim tips: pays every confirmed, unreserved tip for the repository to its bound payout wallet, one transfer per mint.
// `verifyAuthority` is the same fresh GitHub admin check builder claims use; `review` pins the reviewed payout wallet.
export function createTipPayouts({ pool, connection, signer, now = Date.now, fetcher, log, landing }) {
  async function payout({ githubRepoId, review, verifyAuthority }) {
    if (!signer) throw Error(TIPS_DISABLED)
    const repoId = String(githubRepoId ?? '')
    if (!/^[1-9]\d{0,18}$/.test(repoId) || review?.repoId !== repoId) throw Error('Invalid tip claim review')
    const github = await verifyAuthority({ githubRepoId: BigInt(repoId) })
    const checkedAt = new Date(github?.verifiedAt).getTime()
    if (github?.verified !== true || github.permission !== 'admin' || String(github.githubRepoId) !== repoId ||
      !Number.isFinite(checkedAt) || now() - checkedAt > 60_000) throw Error('Current GitHub admin authority required')
    return withTipWalletLock(pool, async db => {
      const { rows: [beneficiary] } = await db.query('select wallet, bound_at as "boundAt" from repo_beneficiaries where github_repo_id=$1', [repoId])
      if (!beneficiary) throw Error('Set a payout wallet before claiming tips')
      if (beneficiary.wallet !== review.wallet || new Date(beneficiary.boundAt).toISOString() !== review.boundAt) throw Error('Payout wallet changed; review again')
      const { rows } = await db.query(`select ${TIP_ROW} from repo_tips where github_repo_id=$1 and tip_wallet=$2 and status='confirmed'
        and transfer_id is null order by confirmed_at, id`, [repoId, signer.publicKey.toBase58()])
      if (!rows.length) throw Error('No tips are waiting for this repository')
      const results = []
      for (const group of groupTips(rows)) {
        try { results.push(await sendGroup(db, { connection, signer, kind: 'payout', group, recipient: new PublicKey(beneficiary.wallet),
          requestedBy: `github:${github.githubUserId ?? 'admin'}`, now, fetcher, log, landing })) }
        catch (error) { console.error('tip transfer not sent', { mint: group.mint, error: error.message }); results.push({ mint: group.mint, status: 'failed', error: error.message }) }
      }
      return results
    })
  }
  return { payout }
}

// Refund: the donor's own confirmed, unreserved tips whose refund_after has passed, back to the donor wallet.
export function createTipRefunds({ pool, connection, signer, now = Date.now, fetcher, log, landing }) {
  async function refund({ donorWallet, tipIds }) {
    if (!signer) throw Error(TIPS_DISABLED)
    if (!Array.isArray(tipIds) || !tipIds.length || tipIds.length > 20 || new Set(tipIds).size !== tipIds.length || !tipIds.every(validTipId)) throw Error('Choose up to 20 tips to refund')
    const donor = new PublicKey(donorWallet)
    return withTipWalletLock(pool, async db => {
      const { rows } = await db.query(`select ${TIP_ROW}, donor_wallet as "donorWallet", refund_after as "refundAfter", status, transfer_id as "transferId"
        from repo_tips where id = any($1::uuid[]) and tip_wallet=$2 order by id`, [tipIds, signer.publicKey.toBase58()])
      if (rows.length !== tipIds.length || rows.some(r => r.donorWallet !== donor.toBase58())) throw Error('Only the wallet that sent a tip can refund it')
      if (rows.some(r => r.status !== 'confirmed' || r.transferId)) throw Error('Some tips were already paid, refunded or are in flight')
      if (rows.some(r => new Date(r.refundAfter).getTime() > now())) throw Error('Tips can be refunded 90 days after they were sent')
      const results = []
      for (const group of groupTips(rows)) {
        try { results.push(await sendGroup(db, { connection, signer, kind: 'refund', group, recipient: donor, requestedBy: `donor:${donor.toBase58()}`, now, fetcher, log, landing })) }
        catch (error) { console.error('tip transfer not sent', { mint: group.mint, error: error.message }); results.push({ mint: group.mint, status: 'failed', error: error.message }) }
      }
      return results
    })
  }
  return { refund }
}

// Worker: settles or aborts pending transfers from their durable signed bytes only (no key needed), and checks
// tip-wallet coverage. A transfer is aborted only on a finalized failure or a provably expired, unlanded blockhash.
export function createTipTransferRecovery({ pool, connection, now = Date.now }) {
  return { async runOnce() {
    const db = await pool.connect()
    const results = []
    try {
      const { rows: [lock] } = await db.query('select pg_try_advisory_lock($1::bigint) as locked', [TIP_WALLET_LOCK])
      if (!lock.locked) return results
      try {
        const { rows } = await db.query(`select ${TRANSFER_COLUMNS} from tip_transfers where status='pending' order by created_at`)
        for (const transfer of rows) {
          try {
            let result = await settleTransfer(db, connection, transfer)
            if (!result) {
              const status = (await connection.getSignatureStatuses([transfer.signature], { searchTransactionHistory: true })).value[0]
              if (!status && BigInt(await connection.getBlockHeight('finalized')) > BigInt(transfer.lastValidBlockHeight)) {
                result = await settleTransfer(db, connection, transfer)
                if (!result && await provablyExpiredUnlanded(connection, transfer.signature, transfer.lastValidBlockHeight)) {
                  result = await abortTransfer(db, transfer.id, 'Signed blockhash expired without chain evidence')
                }
              } else if (!status) {
                // Re-broadcast only the identical, previously authorized bytes.
                await connection.sendRawTransaction(Buffer.from(transfer.signedTransaction, 'base64'), { skipPreflight: false }).catch(() => null)
              }
            }
            results.push({ id: transfer.id, kind: transfer.kind, status: result?.status ?? 'pending', signature: transfer.signature })
          } catch (error) {
            console.error('tip transfer needs review', { id: transfer.id, error: error.message })
            // Reserved tips stay reserved (never paid twice); an operator reconciles this intent.
            await recordTipReview(pool, 'TIP_TRANSFER_REVIEW', transfer.id, { id: transfer.id, kind: transfer.kind, signature: transfer.signature, error: error.message }, now)
            results.push({ id: transfer.id, kind: transfer.kind, status: 'review' })
          }
        }
      } finally { await db.query('select pg_advisory_unlock($1::bigint)', [TIP_WALLET_LOCK]) }
    } finally { db.release() }
    return results
  } }
}

export function createTipWalletMonitor({ pool, connection, wallets, now = Date.now }) {
  return { async runOnce() {
    const results = []
    for (const wallet of wallets()) {
      const rows = await tipWalletCoverage(pool, connection, wallet)
      const unread = rows.filter(r => r.balance === null).length
      const short = await recordTipShortfall(pool, wallet, rows, now)
      results.push({ wallet, short, unread, status: short ? 'SHORTFALL' : unread ? 'UNVERIFIED' : 'OK' })
    }
    return results
  } }
}
