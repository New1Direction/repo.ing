import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair, PublicKey } from '@solana/web3.js'
import { CREATOR, HOOK_BUILD, MAINNET_GENESIS, ORACLE_TARGET_LAMPORTS, STATUS, checkDatabase, checkEarlyAccessReadiness, formatReadiness,
  lookupTableProblem, programDataMatches } from '../src/early-access-readiness.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, platformAddress, programDataAddress } from '../src/early-access-hook.mjs'
import { EARLY_ACCESS_FEE_CLAIMER, earlyAccessLookupAddresses } from '../src/early-access-config.mjs'
import { readinessEnv } from '../scripts/early-access-readiness.mjs'
import { migrationOverdue } from '../src/graduation-readiness.mjs'
import { createReserveWebhookSender } from '../src/reserve-alerts.mjs'

// Step 8 (docs/EARLY_ACCESS.md): the go-live checklist, read-only. On mainnet it is run by the owner (the runbook).
const so = readFileSync(new URL('./fixtures/validator/early_access_hook.so', import.meta.url))
const programData = (program = so, padding = 1024, authority = Keypair.generate().publicKey) => {
  const header = Buffer.alloc(45)
  header.writeUInt32LE(3, 0)
  header[12] = 1
  authority.toBuffer().copy(header, 13)
  return Buffer.concat([header, program, Buffer.alloc(padding)])
}
const platformData = (admin, oracle) => Buffer.concat([createHash('sha256').update('account:Platform').digest().subarray(0, 8), admin.toBuffer(), oracle.toBuffer(),
  Buffer.from([255])])

test('the readiness check knows the committed, tested build', () => {
  assert.deepEqual({ bytes: so.length, sha256: createHash('sha256').update(so).digest('hex') }, { ...HOOK_BUILD })
})

test('the deployed program matches only the committed bytes, with the rest of its account zero', () => {
  assert.equal(programDataMatches(programData()), true)
  const changed = Buffer.from(so)
  changed[1000] ^= 1
  assert.equal(programDataMatches(programData(changed)), false)
  const tail = programData()
  tail[tail.length - 1] = 1
  assert.equal(programDataMatches(tail), false)
  assert.equal(programDataMatches(programData(so.subarray(0, so.length - 1), 0)), false)
  assert.equal(programDataMatches(null), false)
})

test('the lookup table must be active, the partner wallet\'s, and hold exactly the shared keys', () => {
  const config = Keypair.generate().publicKey, addresses = earlyAccessLookupAddresses(config)
  const table = (extra = {}) => ({ state: { deactivationSlot: BigInt('18446744073709551615'), authority: EARLY_ACCESS_FEE_CLAIMER, addresses: [...addresses].reverse(), ...extra } })
  assert.equal(lookupTableProblem(table(), config), null)
  assert.equal(lookupTableProblem(null, config), 'missing')
  assert.equal(lookupTableProblem(table({ deactivationSlot: 5n }), config), 'deactivated')
  assert.match(lookupTableProblem(table({ authority: Keypair.generate().publicKey }), config), /authority/)
  assert.match(lookupTableProblem(table({ addresses: addresses.slice(1) }), config), /not the 12 shared keys/)
  assert.match(lookupTableProblem(table({ addresses: [...addresses.slice(1), Keypair.generate().publicKey] }), config), /not the 12 shared keys/)
})

test('the checklist: the program and platform pass, unset settings are TODO, the switches are shown, nothing is written', async () => {
  const oracle = Keypair.generate().publicKey, read = []
  const accounts = new Map([[EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58(), { executable: true, data: Buffer.alloc(36) }],
    [programDataAddress().toBase58(), { data: programData() }], [platformAddress().toBase58(), { data: platformData(CREATOR, oracle) }]])
  const connection = { getGenesisHash: async () => MAINNET_GENESIS, getBalance: async () => ORACLE_TARGET_LAMPORTS,
    getAccountInfo: async address => { read.push(address.toBase58()); return accounts.get(address.toBase58()) ?? null } }
  const report = await checkEarlyAccessReadiness({ env: {}, connection, oracle })
  const status = Object.fromEntries(report.items.map(entry => [entry.name, entry.status]))
  assert.deepEqual(status, { 'Hook program': 'PASS', 'Hook platform': 'PASS', 'Oracle wallet': 'PASS', Config: 'TODO', 'Lookup table': 'TODO',
    Database: 'TODO', 'Meteora keeper': 'PASS', EARLY_ACCESS_ENABLED: 'OFF', EARLY_ACCESS_LAUNCHES_READY: 'OFF' })
  assert.equal(report.ok, true)
  assert.match(formatReadiness(report), /^PASS  Hook program/m)
  // Another oracle, an undeployed program, another network: FAIL.
  const other = await checkEarlyAccessReadiness({ env: {}, connection, oracle: Keypair.generate().publicKey })
  assert.equal(other.items.find(entry => entry.name === 'Hook platform').status, STATUS.FAIL)
  accounts.delete(EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58())
  assert.equal((await checkEarlyAccessReadiness({ env: {}, connection, oracle })).items[0].status, STATUS.FAIL)
  assert.deepEqual(await checkEarlyAccessReadiness({ env: {}, connection: { getGenesisHash: async () => 'devnet' } }),
    { ok: false, items: [{ status: 'FAIL', name: 'Network', reason: 'the RPC is not Solana mainnet' }] })
  const wrongAdmin = { ...connection, getAccountInfo: async address => address.equals(platformAddress()) ? { data: platformData(oracle, oracle) } : null }
  assert.match((await checkEarlyAccessReadiness({ env: {}, connection: wrongAdmin })).items[1].reason, /not the creator signer/)
})

