import { isDeepStrictEqual } from 'node:util'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { CUSTODY_VAULT } from './custody-settlement.mjs'

const json = value => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v))
const check = (value, message) => { if (!value) throw Error(`Custody ${message}`) }

export async function custodyBalance(db, repoId) {
  const { rows } = await db.query(`select c.role,coalesce(sum(c.amount),0)::text as collected,
    coalesce(sum((select coalesce(sum(p.amount),0) from custody_fee_payouts p where p.collection_signature=c.signature)),0)::text as paid
    from custody_fee_collections c where c.github_repo_id=$1 group by c.role`, [String(repoId)])
  const totals = { creator: { collected: 0n, paid: 0n, held: 0n }, partner: { collected: 0n, paid: 0n, held: 0n } }
  for (const row of rows) {
    const collected = BigInt(row.collected), paid = BigInt(row.paid)
    check(paid <= collected, 'balance is overdrawn')
    totals[row.role] = { collected, paid, held: collected - paid }
  }
  return totals
}

export async function verifyCustodySolvency(db, connection) {
  const { rows: [row] } = await db.query(`select
    (select coalesce(sum(amount),0) from custody_fee_collections) -
    (select coalesce(sum(amount),0) from custody_fee_payouts) as held`)
  const held = BigInt(row.held)
  check(held >= 0n, 'balance is overdrawn')
  if (held === 0n) return held
  const owner = new PublicKey(CUSTODY_VAULT), address = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true)
  const info = await connection.getAccountInfo(address, 'finalized')
  check(info?.owner.equals(TOKEN_PROGRAM_ID), 'vault balance evidence missing')
  const account = unpackAccount(address, info, TOKEN_PROGRAM_ID)
  check(account.owner.equals(owner) && account.mint.equals(NATIVE_MINT) && account.isNative &&
    account.isInitialized && !account.isFrozen && !account.delegate && !account.closeAuthority && account.amount >= held,
    'vault balance or control mismatch')
  return held
}

async function lockAndBind(db, receipt) {
  const a = receipt.attribution
  check(receipt.vaultControlVerified === true && typeof receipt.amount === 'bigint' && receipt.amount > 0n &&
    Number.isSafeInteger(receipt.slot) && receipt.slot > 0 && typeof receipt.signature === 'string' &&
    /^[1-9][0-9]*$/.test(a?.repoId) && ['creator', 'partner'].includes(a?.role), 'receipt is not verified')
  await db.query('select pg_advisory_xact_lock($1::bigint)', [a.repoId])
  const { rows: [market] } = await db.query('select mint,pool from markets where github_repo_id=$1', [a.repoId])
  check(market?.mint === a.mint && market?.pool === a.curve, 'market attribution mismatch')
  const { rows: [proof] } = await db.query('select creator_position,partner_position from graduated_migration_proofs where github_repo_id=$1', [a.repoId])
  check(proof && a.position === proof[`${a.role}_position`], 'position attribution mismatch')
}

async function rejectOtherLedger(db, signature) {
  const { rows: [r] } = await db.query(`select
    (select count(*) from repo_claims where claim_signature=$1) +
    (select count(*) from builder_fee_collections where signature=$1) +
    (select count(*) from platform_fee_claims where signature=$1) as n`, [signature])
  check(Number(r.n) === 0, 'receipt conflicts with another ledger')
}

// Internal settlement writers: call only with the result of the governance + finalized
// receipt validators, inside one caller-owned SQL transaction. Never expose as a JSON API.
export async function recordCustodyCollection(db, receipt) {
  await lockAndBind(db, receipt)
  check(receipt.kind === 'vault-wsol-fee-collection' && receipt.owner === CUSTODY_VAULT && receipt.beneficiaryPaid === false,
    'collection cannot be treated as payment')
  const { rows: [existing] } = await db.query('select receipt from custody_fee_collections where signature=$1', [receipt.signature])
  if (existing) {
    check(isDeepStrictEqual(existing.receipt, json(receipt)), 'receipt conflict')
    return { inserted: false }
  }
  await rejectOtherLedger(db, receipt.signature)
  check(!(await db.query('select signature from custody_fee_payouts where signature=$1', [receipt.signature])).rows.length, 'signature conflict')
  const a = receipt.attribution
  await db.query(`insert into custody_fee_collections(signature,github_repo_id,role,position,amount,slot,receipt)
    values($1,$2,$3,$4,$5,$6,$7)`, [receipt.signature, a.repoId, a.role, a.position, String(receipt.amount), receipt.slot, json(receipt)])
  return { inserted: true }
}

