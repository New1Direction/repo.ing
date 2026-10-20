import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BorshCoder } from '@anchor-lang/core'
import BN from 'bn.js'
import { buildSelectedStep8Stage, STEP8_STAGE_NAMES, PROPOSED_CUSTODY_DIGEST } from '../scripts/hooklab-selected-step8-plan.mjs'
import { MAINNET_ROLES as roles, MAINNET_GENESIS as genesis, derivedAddresses, pk } from '../src/hooklab-owner-driver/pins.mjs'
import { instructionsFor } from '../src/hooklab-owner-driver/instructions.mjs'

// This release check deliberately uses the candidate's public IDLs, not older vendored ABIs.
const dir = new URL('../../hook-lab-custom-hook-repair/idl/independent/', import.meta.url)
const idls = Object.fromEntries(Object.entries({ launch: 'bordrless_launch', swap: 'bordrless_swap', gate: 'hook_max_wallet', token: 'bordrless_token' })
  .map(([r, f]) => [r, JSON.parse(readFileSync(new URL(`${f}.json`, dir), 'utf8'))]))
const abi = { idls, coders: Object.fromEntries(Object.entries(idls).map(([r, j]) => [r, new BorshCoder(j)])) }
const programs = Object.fromEntries(Object.entries(idls).map(([r, j]) => [r, j.address]))
const d = derivedAddresses(programs), ix = instructionsFor(abi)
const put = (accounts, r, type, data) => accounts.set(d[`${r}${type}`], { owner: programs[r], executable: false, lamports: '1', dataBase64: Buffer.concat([
  Buffer.from(idls[r].accounts.find(a => a.name === type).discriminator), abi.coders[r].types.encode(type, data)]).toString('base64') })
const build = (name, accounts, extra = {}) => buildSelectedStep8Stage({ name, accounts, abi, programs, roles, genesis, ...extra })
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
test('native and open menus use existing APIs, bind live state and skip replay without opening gates', () => {
  const accounts = fixture()
  const config = abi.coders.launch.accounts.decode('Config', Buffer.from(accounts.get(d.launchConfig).dataBase64, 'base64'))
  const native = build('native-launches', accounts)
  assert.equal(abi.coders.launch.instruction.decode(native.instructions[0].data).name, 'governed_set_native_launches')
  assert.throws(() => build('open-creation', accounts), /Native/)
  config.reserved[0] = 1
  config.max_creator_fee_bps = 200
  put(accounts, 'launch', 'Config', config)
  assert.equal(build('native-launches', accounts).skipped, true)
  const open = build('open-creation', accounts)
  const decoded = abi.coders.launch.instruction.decode(open.instructions[0].data)
  assert.equal(decoded.name, 'governed_set_open_creation')
  assert.deepEqual(Buffer.from(decoded.data.expected), Buffer.from(open.expectedEffects.expectedGovernanceCommitment, 'hex'))
  assert.deepEqual(open.expectedEffects.menus, { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
  config.paused = false
  put(accounts, 'launch', 'Config', config)
  assert.throws(() => build('launch-fee', accounts), /paused/)
})
