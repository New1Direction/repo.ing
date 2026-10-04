import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFile, mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { POLICY_VERSION, dammCheckpoint, splitCurveFee } from '../src/stock-fee-policy.mjs'

// Migration 0054 (stock ledgers, docs/STOCK_QUOTES.md) on real PostgreSQL. The database is brought to 0053 and seeded with SOL
// rows across the ledgers the stock tables sit beside (trades, curve and DAMM fees, cursors, graduation, claims) plus two
// stock-stamped markets, then upgraded. Every existing row and definition must read back identically, and re-applying the file
// must change nothing. The new tables must be exactly the contract's, accept valid rows, refuse every row their checks and
// triggers refuse, and notify on their own channel.
const DB = 'repoing_stock_ledgers_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const SOL_MINT = 'So11111111111111111111111111111111111111112'
const META = quoteAssetById('meta-xstock'), MSFT = quoteAssetById('msft-xstock')
// facebook/docusaurus (METAx, canonical: confirmed, indexed, finalized), microsoft/vscode (MSFTx, confirmed, not indexed yet),
// octocat/Hello-World (SOL), facebook/react (SOL, a failed launch).
const DOCS = '94911145', VSCODE = '41881900', HELLO = '1296269', REACT = '10270250'
const LAUNCHER = { [DOCS]: 'LauncherDocs', [VSCODE]: 'LauncherVscode', [HELLO]: 'LauncherSol', [REACT]: 'LauncherReact' }
const SEED = `
insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
  (${DOCS},'facebook','docusaurus','facebook/docusaurus',null,null,60000,9000,false,'2026-10-01T00:00:00Z'),
  (${VSCODE},'microsoft','vscode','microsoft/vscode',null,null,180000,35000,false,'2026-10-01T00:00:00Z'),
  (${HELLO},'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
  (${REACT},'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z');
insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
    last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version) values
  (${HELLO},'confirmed','MintSol','PoolSol','LauncherSol','CreatorSol','Hello','HELLO','LaunchSol','Hash',100,10,'finalized',now(),now(),null,null,null),
  (${REACT},'failed',null,null,'LauncherReact','CreatorReact','React','REACT',null,null,null,null,null,null,null,null,null,null),
  (${DOCS},'confirmed','MintDocs','PoolDocs','LauncherDocs','CreatorDocs','Docusaurus','DOCUSAURUS','LaunchDocs','Hash',100,12,'finalized',now(),now(),
    'meta-xstock','${META.mint}',1),
  (${VSCODE},'confirmed','MintVscode','PoolVscode','LauncherVscode','CreatorVscode','VSCode','VSCODE','LaunchVscode','Hash',100,null,null,null,null,
    'msft-xstock','${MSFT.mint}',1);
insert into trade_events(pool,signature,event_index,slot,traded_at,direction,input_base_units,output_base_units,next_sqrt_price,trader) values
  ('PoolSol','TradeSol',0,11,'2026-10-01T00:00:00Z','buy','1000000000','35000000000','123456789','TraderSol');
insert into fee_events(github_repo_id,mint,pool,signature,event_index,amount_base_units,asset,kind,slot) values
  (${HELLO},'MintSol','PoolSol','TradeSol',0,9940000,'${SOL_MINT}','dbc_creator_quote',11);
insert into discovery_fee_events(github_repo_id,pool,signature,event_index,partner_amount,slot,traded_at) values
  (${HELLO},'PoolSol','TradeSol',0,4060000,11,'2026-10-01T00:00:00Z');
insert into pool_fee_cursors(pool,last_signature,last_slot) values ('PoolSol','TradeSol',11);
insert into graduation_observations(github_repo_id,checked_at,status,observation) values (${HELLO},'2026-10-01T00:00:00Z','VERIFIED','{}');
insert into damm_trade_events(github_repo_id,pool,signature,event_index,slot,traded_at,quote_amount,direction,evidence,next_sqrt_price,trader,base_amount) values
  (${HELLO},'DammSol','DammTradeSol',0,30,'2026-10-02T00:00:00Z',500000000,'sell','{}','123456789','TraderSol',1000000);
insert into damm_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence) values
  (${HELLO},'DammSol','PositionSol',31,5000,5000,0,repeat('a',64),'{}');
insert into platform_fee_events(github_repo_id,pool,position,slot,amount_base_units,cumulative_earned,cumulative_claimed,evidence_hash,evidence) values
  (${HELLO},'DammSol','PartnerSol',31,2000,2000,0,repeat('b',64),'{}');
insert into repo_claims(github_repo_id,beneficiary_wallet,amount_base_units,asset,claim_signature,status,settled_at) values
  (${HELLO},'BuilderSol',9940000,'${SOL_MINT}','ClaimSol','settled','2026-10-03T00:00:00Z');`

const STOCK_TABLES = ['stock_canonical_pools', 'stock_damm_fee_checkpoints', 'stock_fee_collections', 'stock_fee_events', 'stock_graduation_events',
  'stock_graduation_observations', 'stock_launcher_payouts', 'stock_pool_cursors', 'stock_settlement_receipts', 'stock_trade_events']
const STOCK_FUNCTIONS = ['repoing_notify_stock_market_update()', 'stock_launcher_payout_wallet_check()', 'stock_ledger_market_check()']

