// Owner/admin stages: governed config, creator grant, gate finalization, funding, creation gates.
import { isDeepStrictEqual } from 'node:util'
import BN from 'bn.js'
import { derivedAddresses, authorizationAddress, LOADER, SYSTEM, sha256, pk } from '../pins.mjs'
import { readAccounts, rentExemption } from '../rpc.mjs'
import { value } from '../config.mjs'
import { fieldDiff, plain, sol } from '../preview.mjs'
import { LAUNCH_CONFIG_RESERVED_AT, parseLaunchConfigReserved } from '../../hooklab-launch-config-reserved.mjs'
import { check, cdecode, owned, hex, nextState, gsection, gview, simpleMessage, ixOf, elfOf } from './common.mjs'
import { checkMoneyRouting } from './money-routing.mjs'

const configRole = { 'launch-config': 'launch', 'swap-config': 'swap' }
export function wanted(ctx, role, current) {
  // Ceilings, not the canary's own fee: they bound every creator-selectable fee (0.5%, 1%, 2%).
  if (role === 'launch') return { ...current, max_creator_fee_bps: value(ctx.config, 'maxCreatorFeeBps'),
    rule_bounds: { ...current.rule_bounds, max_rules_fee_bps: value(ctx.config, 'maxRulesFeeBps'),
      ...(ctx.config.decisions.maxBurnBps ? { max_burn_bps: value(ctx.config, 'maxBurnBps') } : {}),
      ...(ctx.config.decisions.maxHolderFeeBps ? { max_holder_fee_bps: value(ctx.config, 'maxHolderFeeBps') } : {}) } }
  return { ...current, protocol_fee_bps: value(ctx.config, 'protocolFeeBps'), launch_protocol_share_bps: value(ctx.config, 'launchProtocolShareBps') }
}
export async function governedSnapshot(ctx, role, extra = []) {
  const d = derivedAddresses(ctx.programs, ctx.quoteMint), config = role === 'launch' ? d.launchConfig : d.swapConfig, governance = role === 'launch' ? d.launchGovernance : d.swapGovernance
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, [config, governance, ctx.roles.payer, ...extra])
  const c = cdecode(ctx, role, 'Config', owned(snapshot.accounts, config, ctx.programs[role], `${role} config`))
  const g = cdecode(ctx, role, 'Governance', owned(snapshot.accounts, governance, ctx.programs[role], `${role} governance`))
  check(c.admin.toBase58() === ctx.roles.admin && g.state.roles.admin.toBase58() === ctx.roles.admin, `${role} admin differs from the pinned admin role`)
  check(g.state.pending_admin === null, `${role} governance has a pending admin nomination; refusing`)
  return { snapshot, config: c, governance: g, addresses: { config, governance } }
}
export const payerRow = (ctx, snapshot) => `payer ${ctx.roles.payer} balance ${sol(snapshot.accounts.get(ctx.roles.payer)?.lamports ?? 0)}`
// Post-execution check shared by every governed_set_config stage: the reviewed args and the predicted commitment.
export async function verifyGovernedConfig(ctx, expect) {
  const { config, governance } = await governedSnapshot(ctx, expect.role)
  const now = plain(expect.role === 'launch' ? ixOf(ctx).launchConfigArgs(config) : ixOf(ctx).swapConfigArgs(config))
  check(isDeepStrictEqual(now, expect.config), `${expect.role} config after execution differs from the reviewed values`)
  check(gview(ctx, expect.role, governance.state).commitment === expect.commitment, 'Governance commitment differs from the predicted post-state')
  return [`${expect.role} config matches reviewed values`, `governance commitment ${expect.commitment}`]
}

