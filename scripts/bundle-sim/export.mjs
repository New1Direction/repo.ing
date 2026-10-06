// Read-only export of the public trade history the simulation replays (pool, time, direction, amounts; no wallets).
// Runs on the web service: B64=$(base64 < scripts/bundle-sim/export.mjs | tr -d '\n'); railway ssh ... -- "echo $B64 | base64 -d | node --input-type=module" > trades.json
import pg from 'pg'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('sslmode') ? undefined : false })
await client.connect()
try {
  await client.query('begin read only')
  const dcols = await client.query("select column_name from information_schema.columns where table_name = 'damm_trade_events' order by ordinal_position")
  const markets = await client.query(`select pool, mint, token_symbol, status, extract(epoch from launch_block_time)::bigint launched, launch_signature
    from markets where quote_mint is null and pool is not null and launch_block_time is not null order by launch_block_time`)
  const trades = await client.query(`select t.pool, extract(epoch from t.traded_at)::bigint t, t.direction d, t.input_base_units i, t.output_base_units o, t.next_sqrt_price p,
    (t.signature = m.launch_signature) launch from trade_events t join markets m on m.pool = t.pool where m.quote_mint is null order by t.pool, t.slot, t.event_index`)
  const out = { dammColumns: dcols.rows.map(r => r.column_name), markets: markets.rows.map(({ launch_signature, ...m }) => ({ ...m, launched: Number(m.launched) })),
    trades: trades.rows.map(r => [r.pool, Number(r.t), r.d, r.i, r.o, r.p, r.launch]) }
  process.stdout.write(JSON.stringify(out))
} finally { await client.query('rollback').catch(() => {}); await client.end() }
