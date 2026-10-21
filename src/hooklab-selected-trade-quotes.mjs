// Server-owned estimate identity only. No message, signatures, executable minimum or custody.
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
const ready = new WeakSet()
const stores = new WeakSet()
const check = value => { if (!value) throw Error('Selected quote expired, changed or unavailable') }
const intentIdentity = intent => { const { minAmountOut, ...rest } = intent; return JSON.parse(JSON.stringify(rest)) }
export const readySelectedTradeQuoteStore = store => ready.has(store)
export const isSelectedTradeQuoteStore = store => stores.has(store)
export function selectedTradeQuoteStore(pool, { clock = Date.now } = {}) {
  const store = Object.freeze({
    async verifySchema() {
      ready.delete(store)
      await pool.query('select quote_id,owner_wallet,stage,configuration_sha256,intent,selected_authority_evidence,expires_at_ms from hook_lab_selected_trade_quotes limit 0')
      await pool.query('select c.selected_authority_evidence,s.setup_request,o.settlement_context,o.resolved_request from hook_lab_native_signer_custody c cross join hook_lab_selected_hook_setup_intents s cross join hook_lab_native_signing_operations o limit 0')
      const { rows: [row] } = await pool.query(`select count(*)::int n from pg_trigger where (tgrelid,tgname) in (
        ('hook_lab_selected_trade_quotes'::regclass,'hook_lab_selected_quote_immutable'),
        ('hook_lab_native_signer_custody'::regclass,'hook_lab_selected_authority_immutable'),
        ('hook_lab_selected_hook_setup_intents'::regclass,'hook_lab_selected_hook_setup_immutable'),
        ('hook_lab_native_signing_operations'::regclass,'hook_lab_native_signing_identity_immutable'),
        ('hook_lab_native_signing_operations'::regclass,'hook_lab_native_signing_context_immutable')) and tgenabled='O' and not tgisinternal`)
      check(row.n === 5)
      ready.add(store)
    },
    async retain({ id, owner, stage, configurationSha256, intent, selectedAuthorityEvidence, expiresAtMs }) {
      z.uuid().parse(id)
      const now = clock()
      check(Number.isSafeInteger(expiresAtMs) && expiresAtMs > now && expiresAtMs <= now + 300000 && selectedAuthorityEvidence)
      let db
      try {
        db = await pool.connect(); await db.query('begin')
        // Serialize pruning/capacity/insertion across instances; RPC collection never holds this lock.
        await db.query('select pg_advisory_xact_lock(731942812)')
        await db.query('delete from hook_lab_selected_trade_quotes where expires_at_ms <= $1', [now])
        const { rows: [row] } = await db.query('select count(*)::int n from hook_lab_selected_trade_quotes')
        check(row.n < 1000)
        await db.query('insert into hook_lab_selected_trade_quotes(quote_id,owner_wallet,stage,configuration_sha256,intent,selected_authority_evidence,expires_at_ms) values($1,$2,$3,$4,$5,$6,$7)',
          [id, owner, stage, configurationSha256, intentIdentity(intent), selectedAuthorityEvidence, expiresAtMs])
        await db.query('commit')
      } catch (error) { await db?.query('rollback').catch(() => {}); throw error } finally { db?.release() }
    },
    async authorityFor({ id, owner, stage, configurationSha256, intent }) {
      z.uuid().parse(id)
      const { rows: [row] } = await pool.query('select * from hook_lab_selected_trade_quotes where quote_id=$1', [id])
      check(row && row.owner_wallet === owner && row.stage === stage && row.configuration_sha256 === configurationSha256
        && Number(row.expires_at_ms) > clock() && isDeepStrictEqual(row.intent, intentIdentity(intent)))
      return row.selected_authority_evidence
    },
  })
  stores.add(store)
  return store
}
