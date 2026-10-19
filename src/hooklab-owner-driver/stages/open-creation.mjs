// Self-serve launch stages. Each previews before it signs; plan compiles only.
//  open-creation --to on|off  governed_set_open_creation with the menus from the owner's config file (openCreationMenus,
//                             never defaulted). Open launches run on our own stack: its launch build must have them.
//  launch-fee                 governed_set_config of launch_fee_lamports alone: the creation fee every launch pays the
//                             treasury. Owner-confirmed 20,000,000 lamports (0.02 SOL), the default without a decision.
//  launch-table               creates, then freezes, the one shared launch lookup table every open launch uses: exactly
//                             the constant addresses of an open launch on this stack (two runs, like trade-table).
//  guardian-pause --pause creation|trading|both
//                             the guardian's emergency pause (governance_action Pause): creation on the launch governance,
//                             trading on the swap governance. The guardian signs; the payer pays the fee. Reopening is the
//                             admin's open-launches / open-trading.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import BN from 'bn.js'
import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, SYSVAR_SLOT_HASHES_PUBKEY } from '@solana/web3.js'
import { derivedAddresses, ALT_PROGRAM, sha256 } from '../pins.mjs'
import { decisionValue } from '../config.mjs'
import { readAccounts } from '../rpc.mjs'
import { fieldDiff, plain, sol } from '../preview.mjs'
import { LAUNCH_CONFIG_RESERVED_AT, encodeOpenCreationReserved, parseLaunchConfigReserved } from '../../hooklab-launch-config-reserved.mjs'
import { governedSetOpenCreation, openCreationDigest } from '../../hooklab-open-creation.mjs'
import { openLaunchTableAddresses } from '../../hooklab-max-wallet-launch.mjs'
import { check, cdecode, hex, nextState, gsection, gview, owned, simpleMessage, ixOf, abiOf, elfOf } from './common.mjs'
import { governedSnapshot, payerRow, programDataState, verifyGovernedConfig } from './admin.mjs'

// The owner confirmed the creation fee for production (2026-10-19): 0.02 SOL.
export const OWNER_CREATION_FEE_LAMPORTS = '20000000'
const requireOpenStack = (ctx, stage) => check(ctx.stack?.build.open === true, `${stage}: open launches run on our own stack; pass --stack FILE --stack-idls DIR for a build with open creation`)
// The deployed launch program is the stack build: its trimmed ELF, then only zeros.
const launchIsStackBuild = (ctx, programData) => !!programData && programDataState(programData, elfOf(ctx).launch).elfMatches
const pct = bps => `${bps / 100}%`

