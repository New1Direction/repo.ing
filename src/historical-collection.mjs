import { createHash, randomUUID } from 'node:crypto'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import bs58 from 'bs58'

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const check = value => { if (!value) throw Error('Historical receipt evidence mismatch') }
const eventTag = Buffer.from('e445a52e51cb9a1dc6b6b734610c3138', 'hex')

// Receipt-backed reconstruction, NOT a retroactive signing authorization. The complete
// jsonParsed transaction hash is independently reviewed; finality comes from trusted RPC.
// This deliberately supports one DAMM claim followed by one explicit SOL payout only.
export function verifyHistoricalCollection({ transaction: tx, finality, review: r }) {
  check(tx?.meta?.err === null && finality?.err === null && finality.confirmationStatus === 'finalized' &&
    Number.isSafeInteger(tx.slot) && tx.slot > 0 && finality.slot === tx.slot &&
    finality.signature === r?.signature && tx.transaction?.signatures?.[0] === r.signature &&
    hash(tx) === r.transactionHash)
  check(/^[1-9][0-9]*$/.test(r.repoId) && /^[1-9][0-9]*$/.test(r.amount) && /^[1-9][0-9]*$/.test(r.dammClaimed))
  for (const field of ['mint', 'curve', 'pool', 'position', 'source', 'receiver']) new PublicKey(r[field])
  check(r.source !== r.receiver)
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey)
  check(keys.every(k => typeof k === 'string') && new Set(keys).size === keys.length)
  const delta = key => {
    const i = keys.indexOf(key)
    check(i >= 0 && Number.isSafeInteger(tx.meta.preBalances[i]) && Number.isSafeInteger(tx.meta.postBalances[i]))
    return BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i])
  }
  check(delta(r.receiver) === BigInt(r.amount))
  const transfers = tx.transaction.message.instructions.filter(i => i.programId === SystemProgram.programId.toBase58() && i.parsed?.type === 'transfer')
  check(transfers.length === 1 && transfers[0].parsed.info.source === r.source &&
    transfers[0].parsed.info.destination === r.receiver && Number.isSafeInteger(transfers[0].parsed.info.lamports) &&
    BigInt(transfers[0].parsed.info.lamports) === BigInt(r.amount))
  const events = (tx.meta.innerInstructions ?? []).flatMap(g => g.instructions).filter(i =>
    i.programId === CP_AMM_PROGRAM_ID.toBase58() && typeof i.data === 'string').map(i => Buffer.from(bs58.decode(i.data)))
    .filter(b => b.subarray(0, 16).equals(eventTag))
  check(events.length === 1)
  const e = events[0]
  check(e.length === 128 && new PublicKey(e.subarray(16, 48)).toBase58() === r.pool &&
    new PublicKey(e.subarray(48, 80)).toBase58() === r.position &&
    new PublicKey(e.subarray(80, 112)).toBase58() === r.source && e.readBigUInt64LE(112) === 0n &&
    e.readBigUInt64LE(120) === BigInt(r.dammClaimed))
  check(Number.isSafeInteger(tx.meta.fee) && keys.reduce((sum, key) => sum + delta(key), 0n) === -BigInt(tx.meta.fee))
  return Object.freeze({ status: 'settled', evidenceSource: 'historical-receipt', originalIntentAvailable: false,
    signature: r.signature, slot: tx.slot, amount: r.amount, dammClaimed: r.dammClaimed,
    receiver: r.receiver, position: r.position, pool: r.pool, transactionHash: r.transactionHash })
}

// Caller owns a database transaction. This API cannot sign or broadcast and never creates
// a pending row. Repository advisory locking is shared with normal claims/reconciliation.
export async function importHistoricalCollection(client, input) {
  const receipt = verifyHistoricalCollection(input), r = input.review
  await client.query('select pg_advisory_xact_lock($1::bigint)', [r.repoId])
  const { rows: [market] } = await client.query('select mint,pool,creator_wallet from markets where github_repo_id=$1', [r.repoId])
  check(market?.mint === r.mint && market?.pool === r.curve && market.creator_wallet === r.source)
  const { rows: [proof] } = await client.query('select curve,mint,pool,creator_position from graduated_migration_proofs where github_repo_id=$1', [r.repoId])
  check(proof?.curve === r.curve && proof.mint === r.mint && proof.pool === r.pool && proof.creator_position === r.position)
  const { rows: claims } = await client.query('select id from repo_claims where claim_signature=$1', [r.signature])
  if (claims.length) throw Error('Historical receipt conflicts with an existing beneficiary payment')
  const terms = { purpose: 'historical-damm-receipt-v1', ...r, originalIntentAvailable: false }
  const { rows: existing } = await client.query('select * from builder_fee_collections where signature=$1', [r.signature])
  if (existing.length) {
    const row = existing[0]
    if (row.evidence_source !== 'historical-receipt' || row.status !== 'settled' ||
        String(row.github_repo_id) !== r.repoId || row.mint !== r.mint || row.pool !== r.curve ||
        row.wallet !== r.receiver || row.amount !== r.amount || row.terms_hash !== hash(terms) ||
        row.receipt !== JSON.stringify({ ...receipt, transaction: input.transaction }))
      throw Error('Historical receipt conflicts with existing ledger evidence')
    return { inserted: false, receipt }
  }
  await client.query(`insert into builder_fee_collections
    (id,github_repo_id,mint,pool,wallet,amount,status,terms,terms_hash,signature,receipt,settled_at,evidence_source)
    values($1,$2,$3,$4,$5,$6,'settled',$7,$8,$9,$10,now(),'historical-receipt')`,
    [randomUUID(), r.repoId, r.mint, r.curve, r.receiver, r.amount, JSON.stringify(terms), hash(terms),
      r.signature, JSON.stringify({ ...receipt, transaction: input.transaction })])
  return { inserted: true, receipt }
}
