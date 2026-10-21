// Pure unsigned instruction preparation. No RPC, filesystem, signing, tables or custody access.
import BN from 'bn.js'
import { instructionsFor } from '../src/hooklab-owner-driver/instructions.mjs'
import { MAINNET_GENESIS, MAINNET_ROLES, derivedAddresses, pk } from '../src/hooklab-owner-driver/pins.mjs'
import { LAUNCH_CONFIG_START, SWAP_CONFIG_START } from '../src/hooklab-owner-driver/stages/stack.mjs'
import { governedSetNativeLaunches } from '../src/hooklab-native-launch.mjs'
import { governedSetOpenCreation } from '../src/hooklab-open-creation.mjs'
import { parseLaunchConfigReserved } from '../src/hooklab-launch-config-reserved.mjs'

export const STEP8_STAGE_NAMES = Object.freeze(['launch-config-init', 'swap-config-init', 'launch-governance-init', 'swap-governance-init',
  'launch-config', 'swap-config', 'launch-fee', 'launch-usd-bounds', 'native-launches', 'open-creation'])
// Public historical review-sheet proposal, NOT an approval or a custody-file read.
export const PROPOSED_CUSTODY_DIGEST = '58ab093cc13198d5bb35e92df45e22cc7a0dd5e379c3f99acbd8c8b0c4c76e8a'
const MARKER = '4e3A61oP4PHqk6Hp5DUmYKyBK9qjosqbK9JxB21Yr33g'
const check = (ok, why) => { if (!ok) throw Error(why) }
const bn = n => new BN(String(n))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