// The contract (columns in order: name, type, "null" when nullable, "= default"), indexes, checks and triggers of each table.
const MARKET = 'github_repo_id bigint; asset_id varchar(32); quote_mint varchar(44)'
const SETTLE = 'status varchar(10); signature varchar(88) null; signed_transaction text null; receipt jsonb null; created_at timestamptz = now(); settled_at timestamptz null'
const MARKET_CHECK = 'stock_ledger_market_check BEFORE INSERT OR UPDATE OF github_repo_id, asset_id, quote_mint FOR EACH ROW EXECUTE FUNCTION stock_ledger_market_check()'
const pending = "WHERE ((status)::text = 'pending'::text)"
const CONTRACT = {
  stock_pool_cursors: { columns: 'pool varchar(44); github_repo_id bigint; venue varchar(4); last_signature varchar(88); last_slot bigint; updated_at timestamptz = now()',
    indexes: ['stock_pool_cursors_pkey unique (pool)'], checks: ['venue'], triggers: [] },
  stock_trade_events: { columns: `id bigint = serial; ${MARKET}; venue varchar(4); pool varchar(44); signature varchar(88); event_index integer; slot bigint; traded_at timestamptz; direction varchar(4); quote_amount bigint; base_amount bigint; next_sqrt_price varchar(40); trader varchar(44); created_at timestamptz = now()`,
    indexes: ['stock_trade_events_chain_event_unique unique (signature, event_index)', 'stock_trade_events_pkey unique (id)', 'stock_trade_events_repo_slot (github_repo_id, slot)'],
    checks: ['amounts', 'direction', 'venue'],
    triggers: ['repoing_stock_trade_update AFTER INSERT FOR EACH ROW EXECUTE FUNCTION repoing_notify_stock_market_update()', MARKET_CHECK] },
  stock_fee_events: { columns: `id bigint = serial; ${MARKET}; pool varchar(44); signature varchar(88); event_index integer; slot bigint; creator_amount bigint; partner_amount bigint; launcher_amount bigint; accumulator_amount bigint; policy_version integer; created_at timestamptz = now()`,
    indexes: ['stock_fee_events_asset (asset_id)', 'stock_fee_events_chain_event_unique unique (signature, event_index)', 'stock_fee_events_pkey unique (id)',
      'stock_fee_events_repo (github_repo_id)'],
    checks: ['amounts', 'launcher', 'split'],
    triggers: ['repoing_stock_fee_update AFTER INSERT FOR EACH ROW EXECUTE FUNCTION repoing_notify_stock_market_update()', MARKET_CHECK] },
  stock_graduation_observations: { columns: `id bigint = serial; ${MARKET}; pool varchar(44); slot bigint; observed_at timestamptz; quote_reserve bigint; migration_threshold bigint; is_migrated boolean`,
    indexes: ['stock_graduation_observations_pkey unique (id)', 'stock_graduation_observations_repo_observed (github_repo_id, observed_at)'],
    checks: ['amounts'], triggers: [MARKET_CHECK] },
  stock_graduation_events: { columns: `${MARKET}; dbc_pool varchar(44); damm_pool varchar(44); migration_signature varchar(88); slot bigint; creator_position varchar(44) null; partner_position varchar(44) null; evidence jsonb; created_at timestamptz = now()`,
    indexes: ['stock_graduation_events_pkey unique (github_repo_id)'], checks: [], triggers: [MARKET_CHECK] },
  stock_damm_fee_checkpoints: { columns: `id bigint = serial; ${MARKET}; damm_pool varchar(44); side varchar(8); position varchar(44); slot bigint; cumulative_earned bigint; cumulative_claimed bigint; credit bigint; launcher_cumulative bigint; launcher_credit bigint; accumulator_credit bigint; policy_version integer; created_at timestamptz = now()`,
    indexes: ['stock_damm_fee_checkpoints_asset (asset_id)', 'stock_damm_fee_checkpoints_pkey unique (id)',
      'stock_damm_fee_checkpoints_pool_side_slot_unique unique (damm_pool, side, slot)', 'stock_damm_fee_checkpoints_repo (github_repo_id)'],
    checks: ['amounts', 'partner', 'side', 'split'], triggers: [MARKET_CHECK] },
  stock_fee_collections: { columns: `id bigint = serial; ${MARKET}; source varchar(16); reviewed_amount bigint; actual_amount bigint null; launcher_amount bigint; accumulator_amount bigint; terms_hash varchar(64); ${SETTLE}`,
    indexes: ['stock_fee_collections_asset_status (asset_id, status)', `stock_fee_collections_one_pending unique (github_repo_id, source) ${pending}`,
      'stock_fee_collections_pkey unique (id)'],
    checks: ['amounts', 'settlement', 'source', 'status'], triggers: [MARKET_CHECK] },
  stock_launcher_payouts: { columns: `id bigint = serial; ${MARKET}; wallet varchar(44); amount bigint; ${SETTLE}`,
    indexes: [`stock_launcher_payouts_one_pending unique (github_repo_id) ${pending}`, 'stock_launcher_payouts_pkey unique (id)',
      'stock_launcher_payouts_repo_status (github_repo_id, status)'],
    checks: ['amount', 'settlement', 'status'],
    triggers: ['stock_launcher_payout_wallet_check BEFORE INSERT OR UPDATE OF github_repo_id, wallet FOR EACH ROW EXECUTE FUNCTION stock_launcher_payout_wallet_check()', MARKET_CHECK] },
  stock_canonical_pools: { columns: 'id bigint = serial; asset_id varchar(32); quote_mint varchar(44); pool varchar(44); repoing_mint varchar(44); position varchar(44) null; evidence jsonb; active boolean = true; registered_at timestamptz = now()',
    indexes: ['stock_canonical_pools_one_active unique (asset_id) WHERE active', 'stock_canonical_pools_pkey unique (id)'], checks: [], triggers: [] },
  stock_settlement_receipts: { columns: 'id bigint = serial; asset_id varchar(32); quote_mint varchar(44); kind varchar(16); signature varchar(88); quote_spent bigint; repoing_spent bigint; repoing_received bigint; evidence jsonb; created_at timestamptz = now()',
    indexes: ['stock_settlement_receipts_pkey unique (id)', 'stock_settlement_receipts_signature_unique unique (signature)'], checks: ['amounts', 'kind'], triggers: [] },
}

