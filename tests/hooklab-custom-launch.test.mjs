import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { buildCustomLaunchReview, buildCustomLaunchReviewForFixture } from '../src/hooklab-custom-launch.mjs'
import { customPreparationRequestSchema } from '../src/hooklab-custom-preparation.mjs'
import { customLaunchFixture, customLaunchRustVector } from './fixtures/hooklab-custom-launch.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const artifacts = missingGeneratedArtifacts(['hooklab-custom-launch-rust-vector.json'])
const test = testRequiring(artifacts)
const sha = b => createHash('sha256').update(b).digest('hex'), pk = value => new PublicKey(value)
// Built only when the private vector is present; otherwise every case is skipped and these stay null.
const fixture = artifacts ? null : customLaunchFixture(), baseline = fixture && buildCustomLaunchReviewForFixture(fixture)
const names = fixture && { ...baseline.addresses, selectedConfig: fixture.request.selectedConfig, creator: fixture.request.creator,
  reviewer: fixture.request.reviewer, mint: fixture.request.mint, quoteMint: JSON.parse(fixture.profile.json).quoteMint }
const entry = (f, name, index = 0) => f.observations[index].accounts.find(a => a.address === (names[name] ?? name))
function editAccount(f, name, edit, { rebind = false } = {}) {
  const item = entry(f, name); edit(item.account, item)
  f.observations[1].accounts = structuredClone(f.observations[0].accounts)
  if (rebind) {
    const hash = sha(Buffer.from(item.account.dataBase64, 'base64'))
    if (name in f.reviewedStateHashes) f.reviewedStateHashes[name] = hash
    if (name in f.preparationEvidence.preparedAccountHashes) f.preparationEvidence.preparedAccountHashes[name] = hash
  }
}
function editBytes(f, name, edit, opts) { editAccount(f, name, a => { const b = Buffer.from(a.dataBase64, 'base64'); edit(b); a.dataBase64 = b.toString('base64') }, opts) }
function editDecoded(f, name, role, type, edit, opts = { rebind: true }) {
  const coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls[role], 'base64')))
  editAccount(f, name, a => {
    const raw = Buffer.from(a.dataBase64, 'base64'), value = coder.accounts.decode(type, raw); edit(value)
    const encoded = coder.types.encode(type, value), next = Buffer.alloc(raw.length)
    raw.subarray(0, 8).copy(next); encoded.copy(next, 8); a.dataBase64 = next.toString('base64')
  }, opts)
}
function changeTable(f, edit) { const b = Buffer.from(f.lookupTable.dataBase64, 'base64'); edit(b); f.lookupTable.dataBase64 = b.toString('base64'); f.lookupTable.sha256 = sha(b) }
function refuses(label, mutate, pattern) { test(label, () => { const f = customLaunchFixture(); mutate(f); assert.throws(() => buildCustomLaunchReviewForFixture(f), pattern) }) }

test('independently generated stage2 data and all40 ordered metas equal the executed Rust vector', () => {
  const v = customLaunchRustVector(), p = buildCustomLaunchReviewForFixture(customLaunchFixture())
  assert.equal(v.originalVectorSha256, 'f5820f16ea1a4ab59598f8d85e0c068c7e44492ce81c18acfbb617b5a6d389f2')
  assert.equal(sha(v.profileJson), 'dd3ee75373208bc58c2079d107fb8c7e998b01560ae33a69ca36b109c8f20391')
  assert.equal(p.instructions[2].dataHex, v.expectedInstruction.dataHex)
  assert.deepEqual(p.instructions[2].accounts, v.expectedInstruction.keys.map(k => ({ address: k.pubkey, signer: k.isSigner, writable: k.isWritable })))
  assert.equal(p.instructions[2].accounts.length, 40); assert.equal(p.instructions.length, 3)
  const message = VersionedMessage.deserialize(Buffer.from(p.review.messageBase64, 'base64'))
  assert.equal(message.version, 0); assert.equal(new VersionedTransaction(message).serialize().length, 788)
  assert.deepEqual(p.review.requiredSigners, [fixture.request.creator, fixture.request.mint, fixture.request.reviewer])
  for (const name of ['policy', 'registry']) assert.deepEqual(p.review.accounts.find(a => a.address === p.addresses[name]), { address: p.addresses[name], signer: false, writable: false })
  assert.equal(p.review.instructionDebitLamports, fixture.limits.maxInstructionDebitLamports)
  assert.equal(p.productionPreparationReceipt, null)
  for (const k of ['preparationReceiptAccepted', 'artifactAdopted', 'deploymentAdopted', 'policyApproved', 'executionAuthorized', 'publicExecutionEnabled', 'feeEvidenceAuthenticated', 'dependencyCodeAuthenticated', 'canSign', 'canSubmit', 'canRetry']) assert.equal(p[k], false)
  assert.match(p.status, /synthetic/); assert.match(p.provenance, /not-rpc-evidence/)
  assert.ok(Object.isFrozen(p.review)); assert.deepEqual(buildCustomLaunchReviewForFixture(customLaunchFixture()), p)
})