test('the database check reads the catalog in a read-only transaction and rolls back', async () => {
  const run = async found => { const asked = []; const result = await checkDatabase({ db: { query: async sql => { asked.push(sql.trim().split(/\s+/).slice(0, 2).join(' '))
    return { rows: [found] } } } }); return { result, asked } }
  const all = await run({ links: true, contributors: true, stamp: true })
  assert.deepEqual([all.result.status, all.asked[0], all.asked.at(-1)], ['PASS', 'begin read', 'rollback'])
  assert.match((await run({ links: true, contributors: false, stamp: true })).result.reason, /missing: contributors/)
  assert.equal((await checkDatabase({ dbError: { code: 'ECONNREFUSED' } })).status, 'FAIL')
})

test('the script takes only the variables its checks use', () => {
  assert.deepEqual(readinessEnv({ SOLANA_RPC_URL: 'https://rpc', EARLY_ACCESS_ORACLE_SECRET_KEY: 'secret', PLATFORM_PARTNER_SECRET_KEY: 'secret',
    EARLY_ACCESS_DBC_CONFIG: 'x' }), { SOLANA_RPC_URL: 'https://rpc', EARLY_ACCESS_DBC_CONFIG: 'x' })
})

test('RPC errors reach the output redacted, and a failed read is a FAIL, never a crash', async () => {
  const rpc = 'https://rpc.example.com/v1/?api-key=SECRETKEY123456'
  const failing = { getGenesisHash: async () => { throw Error(`500 Internal Server Error: {"upstream":"${rpc}","key":"SECRETKEY123456"}`) } }
  const report = await checkEarlyAccessReadiness({ env: { SOLANA_RPC_URL: rpc }, connection: failing })
  assert.equal(report.ok, false)
  assert.equal(report.items[0].status, STATUS.FAIL)
  assert.doesNotMatch(JSON.stringify(report), /SECRETKEY123456|rpc\.example\.com\/v1/)
})

test('the builder allocation setting must list the config: unlisted or unparsable is a FAIL', async () => {
  const config = Keypair.generate().publicKey.toBase58()
  const connection = { getGenesisHash: async () => MAINNET_GENESIS, getBalance: async () => 0, getAccountInfo: async () => null,
    getAddressLookupTable: async () => ({ value: null }) }
  const allocation = async value => (await checkEarlyAccessReadiness({ env: { EARLY_ACCESS_DBC_CONFIG: config, ...value === undefined ? {} : { BUILDER_ALLOCATION_CONFIGS: value } },
    connection })).items.find(entry => entry.name === 'Builder allocation')
  assert.equal((await allocation(undefined)).status, STATUS.FAIL)
  assert.equal((await allocation(Keypair.generate().publicKey.toBase58())).status, STATUS.FAIL)
  assert.match((await allocation('not-a-key,')).reason, /does not parse/)
  assert.equal((await allocation(`${Keypair.generate().publicKey.toBase58()},${config}`)).status, STATUS.PASS)
})

test('the overdue-migration alert: a full curve, not migrated, past the overdue time by the chain\'s clock', () => {
  const state = { curve: 'Curve1', curveFinishedAt: '2026-10-07T08:00:00.000Z', chainTime: '2026-10-07T08:31:00.000Z', checkedAt: '2026-10-07T08:31:05.000Z' }
  const market = { fullName: 'octo/second' }, now = () => Date.parse('2026-10-07T08:31:05Z')
  const detail = migrationOverdue(state, market, { now })
  assert.deepEqual({ ...detail, delivery: detail.delivery.status }, { fullName: 'octo/second', curve: 'Curve1', curveFinishedAt: state.curveFinishedAt, minutes: 31,
    observedAt: state.checkedAt, delivery: 'pending' })
  assert.equal(migrationOverdue({ ...state, chainTime: '2026-10-07T08:29:59.000Z' }, market, { now }), null, 'not yet')
  assert.equal(migrationOverdue({ ...state, migration: { pool: 'p' } }, market, { now }), null, 'migrated')
  assert.equal(migrationOverdue({ ...state, curveFinishedAt: undefined }, market, { now }), null, 'not full')
  assert.ok(migrationOverdue({ ...state, chainTime: state.curveFinishedAt }, market, { now, overdueMs: 0 }), 'the chain test\'s zero')
})

test('a generic webhook receives the overdue alert as its own event', async () => {
  const bodies = []
  const send = createReserveWebhookSender({ env: { RESERVE_ALERT_WEBHOOK_URL: 'https://hooks.example.com/repoing' },
    fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200, body: null } } })
  await send({ id: 9, text: 'repo.ing · Full curve not migrated', detail: { curve: 'Curve1', curveFinishedAt: '2026-10-07T08:00:00.000Z', minutes: 31, delivery: {} } })
  assert.deepEqual([bodies[0].event, bodies[0].market.curve, 'delivery' in bodies[0].market], ['migration_overdue', 'Curve1', false])
})
