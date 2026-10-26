// The server's open-launch review: two providers' identical finalized snapshots, the operator's pinned bundle and shared
// launch table, then the open compiler; and the settlement it will check: OpenLaunchCreated before LaunchCreated, then
// NativeLaunchCreated, and no creator grant consumed. Synthetic native canary state; no keys sign.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PublicKey } from '@solana/web3.js'
import { collectOpenLaunchReview, collectMaxWalletLaunchReview } from '../src/hooklab-max-wallet-launch-collector.mjs'
import { deriveOpenLaunchPostconditions } from '../src/hooklab-max-wallet-launch-settlement.mjs'
import { openLaunchErrorText } from '../src/hooklab-open-creation.mjs'
import { openState, openRequest, openBindings, openConnections, openPreparation, OPEN_LIMITS, withLocalAcceptance } from './fixtures/hooklab-open-launch.mjs'
import { missingArtifactEnv } from './fixtures/hooklab-generated-artifact.mjs'

const skip = missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native ELFs')
const collect = (world, overrides = {}) => collectOpenLaunchReview({ ...openBindings(world), connections: openConnections(world), preparation: openPreparation(world),
  request: openRequest(world), limits: OPEN_LIMITS, clock: () => 1000, ...overrides })

test('the server collects an open launch review through the shared launch table, with the creator\'s fee from the chain menu', { skip }, () => withLocalAcceptance(async () => {
  const world = openState(), result = await collect(world)
  assert.equal(result.plan.review.operation, 'open-launch')
  assert.deepEqual(result.plan.review.requiredSigners, [world.roles.creator, world.roles.mint])
  assert.equal(result.settlementContext.schema, 'repoing/open-launch-settlement-context/1')
  assert.deepEqual(result.plan.review.lookupTables.map(t => t.address), [world.table.address])
  assert.equal(result.settlementContext.compilationInput.reviewedStateHashes.authorization, undefined)
  // The creator may pick any fee on the chain's menu: the operator's default is not imposed (the rest of the economics is).
  assert.equal(openBindings(world).config.economics.creatorFeeBps, 100)
}))

test('refused: no shared launch table configured, a table that differs from its pin, a request with a reviewer, open creation off', { skip }, () => withLocalAcceptance(async () => {
  const world = openState(), bindings = openBindings(world)
  await assert.rejects(collect(world, { config: (({ launchLookupTable, ...rest }) => rest)(bindings.config) }), /Open launch evidence unavailable/)
  await assert.rejects(collect(world, { config: { ...bindings.config, launchLookupTable: { ...bindings.config.launchLookupTable, sha256: '0'.repeat(64) } } }), /Open launch evidence unavailable/)
  await assert.rejects(collect(world, { request: { ...openRequest(world), reviewer: world.roles.admin } }), /Open launch evidence unavailable/)
  const off = openState({ reserved: { native: true, open: false, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] } })
  // The chain's own state reaches the creator in plain words (a customer-visible refusal), not a masked error.
  await assert.rejects(collect(off), { code: 'HOOKLAB_USER_REFUSAL', message: openLaunchErrorText(6120) })
  const native = openState({ reserved: { native: false, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] } })
  await assert.rejects(collect(native), { code: 'HOOKLAB_USER_REFUSAL', message: openLaunchErrorText(6103) })
  const menu = openState({ reserved: { native: true, open: true, creatorFeeBps: [50, 200], capBps: [100, 200, 300, 500] } })
  await assert.rejects(collect(menu), { code: 'HOOKLAB_USER_REFUSAL', message: openLaunchErrorText(6121) }, 'the creator chose 100, no longer offered')
  // The owner-approved path does not take an open request.
  await assert.rejects(collectMaxWalletLaunchReview({ ...bindings, connections: openConnections(world), preparation: openPreparation(world), request: openRequest(world), limits: OPEN_LIMITS, clock: () => 1000 }))
}))

test('settlement expects OpenLaunchCreated before LaunchCreated, then NativeLaunchCreated; no grant is consumed', { skip }, () => withLocalAcceptance(async () => {
  const world = openState(), { settlementContext, plan } = await collect(world)
  const expected = deriveOpenLaunchPostconditions(settlementContext, { slot: 120, timestamp: 1700000000 })
  assert.deepEqual(expected.events.map(e => e.name), ['OpenLaunchCreated', 'LaunchCreated', 'PoolCreated', 'NativeLaunchCreated'])
  const open = Buffer.from(expected.events[0].dataBase64, 'base64')
  assert.deepEqual([...open.subarray(8, 16)], [228, 69, 40, 108, 62, 242, 68, 231])
  const at = i => new PublicKey(open.subarray(16 + 32 * i, 48 + 32 * i)).toBase58()
  assert.deepEqual([at(0), at(1), at(2), at(3), open.readUInt16LE(144), open.readUInt16LE(146)], [plan.addresses.launch, world.roles.mint, world.roles.creator, world.roles.config, 100, 200])
  assert.ok(!expected.accounts.some(a => a.address === plan.addresses.authorization), 'an open launch has no creator grant to consume')
  assert.equal(expected.native, true)
}))

test('the collector takes any fee under the ceiling when the chain has no fee menu (continuous fee)', { skip }, () => withLocalAcceptance(async () => {
  const continuous = { native: true, open: true, creatorFeeBps: [], capBps: [100, 200, 300, 500] }
  assert.equal((await collect(openState({ reserved: continuous }))).plan.creatorFeeBps, 100)
  await assert.rejects(collect(openState({ reserved: continuous, ceiling: 50 })), { code: 'HOOKLAB_USER_REFUSAL', message: openLaunchErrorText(6121) })
}))
