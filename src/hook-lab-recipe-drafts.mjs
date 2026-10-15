import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { hookLabRecipeSaveSchema, parseHookLabRecipe, serializeHookLabRecipe } from './hook-lab-recipe.mjs'

const ownerId = value => z.string().regex(/^[1-9]\d{0,17}$/).parse(String(value))
const conflict = () => Object.assign(new Error('Recipe changed or is unavailable. Reload before saving.'), { status: 409 })
const decode = row => ({ ...row, envelope: parseHookLabRecipe(JSON.parse(row.envelope)) })

// Separate tables: never reinterpret the narrower direct_coin_drafts.plan column.
// No chain, wallet, inspection or transaction operations belong to this store.
export function hookLabRecipeDrafts(pool) {
  return {
    async list(owner) {
      owner = ownerId(owner)
      const drafts = (await pool.query(`select id, revision, envelope, updated_at from hook_lab_recipe_drafts
        where github_user_id=$1 and updated_at > now() - interval '30 days' order by updated_at desc limit 10`, [owner])).rows.map(decode)
      const events = (await pool.query(`select id::text, draft_id, revision, action, envelope, created_at from hook_lab_recipe_events
        where github_user_id=$1 and created_at > now() - interval '30 days' order by id desc limit 50`, [owner])).rows.map(decode)
      return { drafts, events }
    },
    async save(owner, input) {
      owner = ownerId(owner)
      const { id, revision, envelope } = hookLabRecipeSaveSchema.parse(input)
      const text = serializeHookLabRecipe(envelope)
      const db = await pool.connect()
      try {
        await db.query('begin')
        await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`hook-lab-recipe:${owner}`])
        await db.query(`delete from hook_lab_recipe_drafts where github_user_id=$1 and updated_at <= now() - interval '30 days'`, [owner])
        await db.query(`delete from hook_lab_recipe_events where github_user_id=$1 and created_at <= now() - interval '30 days'`, [owner])
        const current = (await db.query(`select id, revision, envelope, updated_at from hook_lab_recipe_drafts
          where id=$1 and github_user_id=$2 for update`, [id, owner])).rows[0]
        if (current) {
          const existing = decode(current) // Refuse incompatible stored versions; don't overwrite them.
          if (isDeepStrictEqual(existing.envelope, envelope) && (revision === current.revision || revision === current.revision - 1)) {
            await db.query('commit')
            return existing // Same save or retry: no extra revision/event and no expiry extension.
          }
          if (revision !== current.revision) throw conflict()
        } else {
          if (revision !== 0) throw conflict()
          const count = (await db.query('select count(*)::int as n from hook_lab_recipe_drafts where github_user_id=$1', [owner])).rows[0].n
          if (count >= 10) throw Object.assign(new Error('Ten saved recipes already exist. Resume an existing draft.'), { status: 409 })
        }
        const row = current
          ? (await db.query(`update hook_lab_recipe_drafts set envelope=$1, revision=revision+1, updated_at=now()
              where id=$2 and github_user_id=$3 and revision=$4 returning id, revision, envelope, updated_at`, [text, id, owner, revision])).rows[0]
          : (await db.query(`insert into hook_lab_recipe_drafts(id,github_user_id,revision,envelope) values($1,$2,1,$3)
              on conflict(id) do nothing returning id, revision, envelope, updated_at`, [id, owner, text])).rows[0]
        if (!row) throw conflict()
        await db.query(`insert into hook_lab_recipe_events(github_user_id,draft_id,revision,action,envelope) values($1,$2,$3,'save',$4)`, [owner, id, row.revision, text])
        await db.query('commit')
        return decode(row)
      } catch (error) { await db.query('rollback'); throw error } finally { db.release() }
    },
  }
}