// Every definition in the public schema, keyed by object: columns, constraints, indexes, triggers, functions, sequences, relations.
async function catalog(pool) {
  const queries = [
    `select 'col:' || table_name || '.' || column_name as key, concat_ws('|', data_type, character_maximum_length, numeric_precision, is_nullable, column_default) as def
      from information_schema.columns where table_schema = 'public'`,
    `select 'con:' || conrelid::regclass::text || '.' || conname as key, pg_get_constraintdef(oid) as def from pg_constraint where connamespace = 'public'::regnamespace`,
    `select 'idx:' || tablename || '.' || indexname as key, indexdef as def from pg_indexes where schemaname = 'public'`,
    `select 'trg:' || tgrelid::regclass::text || '.' || tgname as key, pg_get_triggerdef(oid) as def from pg_trigger where not tgisinternal`,
    `select 'fn:' || oid::regprocedure::text as key, pg_get_functiondef(oid) as def from pg_proc where pronamespace = 'public'::regnamespace and prokind = 'f'`,
    `select 'seq:' || sequencename as key, concat_ws('|', data_type, start_value, min_value, max_value, increment_by, cycle) as def from pg_sequences where schemaname = 'public'`,
    `select 'rel:' || relname as key, relkind::text as def from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'v', 'm', 'S', 'p')`,
    `select 'view:' || viewname as key, definition as def from pg_views where schemaname = 'public'`,
  ]
  const entries = []
  for (const sql of queries) for (const { key, def } of (await pool.query(sql)).rows) entries.push([key, def])
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)))
}
const isStockObject = key => /^(col|con|idx|trg|seq|rel):stock_/.test(key) || STOCK_FUNCTIONS.some(fn => key === `fn:${fn}`)

async function columnsByRelation(pool) {
  const { rows } = await pool.query(`select c.table_name as name, array_agg(c.column_name::text order by c.ordinal_position) as columns
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type in ('BASE TABLE', 'VIEW') group by c.table_name order by 1`)
  return Object.fromEntries(rows.map(row => [row.name, row.columns]))
}
async function checksums(pool, relations) {
  const sums = {}
  for (const [name, columns] of Object.entries(relations)) {
    const { rows: [row] } = await pool.query(`select count(*)::int as n, md5(coalesce(string_agg(r, E'\\n' order by r), '')) as sum
      from (select row(${columns.map(column => `"${column}"`).join(', ')})::text as r from "${name}") rows`)
    sums[name] = `${row.n}:${row.sum}`
  }
  return sums
}

const insert = (pool, table, values) => {
  const columns = Object.keys(values)
  return pool.query(`insert into "${table}" (${columns.map(column => `"${column}"`).join(', ')}) values (${columns.map((_, i) => `$${i + 1}`).join(', ')}) returning *`,
    columns.map(column => values[column]))
}
async function refused(promise, expected, label) {
  await assert.rejects(promise, error => {
    assert.ok(error.constraint === expected || error.message.includes(expected), `${label}: expected ${expected}, got ${error.message}`)
    return true
  }, label)
}

// A valid row for each table, for the stamped METAx market unless overridden. Signatures, pools and slots are fresh per call.
let serial = 0
const fresh = prefix => `${prefix}${++serial}`
const docs = { github_repo_id: DOCS, asset_id: META.assetId, quote_mint: META.mint }
const vscode = { github_repo_id: VSCODE, asset_id: MSFT.assetId, quote_mint: MSFT.mint }
const CURVE_FEE = { creatorAmount: 994_000n, partnerAmount: 406_000n }
const checkpoint = (side, cumulativeEarned, previous = null) => {
  const { credit, launcherCumulative, launcherCredit, accumulatorCredit } = dammCheckpoint({ side, cumulativeEarned, previous })
  return { damm_pool: 'DammDocs', side, position: `${side}PositionDocs`, cumulative_earned: cumulativeEarned, cumulative_claimed: 0n, credit,
    launcher_cumulative: launcherCumulative, launcher_credit: launcherCredit, accumulator_credit: accumulatorCredit, policy_version: POLICY_VERSION }
}
const ROWS = {
  stock_pool_cursors: over => ({ pool: fresh('CursorPool'), github_repo_id: DOCS, venue: 'dbc', last_signature: 'TradeDocs', last_slot: 1000, ...over }),
  stock_trade_events: over => ({ ...docs, venue: 'dbc', pool: 'PoolDocs', signature: fresh('TradeDocs'), event_index: 0, slot: 1000 + serial,
    traded_at: '2026-10-04T00:00:00Z', direction: 'buy', quote_amount: 100_000_000n, base_amount: 3_500_000_000_000n, next_sqrt_price: '123456789',
    trader: 'TraderDocs', ...over }),
  stock_fee_events: over => {
    const { launcherAmount, accumulatorAmount } = splitCurveFee(CURVE_FEE)
    return { ...docs, pool: 'PoolDocs', signature: fresh('FeeDocs'), event_index: 0, slot: 1000 + serial, creator_amount: CURVE_FEE.creatorAmount,
      partner_amount: CURVE_FEE.partnerAmount, launcher_amount: launcherAmount, accumulator_amount: accumulatorAmount, policy_version: POLICY_VERSION, ...over }
  },
  stock_graduation_observations: over => ({ ...docs, pool: 'PoolDocs', slot: 2000 + ++serial, observed_at: '2026-10-04T01:00:00Z',
    quote_reserve: 50_000_000_000n, migration_threshold: 100_000_000_000n, is_migrated: false, ...over }),
  stock_graduation_events: over => ({ ...docs, dbc_pool: 'PoolDocs', damm_pool: 'DammDocs', migration_signature: fresh('MigrateDocs'), slot: 3000,
    creator_position: 'creatorPositionDocs', partner_position: 'partnerPositionDocs', evidence: { migration: 'fixture' }, ...over }),
  stock_damm_fee_checkpoints: over => ({ ...docs, ...checkpoint('creator', 994_000n), slot: 4000 + ++serial, ...over }),
  stock_fee_collections: over => ({ ...docs, source: 'dbc_creator', reviewed_amount: 994_000n, actual_amount: null, launcher_amount: 300_000n,
    accumulator_amount: 694_000n, terms_hash: 'a'.repeat(64), status: 'pending', ...over }),
  stock_launcher_payouts: over => ({ ...docs, wallet: LAUNCHER[over?.github_repo_id ?? DOCS] ?? 'LauncherDocs', amount: 300_000n, status: 'pending', ...over }),
  stock_canonical_pools: over => ({ asset_id: META.assetId, quote_mint: META.mint, pool: fresh('RepoingMetaPool'), repoing_mint: 'RepoingMint',
    position: null, evidence: { pool: 'fixture' }, ...over }),
  stock_settlement_receipts: over => ({ asset_id: META.assetId, quote_mint: META.mint, kind: 'swap', signature: fresh('SettleMeta'), quote_spent: 550_000n,
    repoing_spent: 0n, repoing_received: 1_000_000n, evidence: { receipt: 'fixture' }, ...over }),
}
const STAMPED = Object.keys(ROWS).filter(table => !['stock_pool_cursors', 'stock_canonical_pools', 'stock_settlement_receipts'].includes(table))
// The same rows for the MSFTx market (microsoft/vscode), with its own pools and launcher.
const VSCODE_ROW = { stock_launcher_payouts: { ...vscode, wallet: 'LauncherVscode' }, stock_graduation_events: { ...vscode, dbc_pool: 'PoolVscode', damm_pool: 'DammVscode' },
  stock_damm_fee_checkpoints: { ...vscode, damm_pool: 'DammVscode' }, stock_fee_collections: vscode }
