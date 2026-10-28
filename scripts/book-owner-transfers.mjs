// One-off owner bookings (owner 2026-10-28: "Book as paid to me"). DATABASE_URL: the owner role (or a Neon branch of it).
//   node scripts/book-owner-transfers.mjs dry|commit [DAMM_CLAIM_SIGNATURE ...]
// 1. Every custody collection still held (the 2026-10-26 vault sweep 4wCQ1y8y… moved all of it to the team wallet in one
//    transaction) becomes a custody_owner_transfers row (migration 0090): paid out of custody, a creator's entitlement settled.
//    The total must equal the sweep's 6.666505574 SOL exactly.
// 2. Each repo.ing graduated claim the vault made (scripts/collect-vault-creator-fees.mjs damm-collect) is booked from its own
//    finalized events: the creator position as a historical-receipt builder_fee_collections row, the partner position as a
//    DAMM platform_fee_claims row, both to the team wallet. dry runs everything and rolls back.
import { createHash } from 'node:crypto'
import pg from 'pg'
import bs58 from 'bs58'

const SWEEP = '4wCQ1y8yRqRtiCehbyEYHeWeiVjCREEbuyUtBVvWJUvpFn3bEzvUPr29CPN4u8EY5Mh9czMwwofCowePoKSAQpAQ', SWEEP_LAMPORTS = 6666505574n
const TEAM = '4euCWuZo1Ud3PfhFQr9ShmJVzqmARGqY2LR23YECDYce', VAULT = '3dHCTpgdx15yXyVGh7DK1woQ1XisQpmFCxncURrq63Gs'
const REPO = '1388219884', CP_AMM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', EVENT = Buffer.from('e445a52e51cb9a1dc6b6b734610c3138', 'hex')
const DECISION = 'owner 2026-10-28: "Book as paid to me"'
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const [mode, ...claims] = process.argv.slice(2)
if (!['dry', 'commit'].includes(mode)) throw Error('Usage: book-owner-transfers.mjs dry|commit [DAMM_CLAIM_SIGNATURE ...]')
const check = (ok, message) => { if (!ok) throw Error(message) }
const sha256 = text => createHash('sha256').update(text).digest('hex')

