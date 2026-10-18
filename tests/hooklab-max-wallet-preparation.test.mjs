import assert from 'node:assert/strict'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { planMaxWalletPreparation, deriveMaxWalletPreparedAccounts, maxWalletPreparationRequestSchema } from '../src/hooklab-max-wallet-preparation.mjs'
import { maxWalletPreparationFixture, maxWalletRustVector, maxWalletSnapshot, maxWalletFrozenPins, sha, pk, pda } from './fixtures/hooklab-max-wallet-preparation.mjs'
import { missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const test = testRequiring(missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json']))
const both = (f, edit) => f.observations.forEach(edit)
function editConfig(f, edit) {
  const coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.launch, 'base64')))
  for (const o of f.observations) {
    const account = o.accounts[4].account, raw = Buffer.from(account.dataBase64, 'base64'), c = coder.accounts.decode('Config', raw); edit(c)
    const encoded = coder.types.encode('Config', c), bytes = Buffer.alloc(250); raw.subarray(0, 8).copy(bytes); encoded.copy(bytes, 8); account.dataBase64 = bytes.toString('base64')
  }
}
function tableFor(f) {
  const p = planMaxWalletPreparation(f), addresses = p.review.accounts.filter(a => !a.signer).map(a => a.address), bytes = Buffer.alloc(56 + addresses.length * 32)
  bytes.writeUInt32LE(1); bytes.writeBigUInt64LE(0xffffffffffffffffn, 4); bytes.writeBigUInt64LE(BigInt(f.observations[0].slot - 1), 12)
  addresses.forEach((address, i) => pk(address).toBuffer().copy(bytes, 56 + i * 32))
  f.lookupTable = { address: pk(Buffer.alloc(32, 211)).toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: bytes.toString('base64'), sha256: sha(bytes) }
  return bytes
}

test('exact max-wallet preparation bytes and canonical metas match frozen executed Rust vector', () => {
  const f = maxWalletPreparationFixture(), v = maxWalletRustVector(), p = planMaxWalletPreparation(f)
  assert.equal(sha(f.profile.json), maxWalletFrozenPins.profileSha256)
  assert.equal(JSON.parse(f.profile.json).sourcePatchSha256, maxWalletFrozenPins.sourcePatchSha256)
  assert.deepEqual(p.instructions.slice(2), v.preparation.instructions.map(i => ({ program: i.programId, dataHex: i.dataHex,
    accounts: i.keys.map(k => ({ address: k.pubkey, signer: k.isSigner, writable: k.isWritable })) })))
  assert.deepEqual(p.rentAccountSizes, { policy: 85, registry: 81, selectedConfig: 176 })
  assert.equal(p.policy.initialSupply, v.request.initialSupply); assert.equal(p.policy.capBps, v.request.capBps)
  assert.equal(p.policy.quoteMint, v.request.quoteMint); assert.equal(p.policy.lpFeeBps, v.request.lpFeeBps)
  assert.equal(p.policy.capRaw, String(BigInt(v.request.initialSupply) * BigInt(v.request.capBps) / 10000n))
  assert.equal(p.policy.endsAt, 'authenticated-graduation'); assert.equal(p.policy.poolExemption, 'canonical-pool-only')
  assert.deepEqual(new Set(p.review.requiredSigners), new Set([f.request.creator, f.request.mint, f.request.selectedConfig]))
  assert.equal(p.instructions[2].accounts[1].signer, true); assert.equal(p.instructions[2].accounts[1].writable, false)
  assert.deepEqual(p.instructions[3].accounts.at(-1), { address: p.addresses.gateProgramData, signer: false, writable: false })
  assert.equal(f.observations[0].accounts.at(-1).address, p.addresses.canonicalLaunch); assert.equal(f.observations[0].accounts.at(-1).account, null)
  const m = VersionedMessage.deserialize(Buffer.from(p.review.messageBase64, 'base64'))
  assert.equal(m.version, 0); assert.equal(m.compiledInstructions.length, 4); assert.ok(new VersionedTransaction(m).serialize().length <= 1232)
  for (const name of ['preparationReceiptAccepted', 'artifactAdopted', 'deploymentAdopted', 'policyApproved', 'executionAuthorized', 'publicExecutionEnabled', 'ownerApprovalVerified', 'rentCapEnforcedOnchain', 'feeEvidenceAuthenticated', 'canSign', 'canSubmit', 'canRetry']) assert.equal(p[name], false)
  assert.equal(p.launchPlan, null); assert.deepEqual(planMaxWalletPreparation(f), p)
})

