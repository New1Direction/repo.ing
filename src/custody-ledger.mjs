import { isDeepStrictEqual } from 'node:util'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token'
import { CUSTODY_VAULT } from './custody-settlement.mjs'

const json = value => JSON.parse(JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? String(v) : v))
const check = (value, message) => { if (!value) throw Error(`Custody ${message}`) }

// Legacy consumers use collected as DAMM withdrawals. Fail closed once DBC exists
// until they explicitly select all (held liabilities) or DAMM (source withdrawals).
export async function custodyBalance(db, repoId, { phase = null } = {}) {
  check([null, 'all', 'DAMM', 'DBC'].includes(phase), 'invalid balance phase')
  if (phase === null) check(!(await db.query("select 1 from custody_fee_collections where github_repo_id=$1 and phase='DBC' limit 1", [String(repoId)])).rows.length,
    'balance phase selection required for DBC collections')
  // Owner-booked transfers (migration 0090) leave custody like payouts.
  const { rows } = await db.query(`select c.role,coalesce(sum(c.amount),0)::text as collected,
    coalesce(sum((select coalesce(sum(p.amount),0) from custody_fee_payouts p
      where p.collection_signature=c.signature and p.collection_item_index=c.item_index)
      + (select coalesce(sum(o.amount),0) from custody_owner_transfers o
      where o.collection_signature=c.signature and o.collection_item_index=c.item_index)),0)::text as paid
    from custody_fee_collections c where c.github_repo_id=$1 and ($2='all' or c.phase=$2) group by c.role`, [String(repoId), phase ?? 'DAMM'])
  const totals = { creator: { collected: 0n, paid: 0n, held: 0n }, partner: { collected: 0n, paid: 0n, held: 0n } }
  for (const row of rows) {
    const collected = BigInt(row.collected), paid = BigInt(row.paid)
    check(paid <= collected, 'balance is overdrawn')
    totals[row.role] = { collected, paid, held: collected - paid }
  }
  return totals
}

// Whether a market still has collected fees held in custody (not yet paid to its beneficiary); only then does its
// reconciliation depend on the vault holding them.
export const holdsCustodyFunds = funds => !!funds && (funds.creator.held > 0n || funds.partner.held > 0n)

export async function verifyCustodySolvency(db, connection) {
  const { rows: [row] } = await db.query(`select
    (select coalesce(sum(amount),0) from custody_fee_collections) -
    (select coalesce(sum(amount),0) from custody_fee_payouts) -
    (select coalesce(sum(amount),0) from custody_owner_transfers) as held`)
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
  if (a.phase === 'DBC') {
    check(a.config && !a.position, 'DBC attribution mismatch')
  } else {
    check(a.phase === undefined || a.phase === 'DAMM', 'unsupported attribution phase')
    const { rows: [proof] } = await db.query('select creator_position,partner_position from graduated_migration_proofs where github_repo_id=$1', [a.repoId])
    check(proof && a.position === proof[`${a.role}_position`], 'position attribution mismatch')
  }
}

