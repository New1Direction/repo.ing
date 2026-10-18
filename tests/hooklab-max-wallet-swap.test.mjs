import assert from 'node:assert/strict'
import { generatedMaxWalletArtifact, missingGeneratedArtifacts, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { PublicKey, VersionedMessage, VersionedTransaction } from '@solana/web3.js'
import { buildMaxWalletSwapReview, buildMaxWalletSwapReviewForFixture, maxWalletSwapInventory } from '../src/hooklab-max-wallet-swap.mjs'
import { maxWalletSwapFixture, maxWalletSwapRustVector } from './fixtures/hooklab-max-wallet-swap.mjs'
import { sha, pk } from './fixtures/hooklab-max-wallet-preparation.mjs'
// Every case needs private generated artifacts; without them each skips with the reason below.
const artifacts = missingGeneratedArtifacts(['hooklab-max-wallet-rust-vector.json', 'hooklab-max-wallet-buy-rust-vector.json', 'hooklab-max-wallet-sell-rust-vector.json', 'hooklab-max-wallet-buy-app-plan.json', 'hooklab-max-wallet-sell-app-plan.json'])
const test = testRequiring(artifacts)
// Built only when the private vector is present; otherwise every case is skipped and these stay null.
const fixture = artifacts ? null : maxWalletSwapFixture(), baseline = fixture && buildMaxWalletSwapReviewForFixture(fixture)
const names = fixture && { ...baseline.addresses, selectedConfig: fixture.request.selectedConfig, trader: fixture.request.trader, mint: fixture.request.mint, quoteMint: JSON.parse(fixture.profile.json).quoteMint }
const entry = (f, name) => f.observations[0].accounts.find(a => a.address === (names[name] ?? name))
function editAccount(f, name, edit) { const item = entry(f, name); edit(item.account, item); f.observations[1].accounts = structuredClone(f.observations[0].accounts) }
function editBytes(f, name, edit) { editAccount(f, name, a => { const bytes = Buffer.from(a.dataBase64, 'base64'); edit(bytes); a.dataBase64 = bytes.toString('base64') }) }
function editDecoded(f, name, role, type, edit) {
  const coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls[role], 'base64')))
  editAccount(f, name, a => { const bytes = Buffer.from(a.dataBase64, 'base64'), value = coder.types.decode(type, bytes.subarray(8)); edit(value)
    const next = Buffer.alloc(bytes.length); bytes.subarray(0, 8).copy(next); coder.types.encode(type, value).copy(next, 8); a.dataBase64 = next.toString('base64') })
}
const ix = i => ({ program: i.programId, dataHex: i.dataHex, accounts: i.keys.map(k => ({ address: k.pubkey, signer: k.isSigner, writable: k.isWritable })) })

for (const side of ['buy', 'sell']) test(`${side} exact unsigned bytes, all23declared metas and independent constant-product quote match actual Rust state`, () => {
  const f = maxWalletSwapFixture(side), v = maxWalletSwapRustVector(side), p = buildMaxWalletSwapReviewForFixture(f)
  assert.deepEqual(p.canonicalInstruction, ix(v.quote.instruction)); assert.equal(p.quote.delivered, v.quote.delivered); assert.equal(p.quote.minAmountOut, v.quote.minAmountOut)
  assert.equal(p.canonicalInstruction.accounts.length, 23); assert.equal(p.instructions.length, 3)
  assert.equal(p.canonicalInstruction.accounts[18].address, p.addresses.launch); assert.equal(p.canonicalInstruction.accounts[18].writable, false)
  assert.equal(p.instructions[2].accounts[18].writable, true); assert.equal(p.instructions[2].accounts[0].writable, true)
  assert.deepEqual(p.review.accounts.find(a => a.address === p.addresses.policy), { address: p.addresses.policy, writable: false, signer: false })
  const message = VersionedMessage.deserialize(Buffer.from(p.review.messageBase64, 'base64'))
  assert.equal(message.version, 0); assert.equal(message.compiledInstructions.length, 3); assert.ok(new VersionedTransaction(message).serialize().length <= 1232)
  assert.deepEqual(p.review.requiredSigners, [f.request.trader]); assert.equal(p.review.instructionDebitLamports, '0')
  assert.equal(p.onchainExactInputAndMinimumOutput, true); assert.equal(p.onchainDeadlineEnforced, false); assert.equal(p.onchainEconomicsGuard, false)
  for (const flag of ['artifactAdopted', 'deploymentAdopted', 'policyApproved', 'executionAuthorized', 'publicExecutionEnabled', 'feeEvidenceAuthenticated', 'dependencyCodeAuthenticated', 'canSign', 'canSubmit', 'canRetry']) assert.equal(p[flag], false)
  assert.equal(p.productionReceipt, null); assert.match(p.provenance, /not-rpc-evidence/); assert.deepEqual(buildMaxWalletSwapReviewForFixture(f), p)
  assert.deepEqual(JSON.parse(readFileSync(generatedMaxWalletArtifact(`hooklab-max-wallet-${side}-app-plan.json`,new URL('./fixtures/helper.mjs',import.meta.url)))), p)
})