for (const [label, change, pattern] of [
  ['missing cap has no default', f => { delete f.request.capBps }, /Invalid/],
  ['zero cap', f => { f.request.capBps = 0 }, /1/],
  ['uncapped 10000 basis points', f => { f.request.capBps = 10000 }, /9999/],
  ['fractional cap', f => { f.request.capBps = 100.5 }, /int/],
  ['string cap', f => { f.request.capBps = '100' }, /number/],
  ['missing policy discriminant', f => { delete f.request.policyKind }, /max-wallet/],
  ['unknown policy discriminant', f => { f.request.policyKind = 'blocked-owner' }, /max-wallet/],
  ['unknown policy version', f => { f.request.policyVersion = 2 }, /1/],
  ['creator supplied initial supply', f => { f.request.initialSupply = '100' }, /unrecognized/i],
  ['creator supplied quote mint', f => { f.request.quoteMint = f.request.creator }, /unrecognized/i],
  ['creator supplied LP fee', f => { f.request.lpFeeBps = 30 }, /unrecognized/i],
  ['arbitrary blocked owner', f => { f.request.blockedOwner = f.request.creator }, /unrecognized/i],
  ['arbitrary hook rules', f => { f.request.rules = 'max-wallet' }, /none/],
  ['nonzero creator fee', f => { f.request.creatorFeeBps = 1 }, /0/],
  ['wrong hook flags', f => { f.request.hookFlags = 2 }, /1/],
  ['extra input field', f => { f.approved = true }, /unrecognized/i],
  ['oversized UTF8 label', f => { f.request.label = '界'.repeat(11) }, /Invalid/],
  ['profile digest changed', f => { f.profile.json += ' ' }, /digest differs/],
  ['wrong profile policy', f => { const p = JSON.parse(f.profile.json); p.capability.kind = 'immutable-canonical-single-blocked-owner'; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) }, /immutable-initial/],
  ['profile claims adoption', f => { const p = JSON.parse(f.profile.json); p.artifactAdopted = true; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) }, /false/],
  ['candidate patch absent', f => { const p = JSON.parse(f.profile.json); p.sourcePatchSha256 = null; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) }, /string/],
  ['gate IDL bytes changed', f => { f.profile.idls.gate = Buffer.from('{}').toString('base64') }, /IDL digest/],
  ['mutable gate', f => both(f, o => { const b = Buffer.from(o.accounts[3].account.dataBase64, 'base64'); b[12] = 1; o.accounts[3].account.dataBase64 = b.toString('base64') }), /ProgramData state/],
  ['wrong gate ELF', f => both(f, o => { const b = Buffer.from(o.accounts[3].account.dataBase64, 'base64'); b[100] ^= 1; o.accounts[3].account.dataBase64 = b.toString('base64') }), /ELF/],
  ['wrong config bump', f => editConfig(f, c => { c.bump ^= 1 }), /layout/],
  ['unknown config version', f => editConfig(f, c => { c.version = 2 }), /layout/],
  ['nonzero config reserved', f => editConfig(f, c => { c.reserved[63] = 1 }), /layout/],
  ['quote differs from reviewed profile', f => editConfig(f, c => { c.quote_mint = pk(f.request.creator) }), /economics/],
  ['zero initial supply', f => editConfig(f, c => { c.supply = new BN(0) }), /rounded cap/],
  ['cap rounds to zero', f => { f.request.capBps = 1; editConfig(f, c => { c.supply = new BN(9999) }) }, /rounded cap/],
  ['LP fee at 10000', f => editConfig(f, c => { c.lp_fee_bps = 10000 }), /economics/],
  ['already prepared policy', f => both(f, o => { o.accounts[5].account = { ...o.accounts[9].account, address: o.accounts[5].address } }), /already exists/],
  ['Launch already exists', f => both(f, o => { o.accounts[11].account = { ...o.accounts[9].account, address: o.accounts[11].address } }), /already exists/],
  ['missing absent Launch evidence', f => both(f, o => { o.accounts.pop() }), /12/],
  ['provider disagreement', f => { f.observations[1].accounts[0].account.lamports = '1' }, /disagree/],
  ['unbound provider', f => { f.observations[1].provider = 'attacker' }, /binding/],
  ['same-payer evidence mismatch', f => both(f, o => { o.accounts[10].account.lamports = '9' }), /Repeated payer/],
  ['insufficient creator funds', f => both(f, o => { o.accounts[9].account.lamports = '0'; o.accounts[10].account.lamports = '0' }), /funds insufficient/],
  ['rent above cap', f => { f.limits.maxRentLamports = '0' }, /cap exceeded/],
  ['network above cap', f => { f.limits.maxNetworkFeeLamports = '14999' }, /cap exceeded/],
  ['total debit above cap', f => { f.limits.maxTotalDebitLamports = '0' }, /cap exceeded/],
  ['missing rent quote', f => { f.observations.forEach(o => { o.rentExemptionLamports.policy = '0' }) }, /cap exceeded/],
  ['underquoted signature fee', f => { f.recentBlockhash.networkFeeLamports = '10000' }, /signature fee basis/],
  ['invalid blockhash', f => { f.recentBlockhash.blockhashValid = false }, /true/],
  ['expired block height', f => { f.recentBlockhash.currentBlockHeight = f.recentBlockhash.lastValidBlockHeight + 1 }, /lifetime/],
  ['stale observation', f => { f.limits.nowMs = 7000 }, /Stale/],
  ['wrong chain', f => { f.observations[0].genesisHash = f.request.creator }, /wrong-chain/],
  ['unbounded deadline', f => { f.limits.validUntilSlot = f.observations[0].slot + 151 }, /lifetime/],
  ['mint aliases selected config', f => { f.request.mint = f.request.selectedConfig }, /alias/],
  ['signer aliases token program', f => { f.request.mint = JSON.parse(f.profile.json).programs.token }, /alias/],
]) test(label, () => { const f = maxWalletPreparationFixture(); change(f); assert.throws(() => planMaxWalletPreparation(f), pattern) })

