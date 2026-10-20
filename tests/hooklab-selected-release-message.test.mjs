import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { PublicKey } from '@solana/web3.js'
import { SELECTED_PROGRAMS, digestJson, sha256, prepareSelectedReleaseMessage } from '../scripts/hooklab-selected-release-message.mjs'

const loader = 'BPFLoaderUpgradeab1e11111111111111111111111'
const pub = n => new PublicKey(Buffer.alloc(32, n)).toBase58() // synthetic public bytes, never keys
const nowMs = 1000000
function fixture(name = 'launch') {
  const program = new PublicKey(SELECTED_PROGRAMS[name])
  const [pd] = PublicKey.findProgramAddressSync([program.toBuffer()], new PublicKey(loader))
  const p = Buffer.alloc(36); p.writeUInt32LE(2); pd.toBuffer().copy(p, 4)
  const d = Buffer.alloc(109); d.writeUInt32LE(3); d.writeBigUInt64LE(90n, 4); d[12] = 1; new PublicKey(pub(3)).toBuffer().copy(d, 13)
  const elf = Buffer.from([127, 69, 76, 70, 1, 2, 3, 0])
  const b = Buffer.alloc(37 + elf.length + 2); b.writeUInt32LE(1); b[4] = 1; new PublicKey(pub(3)).toBuffer().copy(b, 5); elf.copy(b, 37)
  const account = (address, data, executable = false) => ({ address, dataBase64: data.toString('base64'), sha256: sha256(data), owner: loader, executable, slot: 100, lamports: '10000000' })
  const sourceManifest = { 'program.rs': sha256('synthetic test source') }
  const features = { [name]: ['inclusive-fees-candidate', ...(name === 'swap' ? ['custom-hooks-reuse-candidate'] : []), 'repoing-independent'] }
  const inputs = {
    programName: name, cluster: 'mainnet-beta', genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), clean: true, sourceManifest, sourceManifestSha256: digestJson(sourceManifest), features, featuresSha256: digestJson(features) },
    snapshot: { commitment: 'finalized', providers: ['synthetic offline fixture'], slot: 100, observedAtMs: nowMs, maxAgeMs: 60000 },
    program: account(program.toBase58(), p, true), programData: account(pd.toBase58(), d), deploymentSlot: 90, capacity: 64,
    buffer: account(pub(4), b), approvedBuffer: pub(4), bufferPadding: 'zero', bufferPaddingBytes: 2,
    elf: { dataBase64: elf.toString('base64'), sha256: sha256(elf), length: elf.length },
    payer: { address: pub(1), lamports: '1000000' }, spill: pub(2), authority: pub(3), approvedSignerOrder: [pub(1), pub(3)],
    rent: { programDataMinimumLamports: '1000000', programDataLength: d.length, bufferMinimumLamports: '1000000', bufferLength: b.length, additionalPayerDebitLamports: '0' },
    fees: { computeUnitLimit: 1000000, maxComputeUnitLimit: 1400000, microLamportsPerUnit: '1', maxMicroLamportsPerUnit: '10', lamportsPerSignature: '5000', maxTotalLamports: '10001' },
    blockhash: { mode: 'recent', approved: true, value: pub(5), observedBlockHeight: 100, currentBlockHeight: 101, lastValidBlockHeight: 200, observedAtMs: nowMs, expiresAtMs: nowMs + 60000 },
    sequencePolicy: 'one-upgrade-stop-and-reexport-before-next',
  }
  return { schema: 'hooklab-selected-upgrade-review-v1', inputs, approvedInputsSha256: digestJson(inputs) }
}
const prepare = e => prepareSelectedReleaseMessage(e, { nowMs })
function mutateAccount(i, field, change) {
  const data = Buffer.from(i[field].dataBase64, 'base64'); change(data)
  i[field].dataBase64 = data.toString('base64'); i[field].sha256 = sha256(data)
}

// Independent wire parser: deliberately does not use Message.from or builder decode APIs.
function decode(wire) {
  let o = 0
  const read = n => { const b = wire.subarray(o, o + n); assert.equal(b.length, n); o += n; return b }
  const short = () => { let v = 0, shift = 0, b; do { b = read(1)[0]; v |= (b & 127) << shift; shift += 7 } while (b & 128); return v }
  const header = [...read(3)]
  const keys = Array.from({ length: short() }, () => new PublicKey(read(32)).toBase58())
  const blockhash = new PublicKey(read(32)).toBase58()
  const instructions = Array.from({ length: short() }, () => {
    const program = keys[read(1)[0]], indices = [...read(short())], data = read(short())
    return { program, indices, accounts: indices.map(n => keys[n]), data }
  })
  assert.equal(o, wire.length)
  return { header, keys, blockhash, instructions }
}