const forVscode = table => VSCODE_ROW[table] ?? { ...vscode, pool: 'PoolVscode' }

test('migration 0054 adds the stock ledgers, leaves every SOL table as it was, and guards every stock row', { timeout: 120_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'))
  const at = journal.entries.findIndex(entry => entry.tag === '0054_stock_ledgers')
  assert.ok(at > 0, '0054 is in the journal')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0054-'))
  let created = false, pool
  try {
    await admin.query(`drop database if exists ${DB}`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    // A migrations folder that ends at 0053, then at 0054: migrations added after 0054 never run here.
    await mkdir(join(folder, 'meta'))
    for (const entry of journal.entries.slice(0, at + 1)) await copyFile(`drizzle/${entry.tag}.sql`, join(folder, `${entry.tag}.sql`))
    const migrateThrough = async count => {
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }))
      await migrate(drizzle(pool), { migrationsFolder: folder })
    }
    await migrateThrough(at)
    await pool.query(SEED)
    const solRelations = await columnsByRelation(pool)
    const solRows = await checksums(pool, solRelations), before = await catalog(pool)
    assert.ok(Object.keys(before).some(key => key === 'fn:repoing_notify_market_update()'), '0023 is part of the baseline')

    await t.test('upgrading changes no SOL row or definition; it adds only the stock tables and functions', async () => {
      await migrateThrough(at + 1)
      assert.equal((await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, at + 1)
      const after = await catalog(pool)
      assert.deepEqual(Object.keys(before).filter(key => after[key] !== before[key]), [], 'every existing object reads back identically')
      const added = Object.keys(after).filter(key => !(key in before))
      assert.deepEqual(added.filter(key => !isStockObject(key)), [], 'nothing but stock objects is added')
      assert.deepEqual(added.filter(key => key.startsWith('rel:') && after[key] === 'r').map(key => key.slice(4)), STOCK_TABLES)
      assert.deepEqual(added.filter(key => key.startsWith('fn:')).map(key => key.slice(3)).sort(), STOCK_FUNCTIONS)
      assert.deepEqual(await checksums(pool, solRelations), solRows, 'every SOL row reads back identically')
    })

    await t.test('re-applying 0054 changes nothing', async () => {
      const once = await catalog(pool), relations = await columnsByRelation(pool), rows = await checksums(pool, relations)
      for (let round = 0; round < 2; round++) {
        for (const statement of (await readFile('drizzle/0054_stock_ledgers.sql', 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
      }
      assert.deepEqual(await catalog(pool), once)
      assert.deepEqual(await checksums(pool, relations), rows)
    })

    await t.test('the stock tables are exactly the contract: columns, nullability, defaults, indexes, checks and triggers', async () => {
      for (const [table, expected] of Object.entries(CONTRACT)) {
        const { rows: columns } = await pool.query(`select column_name, data_type, character_maximum_length, is_nullable, column_default
          from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [table])
        const spec = columns.map(column => {
          const type = column.data_type === 'character varying' ? `varchar(${column.character_maximum_length})`
            : column.data_type === 'timestamp with time zone' ? 'timestamptz' : column.data_type
          const fallback = column.column_default === null ? '' : column.column_default.startsWith('nextval(') ? ' = serial' : ` = ${column.column_default}`
          return `${column.column_name} ${type}${column.is_nullable === 'YES' ? ' null' : ''}${fallback}`
        }).join('; ')
        assert.equal(spec, expected.columns, `${table} columns`)
        // Sorted here, not in SQL: a database collation may ignore the underscores.
        const { rows: indexes } = await pool.query('select indexdef from pg_indexes where schemaname = $1 and tablename = $2', ['public', table])
        assert.deepEqual(indexes.map(({ indexdef }) => indexdef.replace(/^CREATE (UNIQUE )?INDEX (\S+) ON (public\.)?\S+ USING btree /,
          (_, unique, name) => `${name}${unique ? ' unique' : ''} `)).sort(), expected.indexes, `${table} indexes`)
        // NOT NULL constraints (pg_constraint rows from PostgreSQL 18 on) are the columns' nullability, checked above.
        const { rows: constraints } = await pool.query(`select conname, contype from pg_constraint where conrelid = $1::regclass and contype <> 'n'`, [table])
        assert.deepEqual(constraints.filter(c => c.contype === 'c').map(c => c.conname).sort(), expected.checks.map(name => `${table}_${name}_check`), `${table} checks`)
        assert.deepEqual(constraints.filter(c => c.contype !== 'c').map(c => `${c.conname}:${c.contype}`), [`${table}_pkey:p`], `${table}: a primary key and no foreign keys`)
        const { rows: triggers } = await pool.query('select pg_get_triggerdef(oid) as def from pg_trigger where tgrelid = $1::regclass and not tgisinternal', [table])
        assert.deepEqual(triggers.map(({ def }) => def.replace(/^CREATE TRIGGER /, '').replace(new RegExp(` ON (public\\.)?${table}\\b`), '')).sort(),
          expected.triggers, `${table} triggers`)
      }
    })

    await t.test('valid rows are accepted in every table, for each stamped market', async () => {
      for (const [table, build] of Object.entries(ROWS)) {
        const { rows: [row] } = await insert(pool, table, build())
        assert.ok(row, table)
      }
      // The other stock market, with its own stamp and launcher.
      for (const table of STAMPED) await insert(pool, table, ROWS[table](forVscode(table)))
      await insert(pool, 'stock_canonical_pools', ROWS.stock_canonical_pools({ asset_id: MSFT.assetId, quote_mint: MSFT.mint }))
      // The policy's own outputs satisfy the database's split checks: a creator checkpoint chain and a partner checkpoint.
      const first = checkpoint('creator', 1_988_000n, { cumulativeEarned: 994_000n })
      await insert(pool, 'stock_damm_fee_checkpoints', { ...docs, ...first, slot: 5000 })
      await insert(pool, 'stock_damm_fee_checkpoints', { ...docs, ...checkpoint('creator', 1_988_003n, { cumulativeEarned: 1_988_000n,
        launcherCumulative: first.launcher_cumulative }), slot: 5001 })
      await insert(pool, 'stock_damm_fee_checkpoints', { ...docs, ...checkpoint('partner', 406_000n), slot: 5000 })
      const { rows } = await pool.query(`select side, sum(launcher_credit)::text as launcher, sum(accumulator_credit)::text as accumulator from stock_damm_fee_checkpoints
        where github_repo_id = $1 and slot >= 5000 group by side order by side`, [DOCS])
      assert.deepEqual(rows, [{ side: 'creator', launcher: '300000', accumulator: '694003' }, { side: 'partner', launcher: '0', accumulator: '406000' }])
      // A graduation's positions may be unknown at first.
      await pool.query('delete from stock_graduation_events')
      await insert(pool, 'stock_graduation_events', ROWS.stock_graduation_events({ creator_position: null, partner_position: null }))
    })

    await t.test('a row whose market, stock or mint does not match the market\'s stamp is refused in every stamped table', async () => {
      const cases = [['another stock', { asset_id: MSFT.assetId }], ['another mint', { quote_mint: MSFT.mint }],
        ['another stock market', { github_repo_id: VSCODE }], ['a SOL market', { github_repo_id: HELLO }],
        ['a launch that failed', { github_repo_id: REACT }], ['an unknown market', { github_repo_id: '424242' }],
        ['no stock', { asset_id: null, quote_mint: null }]]
      for (const table of STAMPED) {
        for (const [label, over] of cases) {
          // The payout wallet check runs first by name; the market's own launcher wallet isolates the market check.
          const row = ROWS[table](table === 'stock_launcher_payouts' ? { ...over, wallet: LAUNCHER[over.github_repo_id ?? DOCS] ?? 'LauncherDocs' } : over)
          const expected = table === 'stock_launcher_payouts' && over.github_repo_id === '424242' ? 'not the market\'s launcher wallet' : 'does not match a stock-paired market'
          await refused(insert(pool, table, row), expected, `${table}: ${label}`)
        }
      }
      assert.equal((await pool.query(`select count(*)::int as n from stock_trade_events where github_repo_id = $1`, [HELLO])).rows[0].n, 0)
    })

    await t.test('a stored row can never be re-pointed to another market or stock, in every stamped table', async () => {
      const MISMATCH = 'does not match a stock-paired market', MOVE = 'cannot move to another market or stock', WALLET = 'not the market\'s launcher wallet'
      for (const table of STAMPED) {
        const key = table === 'stock_graduation_events' ? 'github_repo_id' : 'id'
        const { rows: [row] } = await pool.query(`select * from "${table}" where github_repo_id = $1 order by "${key}" limit 1`, [DOCS])
        const update = set => pool.query(`update "${table}" set ${set} where "${key}" = $1`, [row[key]])
        const payout = table === 'stock_launcher_payouts'
        // The payout wallet check runs first by name on a change of market; a payout's own move takes its wallet along.
        for (const [label, set, expected] of [
          ['another stock', `asset_id = '${MSFT.assetId}'`, MISMATCH],
          ['another mint', `quote_mint = '${MSFT.mint}'`, MISMATCH],
          ['a SOL market', `github_repo_id = ${HELLO}`, payout ? WALLET : MISMATCH],
          ['an unknown market', 'github_repo_id = 424242', payout ? WALLET : MISMATCH],
          // Consistent with the other stock market's stamp, so only the rule that a row never moves refuses it.
          ['the other stock market, stamp and all', `github_repo_id = ${VSCODE}, asset_id = '${MSFT.assetId}', quote_mint = '${MSFT.mint}'` +
            (payout ? `, wallet = 'LauncherVscode'` : ''), MOVE],
        ]) await refused(update(set), expected, `${table}: ${label}`)
        // Writing the same market and stock back, or changing any other column, is allowed.
        await update('github_repo_id = github_repo_id, asset_id = asset_id, quote_mint = quote_mint')
        const { rows: [after] } = await pool.query(`select github_repo_id::text as repo, asset_id, quote_mint from "${table}" where "${key}" = $1`, [row[key]])
        assert.deepEqual(after, { repo: DOCS, asset_id: META.assetId, quote_mint: META.mint }, table)
      }
      await pool.query(`update stock_trade_events set trader = 'TraderDocsRenamed' where github_repo_id = $1`, [DOCS])
    })

    await t.test('amounts, splits, enumerations and chain events are enforced', async () => {
      const cases = [
        ['stock_pool_cursors', { venue: 'amm' }, 'stock_pool_cursors_venue_check'],
        ['stock_trade_events', { venue: 'amm' }, 'stock_trade_events_venue_check'],
        ['stock_trade_events', { direction: 'swap' }, 'stock_trade_events_direction_check'],
        ['stock_trade_events', { quote_amount: -1n }, 'stock_trade_events_amounts_check'],
        ['stock_trade_events', { base_amount: -1n }, 'stock_trade_events_amounts_check'],
        // Each fee row breaks exactly one rule.
        ['stock_fee_events', { creator_amount: 10n, partner_amount: -5n, launcher_amount: 3n, accumulator_amount: 2n }, 'stock_fee_events_amounts_check'],
        ['stock_fee_events', { creator_amount: 10n, partner_amount: 5n, launcher_amount: 3n, accumulator_amount: 11n }, 'stock_fee_events_split_check'],
        ['stock_fee_events', { creator_amount: 10n, partner_amount: 5n, launcher_amount: 12n, accumulator_amount: 3n }, 'stock_fee_events_launcher_check'],
        ['stock_graduation_observations', { quote_reserve: -1n }, 'stock_graduation_observations_amounts_check'],
        ['stock_graduation_observations', { migration_threshold: -1n }, 'stock_graduation_observations_amounts_check'],
        ['stock_damm_fee_checkpoints', { side: 'launcher' }, 'stock_damm_fee_checkpoints_side_check'],
        ['stock_damm_fee_checkpoints', { cumulative_claimed: -1n }, 'stock_damm_fee_checkpoints_amounts_check'],
        ['stock_damm_fee_checkpoints', { credit: 10n, launcher_credit: 3n, accumulator_credit: 8n }, 'stock_damm_fee_checkpoints_split_check'],
        ['stock_damm_fee_checkpoints', { side: 'partner', launcher_cumulative: 3n, credit: 10n, launcher_credit: 3n, accumulator_credit: 7n },
          'stock_damm_fee_checkpoints_partner_check'],
        ['stock_fee_collections', { source: 'dbc' }, 'stock_fee_collections_source_check'],
        ['stock_fee_collections', { status: 'sent' }, 'stock_fee_collections_status_check'],
        ['stock_fee_collections', { reviewed_amount: -1n }, 'stock_fee_collections_amounts_check'],
        ['stock_fee_collections', { actual_amount: -1n, status: 'settled', signature: 'CollectNegative', settled_at: '2026-10-04T02:00:00Z', receipt: { slot: 1 } },
          'stock_fee_collections_amounts_check'],
        ['stock_launcher_payouts', { amount: 0n }, 'stock_launcher_payouts_amount_check'],
        ['stock_launcher_payouts', { status: 'sent' }, 'stock_launcher_payouts_status_check'],
        ['stock_settlement_receipts', { kind: 'burn' }, 'stock_settlement_receipts_kind_check'],
        ['stock_settlement_receipts', { repoing_received: -1n }, 'stock_settlement_receipts_amounts_check'],
      ]
      for (const [table, over, constraint] of cases) await refused(insert(pool, table, ROWS[table](over)), constraint, `${table} ${constraint}`)
      // A chain event, a checkpoint slot, a receipt, a cursor and a graduation are each recorded once.
      await insert(pool, 'stock_damm_fee_checkpoints', { ...docs, ...checkpoint('partner', 1n), slot: 6000 })
      const { rows: [trade] } = await insert(pool, 'stock_trade_events', ROWS.stock_trade_events())
      await refused(insert(pool, 'stock_trade_events', ROWS.stock_trade_events({ signature: trade.signature })), 'stock_trade_events_chain_event_unique', 'trade replay')
      await insert(pool, 'stock_trade_events', ROWS.stock_trade_events({ signature: trade.signature, event_index: 1 }))
      const { rows: [fee] } = await insert(pool, 'stock_fee_events', ROWS.stock_fee_events())
      await refused(insert(pool, 'stock_fee_events', ROWS.stock_fee_events({ signature: fee.signature })), 'stock_fee_events_chain_event_unique', 'fee replay')
      await refused(insert(pool, 'stock_damm_fee_checkpoints', { ...docs, ...checkpoint('partner', 2n), slot: 6000 }),
        'stock_damm_fee_checkpoints_pool_side_slot_unique', 'checkpoint replay')
      const { rows: [receipt] } = await insert(pool, 'stock_settlement_receipts', ROWS.stock_settlement_receipts())
      await refused(insert(pool, 'stock_settlement_receipts', ROWS.stock_settlement_receipts({ signature: receipt.signature })),
        'stock_settlement_receipts_signature_unique', 'receipt replay')
      const { rows: [cursor] } = await insert(pool, 'stock_pool_cursors', ROWS.stock_pool_cursors())
      await refused(insert(pool, 'stock_pool_cursors', ROWS.stock_pool_cursors({ pool: cursor.pool })), 'stock_pool_cursors_pkey', 'cursor twice')
      await refused(insert(pool, 'stock_graduation_events', ROWS.stock_graduation_events()), 'stock_graduation_events_pkey', 'second graduation')
    })

    await t.test('a launcher payout goes only to the market\'s launcher wallet', async () => {
      await pool.query('delete from stock_launcher_payouts')
      await refused(insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ wallet: 'LauncherVscode' })), 'not the market\'s launcher wallet', 'other launcher')
      await refused(insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ wallet: 'CreatorDocs' })), 'not the market\'s launcher wallet', 'creator wallet')
      const { rows: [payout] } = await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts())
      await refused(pool.query('update stock_launcher_payouts set wallet = $1 where id = $2', ['Attacker', payout.id]), 'not the market\'s launcher wallet', 'wallet changed')
      await refused(pool.query('update stock_launcher_payouts set github_repo_id = $1 where id = $2', [VSCODE, payout.id]), 'not the market\'s launcher wallet', 'market changed')
      await pool.query(`update stock_launcher_payouts set status = 'settled', signature = 'PayoutDocs', receipt = '{"ok":true}', settled_at = now() where id = $1`, [payout.id])
      assert.deepEqual((await pool.query('select wallet, status from stock_launcher_payouts where id = $1', [payout.id])).rows, [{ wallet: 'LauncherDocs', status: 'settled' }])
    })

    await t.test('one pending payout per market, one pending collection per market and source, one active canonical pool per stock', async () => {
      await pool.query('delete from stock_launcher_payouts; delete from stock_fee_collections; delete from stock_canonical_pools')
      const { rows: [payout] } = await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts())
      await refused(insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts()), 'stock_launcher_payouts_one_pending', 'second pending payout')
      await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ ...vscode, wallet: 'LauncherVscode' }))
      await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ status: 'aborted' }))
      await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ status: 'aborted' }))
      await pool.query(`update stock_launcher_payouts set status = 'settled', signature = 'PayoutSettled', receipt = '{"slot":1}', settled_at = now() where id = $1`,
        [payout.id])
      await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts())

      const { rows: [collection] } = await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections())
      await refused(insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections()), 'stock_fee_collections_one_pending', 'second pending collection')
      for (const source of ['dbc_partner', 'damm_creator', 'damm_partner']) await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections({ source }))
      await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections(vscode))
      await pool.query(`update stock_fee_collections set status = 'settled', signature = 'CollectSettled', actual_amount = 994000, receipt = '{"slot":1}',
        settled_at = now() where id = $1`, [collection.id])
      await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections())
      await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections({ status: 'aborted' }))

      const { rows: [canonical] } = await insert(pool, 'stock_canonical_pools', ROWS.stock_canonical_pools())
      await refused(insert(pool, 'stock_canonical_pools', ROWS.stock_canonical_pools()), 'stock_canonical_pools_one_active', 'second active pool')
      await insert(pool, 'stock_canonical_pools', ROWS.stock_canonical_pools({ active: false }))
      await insert(pool, 'stock_canonical_pools', ROWS.stock_canonical_pools({ asset_id: MSFT.assetId, quote_mint: MSFT.mint }))
      await pool.query('update stock_canonical_pools set active = false where id = $1', [canonical.id])
      await insert(pool, 'stock_canonical_pools', ROWS.stock_canonical_pools())
      const { rows } = await pool.query('select asset_id, count(*) filter (where active)::int as active, count(*)::int as n from stock_canonical_pools group by 1 order by 1')
      assert.deepEqual(rows, [{ asset_id: 'meta-xstock', active: 1, n: 3 }, { asset_id: 'msft-xstock', active: 1, n: 1 }])
    })

    await t.test('a settled collection or payout carries its signature, settlement time and receipt; a pending one has no settlement time', async () => {
      await pool.query('delete from stock_fee_collections; delete from stock_launcher_payouts')
      const settled = { status: 'settled', settled_at: '2026-10-04T02:00:00Z', receipt: { slot: 9000 } }
      const collection = over => ROWS.stock_fee_collections({ ...settled, signature: fresh('CollectDocs'), actual_amount: 994_000n, ...over })
      const payout = over => ROWS.stock_launcher_payouts({ ...settled, signature: fresh('PayoutDocs'), ...over })
      for (const missing of ['signature', 'settled_at', 'actual_amount', 'receipt']) {
        await refused(insert(pool, 'stock_fee_collections', collection({ [missing]: null })), 'stock_fee_collections_settlement_check',
          `settled collection without ${missing}`)
      }
      for (const missing of ['signature', 'settled_at', 'receipt']) {
        await refused(insert(pool, 'stock_launcher_payouts', payout({ [missing]: null })), 'stock_launcher_payouts_settlement_check', `settled payout without ${missing}`)
      }
      await refused(insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections({ settled_at: settled.settled_at })),
        'stock_fee_collections_settlement_check', 'pending collection with a settlement time')
      await refused(insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ settled_at: settled.settled_at })),
        'stock_launcher_payouts_settlement_check', 'pending payout with a settlement time')
      // Complete settled rows are accepted, and so are aborted rows that were never signed.
      await insert(pool, 'stock_fee_collections', collection())
      await insert(pool, 'stock_launcher_payouts', payout())
      await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections({ status: 'aborted' }))
      await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts({ status: 'aborted' }))
      // A pending row settles only with all of it, and a settled row never goes back to pending.
      const { rows: [pendingCollection] } = await insert(pool, 'stock_fee_collections', ROWS.stock_fee_collections())
      await refused(pool.query(`update stock_fee_collections set status = 'settled', settled_at = now() where id = $1`, [pendingCollection.id]),
        'stock_fee_collections_settlement_check', 'collection settled without signature, amount or receipt')
      await pool.query(`update stock_fee_collections set status = 'settled', settled_at = now(), signature = $2, actual_amount = 993999,
        receipt = '{"slot":9001}' where id = $1`, [pendingCollection.id, fresh('CollectDocs')])
      await refused(pool.query(`update stock_fee_collections set status = 'pending' where id = $1`, [pendingCollection.id]),
        'stock_fee_collections_settlement_check', 'settled collection back to pending')
      const { rows: [pendingPayout] } = await insert(pool, 'stock_launcher_payouts', ROWS.stock_launcher_payouts())
      await refused(pool.query(`update stock_launcher_payouts set status = 'settled', settled_at = now(), signature = $2 where id = $1`,
        [pendingPayout.id, fresh('PayoutDocs')]), 'stock_launcher_payouts_settlement_check', 'payout settled without a receipt')
      await pool.query(`update stock_launcher_payouts set status = 'settled', settled_at = now(), signature = $2, receipt = '{"slot":9002}' where id = $1`,
        [pendingPayout.id, fresh('PayoutDocs')])
      await refused(pool.query(`update stock_launcher_payouts set status = 'pending' where id = $1`, [pendingPayout.id]),
        'stock_launcher_payouts_settlement_check', 'settled payout back to pending')
      const counts = async table => (await pool.query(`select status, count(*)::int as n from "${table}" group by 1`)).rows
        .sort((a, b) => (a.status < b.status ? -1 : 1))
      assert.deepEqual(await counts('stock_fee_collections'), [{ status: 'aborted', n: 1 }, { status: 'settled', n: 2 }])
      assert.deepEqual(await counts('stock_launcher_payouts'), [{ status: 'aborted', n: 1 }, { status: 'settled', n: 2 }])
    })

    await t.test('the read indexes serve per-market and per-stock reads', async () => {
      const client = await pool.connect()
      try {
        await client.query('begin')
        // Tiny tables are cheapest to scan whole; with sequential scans off, the plan shows the index each read can use.
        await client.query('set local enable_seqscan = off')
        for (const [read, index] of [
          [`select sum(launcher_amount) from stock_fee_events where github_repo_id = ${DOCS}`, 'stock_fee_events_repo'],
          [`select sum(accumulator_amount) from stock_fee_events where asset_id = '${META.assetId}'`, 'stock_fee_events_asset'],
          [`select sum(launcher_credit) from stock_damm_fee_checkpoints where github_repo_id = ${DOCS}`, 'stock_damm_fee_checkpoints_repo'],
          [`select sum(accumulator_credit) from stock_damm_fee_checkpoints where asset_id = '${META.assetId}'`, 'stock_damm_fee_checkpoints_asset'],
          [`select sum(accumulator_amount) from stock_fee_collections where asset_id = '${META.assetId}' and status = 'settled'`,
            'stock_fee_collections_asset_status'],
          [`select sum(amount) from stock_launcher_payouts where github_repo_id = ${DOCS} and status = 'settled'`, 'stock_launcher_payouts_repo_status'],
        ]) {
          const plan = (await client.query(`explain ${read}`)).rows.map(row => row['QUERY PLAN']).join('\n')
          assert.match(plan, new RegExp(`\\b${index}\\b`), `${read}\n${plan}`)
        }
      } finally {
        await client.query('rollback')
        client.release()
      }
    })

    await t.test('stock trade and fee rows of a canonical market notify on the stock channel, and nothing else does', { timeout: 15_000 }, async () => {
      const listener = new pg.Client({ connectionString: URL_ })
      const received = []
      let done
      const sentinel = new Promise(resolve => { done = resolve })
      listener.on('notification', ({ channel, payload }) => (payload === 'sentinel' ? done() : received.push({ channel, payload: JSON.parse(payload) })))
      await listener.connect()
      try {
        await listener.query('LISTEN repoing_stock_market_updates')
        await listener.query('LISTEN repoing_market_updates')
        // Not canonical yet (not indexed): no hint. Then the canonical market's trade and fee rows, and other stock rows, which send none.
        await insert(pool, 'stock_trade_events', ROWS.stock_trade_events({ ...vscode, pool: 'PoolVscode' }))
        await insert(pool, 'stock_trade_events', ROWS.stock_trade_events())
        await insert(pool, 'stock_fee_events', ROWS.stock_fee_events())
        await insert(pool, 'stock_graduation_observations', ROWS.stock_graduation_observations())
        await insert(pool, 'stock_damm_fee_checkpoints', ROWS.stock_damm_fee_checkpoints())
        // Notifications arrive in commit order: once the sentinel is in, every hint the rows above sent has arrived.
        await pool.query(`select pg_notify('repoing_stock_market_updates', 'sentinel')`)
        await sentinel
        assert.deepEqual(received, [
          { channel: 'repoing_stock_market_updates', payload: { mint: 'MintDocs', kind: 'trade' } },
          { channel: 'repoing_stock_market_updates', payload: { mint: 'MintDocs', kind: 'fee' } },
        ])
      } finally {
        await listener.end()
      }
    })

    await t.test('after all of that, every SOL row still reads back exactly as seeded', async () => {
      assert.deepEqual(await checksums(pool, solRelations), solRows)
    })
  } finally {
    await pool?.end()
    if (created) await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.end()
    await rm(folder, { recursive: true, force: true })
  }
})
