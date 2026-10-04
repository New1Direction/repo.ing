import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getScaledUiAmountConfig, unpackAccount,
  unpackMint } from '@solana/spl-token'
import { CP_AMM_PROGRAM_ID, deriveTokenBadgeAddress as dammBadgeAddress } from '@meteora-ag/cp-amm-sdk'
import { DynamicBondingCurveClient, deriveTokenBadgeAddress as dbcBadgeAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PLATFORM_FEE_WALLET } from '../app/lib/buyback-receipts.mjs'
import { plainAmount, shownUnits, stockUnits } from '../app/lib/trade-units.mjs'
import { buildStockLaunchCurve } from './launch-curve.mjs'
import { DBC_PROGRAM_ID } from './launch-fee-config.mjs'
import { QUOTE_REGISTRY, STOCK_PAIR_LAUNCHES_READY, stockQuotesEnabled } from './quote-assets.mjs'
import { stockQuoteConfigs } from './quote-configs.mjs'
import { currentMultiplier, multiplierText, scaledConfig } from './scaled-ui-amount.mjs'
import { POLICY_VERSION, assertStockPolicyConfig } from './stock-fee-policy.mjs'
import { assertStockConfig } from './stock-quote-config.mjs'
import { tipMintCheck } from './tip-tokens.mjs'

// Go-live readiness of stock-paired markets (docs/STOCK_GO_LIVE.md): a checklist of PASS, FAIL and TODO items with a one-line
// reason each, then the switches, shown ON or OFF (off is expected before go-live and is never a failure). READ-ONLY: chain
// accounts are read through the connection given, and database checks are SELECTs inside READ ONLY transactions that are
// rolled back. Nothing here loads a key, signs, sends or writes. Only the variables in READINESS_ENV are read, and the RPC and
// database URLs are never printed. The checks reuse the code that launches and indexes stock pairs: the registry
// (src/quote-assets.mjs), STOCK_QUOTE_CONFIGS parsing (src/quote-configs.mjs), the config review (src/stock-quote-config.mjs),
// the fee policy (src/stock-fee-policy.mjs) and the launch path's mint check (src/tip-tokens.mjs).
export const READINESS_ENV = Object.freeze(['SOLANA_RPC_URL', 'DATABASE_URL', 'STOCK_QUOTE_CONFIGS', 'DBC_CONFIG', 'STOCK_QUOTES_ENABLED',
  'STOCK_COLLECTIONS_EXECUTION_ENABLED', 'STOCK_LAUNCHER_PAYOUTS_ENABLED'])
export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', TODO: 'TODO', ON: 'ON', OFF: 'OFF' })
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const COMMITMENT = 'finalized'
// A ScaledUiAmount multiplier moves with dividends (a little above 1) and splits (whole factors). Outside 1/100..100 it is far
// from anything an xStock has used, so the stock's units need a look before go-live.
export const MULTIPLIER_RANGE = Object.freeze({ min: 0.01, max: 100 })
const { PASS, FAIL, TODO, ON, OFF } = STATUS
const SECTION = Object.freeze({ network: 'Network', registry: 'Registry', configs: 'Stock configs', database: 'Database',
  custody: 'Custody', switches: 'Switches' })
const item = (section, name, status, reason) => ({ section, name, status, reason })

// Where stock fees are held: the stock's Token-2022 associated account of the configs' fee claimer, the platform partner wallet.
export const custodyAddress = asset =>
  getAssociatedTokenAddressSync(new PublicKey(asset.mint), new PublicKey(PLATFORM_FEE_WALLET), false, TOKEN_2022_PROGRAM_ID)
// Meteora's token badges for the stock: launches on DBC and graduation into DAMM v2 need them for a Token-2022 quote.
export const stockBadges = asset => [['DBC', dbcBadgeAddress(new PublicKey(asset.mint)), DBC_PROGRAM_ID],
  ['DAMM v2', dammBadgeAddress(new PublicKey(asset.mint)), CP_AMM_PROGRAM_ID]]

// ---------- chain reads ----------
async function networkItem(connection) {
  try {
    const genesis = await connection.getGenesisHash()
    return genesis === MAINNET_GENESIS ? item(SECTION.network, 'RPC', PASS, 'Solana mainnet (genesis hash checked)')
      : item(SECTION.network, 'RPC', FAIL, `not Solana mainnet (genesis ${genesis}): point SOLANA_RPC_URL at a mainnet RPC`)
  } catch (error) { return item(SECTION.network, 'RPC', FAIL, `could not read the RPC: ${error.message}`) }
}

