// Owner/admin stages: governed config, creator grant, gate finalization, funding, creation gates.
import { isDeepStrictEqual } from 'node:util'
import BN from 'bn.js'
import { derivedAddresses, authorizationAddress, LOADER, SYSTEM, sha256, pk } from '../pins.mjs'
import { ELF } from '../artifacts.mjs'
import { readAccounts, rentExemption } from '../rpc.mjs'
import { value } from '../config.mjs'
import * as ix from '../instructions.mjs'
import { fieldDiff, plain, sol } from '../preview.mjs'
import { check, decode, owned, hex, nextState, governanceSection, governanceView, simpleMessage } from './common.mjs'

const configRole = { 'launch-config': 'launch', 'swap-config': 'swap' }
function wanted(ctx, role, current) {
  if (role === 'launch') return { ...current, max_creator_fee_bps: value(ctx.config, 'creatorFeeBps'),
    rule_bounds: { ...current.rule_bounds, max_rules_fee_bps: value(ctx.config, 'maxRulesFeeBps') } }
  return { ...current, protocol_fee_bps: value(ctx.config, 'protocolFeeBps'), launch_protocol_share_bps: value(ctx.config, 'launchProtocolShareBps') }
}
async function governedSnapshot(ctx, role, extra = []) {
  const d = derivedAddresses(ctx.programs), config = role === 'launch' ? d.launchConfig : d.swapConfig, governance = role === 'launch' ? d.launchGovernance : d.swapGovernance
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, [config, governance, ctx.roles.payer, ...extra])
  const c = decode(role, 'Config', owned(snapshot.accounts, config, ctx.programs[role], `${role} config`))
  const g = decode(role, 'Governance', owned(snapshot.accounts, governance, ctx.programs[role], `${role} governance`))
  check(c.admin.toBase58() === ctx.roles.admin && g.state.roles.admin.toBase58() === ctx.roles.admin, `${role} admin differs from the pinned admin role`)
  check(g.state.pending_admin === null, `${role} governance has a pending admin nomination; refusing`)
  return { snapshot, config: c, governance: g, addresses: { config, governance } }
}
const payerRow = (ctx, snapshot) => `payer ${ctx.roles.payer} balance ${sol(snapshot.accounts.get(ctx.roles.payer)?.lamports ?? 0)}`

function governedConfigStage(stage) {
  const role = configRole[stage]
  return {
    name: stage,
    async build(ctx, pinned) {
      const { snapshot, config, governance } = await governedSnapshot(ctx, role)
      const current = role === 'launch' ? ix.launchConfigArgs(config) : ix.swapConfigArgs(config), after = wanted(ctx, role, current)
      if (role === 'swap') check(after.fee_collector.toBase58() === after.treasury.toBase58(), 'Swap fee collector must equal the treasury')
      const diff = fieldDiff(plain(current), plain(after))
      if (!diff.length) return { blocked: `already applied: ${role} config already equals the decision values`, observedSlot: snapshot.slot }
      const expected = ix.governanceCommitment(role, governance.state)
      const instruction = ix.governedSetConfig(ctx.programs, role, ctx.roles.admin, expected, after)
      const afterState = nextState(governance.state, { config_digest: [...ix.economicsDigest(role, ctx.programs[role], after)], roles: { treasury: after.treasury } })
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot })
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: `${role} config field changes (before -> after)`, rows: diff.map(x => `${x.field}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`) },
          governanceSection(role, governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
        expect: { role, config: plain(after), commitment: hex(ix.governanceCommitment(role, afterState)) } }
    },
    async verify(ctx, expect) {
      const { config, governance } = await governedSnapshot(ctx, expect.role)
      const now = plain(expect.role === 'launch' ? ix.launchConfigArgs(config) : ix.swapConfigArgs(config))
      check(isDeepStrictEqual(now, expect.config), `${expect.role} config after execution differs from the reviewed values`)
      check(governanceView(expect.role, governance.state).commitment === expect.commitment, 'Governance commitment differs from the predicted post-state')
      return [`${expect.role} config matches reviewed values`, `governance commitment ${expect.commitment}`]
    },
  }
}