test('buy post-state arithmetic equals the actual SBF snapshot used for the subsequent sell quote', () => {
  const p = baseline, f = maxWalletSwapFixture('sell'), coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.swap, 'base64')))
  const pool = coder.accounts.decode('Pool', Buffer.from(entry(f, 'pool').account.dataBase64, 'base64'))
  assert.equal(p.quote.after.baseReserve, pool.base_reserve.toString()); assert.equal(p.quote.after.quoteReserve, pool.quote_reserve.toString())
  assert.equal(p.quote.after.swapCount, pool.swap_count.toString())
  for (const name of ['traderBase', 'traderQuote']) assert.equal(p.quote.after[name], Buffer.from(entry(f, name).account.dataBase64, 'base64').readBigUInt64LE(74).toString())
})

test('production export refuses every caller receipt and fixture without producing a message', () => {
  for (const input of [undefined, {}, fixture, { productionReceipt: { accepted: true } }, { resolveTrustedRecord: () => fixture }, { signed: true, finalized: true }]) {
    assert.throws(() => buildMaxWalletSwapReview(input), e => e.code === 'MAX_WALLET_SWAP_PROOF_UNAVAILABLE')
  }
})

for (const [label, mutate, pattern] of [
  ['missing explicit cap', f => { delete f.request.capBps }, /Invalid/],
  ['cap zero', f => { f.request.capBps = 0 }, /1/],
  ['cap 10000', f => { f.request.capBps = 10000 }, /9999/],
  ['old policy kind', f => { f.request.policyKind = 'blocked-owner' }, /max-wallet/],
  ['missing policy version', f => { delete f.request.policyVersion }, /1/],
  ['unknown policy version', f => { f.request.policyVersion = 2 }, /1/],
  ['unknown input field', f => { f.force = true }, /unrecognized/i],
  ['arbitrary instructions', f => { f.instructions = [] }, /unrecognized/i],
  ['arbitrary hook accounts', f => { f.request.hookAccounts = [] }, /unrecognized/i],
  ['creator selected fees', f => { f.request.lpFeeBps = 0 }, /unrecognized/i],
  ['non-synthetic provenance', f => { f.provenance = 'finalized-rpc' }, /synthetic/],
  ['amount zero', f => { f.request.amountIn = '0' }, /Invalid/],
  ['minimum zero', f => { f.request.minAmountOut = '0' }, /Invalid/],
  ['amount leading zero', f => { f.request.amountIn = '01' }, /Invalid/],
  ['amount outside u64', f => { f.request.amountIn = '18446744073709551616' }, /Invalid/],
  ['number amount', f => { f.request.amountIn = 100 }, /string/],
  ['unbounded impact', f => { f.request.maxPriceImpactBps = 1001 }, /1000/],
  ['amount above maxInput', f => { f.request.maxInput = '1' }, /explicit cap/],
  ['amount above source holding', f => { f.request.amountIn = f.request.maxInput = '20000000001' }, /source holding/],
  ['minimum above delivery', f => { f.request.minAmountOut = String(BigInt(baseline.quote.delivered) + 1n) }, /Minimum output/],
  ['price impact above bound', f => { f.request.maxPriceImpactBps = 9 }, /Price impact/],
  ['predicted cap breach', f => { f.request.amountIn = f.request.maxInput = '10000000'; f.request.minAmountOut = '1' }, /cap would be exceeded/],
  ['profile digest mismatch', f => { f.profile.json += ' ' }, /profile digest/],
  ['old capability in profile', f => { const p = JSON.parse(f.profile.json); p.capability.kind = 'immutable-canonical-single-blocked-owner'; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) }, /immutable-initial/],
  ['profile claims approval', f => { const p = JSON.parse(f.profile.json); p.ownerApprovalVerified = true; f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json) }, /false/],
  ['IDL mutation', f => { f.profile.idls.swap = Buffer.from('{}').toString('base64') }, /IDL digest/],
  ['wrong ELF length', f => { f.profile.elfLengths.gate++ }, /ProgramData|ELF/],
  ['provider divergence', f => { f.observations[1].accounts[0].account.lamports = '1' }, /disagree/],
  ['duplicate provider', f => { f.observations[1].provider = f.observations[0].provider }, /binding/],
  ['unbound provider', f => { f.observations[1].provider = 'attacker' }, /binding/],
  ['stale snapshot', f => { f.limits.nowMs = 7000 }, /Stale/],
  ['future snapshot', f => { f.observations[0].observedAtMs++ }, /Stale/],
  ['wrong chain', f => { f.observations[0].genesisHash = f.request.trader }, /wrong-chain/],
  ['missing observed account', f => { f.observations.forEach(o => o.accounts.pop()) }, /inventory/],
  ['extra observed account', f => { f.observations.forEach(o => o.accounts.push({ address: pk(Buffer.alloc(32, 202)).toBase58(), account: null })) }, /inventory/],
  ['duplicate observed account', f => { f.observations.forEach(o => o.accounts.push(o.accounts[0])) }, /inventory/],
  ['account address mismatch', f => editAccount(f, 'pool', a => { a.address = f.request.mint }), /identity/],
  ['initialized Kit config', f => editAccount(f, 'kitConfig', (_a, item) => { item.account = { ...entry(f, 'trader').account, address: item.address } }), /No-Kit/],
  ['initialized holder vault', f => editAccount(f, 'holderVault', (_a, item) => { item.account = { ...entry(f, 'trader').account, address: item.address } }), /No-Kit/],
  ['mutable gate', f => editBytes(f, 'gateProgramData', b => { b[12] = 1 }), /immutable gate/],
  ['modified launch ELF', f => editBytes(f, 'launchProgramData', b => { b[100] ^= 1 }), /Program ELF/],
  ['trader is not empty system', f => editAccount(f, 'trader', a => { a.owner = JSON.parse(f.profile.json).programs.token }), /empty system/],
  ['insufficient network funds', f => editAccount(f, 'trader', a => { a.lamports = '4999' }), /funds insufficient/],
  ['swap paused', f => editDecoded(f, 'swapConfig', 'swap', 'Config', c => { c.paused = true }), /trading pause/],
  ['nonzero configured LP fee', f => editDecoded(f, 'launchConfig', 'launch', 'Config', c => { c.lp_fee_bps = 1 }), /zero-fee/],
  ['nonzero configured protocol fee', f => editDecoded(f, 'swapConfig', 'swap', 'Config', c => { c.protocol_fee_bps = 1 }), /zero-fee/],
  ['nonzero configured protocol share', f => editDecoded(f, 'swapConfig', 'swap', 'Config', c => { c.launch_protocol_share_bps = 1 }), /zero-fee/],
  ['configured sniper window', f => editDecoded(f, 'launchConfig', 'launch', 'Config', c => { c.sniper_window_secs = new BN(1) }), /zero-fee/],
  ['governance trading gate', f => editDecoded(f, 'swapGovernance', 'swap', 'Governance', g => { g.state.gates.trading = true }), /Governance identity/],
  ['governance mismatched digest', f => editDecoded(f, 'launchGovernance', 'launch', 'Governance', g => { g.state.config_digest[0] ^= 1 }), /Governance economics/],
  ['governance wrong admin', f => editDecoded(f, 'launchGovernance', 'launch', 'Governance', g => { g.state.roles.admin = pk(f.request.trader) }), /Governance identity/],
  ['policy cap mismatch', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.cap_bps++ }), /policy binding/],
  ['policy quote mismatch', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.quote_mint = pk(f.request.trader) }), /policy binding/],
  ['policy wrong version', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.version = 2 }), /policy binding/],
  ['policy zero supply', f => editDecoded(f, 'policy', 'gate', 'Policy', p => { p.initial_supply = new BN(0) }), /policy binding/],
  ['registry writable policy', f => editBytes(f, 'registry', b => { b[13] = 1 }), /registry/],
  ['registry writable Launch', f => editBytes(f, 'registry', b => { b[47] = 1 }), /registry/],
  ['registry Launch literal spoof', f => editBytes(f, 'registry', b => { b[80] ^= 1 }), /registry/],
  ['selected fee widened', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', c => { c.creator_fee_bps = 1 }), /no-rules/],
  ['selected rules widened', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', c => { c.rules.max_wallet_bps = 1 }), /no-rules/],
  ['selected hook timelock', f => editDecoded(f, 'selectedConfig', 'launch', 'LaunchConfig', c => { c.reserved[0] = 1 }), /no-rules/],
  ['Launch graduated', f => editDecoded(f, 'launch', 'launch', 'Launch', c => { c.status = 1 }), /pre-graduation/],
  ['Launch wrong version', f => editDecoded(f, 'launch', 'launch', 'Launch', c => { c.version = 2 }), /pre-graduation/],
  ['Launch pool spoof', f => editDecoded(f, 'launch', 'launch', 'Launch', c => { c.pool = pk(f.request.trader) }), /pre-graduation/],
  ['Launch hook widened', f => editDecoded(f, 'launch', 'launch', 'Launch', c => { c.custom_hook_flags = 3 }), /pre-graduation/],
  ['Launch module widened', f => editDecoded(f, 'launch', 'launch', 'Launch', c => { c.modules = 1 }), /pre-graduation/],
  ['Launch lock widened', f => editDecoded(f, 'launch', 'launch', 'Launch', c => { c.creator_unlock_at = new BN(1) }), /pre-graduation/],
  ['pool LP fee changed', f => editDecoded(f, 'pool', 'swap', 'Pool', p => { p.lp_fee_bps = 1 }), /zero-fee curve/],
  ['pool protocol fee changed', f => editDecoded(f, 'pool', 'swap', 'Pool', p => { p.protocol_fee_bps = 1 }), /zero-fee curve/],
  ['pool protocol share changed', f => editDecoded(f, 'pool', 'swap', 'Pool', p => { p.protocol_share_bps = 1 }), /zero-fee curve/],
  ['pool hook changed', f => editDecoded(f, 'pool', 'swap', 'Pool', p => { p.hook_program = pk(f.request.trader) }), /zero-fee curve/],
  ['pool virtual reserves changed', f => editDecoded(f, 'pool', 'swap', 'Pool', p => { p.virtual_base = p.virtual_base.addn(1) }), /zero-fee curve/],
  ['pool no longer curve', f => editDecoded(f, 'pool', 'swap', 'Pool', p => { p.curve = false }), /zero-fee curve/],
  ['base mint authority restored', f => editDecoded(f, 'mint', 'gate', 'Mint', m => { m.mint_authority = pk(f.request.trader) }), /immutable max-wallet/],
  ['base max supply changed', f => editDecoded(f, 'mint', 'gate', 'Mint', m => { m.max_supply = m.max_supply.addn(1) }), /immutable max-wallet/],
  ['base active reserved changed', f => editDecoded(f, 'mint', 'gate', 'Mint', m => { m.reserved[0] = 1 }), /immutable max-wallet/],
  ['quote hooked', f => editDecoded(f, 'quoteMint', 'gate', 'Mint', m => { m.hook_program = pk(f.request.trader) }), /Quote mint/],
  ['LP mint authority spoof', f => editDecoded(f, 'lpMint', 'gate', 'Mint', m => { m.mint_authority = pk(f.request.trader) }), /LP mint/],
  ['wrong holding owner', f => editBytes(f, 'traderBase', b => { b[42] ^= 1 }), /holding/],
  ['holding delegate', f => editBytes(f, 'traderQuote', b => { b[82] = 1 }), /holding/],
  ['holding frozen', f => editBytes(f, 'traderBase', b => { b[91] = 1 }), /holding/],
  ['holding hook data changed', f => editBytes(f, 'baseVault', b => { b[92] = 1 }), /holding/],
  ['vault reserve mismatch', f => editBytes(f, 'baseVault', b => { b.writeBigUInt64LE(b.readBigUInt64LE(74) - 1n, 74) }), /reserve balances/],
  ['pool registry spoof', f => editBytes(f, 'poolRegistry', b => { b[b.length - 1] ^= 1 }), /callback bindings/],
  ['invalid blockhash', f => { f.recentBlockhash.blockhashValid = false }, /true/],
  ['old blockhash observation', f => { f.recentBlockhash.observedSlot-- }, /lifetime/],
  ['expired block height', f => { f.recentBlockhash.currentBlockHeight = f.recentBlockhash.lastValidBlockHeight + 1 }, /lifetime/],
  ['unbounded block height', f => { f.recentBlockhash.lastValidBlockHeight++ }, /lifetime/],
  ['unbound blockhash provider', f => { f.recentBlockhash.providers = ['a', 'b'] }, /lifetime/],
  ['expired review', f => { f.limits.reviewExpiresAtMs = f.limits.nowMs }, /lifetime/],
  ['unbounded offchain lifetime', f => { f.limits.validUntilSlot = f.observations[0].slot + 151 }, /lifetime/],
  ['underquoted signature fee', f => { f.recentBlockhash.networkFeeLamports = '4999' }, /signature fee basis/],
  ['network fee above cap', f => { f.limits.maxNetworkFeeLamports = '4999' }, /fee\/debit/],
  ['total debit above cap', f => { f.limits.maxTotalDebitLamports = '4999' }, /fee\/debit/],
]) test(label, () => { const f = maxWalletSwapFixture(); mutate(f); assert.throws(() => buildMaxWalletSwapReviewForFixture(f), pattern) })