// Every account the checks need, in one read at one commitment, plus the epoch the mint check needs for transfer fees.
async function readAccounts(connection, addresses) {
  const keys = [...new Set(addresses)]
  const [infos, epoch] = await Promise.all([connection.getMultipleAccountsInfo(keys.map(key => new PublicKey(key)), COMMITMENT),
    connection.getEpochInfo(COMMITMENT)])
  if (!Array.isArray(infos) || infos.length !== keys.length) throw Error('the RPC returned an incomplete account list')
  return { accounts: new Map(keys.map((key, index) => [key, infos[index] ?? null])), epoch: epoch.epoch }
}

const address = value => { try { return new PublicKey(String(value ?? '').trim()).toBase58() } catch { return null } }
const when = seconds => Number.isSafeInteger(seconds) && Math.abs(seconds) < 8.64e12 ? new Date(seconds * 1000).toISOString() : `unix ${seconds}`

// ---------- registry ----------
// The registry's pinned mint as it is on chain: Token-2022, initialized, the registry's decimals.
function readStockMint(asset, info) {
  if (!info) throw Error('no account at this address')
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error(`owned by ${info.owner.toBase58()}, not Token-2022`)
  const mint = unpackMint(new PublicKey(asset.mint), info, TOKEN_2022_PROGRAM_ID)
  if (!mint.isInitialized) throw Error('not initialized')
  if (mint.decimals !== asset.decimals) throw Error(`${mint.decimals} decimals where the registry pins ${asset.decimals}`)
  return mint
}

// Both multipliers (the one in force and the scheduled one) must be numbers the site can show the stock's units with.
function displayMultiplier(mint, nowSeconds) {
  const config = scaledConfig(getScaledUiAmountConfig(mint))
  if (!config) throw Error('no ScaledUiAmount extension: the stock\'s units as wallets show them cannot be worked out')
  const sane = value => { try { multiplierText(value) } catch { return false } return value >= MULTIPLIER_RANGE.min && value <= MULTIPLIER_RANGE.max }
  const bad = [['multiplier', config.multiplier], ['scheduled multiplier', config.newMultiplier]].find(([, value]) => !sane(value))
  if (bad) throw Error(`${bad[0]} ${bad[1]} is not a plain number from ${MULTIPLIER_RANGE.min} to ${MULTIPLIER_RANGE.max}`)
  const current = multiplierText(currentMultiplier(config, nowSeconds))
  const later = config.effectiveAt > nowSeconds && config.newMultiplier !== config.multiplier
    ? `, then ${multiplierText(config.newMultiplier)} from ${when(config.effectiveAt)}` : ''
  return { current, text: `ScaledUiAmount multiplier ${current} in force${later}` }
}

function badgeItem(asset, accounts, name) {
  const missing = stockBadges(asset).filter(([, key, program]) => !accounts.get(key.toBase58())?.owner.equals(program))
  if (!missing.length) return item(SECTION.registry, name, PASS, 'Meteora\'s DBC and DAMM v2 token badges exist (launches and graduation need them)')
  const cannot = missing.map(([venue]) => venue === 'DBC' ? 'launch' : 'graduate').join(' or ')
  return item(SECTION.registry, name, FAIL, `no ${missing.map(([venue, key]) => `${venue} token badge (${key.toBase58()})`).join(' and ')}: ` +
    `${asset.symbol} pairs cannot ${cannot} without ${missing.length > 1 ? 'them' : 'it'}; ask Meteora`)
}

function registryItems({ assets, accounts, epoch, nowSeconds }) {
  const items = [], multipliers = new Map()
  for (const asset of assets) {
    const name = what => `${asset.symbol}${asset.enabled ? '' : ' (disabled)'} ${what}`
    const info = accounts.get(asset.mint)
    let mint
    try { mint = readStockMint(asset, info) } catch (error) {
      items.push(item(SECTION.registry, name('mint'), FAIL, `${asset.mint}: ${error.message}`))
      continue
    }
    items.push(item(SECTION.registry, name('mint'), PASS, `Token-2022 mint ${asset.mint} with ${asset.decimals} decimals, as the registry pins it`))
    try {
      const display = displayMultiplier(mint, nowSeconds)
      multipliers.set(asset.assetId, display.current)
      items.push(item(SECTION.registry, name('units'), PASS, `${display.text} (wallets show raw units × multiplier)`))
    } catch (error) { items.push(item(SECTION.registry, name('units'), FAIL, error.message)) }
    try {
      tipMintCheck({ mint: asset.mint, program: asset.tokenProgram, decimals: asset.decimals }, info, epoch)
      items.push(item(SECTION.registry, name('usable now'), PASS, 'not paused, no active transfer hook or fee, accounts not frozen by default ' +
        '(the launch path\'s own mint check)'))
    } catch (error) { items.push(item(SECTION.registry, name('usable now'), FAIL, `${error.message}: stock launches refuse ${asset.symbol} until this changes`)) }
    items.push(badgeItem(asset, accounts, name('Meteora badges')))
  }
  return { items, multipliers }
}