const grant = {
  name: 'grant',
  async build(ctx, pinned) {
    const g = value(ctx.config, 'grant'), creator = g.creator, authorization = authorizationAddress(creator, ctx.programs.launch)
    check(creator === ctx.roles.creator, 'Grant creator must be the pinned controlled-test creator role')
    const { snapshot, governance } = await governedSnapshot(ctx, 'launch', [authorization])
    const existing = snapshot.accounts.get(authorization)
    if (existing) return { blocked: `creator authorization ${authorization} already exists: ${JSON.stringify(plain(decode('launch', 'CreatorAuthorization', existing)))}`, observedSlot: snapshot.slot }
    const expiresAtSlot = pinned?.expiresAtSlot ?? String(BigInt(snapshot.slot) + BigInt(g.expirySlots))
    const rent = (await rentExemption(ctx.readers, [73]))[73]
    const instruction = ix.initCreatorAuthorization(ctx.programs, { admin: ctx.roles.admin, payer: ctx.roles.payer, creator, expiresAtSlot, maxLaunches: g.maxLaunches,
      expectedGovernance: ix.governanceCommitment('launch', governance.state) })
    const afterState = nextState(governance.state, {})
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'grant', payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, instructionDebitLamports: String(rent) })
    return { observedSlot: snapshot.slot, review, deadlineSlot: undefined, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, expiresAtSlot },
      sections: [{ title: 'creator authorization (new account)', rows: [`address ${authorization}`, `creator ${creator}`, `enabled true; max_launches ${g.maxLaunches} (lifetime); expires_at_slot ${expiresAtSlot} (exclusive; ${pinned?.expiresAtSlot ? 'pinned at plan time' : `observed slot ${snapshot.slot} + ${g.expirySlots}`}; current slot ${snapshot.slot})`] },
        governanceSection('launch', governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), `rent ${sol(rent)} paid by payer for the 73-byte authorization`] }],
      expect: { authorization, creator, expiresAtSlot, maxLaunches: g.maxLaunches, commitment: hex(ix.governanceCommitment('launch', afterState)) } }
  },
  async verify(ctx, expect) {
    const { snapshot, governance } = await governedSnapshot(ctx, 'launch', [expect.authorization])
    const a = decode('launch', 'CreatorAuthorization', owned(snapshot.accounts, expect.authorization, ctx.programs.launch, 'authorization'))
    check(a.creator.toBase58() === expect.creator && a.enabled && a.expires_at_slot.toString() === expect.expiresAtSlot && a.max_launches.toString() === expect.maxLaunches
      && a.consumed.isZero() && a.revision.isZero(), 'Creator authorization differs from the reviewed grant')
    check(governanceView('launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs from the predicted post-state')
    return [`authorization ${expect.authorization} enabled, quota ${expect.maxLaunches}, expiry ${expect.expiresAtSlot}`]
  },
}

export function programDataState(account, elf) {
  const data = Buffer.from(account.dataBase64, 'base64')
  check(account.owner === LOADER && !account.executable && data.readUInt32LE(0) === 3, 'ProgramData header differs')
  const authority = data[12] === 1 ? pk(data.subarray(13, 45)).toBase58() : data[12] === 0 ? null : 'NONCANONICAL'
  const elfBytes = data.subarray(45, 45 + elf.length)
  return { deploySlot: data.readBigUInt64LE(4).toString(), authority, elfMatches: sha256(elfBytes) === elf.sha256 && data.subarray(45 + elf.length).every(b => b === 0), length: data.length - 45 }
}
const gateFinalize = {
  name: 'gate-finalize',
  async build(ctx, pinned) {
    const d = derivedAddresses(ctx.programs), gate = ctx.programs.gate
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [gate, d.gateProgramData, ctx.roles.payer, ctx.roles.upgrade])
    const program = snapshot.accounts.get(gate), data = snapshot.accounts.get(d.gateProgramData)
    if (!program || !data) return { blocked: `gate program ${gate} is not deployed yet (program ${program ? 'present' : 'absent'}, ProgramData ${data ? 'present' : 'absent'})`, observedSlot: snapshot.slot }
    const link = Buffer.from(program.dataBase64, 'base64')
    check(program.owner === LOADER && program.executable && link.readUInt32LE(0) === 2 && pk(link.subarray(4, 36)).toBase58() === d.gateProgramData, 'Gate program linkage differs')
    const state = programDataState(data, ELF.gate)
    if (state.authority === null) return { blocked: 'gate ProgramData is already immutable', observedSlot: snapshot.slot }
    check(state.authority === ctx.roles.upgrade, `Gate upgrade authority ${state.authority} is not the pinned upgrade role`)
    if (!state.elfMatches) return { blocked: 'deployed gate ELF differs from the reviewed artifact d7233d...; refusing to make unreviewed code immutable', observedSlot: snapshot.slot }
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'gate-finalize', payer: ctx.roles.payer, instructions: [ix.loaderFinalize(d.gateProgramData, ctx.roles.upgrade)], pinned, snapshot, units: 20000 })
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'IRREVERSIBLE gate finalization', rows: [`program ${gate}; ProgramData ${d.gateProgramData}; deploy slot ${state.deploySlot}`,
        `upgrade authority ${state.authority} -> NONE (immutable forever)`, `deployed ELF sha256 ${ELF.gate.sha256} matches the reviewed artifact (${ELF.gate.length} bytes)`,
        'launch creation requires an immutable gate; this must precede canary-prepare and canary-launch'] }, { title: 'funds', rows: [payerRow(ctx, snapshot), 'no transfer; network fee only'] }],
      expect: { programData: d.gateProgramData } }
  },
  async verify(ctx, expect) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.programData])
    const state = programDataState(snapshot.accounts.get(expect.programData), ELF.gate)
    check(state.authority === null && state.elfMatches, 'Gate ProgramData is not immutable with the reviewed ELF')
    return ['gate ProgramData has no upgrade authority; ELF unchanged']
  },
}