test('production export refuses every caller proof, fixture, resolver injection and unknown outcome without a message', () => {
  const fakeReceipt = { status: 'accepted', finalized: true, signature: 'invented', messageSha256: baseline.review.messageSha256,
    slot: fixture.observations[0].slot, accounts: fixture.observations[0].accounts }
  for (const input of [undefined, {}, fixture, { preparationEvidence: fakeReceipt }, { preparationEvidence: { ...fakeReceipt, status: 'preparation-outcome-unknown' } },
    { preparationEvidence: { status: 'pending' } }, { preparationEvidence: { status: 'reconcile-required' } },
    { ...fixture, resolveTrustedRecord: () => fakeReceipt }, { ...fixture, preparationEvidence: { recordId: 'server-record', trusted: true } }]) {
    assert.throws(() => buildCustomLaunchReview(input), e => e.code === 'CUSTOM_PREPARATION_PROOF_UNAVAILABLE')
  }
})

for (const [label, mutate, pattern] of [
  ['caller approval field', f => { f.finalized = true }, /unrecognized/i],
  ['extra instruction', f => { f.instructions = [] }, /unrecognized/i],
  ['synthetic receipt promoted', f => { f.preparationEvidence.productionPreparationReceipt = { finalized: true } }, /null/i],
  ['caller finalized inside evidence', f => { f.preparationEvidence.finalized = true }, /unrecognized/i],
  ['unknown preparation outcome', f => { f.preparationEvidence.status = 'preparation-outcome-unknown' }, /synthetic-prepared/],
  ['pending preparation outcome', f => { f.preparationEvidence.status = 'pending' }, /synthetic-prepared/],
  ['wrong preparation profile', f => { f.preparationEvidence.profileSha256 = '0'.repeat(64) }, /intent\/profile/],
  ['wrong preparation intent', f => { f.preparationEvidence.preparationIntentSha256 = '0'.repeat(64) }, /intent\/profile/],
  ['wrong execution slot', f => { f.preparationEvidence.executionSlot++ }, /pre-preparation/],
  ['wrong prepared byte hash', f => { f.preparationEvidence.preparedAccountHashes.policy = '0'.repeat(64) }, /Prepared state hashes/],
  ['wrong reviewed state hash', f => { f.reviewedStateHashes.authorization = '0'.repeat(64) }, /Reviewed current state/],
  ['wrong profile bytes', f => { f.profile.json += ' ' }, /profile digest/],
  ['wrong IDL bytes', f => { f.profile.idls.launch = Buffer.from('{}').toString('base64') }, /IDL digest/],
  ['wrong explicit ELF length', f => { f.profile.elfLengths.swap += 88 }, /Program ELF/],
  ['policy widening rules', f => { f.request.rules = 'burn' }, /none/],
  ['nonzero creator fee', f => { f.request.creatorFeeBps = 1 }, /0/],
  ['wrong hook flags', f => { f.request.hookFlags = 3 }, /1/],
  ['default blocked owner', f => { f.request.blockedOwner = '11111111111111111111111111111111' }, /Invalid/],
  ['multibyte oversized metadata', f => { f.request.name = '界'.repeat(11) }, /Invalid/],
  ['wrong current admin reviewer', f => { f.request.reviewer = f.request.creator }, /Current admin/],
  ['unbound provider', f => { f.observations[0].provider = 'attacker' }, /Provider binding/],
  ['duplicate provider', f => { f.observations[0].provider = 'fixture-b' }, /Provider binding/],
  ['divergent readers', f => { f.observations[1].accounts[0].account.lamports = '2' }, /observations disagree/],
  ['pre-preparation snapshot', f => { f.observations[0].slot-- }, /pre-preparation/],
  ['future timestamp', f => { f.observations[0].observedAtMs++ }, /Stale/],
  ['stale snapshot', f => { f.limits.nowMs = 7000 }, /Stale/],
  ['wrong chain', f => { f.observations[0].genesisHash = f.request.creator }, /wrong-chain/],
  ['invalid blockhash', f => { f.recentBlockhash.blockhashValid = false }, /true/],
  ['wrong blockhash chain', f => { f.recentBlockhash.genesisHash = f.request.creator }, /lifetime/],
  ['unbound blockhash readers', f => { f.recentBlockhash.providers = ['a', 'b'] }, /lifetime/],
  ['expired block height', f => { f.recentBlockhash.currentBlockHeight = f.recentBlockhash.lastValidBlockHeight + 1 }, /lifetime/],
  ['unbounded block height', f => { f.recentBlockhash.lastValidBlockHeight++ }, /lifetime/],
  ['old blockhash observation', f => { f.recentBlockhash.observedSlot-- }, /lifetime/],
  ['blockhash slot beyond review', f => { f.recentBlockhash.observedSlot = f.limits.validUntilSlot + 1 }, /lifetime/],
  ['expired review', f => { f.limits.reviewExpiresAtMs = f.limits.nowMs }, /lifetime/],
  ['unbounded deadline', f => { f.limits.validUntilSlot = f.observations[0].slot + 151; editDecoded(f, 'authorization', 'launch', 'CreatorAuthorization', a => { a.expires_at_slot = new BN(f.limits.validUntilSlot + 1000) }) }, /lifetime/],
  ['too much compute', f => { f.limits.computeUnitLimit = 1400001 }, /1400000/],
  ['zero signature fee basis', f => { f.recentBlockhash.lamportsPerSignature = '0' }, /Invalid/],
  ['invented network fee', f => { f.recentBlockhash.networkFeeLamports = '14999' }, /signature fee basis/],
  ['network cap too low', f => { f.limits.maxNetworkFeeLamports = '14999' }, /native fee\/debit/],
  ['total cap too low', f => { f.limits.maxTotalDebitLamports = '200014999' }, /cap exceeded/],
  ['rent exceeds instruction cap', f => { f.limits.maxRentLamports = '200000001' }, /cap exceeded/],
  ['zero rent allowance', f => { f.limits.maxRentLamports = '0' }, /cap exceeded/],
  ['virtual quote outside config', f => { f.request.virtualQuote = '1' }, /Virtual quote/],
  ['ALT absent causes oversized wire', f => { f.lookupTable = null }, /overrun|1232|maximum|mismatch|large/i],
  ['ALT hash forged', f => { f.lookupTable.sha256 = '0'.repeat(64) }, /Lookup table hash/],
  ['ALT aliased to policy', f => { f.lookupTable.address = names.policy }, /aliases/],
  ['ALT aliased to observed swap governance', f => { f.lookupTable.address = names.swapGovernance }, /aliases/],
  ['ALT not warm', f => changeTable(f, b => b.writeBigUInt64LE(BigInt(f.observations[0].slot), 12)), /not warmed/],
  ['ALT deactivated', f => changeTable(f, b => b.writeBigUInt64LE(99n, 4)), /inactive/],
  ['ALT noncanonical authority option', f => changeTable(f, b => { b[21] = 2 }), /canonical/],
  ['ALT duplicate addresses', f => changeTable(f, b => b.subarray(56, 88).copy(b, 88)), /addresses differ/],
  ['ALT arbitrary padding', f => changeTable(f, b => { b[55] = 1 }), /canonical/],
]) refuses(label, mutate, pattern)

