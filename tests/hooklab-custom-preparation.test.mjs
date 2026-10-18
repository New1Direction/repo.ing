import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey, VersionedMessage } from '@solana/web3.js'
import { planCustomPreparation } from '../src/hooklab-custom-preparation.mjs'
import { customPreparationFixture } from './fixtures/hooklab-custom-preparation.mjs'
import { generatedCustomArtifact, missingGeneratedArtifacts } from './fixtures/hooklab-generated-artifact.mjs'
const sha = b => createHash('sha256').update(b).digest('hex')

test('offline preparation uses exact two source instructions, canonical metas and three/four external signers', () => {
  for (const samePayer of [false, true]) {
    const f = customPreparationFixture({ samePayer }), p = planCustomPreparation(f)
    assert.equal(p.instructions.length, 4)
    assert.deepEqual([...p.review.requiredSigners].sort(), [...new Set([f.request.feePayer, f.request.creator, f.request.mint, f.request.selectedConfig])].sort())
    assert.deepEqual(p.rentAccountSizes, { policy: 72, registry: 47, selectedConfig: 176 })
    assert.equal(p.rentQuoteLamports, '6000'); assert.equal(p.launchPlan, null)
    for (const key of ['preparationReceiptAccepted', 'deploymentAdopted', 'policyApproved', 'rentCapEnforcedOnchain', 'canSign', 'canSubmit', 'canRetry']) assert.equal(p[key], false)
    const prepare = p.instructions[2], config = p.instructions[3]
    assert.equal(prepare.dataHex, '799b9c5aa4fcdc6d' + new PublicKey(f.request.blockedOwner).toBuffer().toString('hex'))
    // Independent Borsh: discriminator + 22 zero rule bytes + zero u16 fee + Some(gate) + u16 flags + label.
    const label = Buffer.from(f.request.label), length = Buffer.alloc(4); length.writeUInt32LE(label.length)
    assert.equal(config.dataHex, Buffer.concat([Buffer.from('c9cff3724b6f2fbd', 'hex'), Buffer.alloc(24), Buffer.from([1]),
      new PublicKey(p.addresses.gate).toBuffer(), Buffer.from([1, 0]), length, label]).toString('hex'))
    assert.equal(config.accounts.length, 8)
    assert.deepEqual(config.accounts.at(-1), { address: p.addresses.gateProgramData, signer: false, writable: false })
    assert.equal(prepare.accounts[1].signer, true); assert.equal(prepare.accounts[1].writable, false)
    const message = VersionedMessage.deserialize(Buffer.from(p.review.messageBase64, 'base64'))
    assert.equal(message.version, 0); assert.equal(message.compiledInstructions.length, 4)
    assert.deepEqual(planCustomPreparation(f), p)
  }
})

test('unknown fields, policy widening, signer aliasing, invalid profiles and mutable gate evidence fail closed', () => {
  const both = (f, edit) => f.observations.forEach(edit)
  const mutations = [f => { f.ready = true }, f => { f.request.admin = f.request.creator }, f => { f.request.hookFlags = 2 },
    f => { f.request.creatorFeeBps = 1 }, f => { f.request.rules = 'burn' }, f => { f.request.blockedOwner = '11111111111111111111111111111111' },
    f => { f.request.selectedConfig = f.request.mint }, f => { f.request.feePayer = f.request.mint },
    f => { f.request.label = '界'.repeat(11) }, f => { f.profile.expectedSha256 = '0'.repeat(64) },
    f => { const p = JSON.parse(f.profile.json); p.artifactAdopted = true; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) },
    f => { const p = JSON.parse(f.profile.json); p.idlSha256.gate = '0'.repeat(64); f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) },
    f => both(f, o => { const data = Buffer.from(o.accounts[3].account.dataBase64, 'base64'); data[12] = 1; o.accounts[3].account.dataBase64 = data.toString('base64') }),
    f => both(f, o => { o.accounts[5].account = { ...o.accounts[9].account, address: o.accounts[5].address } }),
    f => { f.observations[1].accounts[0].account.lamports = '1' }, f => { f.observations[1].provider = 'fixture-a' },
    f => { f.limits.maxRentLamports = '5999' }, f => { f.limits.maxNetworkFeeLamports = '19999' },
    f => { f.limits.maxTotalDebitLamports = '25999' }, f => { f.limits.validUntilSlot = 251 }, f => { f.limits.nowMs = 20000 },
    f => { f.recentBlockhash.observedSlot = 99 }, f => { f.recentBlockhash.lastValidBlockHeight = 0 },
    f => { f.recentBlockhash.blockhashValid = false }, f => { f.recentBlockhash.currentBlockHeight = 251 },
    f => { f.recentBlockhash.observedSlot = 150 }, f => { f.recentBlockhash.providers = ['unbound', 'reader'] }, f => { f.recentBlockhash.networkFeeLamports = '0' }, f => { f.recentBlockhash.lamportsPerSignature = '0' }, f => { f.lookupTable = { extra: true } }]
  for (const change of mutations) { const f = customPreparationFixture(); change(f); assert.throws(() => planCustomPreparation(f)) }
})

