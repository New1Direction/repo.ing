import test from 'node:test'
import assert from 'node:assert/strict'
import { BorshCoder } from '@anchor-lang/core'
import { selectedHookPreparationRequestSchema, planSelectedHookPreparation } from '../src/hooklab-selected-hook-preparation.mjs'
import { collectSelectedHookPreparationReview, selectedHookPreparationInventory } from '../src/hooklab-selected-hook-preparation-collector.mjs'
import { fixture, connections, sha } from './fixtures/selected-hook-preparation.mjs'

test('strict selected-hook request has no setup instructions or max-wallet interpretation', () => {
  const r = fixture().request
  assert.deepEqual(selectedHookPreparationRequestSchema.parse(r), r)
  assert.equal(selectedHookPreparationRequestSchema.parse({ ...r, feeModel: 1 }).feeModel, 1)
  for (const change of [{ capBps: 100 }, { hookFlags: 1 }, { rules: 'max-wallet' }, { feeModel: 0 }, { creatorFeeBps: 10000 }, { label: '😀'.repeat(9) }, { instructions: [] }, { policyVersion: 1 }]) assert.throws(() => selectedHookPreparationRequestSchema.parse({ ...r, ...change }))
})
test('config-only candidate uses asymmetric IDs, exactly two signers and existing registry commitment', () => {
  const f = fixture(), p = planSelectedHookPreparation(f)
  assert.deepEqual(selectedHookPreparationInventory(JSON.parse(f.profile.json), f.request), f.observations[0].accounts.map(a => a.address))
  assert.equal(p.review.operation, 'selected-hook-preparation'); assert.equal(p.instructions.length, 3)
  assert.deepEqual(new Set(p.review.requiredSigners), new Set([f.request.creator, f.request.selectedConfig]))
  assert.ok(!p.review.accounts.some(a => a.address === f.request.mint))
  assert.deepEqual(p.rentAccountSizes, { selectedConfig: 176 }); assert.equal(p.rentQuoteLamports, '2000')
  assert.equal(p.canSign, false); assert.equal(p.canSubmit, false); assert.equal(p.selectedHook.commitment.length, 64)
  assert.equal(p.selectedHook.registrySha256, sha(Buffer.from(f.observations[0].accounts[5].account.dataBase64, 'base64')))
  const coder = new BorshCoder(JSON.parse(Buffer.from(f.profile.idls.launch, 'base64')))
  const decoded = coder.instruction.decode(Buffer.from(p.instructions[2].dataHex, 'hex'))
  assert.equal(decoded.name, 'create_config'); assert.equal(decoded.data.args.custom_hook.toBase58(), f.hookPin.program)
  assert.equal(decoded.data.args.custom_hook_flags, 255)
  assert.ok(Object.isFrozen(p.review)); assert.ok(Object.isFrozen(p.selectedHook))
})
for (const [name, mutate] of [
  ['registry changed between providers', f => { f.observations[1].accounts[5].account.dataBase64 += 'AA==' }],
  ['registry wrong owner', f => { for (const o of f.observations) o.accounts[5].account.owner = f.request.creator }],
  ['program changed', f => { for (const o of f.observations) { const a = o.accounts[3].account, b = Buffer.from(a.dataBase64, 'base64'); b[49] ^= 1; a.dataBase64 = b.toString('base64') } }],
  ['future deployment slot', f => { for (const o of f.observations) { const a = o.accounts[3].account, b = Buffer.from(a.dataBase64, 'base64'); b.writeBigUInt64LE(101n, 4); a.dataBase64 = b.toString('base64') } }],
  ['wrong flags', f => { f.request.selectedHook.flags = 1 }],
  ['debit cap', f => { f.limits.maxTotalDebitLamports = '11999' }],
  ['network fee cap', f => { f.limits.maxNetworkFeeLamports = '9999' }],
  ['unoffered creator fee', f => { f.request.creatorFeeBps = 99 }],
  ['mint already exists', f => { for (const o of f.observations) o.accounts[6].account = { ...o.accounts[8].account, address: f.request.mint } }],
  ['separate fee payer adds a signer', f => { f.request.feePayer = f.request.mint }],
]) test(`planner rejects ${name}`, () => { const f = fixture(); mutate(f); assert.throws(() => planSelectedHookPreparation(f)) })
test('missing registry explicitly requires creator initialization without mint replacement', async () => {
  const f = fixture(); for (const o of f.observations) o.accounts[5].account = null
  assert.throws(() => planSelectedHookPreparation(f), { code: 'SELECTED_HOOK_REGISTRY_REQUIRED' })
  await assert.rejects(collectSelectedHookPreparationReview({ ...f, connections: connections(f), clock: () => 1000 }), { code: 'SELECTED_HOOK_REGISTRY_REQUIRED' })
})
test('two-provider collector retains exact review and refuses changed config-bound evidence', async () => {
  const f = fixture(), c = connections(f), args = { ...f, connections: c, clock: () => 1000 }
  const first = await collectSelectedHookPreparationReview(args)
  assert.equal(first.collection.feeQuotedByBoth, true)
  c[0].connection.getLatestBlockhashAndContext = () => { throw Error('Do not replace retained blockhash') }
  const again = await collectSelectedHookPreparationReview({ ...args, expectedReview: first.plan.review })
  assert.deepEqual(again.plan.review, first.plan.review)
  f.request.hookFlags = 1; f.request.selectedHook.flags = 1
  await assert.rejects(collectSelectedHookPreparationReview({ ...args, expectedReview: first.plan.review }))
})
test('collector rejects nonindependent providers and mismatched exact-message fees', async () => {
  const f = fixture(), c = connections(f), args = { ...f, connections: c, clock: () => 1000 }
  c[1].connection.getFeeForMessage = async () => ({ context: { slot: 100 }, value: 9999 })
  await assert.rejects(collectSelectedHookPreparationReview(args))
  c[1].connection = c[0].connection
  await assert.rejects(collectSelectedHookPreparationReview(args))
})