for (const [label, mutate, pattern] of [
  ['mutable gate', f => editBytes(f, 'gateProgramData', b => { b[12] = 1 }), /immutable gate/],
  ['wrong gate ELF', f => editBytes(f, 'gateProgramData', b => { b[100] ^= 1 }), /Program ELF/],
  ['nonzero swap capacity tail', f => editBytes(f, 'swapProgramData', b => { b[b.length - 1] = 1 }), /Program ELF/],
  ['wrong registry owner', f => editAccount(f, 'registry', a => { a.owner = JSON.parse(f.profile.json).programs.launch }), /ownership/],
  ['policy executable', f => editAccount(f, 'policy', a => { a.executable = true }), /ownership/],
  ['wrong registry literal key', f => editBytes(f, 'registry', b => { b[46] ^= 1 }, { rebind: true }), /literal read-only/],
  ['registry writable entry', f => editBytes(f, 'registry', b => { b[13] = 1 }, { rebind: true }), /literal read-only/],
  ['registry dynamic PDA entry', f => editBytes(f, 'registry', b => { b[14] = 1 }, { rebind: true }), /literal read-only/],
  ['wrong policy mint', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.mint = pk(f.request.creator) }), /policy mint/],
  ['wrong blocked owner', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.blocked_owner = pk(f.request.creator) }), /blocked owner/],
  ['nonzero selected creator fee', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.creator_fee_bps = 1 }), /selected configuration/],
  ['nonzero selected author fee', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.author_share_bps = 1 }), /selected configuration/],
  ['selected rules widened', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.rules.burn_buy_bps = 1 }), /selected configuration/],
  ['timelocked selected hook', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.reserved[0] = 1 }), /selected configuration/],
  ['noncanonical selected reserved', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.reserved[29] = 1 }), /selected configuration/],
  ['wrong selected creator', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.creator = pk(f.request.reviewer) }), /selected configuration/],
  ['wrong selected hook', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.custom_hook = pk(JSON.parse(f.profile.json).programs.swap) }), /selected configuration/],
  ['wrong selected label', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', s => { s.label = 'other' }), /selected configuration/],
  ['disabled grant', f => editDecoded(f, 'authorization', 'launch', 'CreatorAuthorization', a => { a.enabled = false }), /grant, quota/],
  ['exhausted quota', f => editDecoded(f, 'authorization', 'launch', 'CreatorAuthorization', a => { a.consumed = a.max_launches }), /grant, quota/],
  ['exclusive expiry at deadline', f => editDecoded(f, 'authorization', 'launch', 'CreatorAuthorization', a => { a.expires_at_slot = new BN(f.limits.validUntilSlot) }), /exclusive expiry/],
  ['wrong grant creator', f => editDecoded(f, 'authorization', 'launch', 'CreatorAuthorization', a => { a.creator = pk(f.request.reviewer) }), /grant, quota/],
  ['grant revision changed since review', f => editDecoded(f, 'authorization', 'launch', 'CreatorAuthorization', a => { a.revision = a.revision.addn(1) }, { rebind: false }), /Reviewed current state/],
  ['launch config paused', f => editDecoded(f, 'launchConfig', 'launch', 'Config', c => { c.paused = true }), /pause/],
  ['swap config paused', f => editDecoded(f, 'swapConfig', 'swap', 'Config', c => { c.paused = true }), /pause/],
  ['governance wrong genesis', f => editDecoded(f, 'launchGovernance', 'launch', 'Governance', g => { g.state.genesis[0] ^= 1 }), /Governance identity/],
  ['governance paused gate', f => editDecoded(f, 'swapGovernance', 'swap', 'Governance', g => { g.state.gates.creation = true }), /Governance identity/],
  ['governance digest mismatch', f => editDecoded(f, 'launchGovernance', 'launch', 'Governance', g => { g.state.config_digest[0] ^= 1 }), /Governance economics/],
  ['governance admin mismatch', f => editDecoded(f, 'launchGovernance', 'launch', 'Governance', g => { g.state.roles.admin = pk(f.request.creator) }), /Governance identity/],
  ['quote wrong owner', f => editAccount(f, 'quoteMint', q => { q.owner = JSON.parse(f.profile.json).programs.swap }), /ownership/],
  ['quote hook flags changed', f => editBytes(f, 'quoteMint', b => { b[31] = 1 }, { rebind: true }), /Quote hook flags/],
  ['quote hooked option', f => editBytes(f, 'quoteMint', b => { b[30] = 1 }, { rebind: true }), /must remain unhooked/],
  ['quote huge metadata length', f => editBytes(f, 'quoteMint', b => { b.writeUInt32LE(0xffffffff, 33) }, { rebind: true }), /metadata bounds/],
  ['quote invalid UTF-8', f => editBytes(f, 'quoteMint', b => { b[37] = 0xff }, { rebind: true }), /UTF-8/],
  ['quote invalid option', f => editBytes(f, 'quoteMint', b => { b[26] = 2 }, { rebind: true }), /option is noncanonical/],
  ['quote nonzero reserved', f => editBytes(f, 'quoteMint', b => { b[b.length - 1] = 1 }, { rebind: true }), /reserved or trailing/],
  ['existing launch account', f => editAccount(f, 'launch', (_a, item) => { item.account = { ...entry(f, 'creator').account, address: item.address } }), /target already exists/],
  ['initialized future mint', f => editAccount(f, 'mint', (_a, item) => { item.account = { ...entry(f, 'quoteMint').account, address: item.address } }), /future mint/],
  ['insufficient creator funds', f => editAccount(f, 'creator', a => { a.lamports = '200014999' }), /funds insufficient/],
  ['extra observed account', f => { const extra = { address: pk(Buffer.alloc(32, 201)).toBase58(), account: null }; f.observations.forEach(o => o.accounts.push(extra)) }, /extra launch inventory/],
  ['missing observed account', f => { f.observations.forEach(o => o.accounts.pop()) }, /inventory/],
  ['duplicate observed account', f => { f.observations.forEach(o => o.accounts.push(o.accounts[0])) }, /Duplicate/],
]) refuses(label, mutate, pattern)

