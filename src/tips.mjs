import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { matchesReviewedTransaction } from './launch-wallet-assertions.mjs'
import { broadcastUntilSettled, withPriorityFee } from './trade-landing.mjs'
import { provablyExpiredUnlanded } from './expiry-proof.mjs'
import { assertTipAmount, checkTipMint, isNativeTip, parseTipAmount, tipToken } from './tip-tokens.mjs'

// "Tip this repo": a donor sends an allowlisted token to the custodial tip wallet in a transaction the server prepares
// (unsigned) and the donor's wallet signs. The row in repo_tips is the liability; it counts only once the finalized
// receipt proves the tip wallet received exactly the requested amount with this tip's memo. Payouts and refunds live
// in src/tip-transfers.mjs.

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
export const REFUND_AFTER_MS = 90 * 24 * 60 * 60 * 1000
export const TIPS_DISABLED = 'Tips are not enabled'
export const tipMemo = id => `repoing-tip:${id}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUBMIT_WAIT_MS = 30_000
const TIP_COLUMNS = `id, github_repo_id::text as "githubRepoId", donor_wallet as "donorWallet", tip_wallet as "tipWallet", mint,
  token_program as "tokenProgram", decimals, symbol, requested_amount::text as "requestedAmount", received_amount::text as "receivedAmount",
  status, message, transaction, last_valid_block_height::text as "lastValidBlockHeight", signature, signed_transaction as "signedTransaction",
  transfer_id as "transferId", created_at as "createdAt", confirmed_at as "confirmedAt", refund_after as "refundAfter"`

// TIP_WALLET_SECRET_KEY (base58 or JSON byte array) is the only source of the tip wallet. Absent: tips are disabled.
// TIP_WALLET_ADDRESS, when set, must match the derived address. Errors never include the key material.
export function readTipWallet(env = process.env) {
  const value = env.TIP_WALLET_SECRET_KEY?.trim()
  if (!value) return null
  let signer
  try { signer = Keypair.fromSecretKey(value.startsWith('[') ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value)) }
  catch { throw Error('TIP_WALLET_SECRET_KEY is not a valid Solana secret key') }
  const expected = env.TIP_WALLET_ADDRESS?.trim()
  if (expected && expected !== signer.publicKey.toBase58()) throw Error('TIP_WALLET_ADDRESS does not match TIP_WALLET_SECRET_KEY')
  return signer
}

export const validTipId = id => typeof id === 'string' && UUID.test(id)

// The exact instructions of a tip: [transfer or (idempotent tip-wallet ATA, transfer_checked)], then the memo.
// `memo` defaults to this tip's memo; parts-fund pledges pass their own (src/parts-pledges.mjs).
export function tipInstructions({ token, donor, tipWallet, amount, id, memo: text = tipMemo(id) }) {
  const memo = new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text, 'utf8') })
  if (isNativeTip(token)) return [SystemProgram.transfer({ fromPubkey: donor, toPubkey: tipWallet, lamports: amount }), memo]
  const program = new PublicKey(token.program), mint = new PublicKey(token.mint)
  const destination = getAssociatedTokenAddressSync(mint, tipWallet, false, program)
  const source = getAssociatedTokenAddressSync(mint, donor, false, program)
  return [createAssociatedTokenAccountIdempotentInstruction(donor, destination, tipWallet, mint, program),
    createTransferCheckedInstruction(source, mint, destination, donor, amount, token.decimals, [], program), memo]
}

export function tipDestination(token, tipWallet) {
  return isNativeTip(token) ? tipWallet : getAssociatedTokenAddressSync(new PublicKey(token.mint), tipWallet, false, new PublicKey(token.program))
}

export async function repoAcceptsTips(db, githubRepoId) {
  const { rows: [market] } = await db.query(`select github_repo_id::text as "repoId" from markets where github_repo_id=$1
    and status='confirmed' and indexed_at is not null and launch_finality='finalized'`, [githubRepoId])
  return Boolean(market)
}

const friendlySimulation = (token, logs = []) => /insufficient (funds|lamports)/i.test(logs.join('\n'))
  ? `Your wallet does not hold enough ${token.symbol}${isNativeTip(token) ? '' : ' (and a little SOL for network fees)'}`
  : 'Tip simulation failed. Check your balance and try again.'

export async function prepareTip({ pool, connection, tipWallet, prices, githubRepoId, wallet, mint, amountBaseUnits, now = Date.now, fetcher, log }) {
  if (!tipWallet) throw Error(TIPS_DISABLED)
  const repoId = String(githubRepoId ?? '')
  if (!/^[1-9]\d{0,18}$/.test(repoId)) throw Error('Invalid repository')
  let donor
  try { donor = new PublicKey(wallet) } catch { throw Error('Connect a Solana wallet to tip') }
  if (!PublicKey.isOnCurve(donor.toBytes())) throw Error('Connect a Solana wallet to tip')
  if (donor.equals(tipWallet)) throw Error('The tip wallet cannot tip itself')
  const token = tipToken(mint)
  const amount = parseTipAmount(amountBaseUnits)
  assertTipAmount(token, amount, prices?.[token.mint])
  if (!await repoAcceptsTips(pool, repoId)) throw Error('This repository has no market on repo.ing yet')
  await checkTipMint(connection, token)
  const id = randomUUID()
  const latest = await connection.getLatestBlockhash('confirmed')
  const destination = tipDestination(token, tipWallet)
  const base = new Transaction({ feePayer: donor, recentBlockhash: latest.blockhash }).add(...tipInstructions({ token, donor, tipWallet, amount, id }))
  const { transaction } = await withPriorityFee(connection, base, { feePayer: donor, blockhash: latest.blockhash,
    writableAccounts: [donor, destination], fetcher, log })
  const simulation = await connection.simulateTransaction(VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })),
    { sigVerify: false, commitment: 'confirmed' }).catch(() => null)
  if (!simulation) throw Error('Tip simulation is unavailable. Try again shortly.')
  if (simulation.value.err) throw Error(friendlySimulation(token, simulation.value.logs ?? []))
  const message = Buffer.from(transaction.serializeMessage()).toString('base64')
  const unsigned = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')
  const createdAt = new Date(now())
  await pool.query(`insert into repo_tips(id, github_repo_id, donor_wallet, tip_wallet, mint, token_program, decimals, symbol,
      requested_amount, status, message, transaction, last_valid_block_height, created_at, refund_after)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared',$10,$11,$12,$13,$14)`,
  [id, repoId, donor.toBase58(), tipWallet.toBase58(), token.mint, token.program, token.decimals, token.symbol, amount.toString(),
    message, unsigned, latest.lastValidBlockHeight, createdAt, new Date(createdAt.getTime() + REFUND_AFTER_MS)])
  return { id, transaction: unsigned, lastValidBlockHeight: latest.lastValidBlockHeight, amountBaseUnits: amount.toString(),
    symbol: token.symbol, decimals: token.decimals, mint: token.mint, tipWallet: tipWallet.toBase58() }
}

