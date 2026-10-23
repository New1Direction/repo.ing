import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { buildSelectedStep8Stage, STEP8_STAGE_NAMES, PROPOSED_CUSTODY_DIGEST } from '../scripts/hooklab-selected-step8-plan.mjs'
import { MAINNET_ROLES as roles, MAINNET_GENESIS as genesis, derivedAddresses, pk } from '../src/hooklab-owner-driver/pins.mjs'
import { instructionsFor } from '../src/hooklab-owner-driver/instructions.mjs'
import { encodeOpenCreationReserved } from '../src/hooklab-launch-config-reserved.mjs'

// This release check deliberately uses the candidate's public IDLs, not older vendored ABIs.
const dir = new URL('../../hook-lab-custom-hook-repair/idl/independent/', import.meta.url)
const idls = Object.fromEntries(Object.entries({ launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet', token: 'bordrless_token' })
  .map(([r, f]) => [r, JSON.parse(readFileSync(new URL(`${f}.json`, dir), 'utf8'))]))
const abi = { idls, coders: Object.fromEntries(Object.entries(idls).map(([r, j]) => [r, new BorshCoder(j)])) }
const programs = Object.fromEntries(Object.entries(idls).map(([r, j]) => [r, j.address]))
const d = derivedAddresses(programs), ix = instructionsFor(abi)
const put = (accounts, r, type, data) => accounts.set(d[`${r}${type}`], { owner: programs[r], executable: false, lamports: '1', dataBase64: Buffer.concat([
  Buffer.from(idls[r].accounts.find(a => a.name === type).discriminator), abi.coders[r].types.encode(type, data)]).toString('base64') })
// Asymmetric test-only choices, not a proposed production policy.
const ownerConfig = { schema: 'repoing/hooklab-owner-config/1', network: 'mainnet-beta', decisions: {
  maxCreatorFeeBps: { value: 137, approved: true }, maxRulesFeeBps: { value: 431, approved: true }, maxBurnBps: { value: 83, approved: true },
  openCreationMenus: { value: { creatorFeeBps: [37, 137], capBps: [100, 300] }, approved: true },
} }
const build = (name, accounts, extra = {}) => buildSelectedStep8Stage({ name, accounts, abi, programs, roles, genesis, ownerConfig, ...extra })
function fixture() {
  const accounts = new Map()
  for (const r of ['launch', 'swap']) {
    const args = build(`${r}-config-init`, accounts).expectedEffects.configArgs
    put(accounts, r, 'Config', { ...args, bump: 1, launches: new BN(17), reserved: Array(r === 'launch' ? 64 : 62).fill(0) })
    const state = { genesis: [...pk(genesis).toBuffer()], program: pk(programs[r]), config: pk(d[`${r}Config`]),
      roles: Object.fromEntries(['upgrade', 'admin', 'treasury', 'guardian'].map(k => [k, pk(roles[k])])), revision: new BN(13),
      gates: { creation: r === 'launch', trading: r === 'swap' }, config_digest: Array(32).fill(3), custody_digest: Array(32).fill(4), pending_admin: null }
    put(accounts, r, 'Governance', { bump: 1, state })
  }
  return accounts
}
test('historical order, unsigned init, explicit adoption and no init replay', () => {
  assert.equal(STEP8_STAGE_NAMES.length, 10)
  assert.equal(STEP8_STAGE_NAMES.at(-1), 'open-creation')
  const accounts = fixture()
  for (const r of ['launch', 'swap']) {
    assert.throws(() => build(`${r}-config-init`, accounts), /replay/)
    assert.throws(() => build(`${r}-governance-init`, accounts), /replay/)
    accounts.delete(d[`${r}Governance`])
    assert.throws(() => build(`${r}-governance-init`, accounts), /adoption/)
    const p = build(`${r}-governance-init`, accounts, { custodyDigest: PROPOSED_CUSTODY_DIGEST })
    assert.deepEqual(p.rentAccountLengths, [348])
    assert.equal(p.expectedEffects.requiresOwnerAdoption, true)
  }
})
test('updates preserve public config fields, skip matching economics, bind live commitment', () => {
  const accounts = fixture(), original = new Map(accounts)
  for (const name of ['launch-config', 'swap-config', 'launch-fee', 'launch-usd-bounds']) {
    const r = name === 'swap-config' ? 'swap' : 'launch'
    const config = abi.coders[r].accounts.decode('Config', Buffer.from(accounts.get(d[`${r}Config`]).dataBase64, 'base64'))
    const state = abi.coders[r].accounts.decode('Governance', Buffer.from(accounts.get(d[`${r}Governance`]).dataBase64, 'base64')).state
    const p = build(name, accounts), decoded = abi.coders[r].instruction.decode(p.instructions[0].data)
    assert.equal(decoded.name, 'governed_set_config')
    assert.deepEqual(Buffer.from(decoded.data.expected), ix.governanceCommitment(r, state))
    assert.equal(decoded.data.args.paused, true)
    assert.equal(decoded.data.args.admin.toBase58(), roles.admin)
    assert.equal(decoded.data.args.treasury.toBase58(), roles.treasury)
    if (r === 'launch') { assert.equal(decoded.data.args.curve_bps, 7500); assert.equal(decoded.data.args.supply.toString(), '1000000000000000') }
    if (name === 'launch-config') {
      assert.equal(decoded.data.args.max_creator_fee_bps, 137)
      assert.equal(decoded.data.args.rule_bounds.max_burn_bps, 83)
      assert.equal(decoded.data.args.rule_bounds.max_rules_fee_bps, 431)
      assert.equal(decoded.data.args.rule_bounds.max_holder_fee_bps, config.rule_bounds.max_holder_fee_bps)
    }
    put(accounts, r, 'Config', { ...config, ...decoded.data.args })
    assert.equal(build(name, accounts).skipped, true)
    state.revision = state.revision.add(new BN(1))
    put(accounts, r, 'Governance', { bump: 1, state })
    assert.notEqual(build(name, accounts).expectedEffects.expectedGovernanceCommitment, p.expectedEffects.expectedGovernanceCommitment)
  }
  assert.equal(original.get(d.launchConfig).dataBase64, fixture().get(d.launchConfig).dataBase64)
  const active = build('open-launches', accounts)
  assert.equal(active.expectedEffects.classification, 'ACTIVATION')
  assert.equal(abi.coders.launch.instruction.decode(active.instructions[0].data).name, 'governance_action')
})
test('launch bounds require adopted decisions; omitted burn preserves current protection', () => {
  const accounts = fixture()
  assert.throws(() => build('launch-config', accounts, { ownerConfig: undefined }))
  for (const name of ['maxCreatorFeeBps', 'maxRulesFeeBps', 'maxBurnBps']) {
    const config = structuredClone(ownerConfig)
    config.decisions[name].approved = false
    assert.throws(() => build('launch-config', accounts, { ownerConfig: config }))
    config.decisions[name] = { value: 10001, approved: true }
    assert.throws(() => build('launch-config', accounts, { ownerConfig: config }))
  }
  const withoutBurn = structuredClone(ownerConfig)
  delete withoutBurn.decisions.maxBurnBps
  const plan = build('launch-config', accounts, { ownerConfig: withoutBurn })
  assert.equal(abi.coders.launch.instruction.decode(plan.instructions[0].data).data.args.rule_bounds.max_burn_bps, 0)
})
test('adopted bounds must fit the candidate binary, including the exact boundary', () => {
  for (const [key, maximum] of [['maxCreatorFeeBps', 1000], ['maxRulesFeeBps', 1000], ['maxBurnBps', 500]]) {
    const config = structuredClone(ownerConfig)
    config.decisions[key].value = maximum
    assert.equal(build('launch-config', fixture(), { ownerConfig: config }).instructions.length, 1)
    config.decisions[key].value = maximum + 1
    assert.throws(() => build('launch-config', fixture(), { ownerConfig: config }), /candidate ceiling/)
  }
})
test('lowering either bound cannot invalidate an existing open gate menu', () => {
  const accounts = fixture()
  const config = abi.coders.launch.accounts.decode('Config', Buffer.from(accounts.get(d.launchConfig).dataBase64, 'base64'))
  config.max_creator_fee_bps = 137
  config.rule_bounds.max_rules_fee_bps = 431
  config.reserved = [...encodeOpenCreationReserved({ native: true, open: true, ...ownerConfig.decisions.openCreationMenus.value })]
  put(accounts, 'launch', 'Config', config)
  assert.equal(build('open-creation', accounts).skipped, true)
  for (const key of ['maxCreatorFeeBps', 'maxRulesFeeBps']) {
    const decision = structuredClone(ownerConfig)
    decision.decisions[key].value = 136
    assert.throws(() => build('launch-config', accounts, { ownerConfig: decision }), /existing gate menu/)
  }
})
test('native and open menus use existing APIs, bind live state and skip replay without opening gates', () => {
  const accounts = fixture()
  const config = abi.coders.launch.accounts.decode('Config', Buffer.from(accounts.get(d.launchConfig).dataBase64, 'base64'))
  const native = build('native-launches', accounts)
  assert.equal(abi.coders.launch.instruction.decode(native.instructions[0].data).name, 'governed_set_native_launches')
  assert.throws(() => build('open-creation', accounts), /Native/)
  config.reserved[0] = 1
  config.max_creator_fee_bps = 137
  config.rule_bounds.max_rules_fee_bps = 431
  put(accounts, 'launch', 'Config', config)
  assert.equal(build('native-launches', accounts).skipped, true)
  assert.throws(() => build('open-creation', accounts, { ownerConfig: undefined }), /configuration/)
  const unapproved = structuredClone(ownerConfig)
  unapproved.decisions.openCreationMenus.approved = false
  assert.throws(() => build('open-creation', accounts, { ownerConfig: unapproved }), /adoption/)
  const open = build('open-creation', accounts)
  const decoded = abi.coders.launch.instruction.decode(open.instructions[0].data)
  assert.equal(decoded.name, 'governed_set_open_creation')
  assert.deepEqual(Buffer.from(decoded.data.expected), Buffer.from(open.expectedEffects.expectedGovernanceCommitment, 'hex'))
  assert.deepEqual(decoded.data.fee_menu, [37, 137, 0, 0])
  assert.deepEqual(decoded.data.cap_menu, [100, 300, 0, 0])
  assert.deepEqual(open.expectedEffects.menus, { creatorFeeBps: [37, 137], capBps: [100, 300] })
  config.rule_bounds.max_rules_fee_bps = 136
  put(accounts, 'launch', 'Config', config)
  assert.throws(() => build('open-creation', accounts), /menu exceeds/)
  config.paused = false
  put(accounts, 'launch', 'Config', config)
  assert.throws(() => build('launch-fee', accounts), /paused/)
})
