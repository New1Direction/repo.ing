import { createHash } from 'node:crypto'
import { z } from 'zod'
import { directPlanSchema } from './direct-coins.mjs'

export const directRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), plan: directPlanSchema, id: z.uuid().optional(), revision: z.number().int().positive().optional() }).strict()
    .refine(v => Boolean(v.id) === Boolean(v.revision), 'Draft ID and revision must be supplied together.'),
  z.object({ action: z.literal('inspect'), plan: directPlanSchema, confirmedNetwork: z.literal('devnet') }).strict(),
])
const ownerId = value => z.string().regex(/^[1-9]\d{0,17}$/).parse(String(value))
const fail = (message, status) => Object.assign(new Error(message), { status })

export function directCoinDrafts(pool) {
  const record = async (db, owner, { action, plan, outcome, id = null, revision = null }) => {
    const parsed = directPlanSchema.parse(plan)
    await db.query(`insert into direct_coin_events(github_user_id,draft_id,revision,action,adapter,outcome,plan_hash,plan)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [owner, id, revision, action, parsed.adapter, outcome,
      createHash('sha256').update(JSON.stringify(parsed)).digest('hex'), parsed])
  }
  return {
    async list(owner) {
      owner = ownerId(owner)
      const drafts = (await pool.query(`select id, revision, plan, updated_at from direct_coin_drafts
        where github_user_id=$1 and updated_at > now() - interval '30 days' order by updated_at desc limit 10`, [owner])).rows
      const events = (await pool.query(`select id::text, draft_id, revision, action, adapter, outcome, plan_hash, created_at from direct_coin_events
        where github_user_id=$1 and created_at > now() - interval '30 days' order by id desc limit 50`, [owner])).rows
      return { drafts, events }
    },
    async save(owner, input) {
      owner = ownerId(owner)
      const request = directRequestSchema.parse(input)
      if (request.action !== 'save') throw fail('Expected save.', 400)
      const db = await pool.connect()
      try {
        await db.query('begin')
        await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`direct-coin:${owner}`])
        await db.query(`delete from direct_coin_drafts where updated_at < now() - interval '30 days'`)
        await db.query(`delete from direct_coin_events where created_at < now() - interval '30 days'`)
        let row
        if (request.id) {
          row = (await db.query(`update direct_coin_drafts set plan=$1, revision=revision+1, updated_at=now()
            where id=$2 and github_user_id=$3 and revision=$4 returning id, revision, plan, updated_at`,
          [request.plan, request.id, owner, request.revision])).rows[0]
          if (!row) throw fail('Draft changed or is unavailable. Reload saved drafts before saving again.', 409)
        } else {
          const count = (await db.query('select count(*)::int as n from direct_coin_drafts where github_user_id=$1', [owner])).rows[0].n
          if (count >= 10) throw fail('Ten saved drafts already exist. Resume an existing draft.', 409)
          row = (await db.query('insert into direct_coin_drafts(github_user_id,plan) values($1,$2) returning id, revision, plan, updated_at', [owner, request.plan])).rows[0]
        }
        await record(db, owner, { action: 'save', plan: row.plan, outcome: 'saved', id: row.id, revision: row.revision })
        await db.query('commit')
        return row
      } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
    },
    async recordInspection(owner, plan, outcome) {
      await pool.query(`delete from direct_coin_events where created_at < now() - interval '30 days'`)
      await record(pool, ownerId(owner), { action: 'inspect', plan, outcome })
    },
  }
}