function governedConfigStage(stage) {
  const role = configRole[stage]
  return {
    name: stage,
    async build(ctx, pinned) {
      const { snapshot, config, governance, addresses } = await governedSnapshot(ctx, role)
      const current = role === 'launch' ? ixOf(ctx).launchConfigArgs(config) : ixOf(ctx).swapConfigArgs(config), after = wanted(ctx, role, current)
      if (role === 'swap') check(after.fee_collector.toBase58() === after.treasury.toBase58(), 'Swap fee collector must equal the treasury')
      const diff = fieldDiff(plain(current), plain(after))
      if (!diff.length) return { blocked: `already applied: ${role} config already equals the decision values`, observedSlot: snapshot.slot }
      const expected = ixOf(ctx).governanceCommitment(role, governance.state)
      const instruction = ixOf(ctx).governedSetConfig(ctx.programs, role, ctx.roles.admin, expected, after)
      const afterState = nextState(governance.state, { config_digest: [...ixOf(ctx).economicsDigest(role, ctx.programs[role], after)], roles: { treasury: after.treasury } })
      // The program does not re-check the open-creation fee menu when the ceiling moves: the site offers only the menu values
      // at or below the CURRENT ceiling, so a lowered ceiling silently withdraws the ones above it.
      const menu = role === 'launch' ? parseLaunchConfigReserved(Buffer.from(snapshot.accounts.get(addresses.config).dataBase64, 'base64').subarray(LAUNCH_CONFIG_RESERVED_AT)) : null
      const withdrawn = menu?.open ? menu.creatorFeeBps.filter(v => v > after.max_creator_fee_bps) : []
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot })
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: `${role} config field changes (before -> after)`, rows: diff.map(x => `${x.field}: ${JSON.stringify(x.before)} -> ${JSON.stringify(x.after)}`) },
          ...(withdrawn.length ? [{ title: 'WARNING: creator fee choices withdrawn', rows: [`the on-chain open-creation fee menu keeps [${withdrawn.join(', ')}] bps, above the new ceiling ${after.max_creator_fee_bps} bps: the site stops offering them (the program does not re-check the menu); set a new menu with open-creation`] }] : []),
          gsection(ctx, role, governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
        expect: { role, config: plain(after), commitment: hex(ixOf(ctx).governanceCommitment(role, afterState)) } }
    },
    verify: verifyGovernedConfig,
  }
}

const grant = {
  name: 'grant',
  async build(ctx, pinned) {
    const g = value(ctx.config, 'grant'), creator = g.creator, authorization = authorizationAddress(creator, ctx.programs.launch)
    check(creator === ctx.roles.creator, 'Grant creator must be the pinned controlled-test creator role')
    const { snapshot, governance } = await governedSnapshot(ctx, 'launch', [authorization])
    const existing = snapshot.accounts.get(authorization)
    if (existing) return { blocked: `creator authorization ${authorization} already exists: ${JSON.stringify(plain(cdecode(ctx, 'launch', 'CreatorAuthorization', existing)))}`, observedSlot: snapshot.slot }
    const expiresAtSlot = pinned?.expiresAtSlot ?? String(BigInt(snapshot.slot) + BigInt(g.expirySlots))
    const rent = (await rentExemption(ctx.readers, [73]))[73]
    const instruction = ixOf(ctx).initCreatorAuthorization(ctx.programs, { admin: ctx.roles.admin, payer: ctx.roles.payer, creator, expiresAtSlot, maxLaunches: g.maxLaunches,
      expectedGovernance: ixOf(ctx).governanceCommitment('launch', governance.state) })
    const afterState = nextState(governance.state, {})
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'grant', payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, instructionDebitLamports: String(rent) })
    return { observedSlot: snapshot.slot, review, deadlineSlot: undefined, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, expiresAtSlot },
      sections: [{ title: 'creator authorization (new account)', rows: [`address ${authorization}`, `creator ${creator}`, `enabled true; max_launches ${g.maxLaunches} (lifetime); expires_at_slot ${expiresAtSlot} (exclusive; ${pinned?.expiresAtSlot ? 'pinned at plan time' : `observed slot ${snapshot.slot} + ${g.expirySlots}`}; current slot ${snapshot.slot})`] },
        gsection(ctx, 'launch', governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), `rent ${sol(rent)} paid by payer for the 73-byte authorization`] }],
      expect: { authorization, creator, expiresAtSlot, maxLaunches: g.maxLaunches, commitment: hex(ixOf(ctx).governanceCommitment('launch', afterState)) } }
  },
  async verify(ctx, expect) {
    const { snapshot, governance } = await governedSnapshot(ctx, 'launch', [expect.authorization])
    const a = cdecode(ctx, 'launch', 'CreatorAuthorization', owned(snapshot.accounts, expect.authorization, ctx.programs.launch, 'authorization'))
    check(a.creator.toBase58() === expect.creator && a.enabled && a.expires_at_slot.toString() === expect.expiresAtSlot && a.max_launches.toString() === expect.maxLaunches
      && a.consumed.isZero() && a.revision.isZero(), 'Creator authorization differs from the reviewed grant')
    check(gview(ctx, 'launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs from the predicted post-state')
    return [`authorization ${expect.authorization} enabled, quota ${expect.maxLaunches}, expiry ${expect.expiresAtSlot}`]
  },
}