test('collector rejects uncorroborated blockhash identity or lifetime before issuing a review', async () => {
  for (const change of [{ blockhash: fixture().request.mint }, { blockHeight: 49 }, null]) {
    const f = fixture(), c = connections(f)
    c[1].connection.getBlock = async () => change === null ? null : ({ blockhash: f.recentBlockhash.blockhash, blockHeight: 50, ...change })
    await assert.rejects(collectSelectedHookPreparationReview({ ...f, connections: c, clock: () => 1000 }))
  }
})

test('retained review binds registry, immutable program, launch config and rent even when both readers agree', async () => {
  for (const change of ['registry', 'program', 'config', 'rent']) {
    const f = fixture(), c = connections(f), args = { ...f, connections: c, clock: () => 1000 }
    const { plan } = await collectSelectedHookPreparationReview(args)
    for (const o of f.observations) {
      if (change === 'registry') {
        const a = o.accounts[5].account
        a.dataBase64 = Buffer.concat([Buffer.from('02daf6662c38c0cd01010000000000', 'hex'), Buffer.alloc(32, 10)]).toString('base64')
      }
      if (change === 'program') {
        const a = o.accounts[3].account, b = Buffer.from(a.dataBase64, 'base64'); b[49] ^= 1; a.dataBase64 = b.toString('base64')
      }
      if (change === 'config') {
        const a = o.accounts[4].account, b = Buffer.from(a.dataBase64, 'base64'); b.writeBigUInt64LE(123n, 106); a.dataBase64 = b.toString('base64')
      }
    }
    if (change === 'program') f.hookPin.elfSha256 = sha(Buffer.from(f.observations[0].accounts[3].account.dataBase64, 'base64').subarray(45))
    if (change === 'rent') for (const { connection } of c) connection.getMinimumBalanceForRentExemption = async () => 1999
    await assert.rejects(collectSelectedHookPreparationReview({ ...args, expectedReview: plan.review }), undefined, change)
  }
})

test('planner refuses hook alias with the inert Kit program', () => {
  const f = fixture(), p = JSON.parse(f.profile.json)
  // The inclusive legacy profile names the kit through its fixed stack convention.
  f.request.selectedHook.program = 'AZDzvrC6733F6orekbzyF5B6Vpd9DxnV9RGfRrDgzHhm'
  f.hookPin.program = f.request.selectedHook.program
  // No inventory bytes can authorize this role collision.
  assert.throws(() => planSelectedHookPreparation(f), /alias/)
  assert.ok(p.programs.gate)
})
