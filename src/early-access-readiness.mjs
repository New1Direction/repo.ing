import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, decodePlatform, platformAddress, programDataAddress } from './early-access-hook.mjs'
import { EARLY_ACCESS_FEE_CLAIMER, assertEarlyAccessConfig, decodeEarlyAccessConfig, earlyAccessLookupAddresses } from './early-access-config.mjs'
import { EARLY_ACCESS_LAUNCHES_READY } from './early-access.mjs'
import { MIN_ORACLE_LAMPORTS } from './early-access-oracle.mjs'
import { allocationConfigs } from './builder-allocation.mjs'
import { redactor } from './stock-readiness.mjs'

// The contributor early access go-live checklist (docs/EARLY_ACCESS.md, step 8): PASS / FAIL / TODO with a one-line reason each,
// then the switches ON or OFF. READ-ONLY: mainnet accounts, and with a database a few catalog SELECTs in a READ ONLY transaction
// that is rolled back. It reads no key: the oracle is given by its public key.

export const READINESS_ENV = Object.freeze(['SOLANA_RPC_URL', 'DATABASE_URL', 'EARLY_ACCESS_ENABLED', 'EARLY_ACCESS_DBC_CONFIG',
  'EARLY_ACCESS_LOOKUP_TABLE', 'BUILDER_ALLOCATION_CONFIGS'])