// ---------- stock configs ----------
// A DBC PoolConfig account: owned by the DBC program, exactly the PoolConfig size, with its discriminator.
function poolConfigOf(coder, info) {
  if (!info) throw Error('no account at this address')
  if (!info.owner.equals(DBC_PROGRAM_ID)) throw Error(`owned by ${info.owner.toBase58()}, not the DBC program`)
  const size = coder.size('poolConfig')
  if (info.data.length !== size) throw Error(`${info.data.length} bytes, where a DBC config has ${size}`)
  if (!Buffer.from(info.data.subarray(0, 8)).equals(Buffer.from(coder.accountDiscriminator('poolConfig')))) {
    throw Error('not a DBC config (wrong account discriminator)')
  }
  return coder.decode('poolConfig', info.data)
}

// STOCK_QUOTE_CONFIGS as web and worker parse it. Unset is an owner step, unless stock launches are already open here.
function configsItem(env, registry, open) {
  const name = 'STOCK_QUOTE_CONFIGS'
  let configs
  try { configs = stockQuoteConfigs(env, registry) } catch (error) {
    return { configs: null, item: item(SECTION.configs, name, FAIL, `${error.message}: no stock market can resolve its config`) }
  }
  if (!configs.size) {
    return { configs: null, item: open ? item(SECTION.configs, name, FAIL, 'not set, but stock launches are open here: no stock pair can launch')
      : item(SECTION.configs, name, TODO, 'not set: owner step (create each stock\'s config, then set it on web and worker)') }
  }
  const symbol = assetId => registry.assets.find(asset => asset.assetId === assetId).symbol
  return { configs, item: item(SECTION.configs, name, PASS, `parses: ${[...configs].map(([assetId, key]) => `${symbol(assetId)} ${key.toBase58()}`).join(', ')}`) }
}

// The SOL launch config new SOL launches use (DBC_CONFIG): the terms every stock config must carry field by field.
function referenceConfig({ coder, env, accounts }) {
  const key = address(env.DBC_CONFIG)
  if (!env.DBC_CONFIG?.trim()) return { problem: 'DBC_CONFIG is not set: it names the live SOL launch config every stock config must match' }
  if (!key) return { problem: 'DBC_CONFIG is not a valid address' }
  try {
    const decoded = poolConfigOf(coder, accounts.get(key))
    if (!new PublicKey(decoded.quoteMint).equals(NATIVE_MINT) || decoded.quoteTokenFlag !== 0) throw Error('not quoted in SOL')
    return { address: key, decoded }
  } catch (error) { return { address: key, problem: `DBC_CONFIG ${key}: ${error.message}` } }
}

const referenceItem = reference => reference.problem ? item(SECTION.configs, 'SOL launch config', FAIL, reference.problem)
  : item(SECTION.configs, 'SOL launch config', PASS, `DBC_CONFIG ${reference.address}: the terms each stock config must carry`)

// The curve's graduation threshold in whole units of the stock, as the create script sets it (--graduation <whole units>).
function graduationOf(decoded, asset) {
  const raw = BigInt(decoded.migrationQuoteThreshold.toString()), unit = 10n ** BigInt(asset.decimals)
  if (raw <= 0n || raw % unit !== 0n || raw / unit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Error(`${raw} raw units is not a positive whole number of ${asset.symbol}; the create script only makes whole-unit thresholds`)
  }
  return { raw, whole: Number(raw / unit) }
}

// A raw amount of the stock, and as wallets show it with the multiplier in force (when the mint could be read).
function stockAmount(raw, asset, multiplier) {
  const units = multiplier ? stockUnits({ symbol: asset.symbol, decimals: asset.decimals, uiMultiplier: multiplier }) : null
  const shown = units ? plainAmount(shownUnits(raw, units), asset.decimals).replace(/(\.\d{4})\d+$/, '$1') : null
  return `${plainAmount(raw, asset.decimals)} ${asset.symbol} (${raw} raw units${shown ? `; about ${shown} as wallets show it today` : ''})`
}