// One owner-approved customer launch: create the creator's grant (1 launch) or re-enable an existing
// one for exactly one more launch. Each grant advances launch governance, which invalidates any other
// in-flight launch review, so the owner agent invites one creator at a time.
const customerGrant = {
  name: 'customer-grant',
  async build(ctx, pinned) {
    const creator = ctx.options?.creator
    check(typeof creator === 'string' && pk(creator).toBase58() === creator, 'customer-grant requires --creator PUBKEY')
    check(!Object.values(ctx.roles).includes(creator), 'customer creator may not be one of the owner role addresses')
    const policy = value(ctx.config, 'customerGrantPolicy'), authorization = authorizationAddress(creator, ctx.programs.launch)
    const { snapshot, governance } = await governedSnapshot(ctx, 'launch', [authorization])
    const existing = snapshot.accounts.get(authorization)
    const expiresAtSlot = pinned?.expiresAtSlot ?? String(BigInt(snapshot.slot) + BigInt(policy.expirySlots))
    const expectedGovernance = ixOf(ctx).governanceCommitment('launch', governance.state)
    let instruction, rent = 0n, before = null, maxLaunches
    if (existing) {
      before = cdecode(ctx, 'launch', 'CreatorAuthorization', owned(snapshot.accounts, authorization, ctx.programs.launch, 'authorization'))
      check(before.creator.toBase58() === creator, 'existing authorization belongs to a different creator')
      maxLaunches = String(BigInt(before.consumed.toString()) + 1n)
      instruction = ixOf(ctx).setCreatorAuthorization(ctx.programs, { admin: ctx.roles.admin, creator, expiresAtSlot, maxLaunches, expectedGovernance })
    } else {
      maxLaunches = '1'
      rent = BigInt((await rentExemption(ctx.readers, [73]))[73])
      instruction = ixOf(ctx).initCreatorAuthorization(ctx.programs, { admin: ctx.roles.admin, payer: ctx.roles.payer, creator, expiresAtSlot, maxLaunches, expectedGovernance })
    }
    const afterState = nextState(governance.state, {})
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'customer-grant', payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, instructionDebitLamports: String(rent) })
    return { observedSlot: snapshot.slot, review, deadlineSlot: undefined, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, expiresAtSlot },
      sections: [{ title: existing ? 'creator authorization (re-enable for one more launch)' : 'creator authorization (new account)', rows: [`address ${authorization}`, `creator ${creator}`,
        ...(before ? [`before: enabled ${before.enabled}; consumed ${before.consumed} of ${before.max_launches}; expires_at_slot ${before.expires_at_slot}`] : []),
        `after: enabled true; max_launches ${maxLaunches} (lifetime, so exactly one more launch); expires_at_slot ${expiresAtSlot} (exclusive; observed slot ${snapshot.slot} + ${policy.expirySlots})`]},
        gsection(ctx, 'launch', governance.state, afterState),
        { title: 'funds', rows: [payerRow(ctx, snapshot), existing ? 'no rent: the authorization already exists' : `rent ${sol(rent)} paid by payer for the 73-byte authorization`] }],
      expect: { authorization, creator, expiresAtSlot, maxLaunches, commitment: hex(ixOf(ctx).governanceCommitment('launch', afterState)) } }
  },
  async verify(ctx, expect) {
    const { snapshot, governance } = await governedSnapshot(ctx, 'launch', [expect.authorization])
    const a = cdecode(ctx, 'launch', 'CreatorAuthorization', owned(snapshot.accounts, expect.authorization, ctx.programs.launch, 'authorization'))
    check(a.creator.toBase58() === expect.creator && a.enabled && a.expires_at_slot.toString() === expect.expiresAtSlot && a.max_launches.toString() === expect.maxLaunches
      && BigInt(a.consumed.toString()) + 1n === BigInt(expect.maxLaunches), 'Creator authorization differs from the reviewed customer grant')
    check(gview(ctx, 'launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs from the predicted post-state')
    return [`customer ${expect.creator}: one more launch allowed until slot ${expect.expiresAtSlot}`]
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
    const state = programDataState(data, elfOf(ctx).gate)
    if (state.authority === null) return { blocked: 'gate ProgramData is already immutable', observedSlot: snapshot.slot }
    check(state.authority === ctx.roles.upgrade, `Gate upgrade authority ${state.authority} is not the pinned upgrade role`)
    if (!state.elfMatches) return { blocked: `deployed gate ELF differs from the reviewed artifact ${elfOf(ctx).gate.sha256.slice(0, 12)}...; refusing to make unreviewed code immutable`, observedSlot: snapshot.slot }
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'gate-finalize', payer: ctx.roles.payer, instructions: [ixOf(ctx).loaderFinalize(d.gateProgramData, ctx.roles.upgrade)], pinned, snapshot, units: 20000 })
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'IRREVERSIBLE gate finalization', rows: [`program ${gate}; ProgramData ${d.gateProgramData}; deploy slot ${state.deploySlot}`,
        `upgrade authority ${state.authority} -> NONE (immutable forever)`, `deployed ELF sha256 ${elfOf(ctx).gate.sha256} matches the reviewed artifact (${elfOf(ctx).gate.length} bytes)`,
        'launch creation requires an immutable gate; this must precede canary-prepare and canary-launch'] }, { title: 'funds', rows: [payerRow(ctx, snapshot), 'no transfer; network fee only'] }],
      expect: { programData: d.gateProgramData } }
  },
  async verify(ctx, expect) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.programData])
    const state = programDataState(snapshot.accounts.get(expect.programData), elfOf(ctx).gate)
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
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'fund', payer: ctx.roles.payer, instructions: targets.map(([role, l]) => ixOf(ctx).transfer(ctx.roles.payer, ctx.roles[role], l)),
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