async function claimEvents(signature) {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1,
    method: 'getTransaction', params: [signature, { commitment: 'finalized', encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }] }) })
  const tx = (await response.json()).result
  check(tx && tx.meta?.err === null, `claim ${signature} not finalized or failed`)
  const events = []
  for (const group of tx.meta.innerInstructions ?? []) for (const ix of group.instructions) {
    if (ix.programId !== CP_AMM || typeof ix.data !== 'string') continue
    const data = Buffer.from(bs58.decode(ix.data))
    if (data.length === 128 && data.subarray(0, 16).equals(EVENT)) events.push({ pool: bs58.encode(data.subarray(16, 48)),
      position: bs58.encode(data.subarray(48, 80)), owner: bs58.encode(data.subarray(80, 112)), base: data.readBigUInt64LE(112), quote: data.readBigUInt64LE(120) })
  }
  return { tx, events }
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
try {
  await db.query('begin')
  // 1. The sweep's custody collections.
  const { rows: held } = await db.query(`select c.signature, c.item_index, c.github_repo_id::text as repo, c.role, (c.amount
      - coalesce((select sum(p.amount) from custody_fee_payouts p where p.collection_signature=c.signature and p.collection_item_index=c.item_index),0)
      - coalesce((select sum(o.amount) from custody_owner_transfers o where o.collection_signature=c.signature and o.collection_item_index=c.item_index),0))::text as held
    from custody_fee_collections c order by c.github_repo_id, c.signature, c.item_index`)
  const open = held.filter(r => BigInt(r.held) > 0n), total = open.reduce((n, r) => n + BigInt(r.held), 0n)
  check(open.length === 0 || total === SWEEP_LAMPORTS, `held custody ${total} differs from the sweep ${SWEEP_LAMPORTS}`)
  for (const r of open) await db.query(`insert into custody_owner_transfers(collection_signature, collection_item_index, github_repo_id, role, amount,
    transfer_signature, recipient, decision) values($1,$2,$3,$4,$5,$6,$7,$8)`, [r.signature, r.item_index, r.repo, r.role, r.held, SWEEP, TEAM, `${DECISION} (2026-10-26 vault sweep)`])
  // 2. repo.ing's graduated claims.
  const { rows: [market] } = await db.query(`select m.mint, m.pool as curve, g.pool, p.creator_position, p.partner_position from markets m
    join graduation_events g on g.github_repo_id=m.github_repo_id join graduated_migration_proofs p on p.github_repo_id=m.github_repo_id where m.github_repo_id=$1`, [REPO])
  const booked = []
  for (const signature of claims) {
    const exists = (await db.query(`select (select count(*) from builder_fee_collections where signature=$1) + (select count(*) from platform_fee_claims where signature=$1) as n`, [signature])).rows[0]
    if (Number(exists.n) > 0) { booked.push({ signature, skipped: 'already booked' }); continue }
    const { tx, events } = await claimEvents(signature)
    const creator = events.find(e => e.position === market.creator_position), partner = events.find(e => e.position === market.partner_position)
    check(events.length === 2 && creator && partner && events.every(e => e.pool === market.pool && e.owner === VAULT && e.base === 0n && e.quote > 0n),
      `claim ${signature} is not exactly repo.ing's two vault positions`)
    const transactionHash = sha256(JSON.stringify(tx))
    const terms = JSON.stringify({ purpose: 'historical-damm-receipt-v1', signature, transactionHash, repoId: REPO, mint: market.mint, curve: market.curve,
      pool: market.pool, position: market.creator_position, source: VAULT, receiver: TEAM, amount: String(creator.quote), dammClaimed: String(creator.quote),
      originalIntentAvailable: false, decision: DECISION })
    const receipt = JSON.stringify({ status: 'settled', evidenceSource: 'historical-receipt', originalIntentAvailable: false, signature, slot: tx.slot,
      amount: String(creator.quote), dammClaimed: String(creator.quote), receiver: TEAM, position: market.creator_position, pool: market.pool, transactionHash,
      decision: DECISION, transaction: tx })
    await db.query(`insert into builder_fee_collections(id, github_repo_id, mint, pool, wallet, amount, status, terms, terms_hash, signature, receipt, settled_at, evidence_source)
      values(gen_random_uuid(), $1, $2, $3, $4, $5, 'settled', $6, $7, $8, $9, now(), 'historical-receipt')`,
    [REPO, market.mint, market.curve, TEAM, String(creator.quote), terms, sha256(terms), signature, receipt])
    await db.query(`insert into platform_fee_claims(github_repo_id, pool, wallet, amount, status, signature, signed_transaction, last_valid_block_height, settled_at, phase)
      values($1, $2, $3, $4, 'settled', $5, 'OFFLINE_RECOVERY_ARCHIVE_NOT_EXECUTABLE', 0, now(), 'DAMM')`, [REPO, market.pool, TEAM, String(partner.quote), signature])
    booked.push({ signature, creator: String(creator.quote), partner: String(partner.quote) })
  }
  const { rows: [after] } = await db.query(`select (select coalesce(sum(amount),0) from custody_fee_collections) - (select coalesce(sum(amount),0) from custody_fee_payouts)
    - (select coalesce(sum(amount),0) from custody_owner_transfers) as custody_held`)
  console.log(JSON.stringify({ mode, ownerTransfers: { rows: open.length, repos: new Set(open.map(r => r.repo)).size, lamports: String(total) }, repoing: booked,
    custodyHeldAfter: String(after.custody_held) }))
  await db.query(mode === 'commit' ? 'commit' : 'rollback')
} catch (error) { await db.query('rollback').catch(() => {}); throw error }
finally { await db.end() }