function termsItem({ asset, decoded, graduation, reference }) {
  const name = `${asset.symbol} config terms`
  if (reference.problem) return item(SECTION.configs, name, FAIL, `not compared: ${reference.problem}`)
  if (!graduation) return item(SECTION.configs, name, FAIL, 'not compared: its graduation threshold is not a whole number of the stock')
  try {
    assertStockConfig(decoded, reference.decoded, { asset, graduation: graduation.whole,
      curve: buildStockLaunchCurve({ quoteDecimals: asset.decimals, migrationQuoteThreshold: graduation.whole }) })
    return item(SECTION.configs, name, PASS, `fees, launch fee, fee mode, migration and locked liquidity equal the SOL launch config field by ` +
      `field, and the curve is the one scripts/create-stock-quote-config.mjs builds for ${graduation.whole} ${asset.symbol}`)
  } catch (error) { return item(SECTION.configs, name, FAIL, `${error.message} (compared with DBC_CONFIG ${reference.address})`) }
}

function configItems({ asset, key, accounts, coder, reference, multiplier }) {
  const name = what => `${asset.symbol} config${what ? ` ${what}` : ''}`
  let decoded
  try { decoded = poolConfigOf(coder, accounts.get(key)) } catch (error) { return [item(SECTION.configs, name(), FAIL, `${key}: ${error.message}`)] }
  const items = [item(SECTION.configs, name(), PASS, `${key} is a DBC config account (owner, size and discriminator checked)`)]
  const quoteMint = new PublicKey(decoded.quoteMint).toBase58()
  items.push(quoteMint === asset.mint && decoded.quoteTokenFlag === 1
    ? item(SECTION.configs, name('quote'), PASS, `quotes the registry's ${asset.symbol} mint through Token-2022`)
    : item(SECTION.configs, name('quote'), FAIL, `quotes ${quoteMint}${decoded.quoteTokenFlag === 1 ? '' : ' without the Token-2022 flag'}, ` +
      `not the registry's ${asset.symbol} mint ${asset.mint} through Token-2022`))
  try {
    assertStockPolicyConfig(decoded)
    items.push(item(SECTION.configs, name('creator share'), PASS, `${decoded.creatorTradingFeePercentage}% of the fee after Meteora's, as stock fee policy ${POLICY_VERSION} needs`))
  } catch (error) { items.push(item(SECTION.configs, name('creator share'), FAIL, error.message)) }
  const claimer = new PublicKey(decoded.feeClaimer).toBase58()
  items.push(claimer === PLATFORM_FEE_WALLET ? item(SECTION.configs, name('fee claimer'), PASS, `the platform partner wallet ${PLATFORM_FEE_WALLET}`)
    : item(SECTION.configs, name('fee claimer'), FAIL, `${claimer}, not the platform partner wallet ${PLATFORM_FEE_WALLET}: its fees would be claimed elsewhere`))
  let graduation = null
  try {
    graduation = graduationOf(decoded, asset)
    items.push(item(SECTION.configs, name('graduation'), PASS, `a market graduates when its curve holds ${stockAmount(graduation.raw, asset, multiplier)}`))
  } catch (error) { items.push(item(SECTION.configs, name('graduation'), FAIL, error.message)) }
  items.push(termsItem({ asset, decoded, graduation, reference }))
  return items
}

function configSection({ assets, configs, accounts, coder, reference, multipliers }) {
  const items = [referenceItem(reference)]
  for (const asset of assets) {
    const key = configs.get(asset.assetId)?.toBase58()
    if (key) items.push(...configItems({ asset, key, accounts, coder, reference, multiplier: multipliers.get(asset.assetId) }))
    else items.push(item(SECTION.configs, `${asset.symbol} config`, TODO, `not in STOCK_QUOTE_CONFIGS: ${asset.symbol} pairs cannot launch until ` +
      'its config is created and set (owner step)'))
  }
  return items
}

// ---------- custody ----------
function custodyItem({ asset, accounts, multiplier }) {
  const key = custodyAddress(asset).toBase58(), info = accounts.get(key), name = `${asset.symbol} custody`
  if (!info) return item(SECTION.custody, name, TODO, `the partner wallet has no ${asset.symbol} account yet (${key}): created on first collection`)
  try {
    if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) throw Error(`owned by ${info.owner.toBase58()}, not Token-2022`)
    const account = unpackAccount(new PublicKey(key), info, TOKEN_2022_PROGRAM_ID)
    if (account.mint.toBase58() !== asset.mint || account.owner.toBase58() !== PLATFORM_FEE_WALLET) throw Error(`not the partner wallet's ${asset.symbol} account`)
    if (account.isFrozen) throw Error('frozen by the issuer: collections into it would fail')
    return item(SECTION.custody, name, PASS, `the partner wallet's ${asset.symbol} account ${key} holds ${stockAmount(account.amount, asset, multiplier)}`)
  } catch (error) { return item(SECTION.custody, name, FAIL, `${key}: ${error.message}`) }
}

