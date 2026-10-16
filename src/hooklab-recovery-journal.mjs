// Durable storage only, not a transaction policy/receipt verifier or broadcast service.
// No public write route until authenticated wallet binding and chain verification exist.
import { createHash, createPublicKey, verify } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { z } from 'zod'
import { HARDENED_MANIFEST_SHA256, hardenedKey, hardenedU64 } from './hooklab-hardened.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const ownerSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const fail = (message, status = 409) => Object.assign(new Error(message), { status })
const termsSchema = z.object({
  schema: z.literal('repoing/hardened-recovery/1'), network: z.literal('devnet'),
  genesisHash: z.literal('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
  manifestSha256: z.literal(HARDENED_MANIFEST_SHA256), operation: z.enum(['launch', 'buy', 'sell']),
  wallet: hardenedKey, mint: hardenedKey, pool: hardenedKey,
  observedSlot: hardenedU64, lastValidBlockHeight: hardenedU64,
  accountsSha256: hash, policySha256: hash,
  maxInput: hardenedU64, minimumOutput: hardenedU64, maxNativeDebitLamports: hardenedU64,
  messageBase64: z.string().max(1644),
}).strict()
function bytes(value) {
  const text = z.string().min(1).max(1644).parse(value)
  const data = Buffer.from(text, 'base64')
  if (data.length > 1232 || data.toString('base64') !== text) throw fail('Invalid canonical wire bytes', 400)
  return data
}

export function hookLabRecoveryJournal(pool) {
  async function transaction(owner, id, fn) {
    ownerSchema.parse(owner); z.uuid().parse(id)
    const db = await pool.connect()
    try {
      await db.query('begin')
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`hooklab-recovery:${id}`])
      const row = (await db.query('select * from hook_lab_recovery_journal where id=$1', [id])).rows[0]
      if (row && row.github_user_id !== owner) throw fail('Recovery entry unavailable', 404)
      const result = await fn(db, row)
      await db.query('commit')
      return result
    } catch (error) { await db.query('rollback'); throw error }
    finally { db.release() }
  }
  return {
    async prepare(owner, id, input) {
      const terms = termsSchema.parse(input), message = bytes(terms.messageBase64)
      const decoded = VersionedMessage.deserialize(message)
      if (decoded.version !== 0 || decoded.staticAccountKeys[0]?.toBase58() !== terms.wallet
        || !decoded.header.numRequiredSignatures || decoded.header.numReadonlySignedAccounts >= decoded.header.numRequiredSignatures
        || !Buffer.from(decoded.serialize()).equals(message)
        || new VersionedTransaction(decoded).serialize().length > 1232) throw fail('Message/payer mismatch', 400)
      const messageHash = digest(message)
      return transaction(owner, id, async (db, row) => {
        if (row) {
          if (!isDeepStrictEqual(row.terms, terms)) throw fail('Recovery identity or reviewed message changed')
          return row
        }
        const saved = (await db.query(`insert into hook_lab_recovery_journal
          (id,github_user_id,manifest_sha256,genesis_hash,operation,mint,message_sha256,terms,status)
          values($1,$2,$3,$4,$5,$6,$7,$8,'prepared') returning *`,
        [id, owner, terms.manifestSha256, terms.genesisHash, terms.operation, terms.mint, messageHash, terms])).rows[0]
        await db.query(`insert into hook_lab_recovery_events(journal_id,kind) values($1,'prepared')`, [id])
        return saved
      })
    },
    // Call BEFORE broadcast. A lost HTTP/RPC response cannot make this intent safe to relaunch.
    // Signature validation establishes possession and byte identity, NOT safe economics or authority to execute.
    async recordSigned(owner, id, signedBase64) {
      const wire = bytes(signedBase64), signed = VersionedTransaction.deserialize(wire)
      if (!Buffer.from(signed.serialize()).equals(wire)) throw fail('Noncanonical signed transaction')
      return transaction(owner, id, async (db, row) => {
        if (!row) throw fail('Recovery entry unavailable', 404)
        const terms = termsSchema.parse(row.terms)
        if (Buffer.from(signed.message.serialize()).toString('base64') !== terms.messageBase64
          || digest(signed.message.serialize()) !== row.message_sha256) throw fail('Signed message differs from journal')
        const keys = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures)
        if (keys.length !== signed.signatures.length || !keys.length) throw fail('Invalid signer count')
        for (const [index, key] of keys.entries()) {
          const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.toBuffer()]), format: 'der', type: 'spki' })
          if (!verify(null, signed.message.serialize(), publicKey, signed.signatures[index])) throw fail('Invalid wallet signature')
        }
        const signature = bs58.encode(signed.signatures[0])
        if (row.status === 'unresolved') {
          if (row.signed_transaction !== signedBase64) throw fail('Different signed transaction already recorded')
          return row
        }
        const saved = (await db.query(`update hook_lab_recovery_journal set status='unresolved',
          signature=$2,signed_transaction=$3,updated_at=now() where id=$1 returning *`, [id, signature, signedBase64])).rows[0]
        await db.query(`insert into hook_lab_recovery_events(journal_id,kind) values($1,'signed')`, [id])
        return saved
      })
    },
    async get(owner, id) {
      ownerSchema.parse(owner); z.uuid().parse(id)
      const row = (await pool.query(`select j.*, coalesce((select json_agg(e order by e.id) from
        (select id,kind,created_at from hook_lab_recovery_events where journal_id=j.id) e),'[]'::json) as events
        from hook_lab_recovery_journal j where j.id=$1 and j.github_user_id=$2`, [id, owner])).rows[0]
      if (!row) return null
      termsSchema.parse(row.terms)
      // No expiration/reset/settlement based on caller claims, elapsed time or missing RPC receipts.
      return { ...row, canRetry: false, canSubmit: false, chainVerified: false }
    },
    async unresolvedCount() {
      return (await pool.query("select count(*)::text as count from hook_lab_recovery_journal where status='unresolved'")).rows[0].count
    },
  }
}
