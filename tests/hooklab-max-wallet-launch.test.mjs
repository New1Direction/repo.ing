import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { buildMaxWalletLaunchReview, buildMaxWalletLaunchReviewForFixture } from '../src/hooklab-max-wallet-launch.mjs'
import { maxWalletPreparationRequestSchema } from '../src/hooklab-max-wallet-preparation.mjs'
import { maxWalletLaunchFixture, maxWalletRustVector } from './fixtures/hooklab-max-wallet-launch.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const artifacts = missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json'])
const test = testRequiring(artifacts)
const sha = b => createHash('sha256').update(b).digest('hex'), pk = value => new PublicKey(value)
// Built only when the private vector is present; otherwise every case is skipped and these stay null.
const fixture = artifacts ? null : maxWalletLaunchFixture(), baseline = fixture && buildMaxWalletLaunchReviewForFixture(fixture)
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
function refuses(label, mutate, pattern) { test(label, () => { const f = maxWalletLaunchFixture(); mutate(f); assert.throws(() => buildMaxWalletLaunchReviewForFixture(f), pattern) }) }

test('independently generated stage2 data and all41 ordered metas equal the executed Rust vector', () => {
  const v = maxWalletRustVector(), p = buildMaxWalletLaunchReviewForFixture(maxWalletLaunchFixture())
  assert.equal(sha(fixture.profile.json), 'f366d222e7257e86ac23d8350741b3c20c08ea084a4445c7b0d2d913593b5ea0')
  assert.equal(p.instructions[2].dataHex, v.launch.instruction.dataHex)
  assert.deepEqual(p.canonicalInstruction.accounts, v.launch.instruction.keys.map(k => ({ address: k.pubkey, signer: k.isSigner, writable: k.isWritable })))
  assert.equal(p.instructions[2].accounts.length, 41); assert.equal(p.instructions.length, 3)
  const message = VersionedMessage.deserialize(Buffer.from(p.review.messageBase64, 'base64'))
  assert.equal(message.version, 0); assert.equal(new VersionedTransaction(message).serialize().length, 789)
  assert.deepEqual(p.review.requiredSigners, [fixture.request.creator, fixture.request.mint, fixture.request.reviewer])
  for (const name of ['policy', 'registry']) assert.deepEqual(p.review.accounts.find(a => a.address === p.addresses[name]), { address: p.addresses[name], signer: false, writable: false })
  assert.equal(p.review.instructionDebitLamports, fixture.limits.maxInstructionDebitLamports)
  assert.equal(p.productionPreparationReceipt, null)
  for (const k of ['preparationReceiptAccepted', 'artifactAdopted', 'deploymentAdopted', 'policyApproved', 'executionAuthorized', 'publicExecutionEnabled', 'feeEvidenceAuthenticated', 'dependencyCodeAuthenticated', 'canSign', 'canSubmit', 'canRetry']) assert.equal(p[k], false)
  assert.match(p.status, /synthetic/); assert.match(p.provenance, /not-rpc-evidence/)
  assert.ok(Object.isFrozen(p.review)); assert.deepEqual(buildMaxWalletLaunchReviewForFixture(maxWalletLaunchFixture()), p)
})

test('production export refuses every caller proof, fixture, resolver injection and unknown outcome without a message', () => {
  const fakeReceipt = { status: 'accepted', finalized: true, signature: 'invented', messageSha256: baseline.review.messageSha256,
    slot: fixture.observations[0].slot, accounts: fixture.observations[0].accounts }
  for (const input of [undefined, {}, fixture, { preparationEvidence: fakeReceipt }, { preparationEvidence: { ...fakeReceipt, status: 'preparation-outcome-unknown' } },
    { preparationEvidence: { status: 'pending' } }, { preparationEvidence: { status: 'reconcile-required' } },
    { ...fixture, resolveTrustedRecord: () => fakeReceipt }, { ...fixture, preparationEvidence: { recordId: 'server-record', trusted: true } }]) {
    assert.throws(() => buildMaxWalletLaunchReview(input), e => e.code === 'MAX_WALLET_PREPARATION_PROOF_UNAVAILABLE')
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
  ['missing explicit cap', f => { delete f.request.capBps }, /Invalid/],
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
  ['wrong policy mint', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.mint = pk(f.request.creator) }), /max-wallet policy/],
  ['wrong policy cap', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.cap_bps++ }), /max-wallet policy/],
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
  const f = maxWalletLaunchFixture(), p = JSON.parse(f.profile.json), coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.swap, 'base64')))
  editDecoded(f, 'swapConfig', 'swap', 'Config', c => { c.fee_collector = pk(f.request.creator) })
  const config = coder.accounts.decode('Config', Buffer.from(entry(f, 'swapConfig').account.dataBase64, 'base64'))
  const digest = createHash('sha256').update(Buffer.concat([Buffer.from('hook-lab/swap-governed-economics/1\0'), pk(p.programs.swap).toBuffer(),
    coder.types.encode('ConfigArgs', { ...config, admin: PublicKey.default, treasury: PublicKey.default, paused: false })])).digest()
  editDecoded(f, 'swapGovernance', 'swap', 'Governance', g => { g.state.config_digest = [...digest] })
  assert.throws(() => buildMaxWalletLaunchReviewForFixture(f), /Governance identity, roles or gates/)
})