test('only explicit cap changes policy bytes; observed launch economics are derived with u64-safe integer math', () => {
  const base = planMaxWalletPreparation(maxWalletPreparationFixture())
  for (const cap of [1, 9999]) {
    const f = maxWalletPreparationFixture(); f.request.capBps = cap
    editConfig(f, c => { c.supply = new BN('18446744073709551615') })
    const p = planMaxWalletPreparation(f)
    assert.equal(p.policy.capRaw, String(18446744073709551615n * BigInt(cap) / 10000n))
    assert.notEqual(p.instructions[2].dataHex, base.instructions[2].dataHex)
    assert.equal(p.instructions[3].dataHex, base.instructions[3].dataHex)
  }
})

test('resolved ALT permits identical instructions, bounded canonical table state and exact signature fee', () => {
  const f = maxWalletPreparationFixture(), baseline = planMaxWalletPreparation(f), raw = tableFor(f)
  const p = planMaxWalletPreparation(f); assert.deepEqual(p.instructions, baseline.instructions)
  assert.ok(Buffer.from(p.review.messageBase64, 'base64').length < Buffer.from(baseline.review.messageBase64, 'base64').length)
  const mutations = [b => { b[21] = 2 }, b => { b[55] = 1 }, b => { b.subarray(56, 88).copy(b, 88) },
    b => b.writeBigUInt64LE(BigInt(f.observations[0].slot), 12), b => b.writeBigUInt64LE(1n, 4)]
  for (const mutate of mutations) { const changed = structuredClone(f), b = Buffer.from(raw); mutate(b); changed.lookupTable.dataBase64 = b.toString('base64'); changed.lookupTable.sha256 = sha(b); assert.throws(() => planMaxWalletPreparation(changed), /Lookup table/) }
  const alias = structuredClone(f); alias.lookupTable.address = baseline.addresses.canonicalLaunch; assert.throws(() => planMaxWalletPreparation(alias), /aliases/)
  const priority = maxWalletPreparationFixture(); priority.limits.computeUnitPriceMicroLamports = '1'; priority.recentBlockhash.networkFeeLamports = '15001'; priority.limits.maxNetworkFeeLamports = '15001'; priority.limits.maxTotalDebitLamports = String(BigInt(priority.limits.maxTotalDebitLamports) + 1n)
  assert.equal(planMaxWalletPreparation(priority).review.baseFeeLamports, '15000')
})

