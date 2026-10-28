// Public projection for the one price source (migrations 0089/0090). The public site reads through
// repoing_operational_public_reader (search_path site_public): views owned by repoing_site_view_owner, security_barrier,
// each granted to the reader. This appends price_sol to the four trade views (CREATE OR REPLACE from their live
// definitions, so filters, owner and grants stay as they are) and adds mint_facts, sol_usd_minutes and trade_prices
// (only markets the projection's own markets view shows). DATABASE_URL: the owner. node price-projection.mjs dry|commit
import pg from 'pg'

const [mode] = process.argv.slice(2)
if (!['dry', 'commit'].includes(mode)) throw Error('Usage: price-projection.mjs dry|commit')
const VIEW_OWNER = 'repoing_site_view_owner', READER = 'repoing_operational_public_reader'
const TRADE_VIEWS = ['trade_events', 'damm_trade_events', 'live_trade_events', 'hook_lab_coin_trades']
const NEW_VIEWS = {
  mint_facts: 'SELECT mint, decimals, supply, slot, read_at FROM public.mint_facts',
  sol_usd_minutes: 'SELECT minute, usd, source FROM public.sol_usd_minutes',
  trade_prices: `SELECT mint, venue, pool, signature, event_index, slot, traded_at, direction, quote_amount, base_amount, price_sol, trader
    FROM public.trade_prices WHERE mint IN (SELECT m.mint FROM site_public.markets m)`,
}
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect()
try {
  await db.query('begin')
  await db.query("set local search_path = public, pg_catalog")
  for (const t of TRADE_VIEWS) await db.query(`GRANT SELECT (price_sol) ON public.${t} TO ${VIEW_OWNER}`)
  await db.query(`GRANT SELECT ON public.mint_facts, public.sol_usd_minutes, public.trade_prices TO ${VIEW_OWNER}`)
  // The owner administers the view-owner role without SET; take SET for this transaction only (revoked below).
  await db.query(`GRANT ${VIEW_OWNER} TO current_user WITH SET TRUE`)
  await db.query(`set local role ${VIEW_OWNER}`)
  const changed = []
  for (const t of TRADE_VIEWS) {
    const { rows: [v] } = await db.query(`select pg_get_viewdef($1::regclass) as def,
      exists(select 1 from information_schema.columns where table_schema='site_public' and table_name=$2 and column_name='price_sol') as has`, [`site_public.${t}`, t])
    if (v.has) { changed.push(`${t}: already has price_sol`); continue }
    // A projected view reads its base table; a typed-empty one (live and Hooks trades, never public) stays empty.
    const from = v.def.indexOf('\n   FROM '), empty = v.def.trimEnd().endsWith('WHERE false;') && from < 0 ? v.def.lastIndexOf('\n  WHERE false') : -1
    if (from < 0 && empty < 0) throw Error(`site_public.${t}: unexpected definition shape`)
    const def = from >= 0 ? `${v.def.slice(0, from)},\n    price_sol${v.def.slice(from)}` : `${v.def.slice(0, empty)},\n    NULL::numeric AS price_sol${v.def.slice(empty)}`
    await db.query(`CREATE OR REPLACE VIEW site_public.${t} WITH (security_barrier = true) AS ${def.trimEnd().replace(/;$/, '')}`)
    changed.push(`${t}: + price_sol`)
  }
  for (const [name, sql] of Object.entries(NEW_VIEWS)) {
    await db.query(`CREATE OR REPLACE VIEW site_public.${name} WITH (security_barrier = true) AS ${sql}`)
    await db.query(`GRANT SELECT ON site_public.${name} TO ${READER}`)
    changed.push(`${name}: view`)
  }
  await db.query('reset role')
  await db.query(`REVOKE SET OPTION FOR ${VIEW_OWNER} FROM current_user`)
  const { rows: check } = await db.query(`select c.relname as view, c.relowner::regrole::text as owner, has_table_privilege($1, c.oid, 'SELECT') as reader,
      coalesce(c.reloptions @> array['security_barrier=true'], false) as barrier,
      exists(select 1 from information_schema.columns i where i.table_schema='site_public' and i.table_name=c.relname and i.column_name='price_sol') as price_sol
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='site_public' and c.relname = any($2) order by 1`,
  [READER, [...TRADE_VIEWS, ...Object.keys(NEW_VIEWS)]])
  const { rows: [counts] } = await db.query(`select (select count(*) from site_public.trade_prices) as trade_prices, (select count(*) from site_public.mint_facts) as mint_facts,
    (select count(*) from site_public.trade_events where price_sol is not null) as priced_curve`)
  const { rows: [m] } = await db.query(`select set_option, admin_option, inherit_option from pg_auth_members where roleid=$1::regrole and member=current_user::regrole`, [VIEW_OWNER])
  console.log(JSON.stringify({ mode, changed, check, counts, ownerMembershipAfter: m }, null, 1))
  await db.query(mode === 'commit' ? 'commit' : 'rollback')
} catch (error) { await db.query('rollback').catch(() => {}); console.log('FAILED (rolled back):', error.message); process.exitCode = 1 }
finally { await db.end() }