for (const name of ['launch', 'swap']) test(`${name}: exact legacy wire, flags, instruction ordering and no authorization`, () => {
  const e = fixture(name), before = JSON.stringify(e), out = prepare(e)
  assert.equal(JSON.stringify(e), before)
  assert.equal(out.canSign, false); assert.equal(out.canSubmit, false); assert.equal(out.signingGate, 'NOT SIGNABLE')
  const wire = Buffer.from(out.messageBase64, 'base64'), d = decode(wire)
  assert.equal(sha256(wire), out.messageSha256); assert.equal(out.estimatedFeeLamports, '10001')
  assert.deepEqual(d.header, [2, 1, 4]); assert.deepEqual(d.keys.slice(0, 2), e.inputs.approvedSignerOrder)
  assert.equal(d.blockhash, pub(5)); assert.equal(d.instructions.length, 3)
  assert.equal(d.instructions[0].program, 'ComputeBudget111111111111111111111111111111')
  assert.equal(d.instructions[0].data.toString('hex'), '0240420f00')
  assert.equal(d.instructions[1].data.toString('hex'), '030100000000000000')
  const ix = d.instructions[2]
  assert.equal(ix.program, loader); assert.equal(ix.data.toString('hex'), '03000000')
  assert.deepEqual(ix.accounts, [e.inputs.programData.address, SELECTED_PROGRAMS[name], pub(4), pub(2), 'SysvarRent111111111111111111111111111111111', 'SysvarC1ock11111111111111111111111111111111', pub(3)])
  assert.ok(ix.indices.slice(0, 4).every(n => n >= 2 && n < d.keys.length - d.header[2]))
  assert.ok(ix.indices.slice(4, 6).every(n => n >= d.keys.length - d.header[2]))
  assert.equal(ix.indices[6], 1)
})

const failures = {
  'arbitrary program': i => { i.program.address = pub(9) },
  'arbitrary ProgramData': i => { i.programData.address = pub(9) },
  'buffer identity': i => { i.buffer.address = pub(9) },
  'loader owner': i => { i.program.owner = pub(9) },
  'wrong executable': i => { i.program.executable = false },
  'Program link': i => mutateAccount(i, 'program', b => { b[4] ^= 1 }),
  'immutable authority': i => mutateAccount(i, 'programData', b => { b[12] = 0 }),
  'changed PD authority': i => mutateAccount(i, 'programData', b => { b[13] ^= 1 }),
  'buffer authority': i => mutateAccount(i, 'buffer', b => { b[5] ^= 1 }),
  'buffer ELF': i => mutateAccount(i, 'buffer', b => { b[38] ^= 1 }),
  'nonzero padding': i => mutateAccount(i, 'buffer', b => { b[b.length - 1] = 1 }),
  'wrong exact length': i => { i.elf.length++ },
  'changed hash': i => { i.programData.sha256 = 'f'.repeat(64) },
  'capacity': i => { i.capacity = 1 },
  'padded buffer capacity': i => {
    const b = Buffer.concat([Buffer.from(i.buffer.dataBase64, 'base64'), Buffer.alloc(64)])
    i.buffer.dataBase64 = b.toString('base64'); i.buffer.sha256 = sha256(b); i.bufferPaddingBytes += 64
  },
  'CU bounds': i => { i.fees.computeUnitLimit = 1400001 },
  'price bounds': i => { i.fees.microLamportsPerUnit = '11' },
  'fee ceiling': i => { i.fees.maxTotalLamports = '10000' },
  'payer funds': i => { i.payer.lamports = '0' },
  'rent': i => { i.rent.programDataMinimumLamports = '999999999' },
  'implicit funding': i => { i.rent.additionalPayerDebitLamports = '1' },
  'stale snapshot': i => { i.snapshot.observedAtMs = 0 },
  'slot mismatch': i => { i.buffer.slot++ },
  'expired blockhash': i => { i.blockhash.currentBlockHeight = 201 },
  'expired time': i => { i.blockhash.expiresAtMs = nowMs },
  'nonce unsupported': i => { i.blockhash.mode = 'nonce' },
  'signer order': i => { i.approvedSignerOrder.reverse() },
  'aliasing': i => { i.spill = i.authority },
  'wrong cluster': i => { i.cluster = 'devnet' },
  'source drift': i => { i.source.sourceManifest['program.rs'] = 'f'.repeat(64) },
  'feature drift': i => { i.source.features.launch.push('other'); i.source.featuresSha256 = digestJson(i.source.features) },
}
for (const [name, change] of Object.entries(failures)) test(`reject ${name} even with newly computed envelope digest`, () => {
  const e = fixture(); change(e.inputs); e.approvedInputsSha256 = digestJson(e.inputs)
  assert.throws(() => prepare(e))
})
test('any changed public input invalidates existing review digest', () => {
  const e = fixture(); e.inputs.blockhash.value = pub(6)
  assert.throws(() => prepare(e), /digest mismatch/)
})
test('no missing input fallback and CLI always returns NOT SIGNABLE without reading file paths', () => {
  assert.throws(() => prepare({}))
  for (const args of [[], ['/never/read/keypair.json']]) {
    const r = spawnSync(process.execPath, ['scripts/hooklab-selected-release-message.mjs', ...args], { input: '{}', encoding: 'utf8' })
    assert.equal(r.status, 2)
    const out = JSON.parse(r.stdout); assert.equal(out.messageBase64, null); assert.equal(out.canSign, false)
    assert.ok(out.unmetPublicInputs.length > 0)
  }
})