export const openCreation = {
  name: 'open-creation',
  async build(ctx, pinned) {
    requireOpenStack(ctx, 'open-creation')
    const to = ctx.options?.to
    check(to === 'on' || to === 'off', 'open-creation requires --to on or --to off')
    const on = to === 'on', menus = decisionValue(ctx.config, 'openCreationMenus')
    check(menus, 'open-creation needs openCreationMenus in the config file (creator fee and max per wallet, 1 to 4 bps values each); it is never defaulted')
    const definition = abiOf(ctx).idls.launch.instructions.find(ix => ix.name === 'governed_set_open_creation')
    const d = derivedAddresses(ctx.programs, ctx.quoteMint)
    const { snapshot, config, governance, addresses } = await governedSnapshot(ctx, 'launch', [d.launchProgramData])
    if (!definition || !launchIsStackBuild(ctx, snapshot.accounts.get(d.launchProgramData)))
      return { blocked: `the deployed launch program is not the stack build with open creation (${ctx.stack.build.name}, ELF ${elfOf(ctx).launch.sha256.slice(0, 12)}…)`, observedSlot: snapshot.slot }
    const raw = Buffer.from(snapshot.accounts.get(addresses.config).dataBase64, 'base64'), current = parseLaunchConfigReserved(raw.subarray(LAUNCH_CONFIG_RESERVED_AT))
    check(current, 'The launch Config reserved bytes are not a state the reviewed programs write; refusing')
    check(menus.creatorFeeBps.every(v => v <= config.max_creator_fee_bps), `every creator fee must be at most the Config ceiling (${config.max_creator_fee_bps} bps; run launch-config first)`)
    if (on) check(current.native, 'turn native launches on first (native-launches --to on): an open launch is native SOL only')
    if (current.open === on && isDeepStrictEqual(current.creatorFeeBps, menus.creatorFeeBps) && isDeepStrictEqual(current.capBps, menus.capBps))
      return { blocked: `open creation is already ${on ? 'ON' : 'OFF'} with these menus (the program refuses the same state, OpenCreationUnchanged)`, observedSlot: snapshot.slot }
    const after = encodeOpenCreationReserved({ native: current.native, open: on, ...menus })
    const instruction = governedSetOpenCreation({ launchProgram: ctx.programs.launch, admin: ctx.roles.admin, expected: ixOf(ctx).governanceCommitment('launch', governance.state), on, ...menus })
    check(Buffer.from(definition.discriminator).equals(instruction.data.subarray(0, 8)), 'governed_set_open_creation differs from the stack\'s launch IDL')
    const afterState = nextState(governance.state, {})
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'open-creation', payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000 })
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [
        { title: 'open creation (launch Config bytes 187..204)', rows: [`open: ${current.open ? 'ON' : 'OFF'} -> ${on ? 'ON' : 'OFF'}`,
          `creator fee menu: [${current.creatorFeeBps.map(pct).join(', ')}] -> [${menus.creatorFeeBps.map(pct).join(', ')}]`,
          `max per wallet menu: [${current.capBps.map(pct).join(', ')}] -> [${menus.capBps.map(pct).join(', ')}]`,
          `bytes 186..204: ${hex(raw.subarray(186, 204))} -> ${hex(after.subarray(0, 18))}`,
          on ? 'anyone can then launch a Hooks coin from the site (create_launch_open_v1: the creator and the mint sign; no invite, no admin co-signature), choosing from these menus'
            : 'create_launch_open_v1 is refused on chain (OpenCreationOff); coins already launched keep trading and their creators can still claim'] },
        { title: 'recorded policy change', rows: [`digest ${hex(openCreationDigest(ctx.programs.launch, addresses.config, { on, ...menus }))} = sha256("hook-lab:open-creation:v1" || launch program || config || on || menus)`,
          'everything else in the Config is unchanged (the switch and menus are outside ConfigArgs, so the economics digest is unchanged)'] },
        gsection(ctx, 'launch', governance.state, afterState),
        { title: 'in-flight launches go stale', rows: ['the revision bump changes every open launch\'s control hash: a launch reviewed before this lands fails on chain (CreationPolicyChanged); creators review again',
          'refresh: the stack bundle\'s launch-config pin tolerates these bytes; re-collect it only if anything else changed'] },
        { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
      expect: { on, menus, commitment: hex(ixOf(ctx).governanceCommitment('launch', afterState)) } }
  },
  async verify(ctx, expect) {
    const { snapshot, governance, addresses } = await governedSnapshot(ctx, 'launch')
    const state = parseLaunchConfigReserved(Buffer.from(snapshot.accounts.get(addresses.config).dataBase64, 'base64').subarray(LAUNCH_CONFIG_RESERVED_AT))
    check(state && state.open === expect.on && isDeepStrictEqual(state.creatorFeeBps, expect.menus.creatorFeeBps) && isDeepStrictEqual(state.capBps, expect.menus.capBps), 'Open creation state differs from the reviewed post-state')
    check(gview(ctx, 'launch', governance.state).commitment === expect.commitment, 'Launch governance commitment differs from the predicted post-state')
    return [`open creation ${expect.on ? 'ON' : 'OFF'}; fee menu [${state.creatorFeeBps}] bps; cap menu [${state.capBps}] bps`, `launch governance commitment ${expect.commitment}`]
  },
}

export const launchFee = {
  name: 'launch-fee',
  async build(ctx, pinned) {
    const decided = decisionValue(ctx.config, 'launchFeeLamports'), fee = decided ?? OWNER_CREATION_FEE_LAMPORTS
    const { snapshot, config, governance } = await governedSnapshot(ctx, 'launch')
    const current = ixOf(ctx).launchConfigArgs(config), after = { ...current, launch_fee_lamports: new BN(fee) }
    const diff = fieldDiff(plain(current), plain(after))
    if (!diff.length) return { blocked: `already applied: the creation fee is already ${sol(fee)}`, observedSlot: snapshot.slot }
    check(diff.every(x => x.field === 'launch_fee_lamports'), 'Only the creation fee may change')
    const instruction = ixOf(ctx).governedSetConfig(ctx.programs, 'launch', ctx.roles.admin, ixOf(ctx).governanceCommitment('launch', governance.state), after)
    const afterState = nextState(governance.state, { config_digest: [...ixOf(ctx).economicsDigest('launch', ctx.programs.launch, after)], roles: { treasury: after.treasury } })
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'launch-fee', payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot })
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'creation fee (to the treasury, paid by every launch)', rows: [`launch_fee_lamports: ${sol(diff[0].before)} -> ${sol(fee)}${decided ? '' : ' (the owner-confirmed default; no launchFeeLamports decision in the config file)'}`,
        `treasury ${config.treasury.toBase58()}`] },
        gsection(ctx, 'launch', governance.state, afterState),
        { title: 'refresh after it lands', rows: ['the launch economics hash covers the fee: launches reviewed before this fail on chain; the bundle\'s launch-config pin and economics must be re-collected',
          'the website reads the fee from chain for the review screen'] },
        { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
      expect: { role: 'launch', config: plain(after), commitment: hex(ixOf(ctx).governanceCommitment('launch', afterState)) } }
  },
  verify: verifyGovernedConfig,
}

