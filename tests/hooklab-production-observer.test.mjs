import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { inspectProductionEvidence } from '../src/hooklab-production-observer.mjs'
import { readProductionEvidence } from '../src/hooklab-production-rpc.mjs'
import { monitorPlainProduction } from '../src/hooklab-production-monitor.mjs'
import { plainFixture } from './fixtures/hooklab-plain.mjs'
import { verifyPlainReceipt } from '../src/hooklab-plain-receipts.mjs'
import { GET, POST } from '../app/api/hook-lab/production/route.js'

const sha = data => createHash('sha256').update(data).digest('hex')
const address = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
// Fabricated loader/account bytes, NOT executable binaries or deployment evidence.
function fixture() {
  const accounts = []
  const programs = ['launch', 'swap', 'token'].map((role, i) => {
    const id = address(i + 1), pd = PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], new PublicKey(loader))[0]
    const elf = Buffer.from([127, 69, 76, 70, 20 + i, 0]) // Meaningful trailing zero belongs in full-file hash.
    const program = Buffer.alloc(36); program.writeUInt32LE(2); pd.toBuffer().copy(program, 4)
    const data = Buffer.alloc(45 + elf.length + 8); data.writeUInt32LE(3); data.writeBigUInt64LE(BigInt(89 + i), 4)
    data[12] = i === 2 ? 0 : 1
    if (i !== 2) new PublicKey(address(10)).toBuffer().copy(data, 13)
    elf.copy(data, 45)
    accounts.push({ address: id, owner: loader, executable: true, dataBase64: program.toString('base64') },
      { address: pd.toBase58(), owner: loader, executable: false, dataBase64: data.toString('base64') })
    return { role, address: id, programData: pd.toBase58(), upgradeAuthority: i === 2 ? null : address(10),
      deploySlot: 89 + i, programDataSha256: sha(data), elfLength: elf.length, elfSha256: sha(elf) }
  })
  const pins = ['launch-config', 'swap-config', 'quote-mint', 'creation-control'].map((role, i) => {
    const raw = Buffer.from([i, 25]), pin = { role, address: address(20 + i), owner: address(1), executable: false, dataSha256: sha(raw) }
    accounts.push({ address: pin.address, owner: pin.owner, executable: false, dataBase64: raw.toString('base64') })
    return pin
  })
  const dossier = { schema: 'repoing/production-observation/1', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    artifacts: { sourceCommit: 'a'.repeat(40), profileSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64), idlSha256: 'd'.repeat(64), provenanceSha256: 'e'.repeat(64) },
    providers: ['fixture-a', 'fixture-b'], minSlot: 100, maxSlotLag: 5, maxAgeMs: 1000, programs, accounts: pins }
  const observations = dossier.providers.map((provider, i) => ({ provider, genesisHash: dossier.genesisHash, commitment: 'finalized',
    slot: 100 + i, observedAtMs: 1000, accounts: structuredClone(accounts) }))
  return { dossier, observations }
}
const inspect = ({ dossier, observations }, extra = {}) => {
  const dossierJson = JSON.stringify(dossier)
  return inspectProductionEvidence({ dossierJson, expectedSha256: sha(dossierJson), observations, nowMs: 2000, ...extra })
}

test('two retained finalized snapshots bind exact programs/authorities/ELFs/configs without asserting policy', () => {
  const result = inspect(fixture())
  assert.equal(result.status, 'account-bindings-matched')
  assert.deepEqual(result.observedSlots, [100, 101])
  assert.equal(result.accountBindingsMatched, true)
  for (const field of ['policyVerified', 'provenanceVerified', 'canSign', 'canSubmit', 'canRetry']) assert.equal(result[field], false)
  assert.equal(inspectProductionEvidence().status, 'unavailable')
  assert.equal(inspect(fixture(), { nowMs: 2001 }).status, 'mismatch')
  assert.equal(inspect(fixture(), { expectedSha256: '0'.repeat(64) }).status, 'mismatch')
})