export async function recordCustodyPayout(db, receipt, { partnerBeneficiary = null } = {}) {
  await lockAndBind(db, receipt)
  check(receipt.kind === 'vault-wsol-beneficiary-payment' && receipt.beneficiaryPaid === true, 'payout is not verified')
  const { rows: [existing] } = await db.query('select receipt from custody_fee_payouts where signature=$1', [receipt.signature])
  if (existing) {
    check(isDeepStrictEqual(existing.receipt, json(receipt)), 'receipt conflict')
    return { inserted: false }
  }
  const { rows: [collection] } = await db.query('select * from custody_fee_collections where signature=$1 for update', [receipt.collectionSignature])
  check(collection && isDeepStrictEqual(collection.receipt.attribution, json(receipt.attribution)) &&
    BigInt(collection.slot) <= BigInt(receipt.slot), 'collection attribution mismatch')
  await rejectOtherLedger(db, receipt.signature)
  check(!(await db.query('select signature from custody_fee_collections where signature=$1', [receipt.signature])).rows.length, 'signature conflict')
  const { rows: [spent] } = await db.query('select coalesce(sum(amount),0)::text as n from custody_fee_payouts where collection_signature=$1', [receipt.collectionSignature])
  check(BigInt(collection.amount) - BigInt(spent.n) >= receipt.amount, 'collection balance exceeded')
  const repoId = receipt.attribution.repoId
  if (collection.role === 'creator') {
    const { rows: [beneficiary] } = await db.query('select wallet,bound_at from repo_beneficiaries where github_repo_id=$1 for share', [repoId])
    check(beneficiary?.wallet === receipt.beneficiary && beneficiary.bound_at.toISOString() === receipt.beneficiaryBoundAt, 'beneficiary binding changed')
    const { rows: [liability] } = await db.query(`select
      (select coalesce(sum(amount_base_units),0) from builder_fee_credits where github_repo_id=$1) -
      (select coalesce(sum(amount_base_units),0) from repo_claims where github_repo_id=$1 and status='settled') -
      (select coalesce(sum(amount),0) from builder_fee_collections where github_repo_id=$1 and status='settled') as available,
      (select count(*) from repo_claims where github_repo_id=$1 and status='pending') +
      (select count(*) from builder_fee_collections where github_repo_id=$1 and status='pending') as pending`, [repoId])
    check(Number(liability.pending) === 0 && BigInt(liability.available) >= receipt.amount, 'entitlement balance unavailable')
  } else {
    check(partnerBeneficiary && partnerBeneficiary === receipt.beneficiary && partnerBeneficiary !== CUSTODY_VAULT,
      'partner beneficiary policy required')
  }
  await db.query(`insert into custody_fee_payouts(signature,collection_signature,beneficiary,amount,slot,receipt)
    values($1,$2,$3,$4,$5,$6)`, [receipt.signature, receipt.collectionSignature, receipt.beneficiary, String(receipt.amount), receipt.slot, json(receipt)])
  if (collection.role === 'creator') await db.query(`insert into repo_claims
    (github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at,damm_amount_base_units,evidence_source,custody_payout_signature)
    values($1,$2,$3,$4,$5,'settled',now(),$3,'custody-receipt',$5)`,
    [repoId, receipt.beneficiary, String(receipt.amount), NATIVE_MINT.toBase58(), receipt.signature])
  return { inserted: true }
}