// The public activations (open-launches, open-trading) first re-read both configs (money-routing.mjs); the canary's
// gate and every close are not held back by it.
const ACTIVATIONS = new Set(['open-launches', 'open-trading'])
function creationGateStage(stage, open) {
  return {
    name: stage, activates: ACTIVATIONS.has(stage),
    async build(ctx, pinned) {
      if (ACTIVATIONS.has(stage)) { const refusal = await checkMoneyRouting(ctx, stage); if (refusal) return refusal }
      const { snapshot, config, governance } = await governedSnapshot(ctx, 'launch')
      if (governance.state.gates.creation === !open) return { blocked: `launch creation gate is already ${open ? 'open' : 'closed'}`, observedSlot: snapshot.slot }
      const gates = { creation: !open, trading: false }
      const instruction = ixOf(ctx).governanceSetGates(ctx.programs, 'launch', ctx.roles.admin, ixOf(ctx).governanceCommitment('launch', governance.state), gates)
      const afterState = nextState(governance.state, { gates })
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000 })
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: 'launch creation gate', rows: [`launch config paused ${config.paused} -> ${!open} (Config.paused mirrors the creation gate)`,
          open ? (ctx.stack ? 'OPENS launch creation: while open creation is on, anyone can launch through the website (no invite, no admin co-signature)' : 'OPENS launch creation for authorized creators only (allow-list grant + admin co-signature still required)') : 'CLOSES launch creation'] },
        gsection(ctx, 'launch', governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), 'no transfer; network fee only'] }],
        expect: { paused: !open, commitment: hex(ixOf(ctx).governanceCommitment('launch', afterState)) } }
    },
    async verify(ctx, expect) {
      const { config, governance } = await governedSnapshot(ctx, 'launch')
      check(config.paused === expect.paused && governance.state.gates.creation === expect.paused, 'Launch creation gate differs from the reviewed post-state')
      check(gview(ctx, 'launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs')
      return [`launch config paused=${config.paused}; commitment ${expect.commitment}`]
    },
  }
}