async function chainItems({ connection, env, assets, configs, nowSeconds }) {
  const network = await networkItem(connection)
  if (network.status !== PASS) return { network: [network], registry: [], configs: [], custody: [] }
  const reference = address(env.DBC_CONFIG)
  const addresses = [...assets.flatMap(asset => [asset.mint, ...stockBadges(asset).map(([, key]) => key.toBase58()), custodyAddress(asset).toBase58()]),
    ...configs ? [...configs.values()].map(key => key.toBase58()) : [], ...configs && reference ? [reference] : []]
  let read
  try { read = await readAccounts(connection, addresses) } catch (error) {
    return { network: [network, item(SECTION.network, 'Account reads', FAIL, `could not read the accounts: ${error.message}`)], registry: [], configs: [], custody: [] }
  }
  const registry = registryItems({ assets, ...read, nowSeconds })
  const coder = new DynamicBondingCurveClient(connection, COMMITMENT).state.getProgram().coder.accounts
  return { network: [network], registry: registry.items,
    configs: configs ? configSection({ assets, configs, accounts: read.accounts, coder, reference: referenceConfig({ coder, env, accounts: read.accounts }),
      multipliers: registry.multipliers }) : [],
    custody: assets.map(asset => custodyItem({ asset, accounts: read.accounts, multiplier: registry.multipliers.get(asset.assetId) })) }
}

// ---------- database ----------
// Migration 0054 (drizzle/0054_stock_ledgers.sql): its tables, functions and triggers, every trigger enabled.
export const STOCK_LEDGER_TABLES = Object.freeze(['stock_pool_cursors', 'stock_trade_events', 'stock_fee_events', 'stock_graduation_observations',
  'stock_graduation_events', 'stock_damm_fee_checkpoints', 'stock_fee_collections', 'stock_launcher_payouts', 'stock_canonical_pools',
  'stock_settlement_receipts'])
export const STOCK_LEDGER_FUNCTIONS = Object.freeze(['stock_ledger_market_check', 'stock_launcher_payout_wallet_check',
  'repoing_notify_stock_market_update'])
export const STOCK_LEDGER_TRIGGERS = Object.freeze([
  ...['stock_trade_events', 'stock_fee_events', 'stock_graduation_observations', 'stock_graduation_events', 'stock_damm_fee_checkpoints',
    'stock_fee_collections', 'stock_launcher_payouts'].map(table => [table, 'stock_ledger_market_check', 'stock_ledger_market_check']),
  ['stock_launcher_payouts', 'stock_launcher_payout_wallet_check', 'stock_launcher_payout_wallet_check'],
  ['stock_trade_events', 'repoing_stock_trade_update', 'repoing_notify_stock_market_update'],
  ['stock_fee_events', 'repoing_stock_fee_update', 'repoing_notify_stock_market_update'],
].map(([table, name, fn]) => Object.freeze({ table, name, function: fn })))
// Migration 0055 (drizzle/0055_stock_ledger_indexes.sql): the stock ledgers' read indexes, each on its table and valid.
export const STOCK_LEDGER_INDEXES = Object.freeze([['stock_trade_events', 'stock_trade_events_repo_traded_at'],
  ['stock_fee_events', 'stock_fee_events_repo_slot'], ['stock_fee_collections', 'stock_fee_collections_repo_status'],
].map(([table, name]) => Object.freeze({ table, name })))
// Migration 0056 (drizzle/0056_stock_execution_guards.sql): the guards of stock fee collection and launcher payout execution,
// each on its table and valid. The two signature indexes must be unique: a transaction settles at most one collection and
// one payout. 0056 ships with that execution: until it is applied, none of these exists and the check is a TODO, not a FAIL.
export const STOCK_EXECUTION_INDEXES = Object.freeze([['stock_fee_collections', 'stock_fee_collections_signature_unique', true],
  ['stock_launcher_payouts', 'stock_launcher_payouts_signature_unique', true], ['stock_launcher_payouts', 'stock_launcher_payouts_asset_status', false],
].map(([table, name, unique]) => Object.freeze({ table, name, unique })))

// The two worker indexers' market lists (src/external-fee-indexer.mjs for SOL, src/stock-fee-indexer.mjs for stocks): every
// confirmed, indexed, finalized market belongs to exactly one, by whether it carries a stock stamp.
export const INDEXED_MARKETS = "status = 'confirmed' and indexed_at is not null and launch_finality = 'finalized'"
export const SOL_INDEXER_MARKETS = `${INDEXED_MARKETS} and quote_asset_id is null`
export const STOCK_INDEXER_MARKETS = `${INDEXED_MARKETS} and quote_asset_id is not null`