test('swap collector differs from treasury even after recomputing config, governance digest and reviewed hashes', () => {
  const f = customLaunchFixture(), p = JSON.parse(f.profile.json), coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.swap, 'base64')))
  editDecoded(f, 'swapConfig', 'swap', 'Config', c => { c.fee_collector = pk(f.request.creator) })
  const config = coder.accounts.decode('Config', Buffer.from(entry(f, 'swapConfig').account.dataBase64, 'base64'))
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('hook-lab/swap-governed-economics/1\0'), pk(p.programs.swap).toBuffer(),
    coder.types.encode('ConfigArgs', { ...config, admin: PublicKey.default, treasury: PublicKey.default, paused: false })])).digest()
  editDecoded(f, 'swapGovernance', 'swap', 'Governance', g => { g.state.config_digest = [...digest] })
  assert.throws(() => buildCustomLaunchReviewForFixture(f), /Governance identity, roles or gates/)
})

test('changing valid metadata generates different exact bytes rather than returning the stored vector', () => {
  const f = customLaunchFixture(); f.request.name = 'Independent custom launch'
  const p = buildCustomLaunchReviewForFixture(f)
  assert.notEqual(p.instructions[2].dataHex, baseline.instructions[2].dataHex)
  assert.deepEqual(p.commitments, baseline.commitments); assert.notEqual(p.review.messageSha256, baseline.review.messageSha256)
  assert.equal(p.canSign, false); assert.equal(p.canSubmit, false)
})