test('preparation bytes and ordered metas match the executed Rust retained-ID staging vector', { skip: missingGeneratedArtifacts(['hooklab-custom-rust-vector.json']) }, async () => {
  const { readFileSync } = await import('node:fs')
  const fixture = JSON.parse(readFileSync(generatedCustomArtifact('hooklab-custom-rust-vector.json')))
  assert.equal(fixture.originalVectorSha256, '42a557ce9e91e2c092b51b590ebbbee6223a3df6708ec70d20923744a677a523')
  assert.equal(fixture.profileSha256, 'dd3ee75373208bc58c2079d107fb8c7e998b01560ae33a69ca36b109c8f20391')
  assert.equal(sha(fixture.profileJson), fixture.profileSha256)
  assert.equal(fixture.productionPreparationReceipt, null)
  assert.match(fixture.provenance, /synthetic-fixture-not-rpc/)
  const f = customPreparationFixture({ samePayer: true }), profile = JSON.parse(fixture.profileJson), slot = Number(fixture.slot)
  f.profile = { json: fixture.profileJson, expectedSha256: fixture.profileSha256,
    idls: { launch: readFileSync(new URL('../vendor/hooklab-event-abi/custom-preparation-reuse/bordrless_launch.json', import.meta.url)).toString('base64'),
      gate: readFileSync(new URL('../vendor/hooklab-event-abi/custom-production/hook_gate.json', import.meta.url)).toString('base64') },
    elfLengths: { launch: 725544, gate: 143848 }, providers: ['fixture-a', 'fixture-b'] }
  Object.assign(f.request, { creator: fixture.request.creator, feePayer: fixture.request.payer, mint: fixture.request.futureMint,
    selectedConfig: fixture.request.selectedConfig, blockedOwner: fixture.request.blockedOwner, label: fixture.request.label })
  f.observations = f.profile.providers.map(provider => ({ provider, genesisHash: profile.genesisHash, commitment: 'finalized', slot,
    observedAtMs: 1000, accounts: fixture.accounts, rentExemptionLamports: fixture.rentExemptionLamports }))
  f.recentBlockhash = { blockhash: fixture.blockhash, genesisHash: profile.genesisHash, providers: f.profile.providers,
    observedAtMs: 1000, currentBlockHeight: slot, blockhashValid: true, lastValidBlockHeight: slot + 150, observedSlot: slot, networkFeeLamports: '15000', lamportsPerSignature: '5000' }
  const rent = Object.values(fixture.rentExemptionLamports).reduce((sum, n) => sum + BigInt(n), 0n)
  Object.assign(f.limits, { validUntilSlot: slot + 100, maxRentLamports: String(rent), maxNetworkFeeLamports: '15000', maxTotalDebitLamports: String(rent + 15000n) })
  const plan = planCustomPreparation(f)
  const expected = fixture.expectedInstructions.map(i => ({ program: i.programId, dataHex: i.dataHex,
    accounts: i.keys.map(k => ({ address: k.pubkey, signer: k.isSigner, writable: k.isWritable })) }))
  assert.deepEqual(plan.instructions.slice(2), expected)
  assert.equal(plan.preparationReceiptAccepted, false); assert.equal(plan.canSign, false); assert.equal(plan.canSubmit, false)
  assert.equal(plan.launchPlan, null)
  assert.match(fixture.atomicPreparationAndLaunch, /refused-HookExtrasMismatch/)
})

test('resolved ALT state and payer funding are bounded; blocked-owner PDAs remain valid data', () => {
  const f = customPreparationFixture(), base = planCustomPreparation(f)
  const addresses = base.review.accounts.filter(a => !a.signer).map(a => a.address)
  const bytes = Buffer.alloc(56 + 32 * addresses.length)
  bytes.writeUInt32LE(1); bytes.writeBigUInt64LE(0xffffffffffffffffn, 4); bytes.writeBigUInt64LE(10n, 12)
  addresses.forEach((a, i) => new PublicKey(a).toBuffer().copy(bytes, 56 + i * 32))
  f.lookupTable = { address: new PublicKey(Buffer.alloc(32, 130)).toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111',
    dataBase64: bytes.toString('base64'), sha256: sha(bytes) }
  const withTable = planCustomPreparation(f)
  assert.equal(withTable.review.lookupTables.length, 1)
  assert.ok(Buffer.from(withTable.review.messageBase64, 'base64').length < Buffer.from(base.review.messageBase64, 'base64').length)
  assert.deepEqual(withTable.instructions, base.instructions)
  for (const address of [base.addresses.policy, base.addresses.gate, f.request.creator]) { const aliased = structuredClone(f); aliased.lookupTable.address = address; assert.throws(() => planCustomPreparation(aliased), /aliases/); }
  f.lookupTable.sha256 = '0'.repeat(64); assert.throws(() => planCustomPreparation(f), /hash differs/)
  for (const [offset, value] of [[4, 99n], [12, 100n]]) {
    const changed = Buffer.from(bytes); changed.writeBigUInt64LE(value, offset)
    f.lookupTable.dataBase64 = changed.toString('base64'); f.lookupTable.sha256 = sha(changed)
    assert.throws(() => planCustomPreparation(f), /inactive or not warmed/)
  }
  const insufficient = customPreparationFixture()
  for (const o of insufficient.observations) o.accounts[9].account.lamports = '5999'
  assert.throws(() => planCustomPreparation(insufficient), /funds insufficient/)
  const duplicate = customPreparationFixture({ samePayer: true })
  for (const o of duplicate.observations) o.accounts[10].account.lamports = '9999999'
  assert.throws(() => planCustomPreparation(duplicate), /Repeated payer/)
  const offCurve = customPreparationFixture()
  offCurve.request.mint = base.addresses.policy
  assert.throws(() => planCustomPreparation(offCurve), /Required signer cannot be a PDA/)
  const blockedPda = customPreparationFixture()
  blockedPda.request.blockedOwner = base.addresses.policy
  assert.equal(planCustomPreparation(blockedPda).request.blockedOwner, base.addresses.policy)
})
