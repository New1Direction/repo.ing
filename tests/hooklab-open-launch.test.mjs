// Open (self-serve) launches: create_launch_open_v1 as fixed by the hook-lab feat/open-creation ABI. The compiler takes
// v4's 32 named accounts and exactly 8 remaining ones (no creator authorization, no reviewer), so the creator and the
// server-sealed mint key are the only signers. It sends through one shared, frozen launch lookup table of constant
// addresses, and offers only the fee and cap the chain's menus hold. Synthetic native canary state over the reviewed native
// ELFs (HOOKLAB_NATIVE_ELF_DIR); no RPC, no bank.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PublicKey, VersionedMessage } from '@solana/web3.js'
import { compileOpenLaunchReview, compileMaxWalletLaunchReview, openLaunchInventory, openLaunchTableAddresses, OPEN_LAUNCH_DISCRIMINATOR } from '../src/hooklab-max-wallet-launch.mjs'
import { openState, openInput, openConnections, sharedTable, OWNER_MENUS, withLocalAcceptance } from './fixtures/hooklab-open-launch.mjs'
import { readOpenCreation } from '../src/hooklab-open-creation.mjs'
import { missingArtifactEnv } from './fixtures/hooklab-generated-artifact.mjs'

const skip = missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native ELFs')
const sha = bytes => createHash('sha256').update(bytes).digest()

test('an open launch compiles to create_launch_open_v1: 40 accounts, only the creator and the mint sign, the open control hash', { skip }, () => withLocalAcceptance(() => {
  const world = openState(), { state, roles, programs } = world, plan = compileOpenLaunchReview(openInput(world))
  const message = VersionedMessage.deserialize(Buffer.from(plan.review.messageBase64, 'base64'))
  assert.deepEqual(plan.review.requiredSigners, [roles.creator, roles.mint])
  assert.equal(plan.review.operation, 'open-launch')
  const ix = plan.canonicalInstruction, data = Buffer.from(ix.dataHex, 'hex')
  assert.deepEqual([...data.subarray(0, 8)], [51, 106, 16, 21, 31, 133, 167, 85])
  assert.deepEqual(OPEN_LAUNCH_DISCRIMINATOR, sha(Buffer.from('global:create_launch_open_v1')).subarray(0, 8))
  assert.equal(ix.accounts.length, 40)
  const a = plan.addresses
  assert.deepEqual(ix.accounts.slice(32).map(m => [m.address, m.signer, m.writable]), [[a.launchGovernance, false, false], [a.gateProgramData, false, false], [programs.gate, false, false],
    [a.gateHookSigner, false, false], [a.registry, false, false], [a.policy, false, false], [a.launch, false, false], [a.inclusiveFeePolicy, false, true]])
  assert.equal(ix.accounts[29].address, roles.config, 'the creator\'s own launch config is account 30')
  for (const absent of [a.authorization, roles.admin]) assert.ok(!plan.review.accounts.some(x => x.address === absent), `${absent} is not in an open launch`)
  // expected_control_hash = sha256("hook-lab:open-creation-controls:v1" || launch program || launch governance commitment)
  assert.equal(plan.commitments.creationControl, sha(Buffer.concat([Buffer.from('hook-lab:open-creation-controls:v1'), new PublicKey(programs.launch).toBuffer(), Buffer.from(plan.commitments.launchGovernance, 'hex')])).toString('hex'))
  assert.equal(message.addressTableLookups.length, 1); assert.equal(message.addressTableLookups[0].accountKey.toBase58(), plan.review.lookupTables[0].address)
  assert.ok(1 + 64 * 2 + message.serialize().length <= 1232, 'fits one packet')
  assert.deepEqual({ creatorFeeBps: plan.creatorFeeBps, capBps: plan.policy.capBps, quoteForm: plan.quoteForm }, { creatorFeeBps: 100, capBps: 200, quoteForm: 1 })
  // Deterministic, and the v4 custom launch over the same state still compiles (existing coins and owner-approved launches).
  assert.equal(compileOpenLaunchReview(openInput(world, { table: plan.review.lookupTables[0] })).review.messageBase64, plan.review.messageBase64)
  assert.ok(compileMaxWalletLaunchReview({ ...state.launchInputNow(), nativeLaunches: true }))
}))

test('the shared launch table holds only the addresses every open launch shares', { skip }, () => withLocalAcceptance(() => {
  const world = openState(), { state, roles, programs } = world, addresses = openLaunchTableAddresses(state.profile, world.configBytes())
  const { addresses: a } = openLaunchInventory(state.profile, openInput(world).request, world.configBytes())
  for (const own of [roles.creator, roles.mint, roles.config, a.launch, a.pool, a.lpMint, a.policy, a.registry, a.inclusiveFeePolicy, a.authorization, programs.launch]) assert.ok(!addresses.includes(own), own)
  for (const shared of [world.configAddress, roles.treasury, a.swapConfig, a.launchGovernance, a.gateProgramData, programs.gate, programs.swap, programs.token]) assert.ok(addresses.includes(shared), shared)
  assert.deepEqual(addresses, [...addresses].sort())
}))