test('revoked Mint authority leaves a legitimate ignored allocation suffix; active prefix remains strict', () => {
  const f = maxWalletSwapFixture(), coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.gate, 'base64'))), bytes = Buffer.from(entry(f, 'mint').account.dataBase64, 'base64')
  const m = coder.types.decode('Mint', bytes.subarray(8)), length = coder.types.encode('Mint', m).length + 8
  assert.ok(bytes.subarray(length).some(v => v !== 0))
  editBytes(f, 'mint', b => { b[b.length - 1] ^= 1 })
  assert.deepEqual(buildMaxWalletSwapReviewForFixture(f).quote, baseline.quote)
})

test('changing explicit minimum regenerates ordinary SwapArgs bytes, without a fictional deadline guard', () => {
  const f = maxWalletSwapFixture(); f.request.minAmountOut = '1'
  const p = buildMaxWalletSwapReviewForFixture(f)
  assert.notEqual(p.canonicalInstruction.dataHex, baseline.canonicalInstruction.dataHex); assert.equal(p.quote.delivered, baseline.quote.delivered)
  assert.equal(p.onchainDeadlineEnforced, false); assert.equal(p.onchainEconomicsGuard, false)
})

test('exact signature fee basis includes separate fee payer and rounded compute priority', () => {
  const f = maxWalletSwapFixture(), address = 'HV86MkNHfzYzoQdT13dbGmtq2kxcjAs5vdVwDEKohL8q'
  f.request.feePayer = address; f.observations.forEach(o => o.accounts.push({ address, account: { ...entry(f, 'trader').account, address } }))
  f.recentBlockhash.networkFeeLamports = '10001'; f.limits.maxNetworkFeeLamports = '10001'; f.limits.maxTotalDebitLamports = '10001'; f.limits.computeUnitPriceMicroLamports = '1'
  const p = buildMaxWalletSwapReviewForFixture(f)
  assert.deepEqual(new Set(p.review.requiredSigners), new Set([f.request.trader, address])); assert.equal(p.review.baseFeeLamports, '10000')
  assert.deepEqual(p.canonicalInstruction, baseline.canonicalInstruction)
})