// SOL ledgers no stock-paired market may appear in (src/db/schema.mjs): SOL fee, trade and cursor tables, the claims paid from
// them, and the SOL rewards stock markets never carry. Each is matched to markets by repository id or by pool.
export const SOL_LEDGERS = Object.freeze([['fee_events', 'github_repo_id'], ['trade_events', 'pool'], ['pool_fee_cursors', 'pool'],
  ['discovery_fee_events', 'github_repo_id'], ['damm_trade_events', 'github_repo_id'], ['damm_fee_events', 'github_repo_id'],
  ['platform_fee_events', 'github_repo_id'], ['repo_claims', 'github_repo_id'], ['platform_fee_claims', 'github_repo_id'],
  ['discovery_claims', 'github_repo_id'], ['verification_bonuses', 'github_repo_id'], ['builder_allocation_claims', 'github_repo_id'],
].map(([table, key]) => Object.freeze({ table, key })))

const some = (ids, max = 5) => `${ids.slice(0, max).join(', ')}${ids.length > max ? ` and ${ids.length - max} more` : ''}`

async function migrationItem(db) {
  const present = async (sql, names) => new Map((await db.query(sql, [names])).rows.map(row => [row.name, row.present]))
  const tables = await present('select name, to_regclass(name) is not null as present from unnest($1::text[]) as name', STOCK_LEDGER_TABLES)
  const functions = await present("select name, to_regprocedure(name || '()') is not null as present from unnest($1::text[]) as name", STOCK_LEDGER_FUNCTIONS)
  const { rows } = await db.query(`select c.relname as "table", t.tgname as name, p.proname as function, t.tgenabled as enabled
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
    where not t.tgisinternal and c.oid in (select to_regclass(name) from unnest($1::text[]) as name)`, [STOCK_LEDGER_TABLES])
  const problems = [...STOCK_LEDGER_TABLES.filter(name => !tables.get(name)).map(name => `table ${name} missing`),
    ...STOCK_LEDGER_FUNCTIONS.filter(name => !functions.get(name)).map(name => `function ${name}() missing`)]
  for (const expected of STOCK_LEDGER_TRIGGERS) {
    const found = rows.find(row => row.table === expected.table && row.name === expected.name)
    if (!found) problems.push(`trigger ${expected.name} on ${expected.table} missing`)
    else if (found.function !== expected.function) problems.push(`trigger ${expected.name} on ${expected.table} calls ${found.function}()`)
    else if (!['O', 'A'].includes(found.enabled)) problems.push(`trigger ${expected.name} on ${expected.table} disabled`)
  }
  return problems.length ? item(SECTION.database, 'Migration 0054', FAIL, `${problems.join('; ')}: apply migration 0054 as written`)
    : item(SECTION.database, 'Migration 0054', PASS, `${STOCK_LEDGER_TABLES.length} stock tables, ${STOCK_LEDGER_FUNCTIONS.length} functions and ` +
      `${STOCK_LEDGER_TRIGGERS.length} triggers present, every trigger enabled`)
}

// The expected indexes that exist, as pg_index describes them: name, table, whether valid and whether unique.
async function readIndexes(db, expected) {
  const { rows } = await db.query(`select i.relname as name, t.relname as "table", x.indisvalid as valid, x.indisunique as "unique" from pg_index x
    join pg_class i on i.oid = x.indexrelid join pg_class t on t.oid = x.indrelid
    where x.indexrelid in (select to_regclass(name) from unnest($1::text[]) as name)`, [expected.map(index => index.name)])
  return rows
}

// What is wrong with the expected indexes ({ table, name, unique }) among those found.
function indexProblems(rows, expected) {
  return expected.flatMap(({ table, name, unique = false }) => {
    const found = rows.find(row => row.name === name)
    if (!found) return [`index ${name} missing`]
    if (found.table !== table) return [`index ${name} is on ${found.table}, not ${table}`]
    if (!found.valid) return [`index ${name} on ${table} is not valid`]
    return unique && !found.unique ? [`index ${name} on ${table} is not unique`] : []
  })
}

async function indexItem(db) {
  const problems = indexProblems(await readIndexes(db, STOCK_LEDGER_INDEXES), STOCK_LEDGER_INDEXES)
  return problems.length ? item(SECTION.database, 'Migration 0055', FAIL, `${problems.join('; ')}: apply migration 0055 as written`)
    : item(SECTION.database, 'Migration 0055', PASS, `the stock ledgers' ${STOCK_LEDGER_INDEXES.length} read indexes are present and valid`)
}