test('refused: open creation off, a fee or cap not on the menu, another payer, a table that is not the frozen shared one, too long a URI', { skip }, () => withLocalAcceptance(() => {
  const refuses = (world, options, pattern) => assert.throws(() => compileOpenLaunchReview(openInput(world, options)), pattern)
  refuses(openState({ reserved: { native: true, open: false, ...OWNER_MENUS } }), {}, /Open creation is off/)
  refuses(openState({ reserved: { native: true, open: true, creatorFeeBps: [50, 200], capBps: [100, 200] } }), {}, /creator fee is not on the on-chain menu/)
  refuses(openState({ reserved: { native: true, open: true, creatorFeeBps: [100], capBps: [100, 500] } }), {}, /wallet cap is not on the on-chain menu/)
  refuses(openState({ reserved: { native: false, open: true, ...OWNER_MENUS } }), {}, /native launches are off/i)
  const world = openState(), addresses = openLaunchTableAddresses(world.state.profile, world.configBytes())
  refuses(world, { request: { feePayer: world.roles.outsider } }, /Preparation intent\/profile differs|creator pays/)   // the preparation binds the payer too
  refuses(world, { table: sharedTable(addresses, { frozen: false }) }, /shared launch table/)
  refuses(world, { table: sharedTable(addresses, { extra: [world.roles.outsider] }) }, /shared launch table/)
  refuses(world, { table: sharedTable(addresses.slice(1)) }, /shared launch table/)
  refuses(world, { uri: `https://repo.ing/${'x'.repeat(183)}` }, /packet/)   // 200 bytes: allowed by the program, too long for one packet here
}))

test('the fee menu on offer is the on-chain menu under the current ceiling: a fee above a lowered max_creator_fee_bps is refused', { skip }, () => withLocalAcceptance(async () => {
  // The owner lowered max_creator_fee_bps to 50 after setting the menu [50, 100, 200]; the program does not re-check it.
  const world = openState({ ceiling: 50 })
  const chain = await readOpenCreation(openConnections(world), world.programs)
  assert.deepEqual([...chain.creatorFeeBps], [50], 'only the fees at or under the ceiling are offered'); assert.equal(chain.maxCreatorFeeBps, 50)
  assert.deepEqual([...chain.capBps], OWNER_MENUS.capBps)
  assert.throws(() => compileOpenLaunchReview(openInput(world)), /not on the on-chain menu under the current ceiling/, 'this coin chose 100')
  // With the ceiling at 100 the same launch compiles.
  assert.ok(compileOpenLaunchReview(openInput(openState({ ceiling: 100 }))).review)
  // The rules-fee bound caps it too: the lower of max_creator_fee_bps and rule_bounds.max_rules_fee_bps.
  const rules = openState({ ceiling: 200, rulesCeiling: 50 }), capped = await readOpenCreation(openConnections(rules), rules.programs)
  assert.deepEqual([...capped.creatorFeeBps], [50]); assert.equal(capped.maxCreatorFeeBps, 50)
  assert.throws(() => compileOpenLaunchReview(openInput(rules)), /under the current ceiling/)
}))

// The independent stack retired the fee menu (owner 2026-10-26): with no fee menu on chain, any whole fee from 0 to the
// ceiling launches. A menu that the ceiling filtered down to nothing is still a menu: that is not a continuous fee.
test('an empty on-chain fee menu means a continuous creator fee from 0 to the ceiling', { skip }, () => withLocalAcceptance(async () => {
  const continuous = { native: true, open: true, creatorFeeBps: [], capBps: OWNER_MENUS.capBps }
  const world = openState({ reserved: continuous })
  const chain = await readOpenCreation(openConnections(world), world.programs)
  assert.deepEqual({ fees: [...chain.creatorFeeBps], continuous: chain.continuousCreatorFee }, { fees: [], continuous: true })
  assert.equal(compileOpenLaunchReview(openInput(world)).creatorFeeBps, 100, 'this coin chose 100, on no menu')
  assert.throws(() => compileOpenLaunchReview(openInput(openState({ reserved: continuous, ceiling: 50 }))), /exceeds the current chain ceiling|under the current ceiling/)
  const filtered = openState({ ceiling: 40 }), old = await readOpenCreation(openConnections(filtered), filtered.programs)
  assert.deepEqual({ fees: [...old.creatorFeeBps], continuous: old.continuousCreatorFee }, { fees: [], continuous: false })
  assert.throws(() => compileOpenLaunchReview(openInput(filtered)), /not on the on-chain menu/)
}))
