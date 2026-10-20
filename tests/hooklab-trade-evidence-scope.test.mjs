// Trade, claim and graduation reviews verify only what a trade executes against: the programs and their ProgramData, the
// swap config and swap governance, and the quote mint (the shared trade table is pinned by the operator config). The
// launch-side pins (launch-config, creation-control) change with an emergency creation pause, a launch policy change or a
// creator grant; they bind launch and preparation reviews only, so a pause there never traps holders. Whole-dossier
// verification (bootstrap, monitoring, launches) is unchanged. Fabricated loader and account bytes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { LAUNCH_SIDE_ROLES, inspectProductionEvidence, tradeEvidenceAddresses } from '../src/hooklab-production-observer.mjs'

const sha = data => createHash('sha256').update(data).digest('hex')
const address = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const ROLES = ['launch-config', 'swap-config', 'quote-mint', 'creation-control', 'swap-governance']
function fixture() {
  const accounts = []
  const programs = ['launch', 'swap', 'token'].map((role, i) => {
    const id = address(i + 1), pd = PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], new PublicKey(loader))[0]
    const elf = Buffer.from([127, 69, 76, 70, 20 + i, 0]), program = Buffer.alloc(36); program.writeUInt32LE(2); pd.toBuffer().copy(program, 4)
    const data = Buffer.alloc(45 + elf.length + 8); data.writeUInt32LE(3); data.writeBigUInt64LE(BigInt(89 + i), 4); elf.copy(data, 45)
    accounts.push({ address: id, owner: loader, executable: true, dataBase64: program.toString('base64') }, { address: pd.toBase58(), owner: loader, executable: false, dataBase64: data.toString('base64') })
    return { role, address: id, programData: pd.toBase58(), upgradeAuthority: null, deploySlot: 89 + i, programDataSha256: sha(data), elfLength: elf.length, elfSha256: sha(elf) }
  })
  const pins = ROLES.map((role, i) => {
    const raw = Buffer.from([i, 25]), pin = { role, address: address(20 + i), owner: address(1), executable: false, dataSha256: sha(raw) }
    accounts.push({ address: pin.address, owner: pin.owner, executable: false, dataBase64: raw.toString('base64') })
    return pin
  })
  const dossier = { schema: 'repoing/production-observation/2', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    artifacts: { sourceCommit: 'a'.repeat(40), profileSha256: 'b'.repeat(64), sdkSha256: 'c'.repeat(64), idlSha256: 'd'.repeat(64), provenanceSha256: 'e'.repeat(64) },
    providers: ['fixture-a', 'fixture-b'], minSlot: 100, maxSlotLag: 5, maxAgeMs: 1000, programs, accounts: pins }
  const observations = dossier.providers.map((provider, i) => ({ provider, genesisHash: dossier.genesisHash, commitment: 'finalized', slot: 100 + i, observedAtMs: 1000, accounts: structuredClone(accounts) }))
  return { dossier, observations }
}
const inspect = ({ dossier, observations }, scope) => {
  const dossierJson = JSON.stringify(dossier)
  return inspectProductionEvidence({ dossierJson, expectedSha256: sha(dossierJson), observations, nowMs: 2000, ...(scope ? { scope } : {}) })
}
// The observations a trade review reads: exactly the trade-scope inventory.
const forTrade = f => {
  const keep = new Set(tradeEvidenceAddresses(f.dossier))
  return { ...f, observations: f.observations.map(o => ({ ...o, accounts: o.accounts.filter(a => keep.has(a.address)) })) }
}
const drift = (f, role) => { const at = f.dossier.accounts.find(a => a.role === role).address
  for (const o of f.observations) { const a = o.accounts.find(x => x.address === at); if (a) a.dataBase64 = Buffer.from([9, 9]).toString('base64') } }

test('trade scope reads the programs, swap config, swap governance and quote mint, and never the launch-side pins', () => {
  assert.deepEqual([...LAUNCH_SIDE_ROLES], ['launch-config', 'creation-control'])
  const f = fixture(), inventory = tradeEvidenceAddresses(f.dossier)
  for (const role of ['swap-config', 'quote-mint', 'swap-governance']) assert.ok(inventory.includes(f.dossier.accounts.find(a => a.role === role).address), role)
  for (const role of LAUNCH_SIDE_ROLES) assert.ok(!inventory.includes(f.dossier.accounts.find(a => a.role === role).address), role)
  for (const p of f.dossier.programs) assert.ok(inventory.includes(p.address) && inventory.includes(p.programData), p.role)
  assert.equal(inspect(forTrade(f), 'trade').status, 'account-bindings-matched')
})

test('a launch-side change (a creation pause, a launch policy change, a grant) leaves trade evidence matched, and whole-dossier evidence refused', () => {
  for (const role of LAUNCH_SIDE_ROLES) {
    const f = fixture(); drift(f, role)
    assert.equal(inspect(f).status, 'mismatch', `${role}: the whole dossier (bootstrap, monitoring, launches)`)
    assert.equal(inspect(forTrade(f), 'trade').status, 'account-bindings-matched', `${role}: trades`)
  }
})

test('trade scope still refuses a swap config, swap governance, quote mint or program change, and an inventory that is not exactly its own', () => {
  for (const role of ['swap-config', 'swap-governance', 'quote-mint']) {
    const f = fixture(); drift(f, role)
    const result = inspect(forTrade(f), 'trade')
    assert.equal(result.status, 'mismatch', role); assert.equal(result.reason, 'Config/control/quote account drift')
  }
  const program = forTrade(fixture()), pd = program.observations[1].accounts[1], raw = Buffer.from(pd.dataBase64, 'base64'); raw[49] ^= 1; pd.dataBase64 = raw.toString('base64')
  assert.equal(inspect(program, 'trade').status, 'mismatch', 'ProgramData')
  assert.equal(inspect(fixture(), 'trade').status, 'mismatch', 'launch-side accounts in a trade inventory')
  const short = forTrade(fixture()); short.observations[1].accounts.pop()
  assert.equal(inspect(short, 'trade').status, 'mismatch', 'missing account')
  assert.equal(inspect(forTrade(fixture()), 'launch').status, 'mismatch', 'unknown scope')
})

test('trade scope requires the swap config and quote mint pins, and swap governance in a production dossier', () => {
  for (const role of ['swap-config', 'quote-mint', 'swap-governance']) {
    const f = fixture(); f.dossier.accounts = f.dossier.accounts.filter(a => a.role !== role)
    const result = inspect(forTrade(f), 'trade')
    assert.equal(result.status, 'mismatch', role)
  }
})