test('changing valid metadata generates different exact bytes rather than returning the stored vector', () => {
  const f = maxWalletLaunchFixture(); f.request.name = 'Independent custom launch'
  const p = buildMaxWalletLaunchReviewForFixture(f)
  assert.notEqual(p.instructions[2].dataHex, baseline.instructions[2].dataHex)
  assert.deepEqual(p.commitments, baseline.commitments); assert.notEqual(p.review.messageSha256, baseline.review.messageSha256)
  assert.equal(p.canSign, false); assert.equal(p.canSubmit, false)
})

test('priority fee is rounded up and added to exact signer-count fee basis', () => {
  const f = maxWalletLaunchFixture(); f.limits.computeUnitPriceMicroLamports = '1'; f.recentBlockhash.networkFeeLamports = '15002'
  f.limits.maxNetworkFeeLamports = '15002'; f.limits.maxTotalDebitLamports = '200015002'
  const p = buildMaxWalletLaunchReviewForFixture(f)
  assert.equal(p.review.baseFeeLamports, '15000')
  f.recentBlockhash.networkFeeLamports = '15001'
  assert.throws(() => buildMaxWalletLaunchReviewForFixture(f), /signature fee basis/)
})


test('ALT with257 entries is impossible even when all instruction indexes stay below256', () => {
  const f = maxWalletLaunchFixture(), old = Buffer.from(f.lookupTable.dataBase64, 'base64'), b = Buffer.alloc(56 + 257 * 32)
  old.copy(b)
  for (let i = (old.length - 56) / 32; i < 257; i++) {
    createHash('sha256').update(`synthetic-alt-entry-${i}`).digest().copy(b, 56 + i * 32)
  }
  f.lookupTable.dataBase64 = b.toString('base64'); f.lookupTable.sha256 = sha(b)
  assert.throws(() => buildMaxWalletLaunchReviewForFixture(f), /Lookup table hash, canonical state/)
})


function rebindPreparationIntent(f) {
  const r = f.request
  const prep = maxWalletPreparationRequestSchema.parse({ schema: 'repoing/max-wallet-preparation-request/1', policyKind: r.policyKind, policyVersion: r.policyVersion, creator: r.creator, feePayer: r.feePayer,
    mint: r.mint, selectedConfig: r.selectedConfig, capBps: r.capBps, label: r.label, creatorFeeBps: r.creatorFeeBps, rules: r.rules, hookFlags: r.hookFlags })
  f.preparationEvidence.preparationIntentSha256 = sha(JSON.stringify(prep))
}
function setSeparatePayer(f, address) {
  f.request.feePayer = address; rebindPreparationIntent(f)
  const item = { address, account: { address, owner: PublicKey.default.toBase58(), executable: false, lamports: '1000000', dataBase64: '' } }
  f.observations.forEach(o => o.accounts.push(structuredClone(item)))
  f.recentBlockhash.networkFeeLamports = '20000'; f.limits.maxNetworkFeeLamports = '20000'; f.limits.maxTotalDebitLamports = '200020000'
}
test('explicit separate on-curve payer adds exactly one signature and only its fee debit', () => {
  const f = maxWalletLaunchFixture()
  // Public address retained in the earlier Rust fixture. No key generation or signing.
  setSeparatePayer(f, 'HV86MkNHfzYzoQdT13dbGmtq2kxcjAs5vdVwDEKohL8q')
  const p = buildMaxWalletLaunchReviewForFixture(f)
  assert.deepEqual(new Set(p.review.requiredSigners), new Set([f.request.feePayer, f.request.creator, f.request.mint, f.request.reviewer]))
  assert.deepEqual(p.instructions[2], baseline.instructions[2]); assert.equal(p.review.baseFeeLamports, '20000')
  assert.equal(p.canSign, false); assert.equal(p.canSubmit, false)
})
test('off-curve fee payer refuses after coherent inventory and preparation-intent rebinding', () => {
  const f = maxWalletLaunchFixture(), program = JSON.parse(f.profile.json).programs.launch
  const payer = PublicKey.findProgramAddressSync([Buffer.from('synthetic-fixture-fee-payer')], pk(program))[0].toBase58()
  setSeparatePayer(f, payer)
  assert.throws(() => buildMaxWalletLaunchReviewForFixture(f), /signer identity cannot be a PDA/)
})
test('fee payer cannot alias any canonical policy, registry, mint, reviewer or selected config', () => {
  for (const payer of [names.policy, names.registry, fixture.request.mint, fixture.request.reviewer, fixture.request.selectedConfig]) {
    const f = maxWalletLaunchFixture(); f.request.feePayer = payer; rebindPreparationIntent(f)
    assert.throws(() => buildMaxWalletLaunchReviewForFixture(f), /Launch roles alias/)
  }
})