test('refuses wrong genesis/provider/finality, missing evidence, slot drift, changed dependencies and authority', () => {
  const cases = [f => { f.observations[1].genesisHash = address(30) },
    f => { f.dossier.genesisHash = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'; f.observations.forEach(o => { o.genesisHash = f.dossier.genesisHash }) },
    f => { f.observations[1].provider = 'fixture-a' }, f => { f.observations[1].commitment = 'confirmed' },
    f => { f.observations[1].slot = 106 }, f => { f.observations[0].slot = 99 }, f => { f.observations[1].observedAtMs = 2001 },
    f => { f.observations[1].accounts.pop() }, f => { f.observations[1].accounts.push(f.observations[1].accounts[0]) },
    f => { f.dossier.programs.pop() }, f => { delete f.dossier.artifacts.sdkSha256 },
    f => { f.observations[1].accounts.at(-1).owner = address(31) },
    f => { f.observations[1].accounts.at(-1).dataBase64 = 'AAAA' },
    f => { f.observations[1].accounts[0].executable = false }]
  // Mutate ProgramData independently: deployment slot, authority, ELF, nonzero padding.
  for (const offset of [4, 13, 49, 58]) cases.push(f => {
    const account = f.observations[1].accounts[1], raw = Buffer.from(account.dataBase64, 'base64')
    raw[offset] ^= 1; account.dataBase64 = raw.toString('base64')
  })
  for (const change of cases) {
    const f = fixture(); change(f)
    assert.equal(inspect(f).status, 'mismatch', change.toString())
  }
  const expanded = fixture(), pd = expanded.observations[1].accounts[1]
  pd.dataBase64 = Buffer.concat([Buffer.from(pd.dataBase64, 'base64'), Buffer.alloc(8)]).toString('base64')
  assert.equal(inspect(expanded).reason, 'ProgramData bytes/allocation drift')
  const unavailable = fixture(); unavailable.observations[0] = { error: 'https://rpc.invalid/private-token' }
  assert.equal(inspect(unavailable).status, 'mismatch')
  assert.ok(!JSON.stringify(inspect(unavailable)).includes('private-token'))
})

test('public production endpoint remains unavailable and refuses all execution without reading body', async () => {
  const response = GET(), readiness = await response.json()
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(readiness.status, 'unavailable'); assert.equal(readiness.activeProfile, null)
  for (const [action, enabled] of Object.entries(readiness.actions)) {
    assert.equal(enabled, false, action)
    const result = POST({ get body() { throw new Error('Must not read request') }, action, approved: true })
    assert.equal(result.status, 423); assert.equal((await result.json()).code, 'PRODUCTION_EXECUTION_DISABLED')
  }
  assert.deepEqual(await GET().json(), readiness)
})

test('trusted read adapters bind one finalized inventory per provider without accepting policy or executing', async () => {
  const f = fixture(), dossierJson = JSON.stringify(f.dossier)
  let reads = 0
  const providers = f.observations.map(o => ({ provider: o.provider, connection: {
    getGenesisHash: async () => o.genesisHash,
    getMultipleAccountsInfoAndContext: async (keys, config) => {
      reads++
      assert.deepEqual(config, { commitment: 'finalized', minContextSlot: 100 })
      return { context: { slot: o.slot }, value: keys.map(k => {
        const a = o.accounts.find(a => a.address === k.toBase58())
        return a ? { owner: new PublicKey(a.owner), executable: a.executable, data: Buffer.from(a.dataBase64, 'base64') } : null
      }) }
    },
  } }))
  const input = { dossierJson, expectedSha256: sha(dossierJson), providers, now: () => 2000 }
  const result = await readProductionEvidence(input)
  assert.equal(result.status, 'account-bindings-matched')
  assert.deepEqual(result.observedSlots, [100, 101])
  assert.equal(reads, 2)
  assert.equal(result.policyVerified, false); assert.equal(result.canSubmit, false)
  assert.equal((await readProductionEvidence({ ...input, expectedSha256: '0'.repeat(64) })).status, 'mismatch')
  assert.equal(reads, 2, 'unreviewed dossier must not reach RPC')
  assert.equal((await readProductionEvidence({ ...input, providers: [providers[0], providers[0]] })).status, 'mismatch')
  f.observations[1].accounts.at(-1).dataBase64 = 'AAAA'
  assert.equal((await readProductionEvidence(input)).status, 'mismatch', 'full account hashing still rejects drift')
  f.observations[1].accounts.pop()
  assert.equal((await readProductionEvidence(input)).status, 'unavailable')
  providers[1].connection.getGenesisHash = async () => { throw Error('https://rpc.invalid/private-token') }
  const unavailable = await readProductionEvidence(input)
  assert.equal(unavailable.status, 'unavailable'); assert.ok(!JSON.stringify(unavailable).includes('private-token'))
  providers[1].connection.getGenesisHash = () => new Promise(() => {})
  assert.equal((await readProductionEvidence({ ...input, timeoutMs: 5 })).status, 'unavailable')
})

test('operator monitor stays inert by default, alerts on drift/age and still reconciles retained signatures', async () => {
  assert.deepEqual((await monitorPlainProduction()).alerts, [])
  assert.equal((await monitorPlainProduction({ enabled: true })).status, 'unavailable')
  const f = fixture(), retained = plainFixture(), dossierJson = JSON.stringify(f.dossier)
  const providers = f.observations.map(o => ({ provider: o.provider, connection: {
    getGenesisHash: async () => o.genesisHash,
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot: o.slot }, value: keys.map(k => {
      const a = o.accounts.find(a => a.address === k.toBase58())
      return { owner: new PublicKey(a.owner), executable: a.executable, data: Buffer.from(a.dataBase64, 'base64') }
    }) }),
    getTransaction: async () => null,
  } }))
  const evidence = { dossierJson, expectedSha256: sha(dossierJson), providers }
  let observations = 0
  const journal = {
    pending: async () => [{ id: 'retained-operation', github_user_id: '101', plan: retained.plan, signed_transaction: retained.signed }],
    observe: async (owner, id, obs, ids) => {
      observations++
      const result = verifyPlainReceipt(retained.plan, retained.signed, obs, ids)
      return { id, status: result.status }
    },
    health: async () => ({ unresolved: '1', review_required: '0', latest_unavailable: '1', oldest_unresolved: new Date(0) }),
  }
  const input = { enabled: true, evidence, journal, now: () => 2000, maxUnresolvedAgeMs: 2000 }
  const result = await monitorPlainProduction(input)
  assert.equal(result.evidence.accountBindingsMatched, true)
  assert.deepEqual(result.receipts, [{ id: 'retained-operation', status: 'unresolved' }])
  assert.deepEqual(result.alerts, ['RECEIPT_PROVIDER_UNAVAILABLE', 'RECEIPT_UNRESOLVED_TOO_LONG'])
  assert.equal(result.executionEnabled, false); assert.equal(result.canSign, false); assert.equal(result.canSubmit, false)
  const younger = await monitorPlainProduction({ ...input, maxUnresolvedAgeMs: 2001 })
  assert.ok(!younger.alerts.includes('RECEIPT_UNRESOLVED_TOO_LONG'))
  f.observations[1].accounts.at(-1).dataBase64 = 'AAAA'
  const drifted = await monitorPlainProduction(input)
  assert.equal(drifted.status, 'attention-required')
  assert.ok(drifted.alerts.includes('DEPLOYMENT_EVIDENCE_UNAVAILABLE_OR_DRIFTED'))
  assert.equal(observations, 3, 'deployment drift must not erase unresolved signature reconciliation')
  await monitorPlainProduction({ ...input, evidence: { ...evidence, expectedSha256: '0'.repeat(64) } })
  assert.equal(observations, 3, 'invalid configuration must not select receipt providers')
  journal.health = async () => { throw Error('private connection data') }
  const unavailable = await monitorPlainProduction(input)
  assert.ok(unavailable.alerts.includes('JOURNAL_HEALTH_UNAVAILABLE'))
  assert.ok(!JSON.stringify(unavailable).includes('private connection data'))
})
