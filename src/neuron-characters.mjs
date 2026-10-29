// Metadata publishing only. No mint, pool, transaction, fee or signer integration.
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { findPersona, validateNeuronDraft } from '../app/lib/neurons-preview.mjs'
import { personalityImportSchema } from '../app/lib/neuron-import.mjs'

const submission = z.union([
  z.object({ requestId: z.string().uuid(), personaId: z.string().max(40),
    name: z.string().max(40), ticker: z.string().max(10), story: z.string().max(280), consent: z.literal(true) }).strict(),
  z.object({ requestId: z.string().uuid(), personality: personalityImportSchema, consent: z.literal(true) }).strict(),
])
export const characterId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const fail = (message, status) => Object.assign(Error(message), { status })
const hash = snapshot => createHash('sha256').update(JSON.stringify(snapshot, (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value)).digest('hex')

export function characterSubmission(input) {
  const value = submission.parse(input)
  if (value.personality) {
    const { name, ticker, story } = value.personality
    const snapshot = { version: 2, name, ticker, story, personality: value.personality, chatMode: 'unavailable' }
    return { requestId: value.requestId, snapshot, metadataSha256: hash(snapshot) }
  }
  const draft = validateNeuronDraft(value)
  if (!draft || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(draft.name + draft.story)) throw fail('Invalid character details.', 400)
  const persona = findPersona(draft.personaId)
  const snapshot = { version: 1, ...draft, chatMode: 'reviewed-scripts-v1', source: 'https://qwen-neurons-site.vercel.app',
    recipe: { model: 'Qwen3-8B', modelRevision: null, status: 'imported', layer: persona.layer, neuron: persona.neuron, direction: persona.direction, alpha: persona.alpha } }
  return { requestId: value.requestId, snapshot, metadataSha256: hash(snapshot) }
}

function view(row) {
  if (!row) return null
  const { personaId, name, ticker, story } = row.snapshot
  const canonical = characterSubmission({ ...(row.snapshot.version === 2 ? { personality: row.snapshot.personality }
    : { personaId, name, ticker, story }), requestId: row.request_id, consent: true })
  if (canonical.metadataSha256 !== row.metadata_sha256 || hash(row.snapshot) !== row.metadata_sha256) throw Error('Character integrity check failed')
  return { id: row.id, ...canonical.snapshot, creatorWallet: row.creator_wallet, metadataSha256: row.metadata_sha256,
    status: row.status, createdAt: new Date(row.created_at).toISOString(), reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    mint: null, financialExecutionEnabled: false }
}

export function neuronCharacterStore(pool) {
  return {
    async list(wallet = null) {
      const { rows } = await pool.query(wallet
        ? 'select * from neuron_characters where creator_wallet=$1 order by created_at desc limit 100'
        : "select * from neuron_characters where status='published' order by created_at desc limit 100", wallet ? [wallet] : [])
      return rows.map(view)
    },
    async publicById(id) {
      if (!characterId(id)) return null
      const { rows } = await pool.query("select * from neuron_characters where id=$1 and status='published'", [id])
      return view(rows[0])
    },
    async submit(wallet, input) {
      const value = characterSubmission(input), client = await pool.connect()
      try {
        await client.query('begin')
        // Serialize insert limits AND idempotency across replicas; never trust client counters.
        await client.query("select pg_advisory_xact_lock(hashtext('neuron-character-publishing-v1'))")
        const prior = await client.query('select * from neuron_characters where creator_wallet=$1 and request_id=$2', [wallet, value.requestId])
        if (prior.rows.length) {
          if (prior.rows[0].metadata_sha256 !== value.metadataSha256) throw fail('This submission ID already belongs to different details.', 409)
          await client.query('commit'); return view(prior.rows[0])
        }
        const { rows: [limits] } = await client.query(`select count(*)::int as total,
          count(*) filter(where created_at >= date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC')::int as today,
          count(*) filter(where creator_wallet=$1 and created_at >= date_trunc('day', clock_timestamp() at time zone 'UTC') at time zone 'UTC')::int as owner_today,
          count(*) filter(where creator_wallet=$1 and status='pending')::int as pending from neuron_characters`, [wallet])
        if (limits.total >= 10000 || limits.today >= 100 || limits.owner_today >= 3 || limits.pending >= 2) throw fail('Publishing limit reached. Try another day or wait for review.', 429)
        const { rows } = await client.query('insert into neuron_characters(id,creator_wallet,request_id,snapshot,metadata_sha256) values($1,$2,$3,$4,$5) returning *',
          [randomUUID(), wallet, value.requestId, value.snapshot, value.metadataSha256])
        await client.query('commit'); return view(rows[0])
      } catch (error) { await client.query('rollback').catch(() => {}); throw error }
      finally { client.release() }
    },
    async review(id, decision, reason) {
      if (!characterId(id) || !['published', 'rejected'].includes(decision) || typeof reason !== 'string' || reason.trim().length < 10 || reason.length > 500) throw fail('Valid ID, decision and 10–500 character review reason required.', 400)
      const client = await pool.connect()
      try {
        await client.query('begin')
        const { rows } = await client.query('select * from neuron_characters where id=$1 for update', [id])
        if (!rows.length) throw fail('Character not found.', 404)
        view(rows[0])
        await client.query('insert into neuron_character_reviews(character_id,decision,reason) values($1,$2,$3)', [id, decision, reason.trim()])
        const result = await client.query('update neuron_characters set status=$2,reviewed_at=clock_timestamp() where id=$1 returning *', [id, decision])
        await client.query('commit'); return view(result.rows[0])
      } catch (error) { await client.query('rollback').catch(() => {}); throw error }
      finally { client.release() }
    },
  }
}