test('priority fee is rounded up and added to exact signer-count fee basis', () => {
  const f = customLaunchFixture(); f.limits.computeUnitPriceMicroLamports = '1'; f.recentBlockhash.networkFeeLamports = '15002'
  f.limits.maxNetworkFeeLamports = '15002'; f.limits.maxTotalDebitLamports = '200015002'
  const p = buildCustomLaunchReviewForFixture(f)
  assert.equal(p.review.baseFeeLamports, '15000')
  f.recentBlockhash.networkFeeLamports = '15001'
  assert.throws(() => buildCustomLaunchReviewForFixture(f), /signature fee basis/)
})


test('ALT with257 entries is impossible even when all instruction indexes stay below256', () => {
  const f = customLaunchFixture(), old = Buffer.from(f.lookupTable.dataBase64, 'base64'), b = Buffer.alloc(56 + 257 * 32)
  old.copy(b)
  for (let i = (old.length - 56) / 32; i < 257; i++) {
    createHash('sha256').update(`synthetic-alt-entry-${i}`).digest().copy(b, 56 + i * 32)
  }
  f.lookupTable.dataBase64 = b.toString('base64'); f.lookupTable.sha256 = sha(b)
  assert.throws(() => buildCustomLaunchReviewForFixture(f), /Lookup table hash, canonical state/)
})