export function buildSelectedStep8Stage({ name, abi, programs, roles, genesis, custodyDigest, accounts }) {
  const activation = ['open-launches', 'open-trading'].includes(name)
  check(STEP8_STAGE_NAMES.includes(name) || activation, 'Unknown selected setup stage')
  check(genesis === MAINNET_GENESIS, 'Mainnet genesis required')
  for (const r of ['admin', 'guardian', 'treasury', 'upgrade', 'payer']) check(roles?.[r] === MAINNET_ROLES[r], `Public ${r} role differs`)
  check(accounts instanceof Map, 'Current account Map required')
  check(programs.launch === '9zzzPsLUsuu1XoGZ4TsHbghyXUPqXnHeJUpPRY7P5ZWu' && programs.swap === '72tDzM3mhFsYU1qecrLpScv1Bud6XaszkQtB4YVjJh9s', 'Independent programs required')
  const ix = instructionsFor(abi), d = derivedAddresses(programs, MARKER)
  const role = name.startsWith('swap-') || name === 'open-trading' ? 'swap' : 'launch'
  const address = (r, type) => d[`${r}${type}`]
  const decode = (r, type) => {
    const a = accounts.get(address(r, type))
    check(a && a.owner === programs[r] && a.executable === false, `${r} ${type} missing or wrong owner/executable`)
    return abi.coders[r].accounts.decode(type, Buffer.from(a.dataBase64, 'base64'))
  }
  // Reject already-active setup snapshots, including the other program when present.
  if (!activation) for (const r of ['launch', 'swap']) {
    if (accounts.get(address(r, 'Config'))) check(decode(r, 'Config').paused, 'Setup requires paused configs')
    if (accounts.get(address(r, 'Governance'))) check(decode(r, 'Governance').state.gates[r === 'launch' ? 'creation' : 'trading'], 'Setup requires closed gates')
  }
  const result = { name, instructions: [], expectedEffects: { classification: activation ? 'ACTIVATION' : 'SETUP' }, rentAccountLengths: [] }
  const emit = instruction => { result.instructions.push(instruction); return result }
  if (name.endsWith('-config-init')) {
    check(!accounts.get(address(role, 'Config')), `${role} Config already present; init replay forbidden`)
    const args = role === 'launch' ? { ...LAUNCH_CONFIG_START, admin: pk(roles.admin), treasury: pk(roles.treasury), quote_mint: pk(MARKER),
      rule_bounds: { ...LAUNCH_CONFIG_START.rule_bounds } } : { ...SWAP_CONFIG_START, admin: pk(roles.admin), treasury: pk(roles.treasury), fee_collector: pk(roles.treasury) }
    for (const k of ['launch_fee_lamports', 'sniper_window_secs', 'supply', 'min_virtual_quote', 'max_virtual_quote', 'pool_creation_fee_lamports']) if (k in args) args[k] = bn(args[k])
    result.rentAccountLengths = [role === 'launch' ? 250 : 189]
    result.expectedEffects.configArgs = args
    return emit(ix.initConfig(programs, role, { authority: roles.upgrade, payer: roles.payer, args }))
  }
  const config = decode(role, 'Config')
  check(config.admin.toBase58() === roles.admin && config.treasury.toBase58() === roles.treasury, 'Config roles differ')
  if (name.endsWith('-governance-init')) {
    check(!accounts.get(address(role, 'Governance')), `${role} Governance already present; init replay forbidden`)
    check(typeof custodyDigest === 'string' && custodyDigest === PROPOSED_CUSTODY_DIGEST, 'Explicit proposed historical custody digest adoption required')
    result.rentAccountLengths = [348]
    result.expectedEffects.custodyDigest = custodyDigest
    result.expectedEffects.requiresOwnerAdoption = true
    return emit(ix.initGovernance(programs, role, { admin: roles.admin, payer: roles.payer, genesis, guardian: roles.guardian, custodyDigest: Buffer.from(custodyDigest, 'hex') }))
  }
  const state = decode(role, 'Governance').state
  check(state.roles.admin.toBase58() === roles.admin && state.pending_admin === null, 'Governance admin/pending nomination differs')
  const expected = ix.governanceCommitment(role, state)
  result.expectedEffects.expectedGovernanceCommitment = expected.toString('hex')
  const skip = () => ({ ...result, skipped: true })
  if (['native-launches', 'open-creation'].includes(name) || activation) {
    const l = decode('launch', 'Config'), s = decode('swap', 'Config')
    check(l.treasury.toBase58() === roles.treasury && l.quote_mint.toBase58() === MARKER && s.treasury.toBase58() === roles.treasury && s.fee_collector.toBase58() === roles.treasury, 'Money routing differs')
  }
  if (activation) {
    const gates = { creation: false, trading: false }
    result.expectedEffects.gates = gates
    result.expectedEffects.paused = false
    // governance_action SetGates itself mirrors the relevant gate into Config.paused (admin stages).
    if (same(state.gates, gates) && !config.paused) return skip()
    return emit(ix.governanceSetGates(programs, role, roles.admin, expected, gates))
  }
  if (['native-launches', 'open-creation'].includes(name)) {
    const current = parseLaunchConfigReserved(Buffer.from(accounts.get(d.launchConfig).dataBase64, 'base64').subarray(186))
    check(current, 'Noncanonical launch reserved state')
    if (name === 'native-launches') {
      result.expectedEffects.native = true
      return current.native ? skip() : emit(governedSetNativeLaunches({ launchProgram: programs.launch, admin: roles.admin, expected, on: true }))
    }
    const menus = { creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] }
    check(current.native && config.max_creator_fee_bps >= 200, 'Native launches and creator ceiling required first')
    result.expectedEffects.menus = menus
    result.expectedEffects.open = true
    if (current.open && same(current.creatorFeeBps, menus.creatorFeeBps) && same(current.capBps, menus.capBps)) return skip()
    return emit(governedSetOpenCreation({ launchProgram: programs.launch, admin: roles.admin, expected, on: true, ...menus }))
  }
  const before = role === 'launch' ? ix.launchConfigArgs(config) : ix.swapConfigArgs(config)
  const after = { ...before }
  if (name === 'launch-config') { after.max_creator_fee_bps = 200; after.rule_bounds = { ...before.rule_bounds, max_rules_fee_bps: 200, max_burn_bps: 200 } }
  if (name === 'swap-config') { after.protocol_fee_bps = 0; after.launch_protocol_share_bps = 2500 }
  if (name === 'launch-fee') after.launch_fee_lamports = bn(20000000)
  if (name === 'launch-usd-bounds') { after.min_virtual_quote = bn('5625000000'); after.max_virtual_quote = bn('112500000000') }
  result.expectedEffects.configArgs = after
  if (same(before, after)) return skip()
  return emit(ix.governedSetConfig(programs, role, roles.admin, expected, after))
}