test('separate fee payer adds exactly one external signature without changing instructions', () => {
  const f = maxWalletPreparationFixture(), baseline = planMaxWalletPreparation(f), address = 'HV86MkNHfzYzoQdT13dbGmtq2kxcjAs5vdVwDEKohL8q'
  f.request.feePayer = address
  both(f, o => { o.accounts[10] = { address, account: { ...o.accounts[9].account, address } } })
  f.recentBlockhash.networkFeeLamports = '20000'; f.limits.maxNetworkFeeLamports = '20000'; f.limits.maxTotalDebitLamports = String(BigInt(f.limits.maxTotalDebitLamports) + 5000n)
  const p = planMaxWalletPreparation(f); assert.equal(p.review.requiredSigners.length, 4); assert.deepEqual(p.instructions, baseline.instructions)
})

test('exact expected prepared bytes require explicit observed selectedConfig timestamp and match SBF post-state', () => {
  const f = maxWalletPreparationFixture(), post = new Map(maxWalletSnapshot('launch').map(a => [a.address, a.account])), coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.launch, 'base64')))
  const selected = coder.accounts.decode('LaunchConfig', Buffer.from(post.get(f.request.selectedConfig).dataBase64, 'base64'))
  const args = { profile: { json: f.profile.json, expectedSha256: f.profile.expectedSha256, idls: f.profile.idls }, request: f.request,
    launchConfig: f.observations[0].accounts[4].account, observedCreatedAtUnixSeconds: selected.created_at.toString(10) }
  const result = deriveMaxWalletPreparedAccounts(args)
  for (const a of Object.values(result.accounts)) { assert.equal(a.dataBase64, post.get(a.address).dataBase64); assert.equal(a.owner, post.get(a.address).owner); assert.equal(a.sha256, sha(Buffer.from(a.dataBase64, 'base64'))) }
  assert.equal(result.expectedAbsent.length, 1); assert.equal(post.get(result.expectedAbsent[0]), null)
  assert.equal(result.historicalStateVerified, false); assert.equal(result.timestampAuthenticated, false); assert.equal(result.preparationReceiptAccepted, false)
  for (const value of [undefined, null, 1, '9223372036854775808', '-9223372036854775809', '01']) assert.throws(() => deriveMaxWalletPreparedAccounts({ ...args, observedCreatedAtUnixSeconds: value }))
  const changed = deriveMaxWalletPreparedAccounts({ ...args, observedCreatedAtUnixSeconds: String(BigInt(args.observedCreatedAtUnixSeconds) + 1n) })
  assert.notEqual(changed.accounts.selectedConfig.dataBase64, result.accounts.selectedConfig.dataBase64)
  assert.deepEqual(changed.accounts.policy, result.accounts.policy); assert.deepEqual(changed.accounts.registry, result.accounts.registry)
})
