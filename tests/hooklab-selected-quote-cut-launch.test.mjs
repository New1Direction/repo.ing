import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { BorshCoder } from '@anchor-lang/core'
import { Keypair } from '@solana/web3.js'
import { selectedHookPreparationRequestSchema, planSelectedHookPreparation, selectedHookConfigReserved } from '../src/hooklab-selected-hook-preparation.mjs'
import { deriveCustomPreparationRecord } from '../src/hooklab-custom-preparation-receipts.mjs'
import { compileSelectedHookLaunchReview, launchPreparationRequest, selectedHookLaunchInventory } from '../src/hooklab-max-wallet-launch.mjs'
import { deriveOpenLaunchPostconditions } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { fixture, sha, key, pk, connections } from './fixtures/selected-hook-preparation.mjs'
import { collectSelectedHookPreparationReview } from '../src/hooklab-selected-hook-preparation-collector.mjs'
import { selectedLaunchFixture } from './fixtures/selected-hook-launch.mjs'

const cut = { maxBuyBps: 321, maxSellBps: 87 }
function launchFixture({ creator, caps = cut, feeModel = 1 } = {}) {
  const f = selectedLaunchFixture({ feeModel }), { input, coders } = f
  input.request.quoteCut = caps; input.request.authorShareBps = 1234
  if (creator) { input.request.configAuthor = input.request.creator; input.request.creator = creator; input.request.feePayer = creator }
  for (const o of input.observations) {
    const a = o.accounts.find(a => a.address === input.request.selectedConfig).account
    const bytes = Buffer.from(a.dataBase64, 'base64'), v = coders.launch.accounts.decode('LaunchConfig', bytes)
    v.author_share_bps = 1234; v.reserved = selectedHookConfigReserved(input.request)
    coders.launch.types.encode('LaunchConfig', v).copy(bytes, 8); a.dataBase64 = bytes.toString('base64')
    input.preparationEvidence.preparedAccountHashes.selectedConfig = sha(bytes)
  }
  if (creator) {
    const accounts = new Map(input.observations[0].accounts.map(a => [a.address, a.account]))
    accounts.set(creator, { address: creator, owner: key(0), executable: false, lamports: '10000000000', dataBase64: '' })
    const { inventory } = selectedHookLaunchInventory(input.profile, input.request, f.configBytes, { accounts, hookPin: input.hookPin })
    input.observations = input.observations.map(o => ({ ...o, accounts: inventory.map(address => ({ address, account: accounts.get(address) ?? null })) }))
  }
  input.preparationEvidence.preparationIntentSha256 = sha(JSON.stringify(launchPreparationRequest(input.request)))
  return f
}
test('quote-cut request caps are asymmetric, bounded and optional without changing legacy parse', () => {
  const r = fixture().request
  assert.deepEqual(selectedHookPreparationRequestSchema.parse(r), r)
  assert.deepEqual(selectedHookPreparationRequestSchema.parse({ ...r, quoteCut: cut }).quoteCut, cut)
  for (const quoteCut of [{ maxBuyBps: 0, maxSellBps: 1 }, { maxBuyBps: 1001, maxSellBps: 1 }, { maxBuyBps: 1, maxSellBps: 1001 }, { ...cut, recipient: r.creator }]) assert.throws(() => selectedHookPreparationRequestSchema.parse({ ...r, quoteCut }))
})
test('config compiler uses additive cut ABI and receipts bind exact reserved bytes and author share', async () => {
  const f = fixture(), idl = JSON.parse(Buffer.from(f.profile.idls.launch, 'base64'))
  const base = idl.instructions.find(i => i.name === 'create_config')
  idl.types.push({ name: 'QuoteCut', type: { kind: 'struct', fields: [{ name: 'max_buy_bps', type: 'u16' }, { name: 'max_sell_bps', type: 'u16' }] } })
  idl.instructions.push({ ...structuredClone(base), name: 'create_quote_cut_config', discriminator: [...createHash('sha256').update('global:create_quote_cut_config').digest().subarray(0, 8)], args: [...base.args, { name: 'author_share_bps', type: 'u16' }, { name: 'cut', type: { defined: { name: 'QuoteCut' } } }] })
  const bytes = Buffer.from(JSON.stringify(idl)), p = JSON.parse(f.profile.json)
  p.idlSha256.launch = sha(bytes); f.profile.idls.launch = bytes.toString('base64'); f.profile.json = JSON.stringify(p); f.profile.expectedSha256 = sha(f.profile.json)
  Object.assign(f.request, { quoteCut: cut, authorShareBps: 1234 })
  const plan = planSelectedHookPreparation(f), coder = new BorshCoder(idl)
  const decoded = coder.instruction.decode(Buffer.from(plan.instructions[2].dataHex, 'hex'))
  assert.equal(decoded.name, 'create_quote_cut_config'); assert.deepEqual(decoded.data.cut, { max_buy_bps: 321, max_sell_bps: 87 }); assert.equal(decoded.data.author_share_bps, 1234)
  const record = deriveCustomPreparationRecord(f, f.profile.expectedSha256)
  const config = coder.accounts.decode('LaunchConfig', Buffer.from(record.expectedAccounts.selectedConfig.canonicalTemplateBase64, 'base64'))
  assert.equal(config.author_share_bps, 1234); assert.deepEqual(config.reserved, [0, 65, 1, 87, 0, ...Array(25).fill(0)])
  assert.deepEqual([...plan.review.requiredSigners].sort(), [f.request.creator, f.request.selectedConfig].sort())
  const collected = await collectSelectedHookPreparationReview({ ...f, connections: connections(f), clock: () => 1000 })
  assert.deepEqual(collected.preparationInput.request.quoteCut, cut)
  assert.equal(collected.plan.review.messageBase64, plan.review.messageBase64)
})
test('cut launch hash binds each cap and actual creator independently; model2 remains legacy-only', () => {
  const a = launchFixture(), b = launchFixture({ caps: { maxBuyBps: 87, maxSellBps: 321 } })
  const c = launchFixture({ creator: key(91) })
  const pa = compileSelectedHookLaunchReview(a.input), pb = compileSelectedHookLaunchReview(b.input)
  assert.notEqual(pa.commitments.launchEconomics, pb.commitments.launchEconomics)
  const pc = compileSelectedHookLaunchReview(c.input)
  assert.notEqual(pa.commitments.launchEconomics, pc.commitments.launchEconomics)
  const d = launchFixture({ creator: Keypair.fromSeed(Buffer.alloc(32,90)).publicKey.toBase58() })
  // Both launches have the same config author and the same effective author share:
  // only the new extension binds these two actual launch creators.
  assert.notEqual(pc.commitments.launchEconomics, compileSelectedHookLaunchReview(d.input).commitments.launchEconomics)
  assert.equal(launchPreparationRequest(c.input.request).creator, a.input.request.creator)
  assert.throws(() => compileSelectedHookLaunchReview(launchFixture({ feeModel: 2 }).input), /Inclusive launch/)
})
test('cut launch postconditions include exact caps, independent bumps and four ordered registry extras', () => {
  const f = launchFixture(), context = { schema: 'repoing/open-launch-settlement-context/1', compilationInput: f.input }
  const result = deriveOpenLaunchPostconditions(context, { slot: 110, timestamp: 1000 })
  const launch = f.coders.launch.accounts.decode('Launch', Buffer.from(result.accounts.find(a => a.address === f.addresses.launch).dataBase64, 'base64'))
  assert.deepEqual(launch.reserved.slice(0, 12), [65, 1, 87, 0, ...Array(8).fill(0)])
  assert.equal(launch.reserved[17], 1); assert.equal(launch.author_share_bps, 0)
  const announced = Buffer.from(result.events.find(e => e.name === 'LaunchQuoteCut').dataBase64, 'base64')
  assert.equal(announced.length, 124); assert.equal(announced.readUInt16LE(112), 321); assert.equal(announced.readUInt16LE(114), 87)
  const registry = Buffer.from(result.accounts.find(a => a.address === f.addresses.poolRegistry).dataBase64, 'base64')
  assert.equal(registry.readUInt32LE(9), 8)
  assert.ok(registry.includes(pk(f.input.request.selectedHook.program).toBuffer()))
})
test('third-party launch retains config author payout while burn-only rules stay bounded', () => {
  const f = launchFixture({ creator: key(91) })
  const result = deriveOpenLaunchPostconditions({ schema: 'repoing/open-launch-settlement-context/1', compilationInput: f.input }, { slot: 110, timestamp: 1000 })
  const launch = f.coders.launch.accounts.decode('Launch', Buffer.from(result.accounts.find(a => a.address === f.addresses.launch).dataBase64, 'base64'))
  assert.equal(launch.author_share_bps, 1234); assert.equal(launch.creator.toBase58(), key(91))
  const prep = fixture(); prep.request.rules = { burnBuyBps: 1, burnSellBps: 0 }
  assert.throws(() => planSelectedHookPreparation(prep), /burn bounds/)
})
