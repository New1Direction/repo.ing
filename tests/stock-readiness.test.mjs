import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import BN from 'bn.js'
import { Keypair, PublicKey } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, AccountState, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PLATFORM_FEE_WALLET } from '../app/lib/buyback-receipts.mjs'
import { buildStockLaunchCurve } from '../src/launch-curve.mjs'
import { launchFeeBaseFee } from '../src/launch-fee.mjs'
import { DBC_PROGRAM_ID } from '../src/launch-fee-config.mjs'
import { QUOTE_REGISTRY, STOCK_PAIR_LAUNCHES_READY, stockPairsLaunchable } from '../src/quote-assets.mjs'
import { INDEXED_MARKETS, MAINNET_GENESIS, READINESS_ENV, SOL_INDEXER_MARKETS, SOL_LEDGERS, STOCK_INDEXER_MARKETS, STOCK_LEDGER_FUNCTIONS,
  STOCK_LEDGER_INDEXES, STOCK_LEDGER_TABLES, STOCK_LEDGER_TRIGGERS, checkStockReadiness, custodyAddress, formatReadiness, partitionProblems,
  stockBadges } from '../src/stock-readiness.mjs'
import { readinessEnv } from '../scripts/stock-readiness.mjs'

// src/stock-readiness.mjs against a fake connection and fake database: fixture accounts only, never mainnet. The METAx mint is
// mainnet's (tests/fixtures/metax-mint.json); DBC configs are PoolConfig accounts encoded by the DBC program's own coder, with
// the terms scripts/create-stock-quote-config.mjs creates (the SOL launch-fee config's, quoted in the stock, with the curve
// buildStockLaunchCurve builds for the threshold).
const STOCKS = QUOTE_REGISTRY.assets.filter(asset => asset.type === 'TOKENIZED_EQUITY')
const [META, MSFT, NVDA] = ['meta-xstock', 'msft-xstock', 'nvda-xstock'].map(id => STOCKS.find(asset => asset.assetId === id))
const METAX_MINT = Buffer.from(JSON.parse(readFileSync(new URL('./fixtures/metax-mint.json', import.meta.url), 'utf8')).data, 'base64')
const NOW = () => Date.parse('2026-10-04T12:00:00Z')
const CREATOR_SIGNER = new PublicKey('FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1')
const key = () => Keypair.generate().publicKey.toBase58()
const CONFIGS = Object.fromEntries(STOCKS.map(asset => [asset.assetId, key()]))
const SOL_CONFIG = key()
const RPC_SECRET = 'rpc-SECRET-api-key-0001', DB_SECRET = 'db-SECRET-password-0002'
const ENV = Object.freeze({ SOLANA_RPC_URL: `https://mainnet.rpc.example/v1/${RPC_SECRET}?api-key=${RPC_SECRET}`,
  STOCK_QUOTE_CONFIGS: JSON.stringify(CONFIGS), DBC_CONFIG: SOL_CONFIG })