// Public trading switch. Swap Config.paused mirrors the trading gate; pool creation stays open.
// Customer (non-canary) launches and trades need BOTH governances fully open, so this is the
// public activation step together with open-launches.
function tradingGateStage(stage, open) {
  return {
    name: stage, activates: ACTIVATIONS.has(stage),
    async build(ctx, pinned) {
      if (ACTIVATIONS.has(stage)) { const refusal = await checkMoneyRouting(ctx, stage); if (refusal) return refusal }
      const { snapshot, config, governance } = await governedSnapshot(ctx, 'swap')
      if (governance.state.gates.trading === !open && !governance.state.gates.creation) return { blocked: `swap trading gate is already ${open ? 'open' : 'closed'}`, observedSlot: snapshot.slot }
      const gates = { creation: false, trading: !open }
      const instruction = ixOf(ctx).governanceSetGates(ctx.programs, 'swap', ctx.roles.admin, ixOf(ctx).governanceCommitment('swap', governance.state), gates)
      const afterState = nextState(governance.state, { gates })
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000 })
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: 'swap trading gate', rows: [`swap config paused ${config.paused} -> ${!open} (Config.paused mirrors the trading gate)`,
          open ? 'OPENS public trading of every hook coin (anyone may buy and sell)' : 'CLOSES trading of every hook coin (emergency stop)'] },
        gsection(ctx, 'swap', governance.state, afterState), { title: 'funds', rows: [payerRow(ctx, snapshot), 'no transfer; network fee only'] }],
        expect: { paused: !open, commitment: hex(ixOf(ctx).governanceCommitment('swap', afterState)) } }
    },
    async verify(ctx, expect) {
      const { config, governance } = await governedSnapshot(ctx, 'swap')
      check(config.paused === expect.paused && governance.state.gates.trading === expect.paused && !governance.state.gates.creation, 'Swap trading gate differs from the reviewed post-state')
      check(gview(ctx, 'swap', governance.state).commitment === expect.commitment, 'Swap governance commitment differs')
      return [`swap config paused=${config.paused}; commitment ${expect.commitment}`]
    },
  }
}

export const adminStages = {
  'launch-config': governedConfigStage('launch-config'), 'swap-config': governedConfigStage('swap-config'), grant, 'customer-grant': customerGrant, 'gate-finalize': gateFinalize, fund,
  'canary-gates-open-creation': creationGateStage('canary-gates-open-creation', true), 'canary-gates-close-creation': creationGateStage('canary-gates-close-creation', false),
  'open-launches': creationGateStage('open-launches', true), 'close-launches': creationGateStage('close-launches', false),
  'open-trading': tradingGateStage('open-trading', true), 'close-trading': tradingGateStage('close-trading', false),
}
export { BN }