// TODO while none of 0056's indexes exists (it is not applied yet); FAIL when only some exist or one is wrong.
async function executionIndexItem(db) {
  const rows = await readIndexes(db, STOCK_EXECUTION_INDEXES)
  if (!rows.length) return item(SECTION.database, 'Migration 0056', TODO, `migration 0056 not applied yet: none of its ${STOCK_EXECUTION_INDEXES.length} ` +
    'stock execution guard indexes exists (it ships with stock fee collection and launcher payout execution, which stay off)')
  const problems = indexProblems(rows, STOCK_EXECUTION_INDEXES)
  return problems.length ? item(SECTION.database, 'Migration 0056', FAIL, `${problems.join('; ')}: apply migration 0056 as written`)
    : item(SECTION.database, 'Migration 0056', PASS, `the stock execution guards' ${STOCK_EXECUTION_INDEXES.length} indexes are present and valid, ` +
      'one collection and one payout per signature')
}

// What is wrong with a split of the indexed markets into the SOL indexer's and the stock indexer's lists.
export function partitionProblems({ all, sol, stock }) {
  const inAll = new Set(all), inSol = new Set(sol), inStock = new Set(stock)
  const both = sol.filter(id => inStock.has(id)), neither = all.filter(id => !inSol.has(id) && !inStock.has(id))
  const outside = [...new Set([...sol, ...stock])].filter(id => !inAll.has(id))
  return [...both.length ? [`in both indexers' lists: ${some(both)}`] : [], ...neither.length ? [`in neither list: ${some(neither)}`] : [],
    ...outside.length ? [`listed but not an indexed market: ${some(outside)}`] : []]
}

async function partitionItem(db) {
  const ids = async where => (await db.query(`select github_repo_id::text as id from markets where ${where} order by github_repo_id`)).rows.map(row => row.id)
  const all = await ids(INDEXED_MARKETS), sol = await ids(SOL_INDEXER_MARKETS), stock = await ids(STOCK_INDEXER_MARKETS)
  const problems = partitionProblems({ all, sol, stock })
  return problems.length ? item(SECTION.database, 'Market partition', FAIL, `${problems.join('; ')}: stock fees could be skipped or counted twice`)
    : item(SECTION.database, 'Market partition', PASS, `${all.length} indexed markets: ${sol.length} SOL (the SOL indexer's list) + ` +
      `${stock.length} stock (the stock indexer's list), none in both`)
}

async function solLedgerItem(db) {
  const { rows } = await db.query(SOL_LEDGERS.map(({ table, key }) => `select '${table}' as ledger, count(*)::int as rows,
    coalesce(array_agg(distinct m.github_repo_id::text), '{}') as markets from ${table} t join markets m on m.${key} = t.${key}
    where m.quote_asset_id is not null`).join('\nunion all\n'))
  const found = rows.filter(row => row.rows > 0)
  return found.length ? item(SECTION.database, 'SOL ledgers', FAIL, `${found.map(row => `${row.ledger} has ${row.rows} row(s) of stock-paired ` +
      `market(s) ${some(row.markets)}`).join('; ')}: stock pairs must stay in the stock ledgers`)
    : item(SECTION.database, 'SOL ledgers', PASS, `no stock-paired market in any of the ${SOL_LEDGERS.length} SOL fee, trade, claim and reward tables`)
}

// Each check in its own READ ONLY transaction, rolled back: PostgreSQL itself refuses any write, and one failed read cannot
// abort the next check.
async function readOnly(db, work) {
  await db.query('begin transaction read only')
  try {
    await db.query("set local statement_timeout = '30s'")
    return await work()
  } finally { await db.query('rollback') }
}

// The database section: db is a single pg client (transactions need one connection), or null when DATABASE_URL is not set.
export async function checkDatabase({ db = null, dbError = null } = {}) {
  if (dbError) return [item(SECTION.database, 'Connection', FAIL, `could not connect to DATABASE_URL: ${dbError.message}`)]
  if (!db) return [item(SECTION.database, 'DATABASE_URL', TODO, 'not set: the database checks did not run (run this on the web or worker service to include them)')]
  const items = []
  for (const [name, check] of [['Migration 0054', migrationItem], ['Migration 0055', indexItem], ['Migration 0056', executionIndexItem],
    ['Market partition', partitionItem], ['SOL ledgers', solLedgerItem]]) {
    try { items.push(await readOnly(db, () => check(db))) } catch (error) {
      items.push(item(SECTION.database, name, FAIL, `could not read the database: ${error.message}`))
    }
  }
  return items
}