// ---------- fixture accounts ----------
const coder = new DynamicBondingCurveClient({ rpcEndpoint: 'fixture' }, 'finalized').state.getProgram().coder.accounts
const SIZE = coder.size('poolConfig'), DISCRIMINATOR = Buffer.from(coder.accountDiscriminator('poolConfig'))
const encode = decoded => {
  const body = Buffer.alloc(SIZE - 8)
  coder.accountLayouts.get('poolConfig').layout.encode(decoded, body)
  return Buffer.concat([DISCRIMINATOR, body])
}
// The live SOL launch-fee config's terms (docs/LAUNCH_FEE.md): quoted in SOL, the launch fee, 71% creator share, DAMM v2.
function solConfig() {
  const config = coder.decode('poolConfig', Buffer.concat([DISCRIMINATOR, Buffer.alloc(SIZE - 8)])), fee = launchFeeBaseFee()
  Object.assign(config.poolFees.baseFee, { cliffFeeNumerator: fee.cliffFeeNumerator, firstFactor: fee.firstFactor, secondFactor: fee.secondFactor,
    thirdFactor: fee.thirdFactor, baseFeeMode: fee.baseFeeMode })
  return Object.assign(config, { quoteMint: NATIVE_MINT, feeClaimer: new PublicKey(PLATFORM_FEE_WALLET), leftoverReceiver: CREATOR_SIGNER,
    collectFeeMode: 0, migrationOption: 1, activationType: 1, tokenDecimal: 6, tokenType: 0, quoteTokenFlag: 0, migrationFeeOption: 2,
    partnerPermanentLockedLiquidityPercentage: 50, creatorPermanentLockedLiquidityPercentage: 50, creatorTradingFeePercentage: 71,
    tokenUpdateAuthority: 1, enableFirstSwapWithMinFee: 1, migrationQuoteThreshold: new BN('85000000000') })
}
// A stock's config as the create script makes it, graduating at `graduation` whole units; overrides change single fields.
function stockConfig(asset, graduation = 14, overrides = {}) {
  const curve = buildStockLaunchCurve({ quoteDecimals: asset.decimals, migrationQuoteThreshold: graduation }), config = solConfig()
  return Object.assign(config, { quoteMint: new PublicKey(asset.mint), quoteTokenFlag: 1,
    migrationQuoteThreshold: new BN(String(BigInt(graduation) * 10n ** BigInt(asset.decimals))), sqrtStartPrice: curve.sqrtStartPrice,
    preMigrationTokenSupply: curve.tokenSupply.preMigrationTokenSupply, postMigrationTokenSupply: curve.tokenSupply.postMigrationTokenSupply,
    curve: config.curve.map((zero, index) => curve.curve[index] ?? zero) }, overrides)
}
const account = (owner, data) => ({ owner, data, lamports: 1_000_000, executable: false, rentEpoch: 0 })
const configAccount = decoded => account(DBC_PROGRAM_ID, encode(decoded))
function tokenAccount(asset, { amount = 250_000_000n, state = AccountState.Initialized } = {}) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode({ mint: new PublicKey(asset.mint), owner: new PublicKey(PLATFORM_FEE_WALLET), amount, delegateOption: 0, delegate: PublicKey.default,
    state, isNativeOption: 0, isNative: 0n, delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data)
  return account(TOKEN_2022_PROGRAM_ID, data)
}
// The METAx mint with one extension's bytes changed: Token-2022 TLV entries follow the 82-byte mint, its padding to 165 bytes
// and the account type byte.
function patchedMint(type, patch) {
  const data = Buffer.from(METAX_MINT)
  for (let at = 166; at + 4 <= data.length; at += 4 + data.readUInt16LE(at + 2)) {
    if (data.readUInt16LE(at) === type) { patch(data, at + 4); return data }
  }
  throw Error(`extension ${type} not in the fixture`)
}
const mintAccount = data => account(TOKEN_2022_PROGRAM_ID, data)

// Every stock ready: its mint, Meteora's badges, its config, and the partner wallet's custody account; plus the SOL config.
function chain(overrides = {}) {
  const accounts = new Map([[SOL_CONFIG, configAccount(solConfig())]])
  for (const asset of STOCKS) {
    accounts.set(asset.mint, mintAccount(METAX_MINT))
    for (const [, badge, program] of stockBadges(asset)) accounts.set(badge.toBase58(), account(program, Buffer.alloc(8)))
    accounts.set(CONFIGS[asset.assetId], configAccount(stockConfig(asset)))
    accounts.set(custodyAddress(asset).toBase58(), tokenAccount(asset))
  }
  for (const [address, value] of Object.entries(overrides)) value === null ? accounts.delete(address) : accounts.set(address, value)
  return accounts
}
// A read-only fake RPC: these three reads are all it offers, so any other call (a send, a simulation) would throw.
function fakeConnection(accounts, { genesis = MAINNET_GENESIS, fail = null } = {}) {
  const calls = []
  return { calls, rpcEndpoint: 'fixture',
    getGenesisHash: async () => { calls.push('getGenesisHash'); if (fail) throw fail; return genesis },
    getEpochInfo: async commitment => { calls.push(`getEpochInfo ${commitment}`); return { epoch: 860 } },
    getMultipleAccountsInfo: async (keys, commitment) => {
      calls.push(`getMultipleAccountsInfo ${commitment}`)
      return keys.map(address => accounts.get(address.toBase58()) ?? null)
    } }
}
async function run({ env = ENV, accounts = chain(), connection = fakeConnection(accounts), db = null, dbError = null, launchesReady = false } = {}) {
  const report = await checkStockReadiness({ env, connection, db, dbError, launchesReady, now: NOW })
  const find = name => report.items.find(entry => entry.name === name) ?? assert.fail(`no item ${name}`)
  return { report, connection, text: formatReadiness(report), find, status: name => find(name).status }
}
const statuses = report => report.items.filter(entry => entry.status === 'FAIL').map(entry => `${entry.name}: ${entry.reason}`)