export async function loadTip(db, id) {
  if (!validTipId(id)) return null
  const { rows: [tip] } = await db.query(`select ${TIP_COLUMNS} from repo_tips where id=$1`, [id])
  return tip ?? null
}

// The wallet-returned transaction: exactly the reviewed message (or it plus constrained Lighthouse assertions),
// paid and signed by the donor, fully signed.
export function acceptSignedTip(tip, transactionBase64) {
  let signed
  try { signed = Transaction.from(Buffer.from(String(transactionBase64), 'base64')) }
  catch { throw Error('Wallet returned an altered or unsigned tip transaction') }
  if (!signed.signature || !matchesReviewedTransaction(Buffer.from(tip.message, 'base64'), signed) ||
      signed.feePayer?.toBase58() !== tip.donorWallet || !signed.verifySignatures()) {
    throw Error('Wallet returned an altered or unsigned tip transaction')
  }
  const signature = bs58.encode(signed.signature)
  if (tip.signature && tip.signature !== signature) throw Error('This tip already has a different signed transaction')
  return { signed, signature }
}

const accountKeys = message => message.staticAccountKeys ?? message.accountKeys

// Finalized receipt check for a submitted tip. Returns the received amount or throws with the mismatch.
export function verifyTipReceipt(tx, tip, memo = tipMemo(tip.id)) {
  if (!tx?.meta) throw Error('Tip receipt is unavailable')
  if (tx.meta.err) throw Error('Tip transaction failed')
  if (tx.transaction.signatures[0] !== tip.signature) throw Error('Tip receipt signature mismatch')
  const signed = Transaction.from(Buffer.from(tip.signedTransaction, 'base64'))
  if (!Buffer.from(signed.serializeMessage()).equals(Buffer.from(tx.transaction.message.serialize()))) throw Error('Tip receipt differs from the signed transaction')
  const message = tx.transaction.message, keys = accountKeys(message)
  if (keys[0].toBase58() !== tip.donorWallet || !message.isAccountSigner(0)) throw Error('Tip was not signed by the donor')
  const memos = message.compiledInstructions.filter(ix => keys[ix.programIdIndex].equals(MEMO_PROGRAM))
  if (memos.length !== 1 || Buffer.from(memos[0].data).toString('utf8') !== memo) throw Error('Tip memo is missing')
  const token = { mint: tip.mint, program: tip.tokenProgram, decimals: tip.decimals }
  const tipWallet = new PublicKey(tip.tipWallet)
  const destination = tipDestination(token, tipWallet)
  const index = keys.findIndex(key => key.equals(destination))
  if (index < 0) throw Error('Tip wallet is missing from the receipt')
  let received
  if (isNativeTip(token)) received = BigInt(tx.meta.postBalances[index]) - BigInt(tx.meta.preBalances[index])
  else {
    const find = list => (list ?? []).find(b => b.accountIndex === index)
    const post = find(tx.meta.postTokenBalances), pre = find(tx.meta.preTokenBalances)
    if (!post || post.mint !== tip.mint || post.owner !== tip.tipWallet || (post.programId && post.programId !== tip.tokenProgram) ||
      (pre && (pre.mint !== tip.mint || pre.owner !== tip.tipWallet))) throw Error('Tip wallet token balance is missing from the receipt')
    received = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0')
  }
  if (received !== BigInt(tip.requestedAmount)) throw Error('Tip wallet received a different amount than the tip')
  return { received, slot: tx.slot }
}