export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', TODO: 'TODO', ON: 'ON', OFF: 'OFF' })
export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
export const COMMITMENT = 'finalized'
// The committed build (tests/fixtures/validator/early_access_hook.so, the copy the chain tests ran); a rebuild updates both
// (tests/early-access-readiness.test.mjs checks them against the file).
export const HOOK_BUILD = Object.freeze({ bytes: 379_392, sha256: 'a99d53f28106a76407a664861d9bb7718a0d6c1d4b2b1d5bd6a4cd035ef99ab0' })
export const CREATOR = new PublicKey('FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1') // admin: the launch co-signer
// The live SOL launch-fee config the early access config must equal but for the fee and token type (scripts/create-early-access-config.mjs).
export const REFERENCE_CONFIG = new PublicKey('8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3')
const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
// Enough for a day of list upkeep and closes; the oracle adds nothing below MIN_ORACLE_LAMPORTS (src/early-access-oracle.mjs).
export const ORACLE_TARGET_LAMPORTS = 50_000_000
// The owner's question for step 8, answered read-only on mainnet (docs/EARLY_ACCESS.md, "Meteora's keeper").
export const KEEPER_CHECKED = Object.freeze({ on: '2026-10-07', summary: 'all 472 migrated of 4,565 DBC transfer-hook pools, none full and waiting; the migrator of $REPOING (Asi5DTGE…) migrates them across launchpads, mostly within seconds' })
const PROGRAM_DATA_HEADER = 45 // [u32 kind = 3][u64 slot][Option<Pubkey> upgrade authority]
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(4)} SOL`
const item = (status, name, reason) => ({ status, name, reason })
const key = value => { try { return new PublicKey(String(value).trim()) } catch { return null } }

// The deployed program data against the committed build: the bytes, and the rest of the account (room for later builds) zero.
export function programDataMatches(data, build = HOOK_BUILD) {
  if (!data || data.length < PROGRAM_DATA_HEADER + build.bytes || data.readUInt32LE(0) !== 3) return false
  const program = data.subarray(PROGRAM_DATA_HEADER, PROGRAM_DATA_HEADER + build.bytes)
  return createHash('sha256').update(program).digest('hex') === build.sha256 && data.subarray(PROGRAM_DATA_HEADER + build.bytes).every(byte => byte === 0)
}
export const upgradeAuthority = data => data?.[12] === 1 ? new PublicKey(data.subarray(13, 45)) : null

// The lookup table every launch is built with: active, the partner wallet its authority, exactly the shared keys.
export function lookupTableProblem(table, config) {
  if (!table) return 'missing'
  if (table.state.deactivationSlot !== BigInt('18446744073709551615')) return 'deactivated'
  if (!table.state.authority?.equals(EARLY_ACCESS_FEE_CLAIMER)) return `authority is not the partner wallet ${EARLY_ACCESS_FEE_CLAIMER.toBase58()}`
  const want = earlyAccessLookupAddresses(config).map(address => address.toBase58()).sort()
  const have = table.state.addresses.map(address => address.toBase58()).sort()
  return JSON.stringify(want) === JSON.stringify(have) ? null : `holds ${have.length} addresses, not the ${want.length} shared keys`
}

// RPC and database URLs, their credentials, query values and path tokens never reach the output (src/stock-readiness.mjs).
export async function checkEarlyAccessReadiness({ env = {}, connection, db = null, dbError = null, oracle = null }) {
  const redact = redactor(env)
  try {
    const report = await checks({ env, connection, db, dbError, oracle })
    return { ...report, items: report.items.map(entry => ({ ...entry, reason: redact(entry.reason).slice(0, 300) })) }
  } catch (error) {
    return { ok: false, items: [item(STATUS.FAIL, 'Chain reads', `could not read mainnet: ${redact(error?.message ?? error).slice(0, 200)}`)] }
  }
}

// The early access config read from chain and checked: the launcher's checks (our hook, the partner wallet claims, the creator signer
// gets the leftover, the curve and fee), and equal to the live SOL launch-fee config in every field but the fee and token type.
async function configProblem(connection, config) {
  const [info, referenceInfo] = await Promise.all([connection.getAccountInfo(config, COMMITMENT), connection.getAccountInfo(REFERENCE_CONFIG, COMMITMENT)])
  if (!info?.owner.equals(DBC_PROGRAM_ID)) return 'no DBC config at this address'
  if (!referenceInfo?.owner.equals(DBC_PROGRAM_ID)) return `the reference config ${REFERENCE_CONFIG.toBase58()} is missing`
  const coder = new DynamicBondingCurveClient(connection, COMMITMENT).state.getProgram().coder
  try {
    assertEarlyAccessConfig(decodeEarlyAccessConfig(info.data, coder), { feeClaimer: EARLY_ACCESS_FEE_CLAIMER, leftoverReceiver: CREATOR,
      reference: coder.accounts.decode('poolConfig', referenceInfo.data) })
    return null
  } catch (error) { return error.message }
}

async function checks({ env, connection, db, dbError, oracle }) {
  const items = []
  const genesis = await connection.getGenesisHash()
  if (genesis !== MAINNET_GENESIS) return { ok: false, items: [item(STATUS.FAIL, 'Network', 'the RPC is not Solana mainnet')] }
  const config = env.EARLY_ACCESS_DBC_CONFIG ? key(env.EARLY_ACCESS_DBC_CONFIG) : null
  const table = env.EARLY_ACCESS_LOOKUP_TABLE ? key(env.EARLY_ACCESS_LOOKUP_TABLE) : null
  const [program, programData, platform, oracleBalance] = await Promise.all([connection.getAccountInfo(EARLY_ACCESS_HOOK_PROGRAM_ID, COMMITMENT),
    connection.getAccountInfo(programDataAddress(), COMMITMENT), connection.getAccountInfo(platformAddress(), COMMITMENT),
    oracle ? connection.getBalance(oracle, COMMITMENT) : null])

  if (!program?.executable) items.push(item(STATUS.FAIL, 'Hook program', `${EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58()} is not deployed (runbook step 1)`))
  else if (!programDataMatches(programData?.data)) items.push(item(STATUS.FAIL, 'Hook program', 'the deployed bytes are not the committed, tested build'))
  else {
    const authority = upgradeAuthority(programData.data)
    items.push(item(STATUS.PASS, 'Hook program', `the committed build; upgrade authority ${authority?.toBase58() ?? 'none (frozen)'}`))
  }

  if (!platform) items.push(item(STATUS.FAIL, 'Hook platform', 'init_platform has not run (runbook step 2)'))
  else {
    const set = decodePlatform(platform.data)
    if (!set.admin.equals(CREATOR)) items.push(item(STATUS.FAIL, 'Hook platform', `the admin is ${set.admin.toBase58()}, not the creator signer ${CREATOR.toBase58()}`))
    else if (!oracle) items.push(item(STATUS.TODO, 'Hook platform', `admin is the creator signer; give --oracle to check the oracle (${set.oracle.toBase58()})`))
    else if (!set.oracle.equals(oracle)) items.push(item(STATUS.FAIL, 'Hook platform', `the oracle is ${set.oracle.toBase58()}, not ${oracle.toBase58()}`))
    else items.push(item(STATUS.PASS, 'Hook platform', 'admin is the creator signer, oracle is the given key'))
  }
  if (oracle) items.push(item(oracleBalance >= ORACLE_TARGET_LAMPORTS ? STATUS.PASS : oracleBalance >= MIN_ORACLE_LAMPORTS ? STATUS.TODO : STATUS.FAIL,
    'Oracle wallet', `${sol(oracleBalance)} (fund it to at least ${sol(ORACLE_TARGET_LAMPORTS)}; it adds nothing under ${sol(MIN_ORACLE_LAMPORTS)})`))

  if (!config) items.push(item(env.EARLY_ACCESS_DBC_CONFIG ? STATUS.FAIL : STATUS.TODO, 'Config', env.EARLY_ACCESS_DBC_CONFIG
    ? 'EARLY_ACCESS_DBC_CONFIG is not a public key' : 'EARLY_ACCESS_DBC_CONFIG is not set (runbook step 3)'))
  else {
    const problem = await configProblem(connection, config)
    items.push(problem ? item(STATUS.FAIL, 'Config', `${config.toBase58()}: ${problem}`)
      : item(STATUS.PASS, 'Config', `${config.toBase58()}: our hook, the partner wallet claims, the creator signer gets the leftover, the live config but its fee and token type`))
  }
  if (!config) items.push(item(STATUS.TODO, 'Lookup table', 'needs the config first'))
  else if (!table) items.push(item(env.EARLY_ACCESS_LOOKUP_TABLE ? STATUS.FAIL : STATUS.TODO, 'Lookup table', env.EARLY_ACCESS_LOOKUP_TABLE
    ? 'EARLY_ACCESS_LOOKUP_TABLE is not a public key' : 'EARLY_ACCESS_LOOKUP_TABLE is not set (runbook step 4)'))
  else {
    const problem = lookupTableProblem((await connection.getAddressLookupTable(table, { commitment: COMMITMENT })).value, config)
    items.push(item(problem ? STATUS.FAIL : STATUS.PASS, 'Lookup table', problem ? `${table.toBase58()}: ${problem}` : `${table.toBase58()}: active, the shared keys`))
  }
  // A market launched while the config is not listed never gets the 1% allocation, and a list that does not parse stops every launch.
  if (config) {
    let listed = null
    try { listed = allocationConfigs(env.BUILDER_ALLOCATION_CONFIGS ?? '').includes(config.toBase58()) } catch { listed = null }
    items.push(listed === null ? item(STATUS.FAIL, 'Builder allocation', 'BUILDER_ALLOCATION_CONFIGS does not parse (comma-separated public keys)')
      : item(listed ? STATUS.PASS : STATUS.FAIL, 'Builder allocation', listed ? 'BUILDER_ALLOCATION_CONFIGS lists the config'
        : 'BUILDER_ALLOCATION_CONFIGS must list the config before launches open: a market launched without it gets no 1% allocation'))
  }
  items.push(await checkDatabase({ db, dbError }))
  items.push(item(STATUS.PASS, 'Meteora keeper', `checked on mainnet ${KEEPER_CHECKED.on}: ${KEEPER_CHECKED.summary}; MIGRATION_OVERDUE watches each market`))
  items.push(item(env.EARLY_ACCESS_ENABLED === 'true' ? STATUS.ON : STATUS.OFF, 'EARLY_ACCESS_ENABLED', 'the contributor wallet link (and, with the code gate, launches)'))
  items.push(item(EARLY_ACCESS_LAUNCHES_READY ? STATUS.ON : STATUS.OFF, 'EARLY_ACCESS_LAUNCHES_READY', 'the code gate (src/early-access.mjs), set by the READY PR'))
  return { ok: !items.some(entry => entry.status === STATUS.FAIL), items }
}

// The early access tables and stamp (drizzle/0059_early_access.sql), read in a READ ONLY transaction that is rolled back.
export async function checkDatabase({ db = null, dbError = null } = {}) {
  if (dbError) return item(STATUS.FAIL, 'Database', `cannot connect (${dbError.code ?? 'error'})`)
  if (!db) return item(STATUS.TODO, 'Database', 'set DATABASE_URL to check migration 0059')
  try {
    await db.query('begin read only')
    const { rows: [found] } = await db.query(`select to_regclass('public.github_wallet_links') is not null as links,
      to_regclass('public.early_access_contributors') is not null as contributors,
      exists(select 1 from information_schema.columns where table_name='markets' and column_name='transfer_hook_program') as stamp`)
    const missing = Object.entries(found).filter(([, present]) => !present).map(([name]) => name)
    return missing.length ? item(STATUS.FAIL, 'Database', `migration 0059 is missing: ${missing.join(', ')}`) : item(STATUS.PASS, 'Database', 'migration 0059 is applied')
  } catch (error) { return item(STATUS.FAIL, 'Database', `read failed (${error.code ?? 'error'})`) }
  finally { await db.query('rollback').catch(() => {}) }
}

export function formatReadiness({ ok, items }) {
  const width = Math.max(...items.map(entry => entry.name.length))
  return [...items.map(entry => `${entry.status.padEnd(4)}  ${entry.name.padEnd(width)}  ${entry.reason}`),
    ok ? 'No check failed. TODO items remain for the owner where listed.' : 'Some checks failed: see FAIL above.'].join('\n')
}