// ---------- fake database ----------
const TRIGGERS = STOCK_LEDGER_TRIGGERS.map(({ table, name, function: fn }) => ({ table, name, function: fn, enabled: 'O' }))
const INDEXES = STOCK_LEDGER_INDEXES.map(({ table, name }) => ({ name, table, valid: true }))
function fakeDb({ tables = STOCK_LEDGER_TABLES, functions = STOCK_LEDGER_FUNCTIONS, triggers = TRIGGERS, indexes = INDEXES, all = ['1', '2', '3'], sol = ['1', '2'],
  stock = ['3'], ledgers = [], fail = null } = {}) {
  const queries = []
  const query = async (sql, params = []) => {
    queries.push(sql.trim())
    if (/^(begin transaction read only|set local statement_timeout|rollback)/.test(sql)) return { rows: [] }
    if (fail?.test(sql)) throw Error(`relation is unreadable (postgres://reader:${DB_SECRET}@db.internal:5432/railway)`)
    if (sql.includes('to_regclass(name) is not null')) return { rows: params[0].map(name => ({ name, present: tables.includes(name) })) }
    if (sql.includes('to_regprocedure')) return { rows: params[0].map(name => ({ name, present: functions.includes(name) })) }
    if (sql.includes('from pg_trigger')) return { rows: triggers }
    if (sql.includes('from pg_index')) return { rows: indexes }
    for (const [where, ids] of [[STOCK_INDEXER_MARKETS, stock], [SOL_INDEXER_MARKETS, sol], [INDEXED_MARKETS, all]]) {
      if (sql.includes(`where ${where} order by`)) return { rows: ids.map(id => ({ id })) }
    }
    if (sql.includes('union all')) return { rows: SOL_LEDGERS.map(({ table }) => ledgers.find(row => row.ledger === table) ?? { ledger: table, rows: 0, markets: [] }) }
    throw Error(`unexpected query: ${sql}`)
  }
  return { queries, query }
}