const fund = {
  name: 'fund',
  async build(ctx, pinned) {
    const f = value(ctx.config, 'fund'), targets = [['creator', f.creatorLamports], ['admin', f.adminLamports], ['treasury', f.treasuryLamports]].filter(([, l]) => BigInt(l) > 0n)
    if (!targets.length) return { blocked: 'fund decision transfers nothing' }
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [ctx.roles.payer, ...targets.map(([r]) => ctx.roles[r])])
    const rent0 = BigInt((await rentExemption(ctx.readers, [0]))[0]), total = targets.reduce((n, [, l]) => n + BigInt(l), 0n)
    const notes = [], rows = [], balances = {}
    for (const [role, lamports] of targets) {
      const account = snapshot.accounts.get(ctx.roles[role]), before = BigInt(account?.lamports ?? 0)
      check(!account || (account.owner === SYSTEM && !account.executable), `${role} is not a plain system account`)
      if (before + BigInt(lamports) < rent0) notes.push(`${role} would stay below the rent-exempt minimum ${sol(rent0)}; the transfer would fail`)
      balances[ctx.roles[role]] = String(before + BigInt(lamports))
      rows.push(`${sol(lamports)}  payer ${ctx.roles.payer} -> ${role} ${ctx.roles[role]} (balance ${sol(before)} -> ${sol(before + BigInt(lamports))})`)
    }
    check(BigInt(snapshot.accounts.get(ctx.roles.payer)?.lamports ?? 0) >= total + 10000n, 'Payer balance cannot cover the transfers plus fee')
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'fund', payer: ctx.roles.payer, instructions: targets.map(([role, l]) => ix.transfer(ctx.roles.payer, ctx.roles[role], l)),
      pinned, snapshot, units: 2000 + 1000 * targets.length, instructionDebitLamports: String(total) })
    return { observedSlot: snapshot.slot, review, notes, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: `SOL transfers (total ${sol(total)})`, rows }, { title: 'funds', rows: [payerRow(ctx, snapshot)] }], expect: { balances } }
  },
  async verify(ctx, expect) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, Object.keys(expect.balances))
    for (const [address, lamports] of Object.entries(expect.balances)) check(snapshot.accounts.get(address)?.lamports === lamports, `Balance of ${address} differs from the reviewed post-state`)
    return Object.entries(expect.balances).map(([a, l]) => `${a} balance ${sol(l)}`)
  },
}

function creationGateStage(stage, open) {
  return {
    name: stage,
    async build(ctx, pinned) {
      const { snapshot, config, governance } = await governedSnapshot(ctx, 'launch')
      if (governance.state.gates.creation === !open) return { blocked: `launch creation gate is already ${open ? 'open' : 'closed'}`, observedSlot: snapshot.slot }
      const gates = { creation: !open, trading: false }
      const instruction = ix.governanceSetGates(ctx.programs, 'launch', ctx.roles.admin, ix.governanceCommitment('launch', governance.state), gates)
      const afterState = nextState(governance.state, { gates })
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000 })
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: 'launch creation gate', rows: [`launch config paused ${config.paused} -> ${!open} (Config.paused mirrors the creation gate)`,
          open ? 'OPENS launch creation for authorized creators only (allow-list grant + admin co-signature still required)' : 'CLOSES launch creation'] },
        governanceSection('launch', governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), 'no transfer; network fee only'] }],
        expect: { paused: !open, commitment: hex(ix.governanceCommitment('launch', afterState)) } }
    },
    async verify(ctx, expect) {
      const { config, governance } = await governedSnapshot(ctx, 'launch')
      check(config.paused === expect.paused && governance.state.gates.creation === expect.paused, 'Launch creation gate differs from the reviewed post-state')
      check(governanceView('launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs')
      return [`launch config paused=${config.paused}; commitment ${expect.commitment}`]
    },
  }
}

export const adminStages = {
  'launch-config': governedConfigStage('launch-config'), 'swap-config': governedConfigStage('swap-config'), grant, 'gate-finalize': gateFinalize, fund,
  'canary-gates-open-creation': creationGateStage('canary-gates-open-creation', true), 'canary-gates-close-creation': creationGateStage('canary-gates-close-creation', false),
}
export { BN }