// Separate two-int advisory-lock namespace; all repo locks precede signature locks.
async function lockSignatures(db, signatures) {
  for (const signature of [...new Set(signatures)].sort())
    await db.query('select pg_advisory_xact_lock(188212,hashtext($1))', [signature])
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
  await lockSignatures(db, [receipt.signature])
  check(receipt.kind === 'vault-wsol-fee-collection' && receipt.owner === CUSTODY_VAULT && receipt.beneficiaryPaid === false,
    'collection cannot be treated as payment')
  check(receipt.attribution.phase !== 'DBC' && receipt.itemIndex === undefined, 'DBC collection requires atomic batch writer')
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

export async function recordDbcCustodyBatchCollection(db, receipt) {
  check(receipt.kind === 'vault-wsol-dbc-collection-batch' && receipt.owner === CUSTODY_VAULT &&
    receipt.beneficiaryPaid === false && receipt.vaultControlVerified === true &&
    Array.isArray(receipt.items) && receipt.items.length > 0 && receipt.items.length <= 2, 'batch is not verified')
  const items = receipt.items
  check(items.every((item, i) => item.itemIndex === i && item.phase === 'DBC' && item.attribution?.phase === 'DBC' &&
    item.attribution.role === items[0].attribution.role && item.signature === receipt.signature && item.slot === receipt.slot &&
    item.kind === 'vault-wsol-fee-collection' && item.owner === CUSTODY_VAULT && item.beneficiaryPaid === false &&
    Array.isArray(item.instructionPath) && Array.isArray(item.eventPath)) &&
    new Set(items.map(i => i.attribution.curve)).size === items.length &&
    new Set(items.map(i => JSON.stringify(i.eventPath))).size === items.length &&
    new Set(items.map(i => JSON.stringify(i.instructionPath))).size === items.length &&
    items.reduce((sum, i) => sum + i.amount, 0n) === receipt.amount, 'batch items mismatch')
  for (const item of [...items].sort((a, b) => BigInt(a.attribution.repoId) < BigInt(b.attribution.repoId) ? -1 : 1))
    await lockAndBind(db, item)
  await lockSignatures(db, [receipt.signature])
  const { rows: [existing] } = await db.query('select receipt from custody_collection_batches where signature=$1', [receipt.signature])
  if (existing) {
    check(isDeepStrictEqual(existing.receipt, json(receipt)), 'receipt conflict')
    const { rows } = await db.query('select receipt from custody_fee_collections where signature=$1 order by item_index', [receipt.signature])
    check(isDeepStrictEqual(rows.map(r => r.receipt), json(items)), 'batch item conflict')
    return { inserted: false }
  }
  await rejectOtherLedger(db, receipt.signature)
  check(!(await db.query(`select signature from custody_fee_collections where signature=$1
    union all select signature from custody_fee_payouts where signature=$1`, [receipt.signature])).rows.length, 'signature conflict')
  await db.query(`insert into custody_collection_batches(signature,item_count,amount,slot,receipt) values($1,$2,$3,$4,$5)`,
    [receipt.signature, items.length, String(receipt.amount), receipt.slot, json(receipt)])
  for (const item of items) await db.query(`insert into custody_fee_collections
    (signature,item_index,phase,batch_signature,github_repo_id,role,position,amount,slot,receipt)
    values($1,$2,'DBC',$1,$3,$4,null,$5,$6,$7)`,
    [item.signature, item.itemIndex, item.attribution.repoId, item.attribution.role, String(item.amount), item.slot, json(item)])
  return { inserted: true }
}

export async function recordCustodyPayout(db, receipt, { partnerBeneficiary = null } = {}) {
  await lockAndBind(db, receipt)
  await lockSignatures(db, [receipt.signature, receipt.collectionSignature])
  check(receipt.kind === 'vault-wsol-beneficiary-payment' && receipt.beneficiaryPaid === true, 'payout is not verified')
  const dbc = receipt.attribution.phase === 'DBC', itemIndex = dbc ? receipt.collectionItemIndex : -1
  check(dbc ? Number.isInteger(itemIndex) && itemIndex >= 0 && itemIndex <= 1 : receipt.collectionItemIndex === undefined,
    'collection item required only for DBC')
  const { rows: [existing] } = await db.query('select receipt from custody_fee_payouts where signature=$1', [receipt.signature])
  if (existing) {
    check(isDeepStrictEqual(existing.receipt, json(receipt)), 'receipt conflict')
    return { inserted: false }
  }
  const { rows: [collection] } = await db.query('select * from custody_fee_collections where signature=$1 and item_index=$2 for update', [receipt.collectionSignature, itemIndex])
  check(collection && isDeepStrictEqual(collection.receipt.attribution, json(receipt.attribution)) &&
    BigInt(collection.slot) <= BigInt(receipt.slot), 'collection attribution mismatch')
  await rejectOtherLedger(db, receipt.signature)
  check(!(await db.query('select signature from custody_fee_collections where signature=$1', [receipt.signature])).rows.length, 'signature conflict')
  const { rows: [spent] } = await db.query('select coalesce(sum(amount),0)::text as n from custody_fee_payouts where collection_signature=$1 and collection_item_index=$2', [receipt.collectionSignature, itemIndex])
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
  await db.query(`insert into custody_fee_payouts(signature,collection_signature,collection_item_index,beneficiary,amount,slot,receipt)
    values($1,$2,$3,$4,$5,$6,$7)`, [receipt.signature, receipt.collectionSignature, itemIndex, receipt.beneficiary, String(receipt.amount), receipt.slot, json(receipt)])
  if (collection.role === 'creator') await db.query(`insert into repo_claims
    (github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at,damm_amount_base_units,evidence_source,custody_payout_signature)
    values($1,$2,$3,$4,$5,'settled',now(),$6,$7,$5)`,
    [repoId, receipt.beneficiary, String(receipt.amount), NATIVE_MINT.toBase58(), receipt.signature,
      dbc ? '0' : String(receipt.amount), dbc ? 'custody-dbc-receipt' : 'custody-receipt'])
  return { inserted: true }
}