const tableRecordPath = ctx => path.join(ctx.journal.dir, '..', `launch-table-${ctx.stack?.id ?? 'legacy'}.public.json`)
const tableRecord = ctx => existsSync(tableRecordPath(ctx)) ? JSON.parse(readFileSync(tableRecordPath(ctx), 'utf8')) : null
function writeTableRecord(ctx, record) {
  mkdirSync(path.dirname(tableRecordPath(ctx)), { recursive: true, mode: 0o700 })
  writeFileSync(`${tableRecordPath(ctx)}.next`, JSON.stringify(record, null, 2), { mode: 0o600 }); renameSync(`${tableRecordPath(ctx)}.next`, tableRecordPath(ctx))
}
async function launchTableInventory(ctx) {
  const d = derivedAddresses(ctx.programs, ctx.quoteMint), base = await readAccounts(ctx.readers, ctx.genesis, [d.launchConfig, ctx.roles.payer])
  const config = owned(base.accounts, d.launchConfig, ctx.programs.launch, 'launch config')
  return { base, inventory: openLaunchTableAddresses(ctx.envelope, Buffer.from(config.dataBase64, 'base64')) }
}
export const launchTable = {
  name: 'launch-table',
  async build(ctx, pinned) {
    requireOpenStack(ctx, 'launch-table')
    const payer = ctx.roles.payer, { base, inventory } = await launchTableInventory(ctx), existing = tableRecord(ctx)
    if (!existing) {
      let recentSlot = pinned?.recentSlot
      if (recentSlot === undefined) {
        const hashes = (await ctx.readers[0].connection.getAccountInfo(SYSVAR_SLOT_HASHES_PUBKEY, 'finalized'))?.data
        check(hashes && hashes.readBigUInt64LE(0) > 0n, 'SlotHashes sysvar unavailable')
        recentSlot = Number(hashes.readBigUInt64LE(8))
      }
      const [create, table] = ixOf(ctx).lookupCreate(payer, payer, recentSlot)
      const { review, blockhash } = await simpleMessage(ctx, { stage: 'launch-table', payer, instructions: [create, ixOf(ctx).lookupExtend(payer, payer, table.toBase58(), inventory)], pinned, snapshot: base, units: 30000 })
      return { observedSlot: base.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight, recentSlot },
        notes: ['step 1 of 2: create the shared launch table with the addresses every open launch shares; run plan/execute launch-table again to freeze it', `recent slot ${recentSlot} must still be in SlotHashes (~200 s) at execution`],
        sections: [{ title: 'shared launch lookup table', rows: [`table ${table.toBase58()} (authority and payer ${payer})`, `${inventory.length} addresses, sha256 ${sha256(JSON.stringify(inventory))}`, ...inventory.map((a, i) => `  [${i}] ${a}`)] }],
        expect: { step: 'create', table: table.toBase58(), recentSlot, inventory } }
    }
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [existing.address]), account = snapshot.accounts.get(existing.address)
    check(account && account.owner === ALT_PROGRAM, 'Recorded launch table is missing on chain; refusing to create a replacement silently')
    const data = Buffer.from(account.dataBase64, 'base64'), state = AddressLookupTableAccount.deserialize(data)
    check(isDeepStrictEqual(state.addresses.map(a => a.toBase58()), inventory), 'Launch table addresses differ from the shared open-launch addresses')
    if (!state.authority) return { blocked: `launch table ${existing.address} is complete and frozen; data sha256 ${sha256(data)} goes into the stack bundle (--launch-table)`, observedSlot: base.slot }
    check(state.authority.toBase58() === payer && state.deactivationSlot === 0xffffffffffffffffn, 'Launch table authority or activation differs')
    const freeze = AddressLookupTableProgram.freezeLookupTable({ lookupTable: new PublicKey(existing.address), authority: new PublicKey(payer) })
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'launch-table', payer, instructions: [freeze], pinned, snapshot: base, units: 30000 })
    return { observedSlot: base.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      notes: ['step 2 of 2: FREEZE the shared launch table. Irreversible: its addresses can never change and its rent stays locked'],
      sections: [{ title: 'freeze shared launch lookup table', rows: [`table ${existing.address}: ${inventory.length} addresses, authority ${payer} -> none (permanent)`] }],
      expect: { step: 'freeze', table: existing.address, inventory } }
  },
  async verify(ctx, expect) {
    if (expect.step === 'create') writeTableRecord(ctx, { address: expect.table, recentSlot: expect.recentSlot, authority: ctx.roles.payer, inventorySha256: sha256(JSON.stringify(expect.inventory)) })
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.table]), account = snapshot.accounts.get(expect.table)
    check(account, 'Launch table not visible')
    const data = Buffer.from(account.dataBase64, 'base64'), state = AddressLookupTableAccount.deserialize(data)
    check(isDeepStrictEqual(state.addresses.map(a => a.toBase58()), expect.inventory), 'Launch table contents differ from the reviewed inventory')
    if (expect.step === 'freeze') check(!state.authority, 'Launch table is not frozen')
    return [`launch table ${expect.table} holds the ${expect.inventory.length} shared open-launch addresses${expect.step === 'freeze' ? '; frozen; data sha256 ' + sha256(data) : ''}`]
  },
}