async function markExpired(db, tip, reason) {
  await db.query(`update repo_tips set status='expired', resolved_at=now() where id=$1 and status in ('prepared','submitted')
    and (signature is null or signature=$2)`, [tip.id, tip.signature ?? null])
  return { state: 'expired', reason }
}

// One step of a tip's state machine against the chain. Safe to repeat from any replica or the worker.
export async function refreshTip(db, connection, tip) {
  if (!tip) return { state: 'missing' }
  if (['confirmed', 'paid', 'refunded', 'failed'].includes(tip.status)) return { state: tip.status }
  if (!tip.signature) {
    // Never signed through submit. An expired blockhash means this exact transaction can no longer land.
    const height = BigInt(await connection.getBlockHeight('finalized'))
    return height > BigInt(tip.lastValidBlockHeight) ? markExpired(db, tip, 'Not submitted before the blockhash expired') : { state: tip.status }
  }
  const tx = await connection.getTransaction(tip.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
  if (tx?.meta?.err) {
    await db.query(`update repo_tips set status='failed', resolved_at=now() where id=$1 and signature=$2 and status in ('submitted','expired')`, [tip.id, tip.signature])
    return { state: 'failed' }
  }
  if (tx) {
    const { received } = verifyTipReceipt(tx, tip)
    const { rowCount } = await db.query(`update repo_tips set status='confirmed', received_amount=$3, confirmed_at=now(), resolved_at=null
      where id=$1 and signature=$2 and status in ('submitted','expired')`, [tip.id, tip.signature, received.toString()])
    return { state: rowCount || tip.status === 'confirmed' ? 'confirmed' : tip.status, received: received.toString() }
  }
  if (tip.status === 'expired') return { state: 'expired' }
  const status = (await connection.getSignatureStatuses([tip.signature], { searchTransactionHistory: true })).value[0]
  if (status?.err) return { state: 'pending' }
  if (!status && await provablyExpiredUnlanded(connection, tip.signature, tip.lastValidBlockHeight)) return markExpired(db, tip, 'Blockhash expired without chain evidence')
  return { state: 'pending', confirmation: status?.confirmationStatus ?? null }
}

export async function submitTip({ pool, connection, id, transaction, waitMs = SUBMIT_WAIT_MS, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, landing = {} }) {
  const tip = await loadTip(pool, id)
  if (!tip) throw Error('Tip was not prepared')
  if (!['prepared', 'submitted', 'expired'].includes(tip.status)) return { id, state: tip.status, signature: tip.signature }
  const { signed, signature } = acceptSignedTip(tip, transaction)
  const raw = signed.serialize()
  // The first signature wins across replicas, and is durable before anything is broadcast.
  const { rows: [row] } = await pool.query(`update repo_tips set status=case when status='expired' then 'expired' else 'submitted' end,
      signature=$2, signed_transaction=$3, submitted_at=coalesce(submitted_at, now())
    where id=$1 and status in ('prepared','submitted','expired') and (signature is null or signature=$2) returning ${TIP_COLUMNS}`,
  [id, signature, raw.toString('base64')])
  if (!row) throw Error('This tip already has a different signed transaction')
  if (row.status !== 'expired') {
    try { await broadcastUntilSettled(connection, raw, { ...landing, signature, lastValidBlockHeight: Number(row.lastValidBlockHeight) }) }
    catch { /* A refused first send is resolved below from chain state, never assumed. */ }
  }
  const deadline = now() + waitMs
  let result = await refreshTip(pool, connection, await loadTip(pool, id))
  while (result.state === 'pending' && now() < deadline) {
    await sleep(2000)
    result = await refreshTip(pool, connection, await loadTip(pool, id))
  }
  return { id, signature, ...result }
}

export async function tipStatus({ pool, connection, id }) {
  const tip = await loadTip(pool, id)
  if (!tip) throw Error('Tip was not prepared')
  return { id, signature: tip.signature, ...await refreshTip(pool, connection, tip) }
}

// Worker: resolves tips a client abandoned (never submitted, or submitted without a final answer).
export function createTipExpiry({ pool, connection, limit = 200 }) {
  return { async runOnce() {
    const { rows } = await pool.query(`select ${TIP_COLUMNS} from repo_tips where status in ('prepared','submitted')
      and created_at < now() - interval '1 minute' order by created_at limit $1`, [limit])
    const results = []
    for (const tip of rows) {
      try { const r = await refreshTip(pool, connection, tip); if (r.state !== tip.status) results.push({ id: tip.id, state: r.state }) }
      catch (error) {
        console.error('tip needs review', { id: tip.id, error: error.message })
        // A landed tip whose receipt does not reconcile (e.g. an issuer enabled a fee) is not a liability yet: alert so
        // an operator can credit or refund it by hand.
        await pool.query(`insert into graduation_alerts(event_key,kind,detail) values($1,'TIP_RECEIPT_REVIEW',$2) on conflict(event_key) do nothing`,
          [`tip-receipt-review:${tip.id}`, JSON.stringify({ id: tip.id, signature: tip.signature, mint: tip.mint, error: error.message })]).catch(() => null)
        results.push({ id: tip.id, state: 'review' })
      }
    }
    return results
  } }
}