// ---------- switches ----------
function switchItems({ env, launchesReady }) {
  const on = key => env[key] === 'true'
  const odd = key => env[key] !== undefined && !['', 'true', 'false'].includes(env[key]) ? ' (it is set, but only exactly "true" turns it on)' : ''
  const open = launchesReady && stockQuotesEnabled(env)
  const flag = (key, ifOn, ifOff) => item(SECTION.switches, key, on(key) ? ON : OFF, on(key) ? `on in this environment: ${ifOn}` : `off in this environment${odd(key)}: ${ifOff}`)
  return [
    item(SECTION.switches, 'STOCK_PAIR_LAUNCHES_READY', launchesReady ? ON : OFF, launchesReady ? 'the code gate in src/quote-assets.mjs is open'
      : 'the code gate in src/quote-assets.mjs; the switch PR turns it on (docs/STOCK_GO_LIVE.md, step 6)'),
    flag('STOCK_QUOTES_ENABLED', 'the launch form offers stock pairs where the code gate allows', 'only SOL pairs are offered (turned on at go-live, on web)'),
    item(SECTION.switches, 'Stock launches', open ? ON : OFF, open ? 'open in this environment: both switches above are on'
      : 'closed in this environment: they open only when both switches above are on'),
    flag('STOCK_COLLECTIONS_EXECUTION_ENABLED', 'stock fee collections may be executed', 'stock fees stay in the pools; collections are previews only (later, off by default)'),
    flag('STOCK_LAUNCHER_PAYOUTS_ENABLED', 'launcher payouts in the stock may be sent', 'no launcher payout is sent (later, off by default)'),
  ]
}

// ---------- report ----------
// Secret-bearing settings are never printed: the RPC and database URLs whole, the database password, and the RPC's
// credentials, query values and path tokens (providers put API keys in either).
function redactor(env) {
  const secrets = new Set()
  const decoded = text => { try { return decodeURIComponent(text) } catch { return text } }
  const parts = (value, rpc) => {
    let url
    try { url = new URL(value) } catch { return [] } // not a URL: only the whole value is redacted
    return [url.password, ...rpc ? [url.username, ...url.searchParams.values(), ...url.pathname.split('/')] : []]
  }
  for (const [key, rpc] of [['SOLANA_RPC_URL', true], ['DATABASE_URL', false]]) {
    const value = env[key]?.trim()
    if (!value) continue
    secrets.add(value)
    for (const part of parts(value, rpc).flatMap(text => [text, decoded(text)])) if (part && part.length >= 6) secrets.add(part)
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length)
  return text => ordered.reduce((out, secret) => out.split(secret).join('[redacted]'), String(text))
}

// { ok, items: [{ section, name, status, reason }] }: ok is false when any item is FAIL. connection needs only getGenesisHash,
// getMultipleAccountsInfo and getEpochInfo; db (a pg client, optional) only query. launchesReady is the code gate, injectable for
// tests.
export async function checkStockReadiness({ env = {}, connection, db = null, dbError = null, registry = QUOTE_REGISTRY,
  launchesReady = STOCK_PAIR_LAUNCHES_READY, now = Date.now } = {}) {
  const assets = registry.assets.filter(asset => asset.type === 'TOKENIZED_EQUITY')
  const parsed = configsItem(env, registry, launchesReady && stockQuotesEnabled(env))
  const chain = await chainItems({ connection, env, assets, configs: parsed.configs, nowSeconds: Math.floor(now() / 1000) })
  const items = [...chain.network, ...chain.registry, parsed.item, ...chain.configs, ...await checkDatabase({ db, dbError }), ...chain.custody,
    ...switchItems({ env, launchesReady })]
  const redact = redactor(env)
  const report = items.map(entry => ({ ...entry, reason: redact(entry.reason) }))
  return { ok: !report.some(entry => entry.status === FAIL), items: report }
}

export function formatReadiness({ ok, items }) {
  const lines = ['Stock-pair go-live readiness (read-only: nothing is signed, sent or written)']
  let section = null
  for (const entry of items) {
    if (entry.section !== section) lines.push('', section = entry.section)
    lines.push(`  ${entry.status.padEnd(4)}  ${entry.name}: ${entry.reason}`)
  }
  const count = status => items.filter(entry => entry.status === status).length
  lines.push('', `${ok ? 'No FAIL' : `${count(FAIL)} FAIL`}, ${count(TODO)} TODO, ${count(PASS)} PASS; switches ${count(ON)} on, ${count(OFF)} off. ` +
    'Nothing was signed, sent or written.')
  return `${lines.join('\n')}\n`
}