test('exact unsigned ALT retains instructions and refuses cold, altered, duplicate or noncanonical state', () => {
  const f = maxWalletSwapFixture(), addresses = baseline.review.accounts.filter(a => !a.signer).map(a => a.address), bytes = Buffer.alloc(56 + 32 * addresses.length)
  bytes.writeUInt32LE(1); bytes.writeBigUInt64LE(0xffffffffffffffffn, 4); bytes.writeBigUInt64LE(BigInt(f.observations[0].slot - 1), 12)
  addresses.forEach((a, i) => pk(a).toBuffer().copy(bytes, 56 + i * 32))
  f.lookupTable = { address: pk(Buffer.alloc(32, 211)).toBase58(), owner: 'AddressLookupTab1e1111111111111111111111111', dataBase64: bytes.toString('base64'), sha256: sha(bytes) }
  assert.deepEqual(buildMaxWalletSwapReviewForFixture(f).instructions, baseline.instructions)
  for (const mutate of [b => { b[21] = 2 }, b => { b[55] = 1 }, b => { b.subarray(56, 88).copy(b, 88) }, b => b.writeBigUInt64LE(BigInt(f.observations[0].slot), 12), b => b.writeBigUInt64LE(1n, 4)]) {
    const changed = structuredClone(f), b = Buffer.from(bytes); mutate(b); changed.lookupTable.dataBase64 = b.toString('base64'); changed.lookupTable.sha256 = sha(b)
    assert.throws(() => buildMaxWalletSwapReviewForFixture(changed), /Lookup table/)
  }
})