const PAUSES = Object.freeze({ creation: ['launch'], trading: ['swap'], both: ['launch', 'swap'] })
const pausedGate = role => role === 'launch' ? 'creation' : 'trading'
async function governances(ctx, roles) {
  const d = derivedAddresses(ctx.programs, ctx.quoteMint), address = role => role === 'launch' ? d.launchGovernance : d.swapGovernance
  const snapshot = await readAccounts(ctx.readers, ctx.genesis, [...roles.map(address), ctx.roles.payer, ctx.roles.guardian])
  return { snapshot, states: Object.fromEntries(roles.map(role => [role, cdecode(ctx, role, 'Governance', owned(snapshot.accounts, address(role), ctx.programs[role], `${role} governance`)).state])) }
}
export const guardianPause = {
  name: 'guardian-pause',
  async build(ctx, pinned) {
    const what = ctx.options?.pause
    check(Object.hasOwn(PAUSES, what ?? ''), 'guardian-pause requires --pause creation, trading or both')
    const { snapshot, states } = await governances(ctx, PAUSES[what])
    for (const [role, state] of Object.entries(states)) check(state.roles.guardian.toBase58() === ctx.roles.guardian, `${role} governance guardian differs from the guardian role`)
    const todo = Object.keys(states).filter(role => !states[role].gates[pausedGate(role)])
    if (!todo.length) return { blocked: `already paused: ${PAUSES[what].map(pausedGate).join(' and ')}`, observedSlot: snapshot.slot }
    const after = Object.fromEntries(todo.map(role => [role, nextState(states[role], { gates: { ...states[role].gates, [pausedGate(role)]: true } })]))
    const instructions = todo.map(role => ixOf(ctx).governancePause(ctx.programs, role, ctx.roles.guardian, ixOf(ctx).governanceCommitment(role, states[role]),
      { creation: role === 'launch', trading: role === 'swap' }))
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'guardian-pause', payer: ctx.roles.payer, instructions, pinned, snapshot, units: 40000 * instructions.length })
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'guardian pause (emergency stop)', rows: [...todo.map(role => role === 'launch' ? 'creation: every new launch is refused on chain (CreationPaused) until the admin runs open-launches'
        : 'trading: every buy and sell is refused on chain until the admin runs open-trading'), 'the guardian signs; the payer pays the network fee; nothing else changes',
        'coins and their pages stay; sent operations stay readable and settle'] },
        ...todo.map(role => gsection(ctx, role, states[role], after[role])),
        { title: 'funds', rows: [payerRow(ctx, snapshot), 'no SOL or token transfer besides the network fee'] }],
      expect: { commitments: Object.fromEntries(todo.map(role => [role, hex(ixOf(ctx).governanceCommitment(role, after[role]))])) } }
  },
  async verify(ctx, expect) {
    const { states } = await governances(ctx, Object.keys(expect.commitments))
    for (const [role, commitment] of Object.entries(expect.commitments)) {
      check(states[role].gates[pausedGate(role)] === true, `${role} is not paused`)
      check(gview(ctx, role, states[role]).commitment === commitment, `${role} governance commitment differs from the predicted post-state`)
    }
    return Object.keys(expect.commitments).map(role => `${pausedGate(role)} paused (${role} governance commitment ${expect.commitments[role]})`)
  },
}
export const openCreationStages = Object.freeze({ 'open-creation': openCreation, 'launch-fee': launchFee, 'launch-table': launchTable, 'guardian-pause': guardianPause })