test('ready stocks: every check passes through three read calls, and the switches are shown off', async () => {
  // Arrange + Act
  const { report, connection, text, find } = await run()

  // Assert
  assert.deepEqual(statuses(report), [])
  assert.equal(report.ok, true)
  assert.deepEqual(connection.calls.sort(), ['getEpochInfo finalized', 'getGenesisHash', 'getMultipleAccountsInfo finalized'])
  const byStatus = Object.groupBy(report.items, entry => entry.status)
  assert.deepEqual(Object.keys(byStatus).sort(), ['OFF', 'PASS', 'TODO'])
  assert.deepEqual(byStatus.TODO.map(entry => entry.name), ['DATABASE_URL'])
  assert.deepEqual(byStatus.OFF.map(entry => entry.name), ['STOCK_PAIR_LAUNCHES_READY', 'STOCK_QUOTES_ENABLED', 'Stock launches',
    'STOCK_COLLECTIONS_EXECUTION_ENABLED', 'STOCK_LAUNCHER_PAYOUTS_ENABLED'])
  for (const asset of STOCKS) {
    for (const what of ['mint', 'units', 'usable now', 'Meteora badges']) assert.equal(find(`${asset.symbol} ${what}`).status, 'PASS')
    for (const what of ['', ' quote', ' creator share', ' fee claimer', ' graduation', ' terms']) assert.equal(find(`${asset.symbol} config${what}`).status, 'PASS')
    assert.equal(find(`${asset.symbol} custody`).status, 'PASS')
  }
  assert.match(find('METAx units').reason, /^ScaledUiAmount multiplier 1\.0028515433272898 in force/)
  assert.match(text, /PASS {2}METAx config graduation: a market graduates when its curve holds 14 METAx \(1400000000 raw units; about 14\.0399 as wallets show it today\)\n/)
  assert.match(text, /PASS {2}METAx config creator share: 71% of the fee after Meteora's, as stock fee policy 1 needs\n/)
  assert.match(text, new RegExp(`PASS {2}METAx config fee claimer: the platform partner wallet ${PLATFORM_FEE_WALLET}\n`))
  assert.match(text, new RegExp(`PASS {2}METAx custody: the partner wallet's METAx account ${custodyAddress(META).toBase58()} holds 2\\.5 METAx \\(250000000 raw units; about 2\\.5071`))
  assert.match(text, /PASS {2}SOL launch config: DBC_CONFIG \w+: the terms each stock config must carry\n/)
  assert.match(text, /\nNo FAIL, 1 TODO, \d+ PASS; switches 0 on, 5 off\. Nothing was signed, sent or written\.\n$/)
  // Sections come in checklist order.
  assert.deepEqual([...new Set(report.items.map(entry => entry.section))], ['Network', 'Registry', 'Stock configs', 'Database', 'Custody', 'Switches'])
  assert.equal(text.includes(RPC_SECRET), false)
})

test('STOCK_QUOTE_CONFIGS: unset is an owner step (TODO); malformed, or unset while launches are open, is a FAIL', async () => {
  const { DBC_CONFIG, SOLANA_RPC_URL } = ENV
  const unset = await run({ env: { SOLANA_RPC_URL } })
  assert.equal(unset.report.ok, true)
  assert.deepEqual([unset.find('STOCK_QUOTE_CONFIGS').status, unset.find('STOCK_QUOTE_CONFIGS').reason],
    ['TODO', 'not set: owner step (create each stock\'s config, then set it on web and worker)'])
  assert.equal(unset.report.items.some(entry => / config/.test(entry.name)), false, 'no per-config items without configs')

  for (const [value, reason] of [['{"meta-xstock":', /must be a JSON object/], [JSON.stringify({ 'tsla-xstock': SOL_CONFIG }), /unknown asset: tsla-xstock/],
    [JSON.stringify({ 'meta-xstock': SOL_CONFIG, 'msft-xstock': SOL_CONFIG }), /repeats a config/]]) {
    const { report, find } = await run({ env: { SOLANA_RPC_URL, DBC_CONFIG, STOCK_QUOTE_CONFIGS: value } })
    assert.equal(report.ok, false)
    assert.equal(find('STOCK_QUOTE_CONFIGS').status, 'FAIL')
    assert.match(find('STOCK_QUOTE_CONFIGS').reason, reason)
  }

  const open = await run({ env: { SOLANA_RPC_URL, STOCK_QUOTES_ENABLED: 'true' }, launchesReady: true })
  assert.equal(open.status('STOCK_QUOTE_CONFIGS'), 'FAIL')
  assert.match(open.find('STOCK_QUOTE_CONFIGS').reason, /stock launches are open here/)

  // Only METAx set: the other stocks are owner steps, not failures.
  const partial = await run({ env: { ...ENV, STOCK_QUOTE_CONFIGS: JSON.stringify({ 'meta-xstock': CONFIGS['meta-xstock'] }) } })
  assert.equal(partial.report.ok, true)
  assert.deepEqual([partial.status('METAx config terms'), partial.status('MSFTx config'), partial.status('NVDAx config')], ['PASS', 'TODO', 'TODO'])
  assert.match(partial.find('MSFTx config').reason, /^not in STOCK_QUOTE_CONFIGS: MSFTx pairs cannot launch until its config is created and set/)
})

test('a config quoting another mint, a creator share other than 71 or another fee claimer fails', async () => {
  // Wrong mint: the METAx entry names a config quoted in MSFTx.
  const wrongMint = await run({ accounts: chain({ [CONFIGS['meta-xstock']]: configAccount(stockConfig(MSFT)) }) })
  assert.equal(wrongMint.report.ok, false)
  assert.equal(wrongMint.status('METAx config quote'), 'FAIL')
  assert.match(wrongMint.find('METAx config quote').reason, new RegExp(`^quotes ${MSFT.mint}, not the registry's METAx mint ${META.mint}`))
  assert.match(wrongMint.find('METAx config terms').reason, /does not quote the asset mint/)
  assert.equal(wrongMint.status('MSFTx config quote'), 'PASS')
  // Not through Token-2022.
  const flag = await run({ accounts: chain({ [CONFIGS['meta-xstock']]: configAccount(stockConfig(META, 14, { quoteTokenFlag: 0 })) }) })
  assert.match(flag.find('METAx config quote').reason, /without the Token-2022 flag/)

  // Creator share 70: the fee policy's own check refuses it.
  const share = await run({ accounts: chain({ [CONFIGS['meta-xstock']]: configAccount(stockConfig(META, 14, { creatorTradingFeePercentage: 70 })) }) })
  assert.equal(share.report.ok, false)
  assert.equal(share.status('METAx config creator share'), 'FAIL')
  assert.match(share.find('METAx config creator share').reason, /needs a creator share of 71%; the config has 70/)
  assert.match(share.find('METAx config terms').reason, /differs from the SOL launch-fee config in: creatorTradingFeePercentage/)

  // Another fee claimer.
  const other = key()
  const claimer = await run({ accounts: chain({ [CONFIGS['nvda-xstock']]: configAccount(stockConfig(NVDA, 14, { feeClaimer: new PublicKey(other) })) }) })
  assert.equal(claimer.report.ok, false)
  assert.equal(claimer.find('NVDAx config fee claimer').reason, `${other}, not the platform partner wallet ${PLATFORM_FEE_WALLET}: its fees would be claimed elsewhere`)
})

test('fee mode, migration settings and curve must be what the create script makes, at a whole-unit threshold', async () => {
  const failing = async (overrides, graduation = 14) => {
    const { report, find } = await run({ accounts: chain({ [CONFIGS['meta-xstock']]: configAccount(stockConfig(META, graduation, overrides)) }) })
    assert.equal(report.ok, false)
    return find
  }
  assert.match((await failing({ collectFeeMode: 1 }))('METAx config terms').reason, /differs from the SOL launch-fee config in: collectFeeMode \(compared with DBC_CONFIG/)
  assert.match((await failing({ migrationOption: 0 }))('METAx config terms').reason, /in: migrationOption/)
  assert.match((await failing({ migrationFeeOption: 3 }))('METAx config terms').reason, /in: migrationFeeOption/)
  assert.match((await failing({ sqrtStartPrice: new BN(1) }))('METAx config terms').reason, /differs from the curve it was built from in: sqrtStartPrice/)
  // A threshold that is not a whole number of the stock: reported, and the terms are not compared.
  const half = await failing({ migrationQuoteThreshold: new BN('1450000000') })
  assert.match(half('METAx config graduation').reason, /^1450000000 raw units is not a positive whole number of METAx/)
  assert.match(half('METAx config terms').reason, /^not compared/)
  // Another whole threshold is fine, and reported in the stock's units.
  const { find } = await run({ accounts: chain({ [CONFIGS['meta-xstock']]: configAccount(stockConfig(META, 20)) }) })
  assert.match(find('METAx config graduation').reason, /holds 20 METAx \(2000000000 raw units; about 20\.057/)
  assert.equal(find('METAx config terms').status, 'PASS')
})

test('config accounts must be DBC configs: owner, size and discriminator', async () => {
  const good = configAccount(stockConfig(META))
  for (const [value, reason] of [[null, /no account at this address/], [account(TOKEN_PROGRAM_ID, good.data), /not the DBC program/],
    [account(DBC_PROGRAM_ID, Buffer.concat([good.data, Buffer.alloc(1)])), new RegExp(`${SIZE + 1} bytes, where a DBC config has ${SIZE}`)],
    [account(DBC_PROGRAM_ID, Buffer.concat([Buffer.alloc(8, 7), good.data.subarray(8)])), /wrong account discriminator/]]) {
    const { report, find } = await run({ accounts: chain({ [CONFIGS['meta-xstock']]: value }) })
    assert.equal(report.ok, false)
    assert.equal(find('METAx config').status, 'FAIL')
    assert.match(find('METAx config').reason, reason)
    assert.equal(report.items.some(entry => entry.name.startsWith('METAx config ')), false, 'nothing else is read from a bad account')
  }
})

test('the SOL launch config (DBC_CONFIG) must be set and be a SOL config', async () => {
  const { DBC_CONFIG, ...withoutReference } = ENV
  const unset = await run({ env: withoutReference })
  assert.equal(unset.report.ok, false)
  assert.match(unset.find('SOL launch config').reason, /^DBC_CONFIG is not set/)
  assert.match(unset.find('METAx config terms').reason, /^not compared: DBC_CONFIG is not set/)
  // A stock config given as the reference would compare a config with itself: refused.
  const stock = await run({ env: { ...ENV, DBC_CONFIG: CONFIGS['meta-xstock'] } })
  assert.match(stock.find('SOL launch config').reason, /not quoted in SOL$/)
  assert.equal(stock.status('METAx config terms'), 'FAIL')
  const missing = await run({ accounts: chain({ [DBC_CONFIG]: null }) })
  assert.match(missing.find('SOL launch config').reason, /no account at this address/)
})

test('registry mints: Token-2022, the registry\'s decimals, a ScaledUiAmount extension with a sane multiplier, usable, badged', async () => {
  const mintFails = async (data, name, reason, owner = TOKEN_2022_PROGRAM_ID) => {
    const { report, find } = await run({ accounts: chain({ [META.mint]: account(owner, data) }) })
    assert.equal(report.ok, false)
    assert.equal(find(name).status, 'FAIL')
    assert.match(find(name).reason, reason)
    return find
  }
  // Missing extension: the base mint alone.
  await mintFails(METAX_MINT.subarray(0, 82), 'METAx units', /no ScaledUiAmount extension/)
  await mintFails(METAX_MINT, 'METAx mint', /not Token-2022/, TOKEN_PROGRAM_ID)
  const decimals = Buffer.from(METAX_MINT)
  decimals[44] = 6
  await mintFails(decimals, 'METAx mint', /6 decimals where the registry pins 8/)
  await mintFails(patchedMint(ExtensionType.ScaledUiAmountConfig, (data, at) => data.writeDoubleLE(0, at + 32)), 'METAx units', /multiplier 0 is not a plain number/)
  await mintFails(patchedMint(ExtensionType.ScaledUiAmountConfig, (data, at) => data.writeDoubleLE(250, at + 48)), 'METAx units', /scheduled multiplier 250/)
  await mintFails(patchedMint(ExtensionType.PausableConfig, (data, at) => { data[at + 32] = 1 }), 'METAx usable now', /paused by the issuer: stock launches refuse METAx/)
  // A scheduled change is shown with its time.
  const later = await run({ accounts: chain({ [META.mint]: mintAccount(patchedMint(ExtensionType.ScaledUiAmountConfig, (data, at) => {
    data.writeBigInt64LE(BigInt(Date.parse('2026-12-01T00:00:00Z') / 1000), at + 40)
    data.writeDoubleLE(1.5, at + 48)
  })) }) })
  assert.match(later.find('METAx units').reason, /^ScaledUiAmount multiplier 1\.002298265651938 in force, then 1\.5 from 2026-12-01T00:00:00\.000Z/)
  // No mint account at all.
  const gone = await run({ accounts: chain({ [META.mint]: null }) })
  assert.match(gone.find('METAx mint').reason, /no account at this address/)
  // Meteora's badges.
  const [[, dbcBadge], [, dammBadge]] = stockBadges(META)
  const noBadge = await run({ accounts: chain({ [dammBadge.toBase58()]: null }) })
  assert.match(noBadge.find('METAx Meteora badges').reason, new RegExp(`^no DAMM v2 token badge \\(${dammBadge.toBase58()}\\): METAx pairs cannot graduate without it`))
  const both = await run({ accounts: chain({ [dbcBadge.toBase58()]: account(TOKEN_PROGRAM_ID, Buffer.alloc(8)), [dammBadge.toBase58()]: null }) })
  assert.match(both.find('METAx Meteora badges').reason, /cannot launch or graduate without them/)
})

test('custody: no partner account yet is a TODO (created on first collection); a frozen one fails', async () => {
  const address = custodyAddress(MSFT).toBase58()
  const missing = await run({ accounts: chain({ [address]: null }) })
  assert.equal(missing.report.ok, true)
  assert.deepEqual([missing.status('MSFTx custody'), missing.find('MSFTx custody').reason],
    ['TODO', `the partner wallet has no MSFTx account yet (${address}): created on first collection`])
  const frozen = await run({ accounts: chain({ [address]: tokenAccount(MSFT, { state: AccountState.Frozen }) }) })
  assert.equal(frozen.report.ok, false)
  assert.match(frozen.find('MSFTx custody').reason, /frozen by the issuer/)
  const otherMint = await run({ accounts: chain({ [address]: tokenAccount(META) }) })
  assert.match(otherMint.find('MSFTx custody').reason, /not the partner wallet's MSFTx account/)
})

test('an RPC that is not mainnet, or cannot be read, fails and the chain checks do not run', async () => {
  const devnet = await run({ connection: fakeConnection(chain(), { genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' }) })
  assert.equal(devnet.report.ok, false)
  assert.match(devnet.find('RPC').reason, /^not Solana mainnet/)
  assert.deepEqual(devnet.connection.calls, ['getGenesisHash'])
  assert.deepEqual([...new Set(devnet.report.items.map(entry => entry.section))], ['Network', 'Stock configs', 'Database', 'Switches'])
  const down = await run({ connection: fakeConnection(chain(), { fail: Error(`fetch failed for ${ENV.SOLANA_RPC_URL}`) }) })
  assert.match(down.find('RPC').reason, /^could not read the RPC: fetch failed for \[redacted\]$/)
  assert.equal(down.text.includes(RPC_SECRET), false)
})

test('switches are shown on or off, never as a failure; launches open only with both', async () => {
  const on = await run({ env: { ...ENV, STOCK_QUOTES_ENABLED: 'true', STOCK_COLLECTIONS_EXECUTION_ENABLED: 'true', STOCK_LAUNCHER_PAYOUTS_ENABLED: 'yes' },
    launchesReady: true })
  assert.equal(on.report.ok, true)
  assert.deepEqual(['STOCK_PAIR_LAUNCHES_READY', 'STOCK_QUOTES_ENABLED', 'Stock launches', 'STOCK_COLLECTIONS_EXECUTION_ENABLED', 'STOCK_LAUNCHER_PAYOUTS_ENABLED']
    .map(name => on.status(name)), ['ON', 'ON', 'ON', 'ON', 'OFF'])
  assert.match(on.find('STOCK_LAUNCHER_PAYOUTS_ENABLED').reason, /only exactly "true" turns it on/)
  const gateClosed = await run({ env: { ...ENV, STOCK_QUOTES_ENABLED: 'true' } })
  assert.deepEqual([gateClosed.status('STOCK_QUOTES_ENABLED'), gateClosed.status('Stock launches')], ['ON', 'OFF'])
  // The code gate is the real one by default, and "Stock launches" agrees with stockPairsLaunchable.
  for (const STOCK_QUOTES_ENABLED of ['true', 'false']) {
    const report = await checkStockReadiness({ env: { ...ENV, STOCK_QUOTES_ENABLED }, connection: fakeConnection(chain()), now: NOW })
    const status = name => report.items.find(entry => entry.name === name).status
    assert.equal(status('STOCK_PAIR_LAUNCHES_READY'), STOCK_PAIR_LAUNCHES_READY ? 'ON' : 'OFF')
    assert.equal(status('Stock launches'), stockPairsLaunchable({ STOCK_QUOTES_ENABLED }) ? 'ON' : 'OFF')
  }
})

test('database: migrations 0054 and 0055, the market partition and the SOL ledgers, each read in its own READ ONLY transaction', async () => {
  const db = fakeDb()
  const { report, find } = await run({ db })
  assert.equal(report.ok, true)
  assert.deepEqual(['Migration 0054', 'Migration 0055', 'Market partition', 'SOL ledgers'].map(name => find(name).status), ['PASS', 'PASS', 'PASS', 'PASS'])
  assert.equal(find('Migration 0055').reason, 'the stock ledgers\' 3 read indexes are present and valid')
  assert.equal(find('Market partition').reason, '3 indexed markets: 2 SOL (the SOL indexer\'s list) + 1 stock (the stock indexer\'s list), none in both')
  assert.match(find('SOL ledgers').reason, /^no stock-paired market in any of the 12 SOL fee, trade, claim and reward tables$/)
  // Four transactions, each begun read only and rolled back; nothing but reads in between.
  assert.equal(db.queries.filter(sql => sql === 'begin transaction read only').length, 4)
  assert.equal(db.queries.filter(sql => sql === 'rollback').length, 4)
  for (const sql of db.queries) assert.match(sql, /^(begin transaction read only|set local statement_timeout = '30s'|rollback|select )/)
})

test('database failures: partition overlap, missing 0054 objects or 0055 indexes, stock rows in SOL ledgers, unreadable tables', async () => {
  // Partition overlap: market 2 in both indexers' lists, market 4 in neither.
  const overlap = await run({ db: fakeDb({ all: ['1', '2', '3', '4'], sol: ['1', '2'], stock: ['2', '3'] }) })
  assert.equal(overlap.report.ok, false)
  assert.equal(overlap.find('Market partition').reason, 'in both indexers\' lists: 2; in neither list: 4: stock fees could be skipped or counted twice')
  assert.deepEqual(partitionProblems({ all: ['1'], sol: ['1', '9'], stock: [] }), ['listed but not an indexed market: 9'])
  // 0054 objects.
  const objects = await run({ db: fakeDb({ tables: STOCK_LEDGER_TABLES.filter(name => name !== 'stock_fee_events'),
    functions: STOCK_LEDGER_FUNCTIONS.slice(1), triggers: TRIGGERS.map((row, index) => index === 0 ? { ...row, enabled: 'D' } : index === 1 ? { ...row, function: 'other' } : row).slice(0, -1) }) })
  assert.equal(objects.find('Migration 0054').reason, 'table stock_fee_events missing; function stock_ledger_market_check() missing; ' +
    'trigger stock_ledger_market_check on stock_trade_events disabled; trigger stock_ledger_market_check on stock_fee_events calls other(); ' +
    'trigger repoing_stock_fee_update on stock_fee_events missing: apply migration 0054 as written')
  // 0055's read indexes: missing, on another table, not valid.
  const indexes = await run({ db: fakeDb({ indexes: [{ ...INDEXES[1], table: 'stock_trade_events' }, { ...INDEXES[2], valid: false }] }) })
  assert.equal(indexes.report.ok, false)
  assert.equal(indexes.find('Migration 0055').reason, 'index stock_trade_events_repo_traded_at missing; index stock_fee_events_repo_slot is on ' +
    'stock_trade_events, not stock_fee_events; index stock_fee_collections_repo_status on stock_fee_collections is not valid: apply migration 0055 as written')
  // A stock market in SOL ledgers.
  const ledgers = await run({ db: fakeDb({ ledgers: [{ ledger: 'fee_events', rows: 2, markets: ['94911145'] }, { ledger: 'trade_events', rows: 1, markets: ['94911145'] }] }) })
  assert.equal(ledgers.find('SOL ledgers').reason, 'fee_events has 2 row(s) of stock-paired market(s) 94911145; trade_events has 1 row(s) of ' +
    'stock-paired market(s) 94911145: stock pairs must stay in the stock ledgers')
  // One unreadable check fails alone; the others still run, and the database URL's password is never printed.
  const env = { ...ENV, DATABASE_URL: `postgres://reader:${DB_SECRET}@db.internal:5432/railway` }
  const unreadable = await run({ env, db: fakeDb({ fail: /from pg_trigger/ }) })
  assert.deepEqual(['Migration 0054', 'Migration 0055', 'Market partition', 'SOL ledgers'].map(name => unreadable.status(name)), ['FAIL', 'PASS', 'PASS', 'PASS'])
  assert.match(unreadable.find('Migration 0054').reason, /^could not read the database: relation is unreadable \(\[redacted\]\)$/)
  const refused = await run({ env, dbError: Error(`password authentication failed: ${DB_SECRET}`) })
  assert.deepEqual([refused.status('Connection'), refused.find('Connection').reason], ['FAIL', 'could not connect to DATABASE_URL: password authentication failed: [redacted]'])
  for (const { text } of [unreadable, refused]) assert.equal(text.includes(DB_SECRET), false)
})

test('only the variables the checks need are read, and the script takes nothing else from the environment', async () => {
  const strict = new Proxy({ ...ENV, STOCK_QUOTES_ENABLED: 'false' }, { get(target, property) {
    if (typeof property === 'string' && !READINESS_ENV.includes(property)) throw Error(`read ${property}`)
    return target[property]
  } })
  const { report } = await run({ env: strict, db: fakeDb() })
  assert.equal(report.ok, true)
  assert.deepEqual(readinessEnv({ ...ENV, PLATFORM_PARTNER_SECRET_KEY: 'x', PLATFORM_CREATOR_SECRET_KEY: 'y', STOCK_QUOTES_ENABLED: 'true' }),
    { ...ENV, STOCK_QUOTES_ENABLED: 'true' })
})

test('read-only by construction: no key, no signing or sending, in the module or the script', () => {
  for (const file of ['../src/stock-readiness.mjs', '../scripts/stock-readiness.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    for (const forbidden of [/Keypair/, /secretKey/i, /SECRET_KEY/, /\bsend(Raw|And|)Transaction/, /sendAndConfirm/, /simulateTransaction/, /\.sign\(/,
      /signTransaction/, /find-generic-password/, /secrets\//, /requestAirdrop/]) assert.doesNotMatch(source, forbidden, `${file}: ${forbidden}`)
  }
})

test('the readiness checks follow the code they mirror', () => {
  const source = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\s+/g, ' ')
  // The SOL and stock indexers' market lists are exactly the partition checked.
  assert.ok(source('../src/external-fee-indexer.mjs').includes(`from markets where ${SOL_INDEXER_MARKETS} order by github_repo_id`))
  assert.ok(source('../src/stock-fee-indexer.mjs').includes(`from markets where ${STOCK_INDEXER_MARKETS} order by github_repo_id`))
  // Migration 0054 creates every object checked.
  const migration = source('../drizzle/0054_stock_ledgers.sql')
  for (const table of STOCK_LEDGER_TABLES) assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS "${table}"`), table)
  for (const fn of STOCK_LEDGER_FUNCTIONS) assert.ok(migration.includes(`CREATE OR REPLACE FUNCTION ${fn}()`), fn)
  for (const { table, name, function: fn } of STOCK_LEDGER_TRIGGERS) {
    assert.match(migration, new RegExp(`CREATE TRIGGER ${name} [^;]*? ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${fn}\\(\\)`), `${name} on ${table}`)
  }
  // Migration 0055 creates every read index checked, on its table.
  const indexes = source('../drizzle/0055_stock_ledger_indexes.sql')
  for (const { table, name } of STOCK_LEDGER_INDEXES) assert.ok(indexes.includes(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}"`), name)
  // Every SOL ledger is a table of the schema with its key column.
  const schema = source('../src/db/schema.mjs')
  for (const { table, key: column } of SOL_LEDGERS) {
    assert.match(schema, new RegExp(`pgTable\\('${table}', \\{(?:(?!pgTable\\()[^])*?\\('${column}'`), `${table}.${column}`)
  }
  // The create script's fee claimer is the partner wallet this checks for.
  assert.ok(source('../scripts/create-stock-quote-config.mjs').includes(`const PARTNER = '${PLATFORM_FEE_WALLET}'`))
})

test('the script needs SOLANA_RPC_URL, prints its usage and reads nothing else without it', () => {
  const env = { PATH: process.env.PATH }
  const missing = spawnSync(process.execPath, ['scripts/stock-readiness.mjs'], { env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /^SOLANA_RPC_URL is required\nUsage: node scripts\/stock-readiness\.mjs/)
  const help = spawnSync(process.execPath, ['scripts/stock-readiness.mjs', '--help'], { env, encoding: 'utf8', timeout: 60_000 })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /never prints the RPC or database URL/)
  const unknown = spawnSync(process.execPath, ['scripts/stock-readiness.mjs', '--execute'], { env: { ...env, SOLANA_RPC_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8', timeout: 60_000 })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /^Unknown argument: --execute/)
})