for (const [label, mutate, pattern] of [
  ['unknown max-wallet policy kind', f => { f.request.policyKind = 'blocked-owner' }, /max-wallet/],
  ['missing max-wallet policy version', f => { delete f.request.policyVersion }, /1/],
  ['unknown max-wallet policy version', f => { f.request.policyVersion = 2 }, /1/],
  ['zero max-wallet cap', f => { f.request.capBps = 0 }, /1/],
  ['uncapped 10000bps refused', f => { f.request.capBps = 10000 }, /9999/],
  ['fractional max-wallet cap', f => { f.request.capBps = 0.5 }, /int/],
  ['creator selected supply refused', f => { f.request.initialSupply = '1' }, /unrecognized/i],
  ['creator selected quote refused', f => { f.request.quoteMint = f.request.creator }, /unrecognized/i],
  ['creator selected LP economics refused', f => { f.request.lpFeeBps = 30 }, /unrecognized/i],
  ['unknown prepared policy version', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.version = 2 }), /max-wallet policy/],
  ['prepared initial supply changed', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.initial_supply = p.initial_supply.subn(1) }), /max-wallet policy/],
  ['prepared quote changed', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.quote_mint = pk(f.request.creator) }), /max-wallet policy/],
  ['prepared LP fee changed', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.lp_fee_bps++ }), /max-wallet policy/],
  ['wrong second registry literal', f => editBytes(f, 'registry', b => { b[80] ^= 1 }, { rebind: true }), /literal read-only/],
  ['second registry entry writable', f => editBytes(f, 'registry', b => { b[47] = 1 }, { rebind: true }), /literal read-only/],
  ['second registry entry dynamic', f => editBytes(f, 'registry', b => { b[48] = 1 }, { rebind: true }), /literal read-only/],
  ['registry entry count changed', f => editBytes(f, 'registry', b => { b.writeUInt32LE(1, 9) }, { rebind: true }), /literal read-only/],
  ['profile policy widened', f => { const p = JSON.parse(f.profile.json); p.capability.kind = 'immutable-canonical-single-blocked-owner'; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) }, /immutable-initial/],
  ['old blocked-owner evidence schema', f => { f.preparationEvidence.schema = 'hooklab/synthetic-prepared-state/1' }, /max-wallet-synthetic/],
]) refuses(label, mutate, pattern)

test('canonical Launch is absent before launch; only its bound identity/owner are committed and its effective writable union is explicit', () => {
  const f = maxWalletLaunchFixture(), p = buildMaxWalletLaunchReviewForFixture(f)
  assert.equal(entry(f, 'launch').account, null)
  assert.deepEqual(p.canonicalInstruction.accounts.at(-1), { address: p.addresses.launch, writable: false, signer: false })
  assert.deepEqual(p.instructions[2].accounts.at(-1), { address: p.addresses.launch, writable: true, signer: false })
  const hash = createHash('sha256'), profile = JSON.parse(f.profile.json), kb = x => pk(x).toBuffer()
  const raw = name => Buffer.from(entry(f, name).account.dataBase64, 'base64'), vector = b => { const n = Buffer.alloc(4); n.writeUInt32LE(b.length); return Buffer.concat([n, b]) }
  hash.update(Buffer.concat([Buffer.from('hook-lab:max-wallet-accounts:v1'), kb(profile.programs.gate), kb(p.addresses.registry), kb(profile.programs.gate), vector(raw('registry')),
    kb(p.addresses.policy), kb(profile.programs.gate), vector(raw('policy')), kb(p.addresses.launch), kb(profile.programs.launch)]))
  assert.equal(hash.digest('hex'), p.commitments.hookAccounts)
})

test('changing an explicit valid cap regenerates bytes and hook commitment without changing launch economics', () => {
  for (const capBps of [1, 9999]) {
    const f = maxWalletLaunchFixture(); f.request.capBps = capBps; rebindPreparationIntent(f)
    editDecoded(f, 'policy', 'gate', 'Policy', p => { p.cap_bps = capBps })
    const p = buildMaxWalletLaunchReviewForFixture(f)
    assert.equal(p.policy.capBps, capBps); assert.notEqual(p.commitments.hookAccounts, baseline.commitments.hookAccounts)
    assert.equal(p.commitments.launchEconomics, baseline.commitments.launchEconomics); assert.equal(p.commitments.poolEconomics, baseline.commitments.poolEconomics)
    assert.notEqual(p.review.messageSha256, baseline.review.messageSha256)
  }
})