function rebindPreparationIntent(f) {
  const r = f.request
  const prep = customPreparationRequestSchema.parse({ schema: 'repoing/custom-preparation-request/1', creator: r.creator, feePayer: r.feePayer,
    mint: r.mint, selectedConfig: r.selectedConfig, blockedOwner: r.blockedOwner, label: r.label, creatorFeeBps: r.creatorFeeBps, rules: r.rules, hookFlags: r.hookFlags })
  f.preparationEvidence.preparationIntentSha256 = sha(JSON.stringify(prep))
}
function setSeparatePayer(f, address) {
  f.request.feePayer = address; rebindPreparationIntent(f)
  const item = { address, account: { address, owner: PublicKey.default.toBase58(), executable: false, lamports: '1000000', dataBase64: '' } }
  f.observations.forEach(o => o.accounts.push(structuredClone(item)))
  f.recentBlockhash.networkFeeLamports = '20000'; f.limits.maxNetworkFeeLamports = '20000'; f.limits.maxTotalDebitLamports = '200020000'
}
test('explicit separate on-curve payer adds exactly one signature and only its fee debit', () => {
  const f = customLaunchFixture()
  // Public address retained in the earlier Rust fixture. No key generation or signing.
  setSeparatePayer(f, 'HV86MkNHfzYzoQdT13dbGmtq2kxcjAs5vdVwDEKohL8q')
  const p = buildCustomLaunchReviewForFixture(f)
  assert.deepEqual(new Set(p.review.requiredSigners), new Set([f.request.feePayer, f.request.creator, f.request.mint, f.request.reviewer]))
  assert.deepEqual(p.instructions[2], baseline.instructions[2]); assert.equal(p.review.baseFeeLamports, '20000')
  assert.equal(p.canSign, false); assert.equal(p.canSubmit, false)
})
test('off-curve fee payer refuses after coherent inventory and preparation-intent rebinding', () => {
  const f = customLaunchFixture(), program = JSON.parse(f.profile.json).programs.launch
  const payer = PublicKey.findProgramAddressSync([Buffer.from('synthetic-fixture-fee-payer')], pk(program))[0].toBase58()
  setSeparatePayer(f, payer)
  assert.throws(() => buildCustomLaunchReviewForFixture(f), /signer identity cannot be a PDA/)
})
test('fee payer cannot alias any canonical policy, registry, mint, reviewer or selected config', () => {
  for (const payer of [names.policy, names.registry, fixture.request.mint, fixture.request.reviewer, fixture.request.selectedConfig]) {
    const f = customLaunchFixture(); f.request.feePayer = payer; rebindPreparationIntent(f)
    assert.throws(() => buildCustomLaunchReviewForFixture(f), /Launch roles alias/)
  }
})
