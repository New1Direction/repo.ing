// First-time setup of our own stack (--stack FILE --stack-idls DIR): hook-lab's independent build of token, gate, launch
// and swap at their own program IDs, with our own quote marker mint and no bridge. Each stage previews before anything is
// signed and verifies its post-state on chain. Order (the owner runbook): stack-verify, quote-marker, launch-config-init,
// swap-config-init, launch-governance-init, swap-governance-init, gate-finalize, launch-config, swap-config, launch-fee,
// launch-usd-bounds, native-launches --to on, open-creation --to on, launch-table (twice), trade-table (twice),
// open-launches, open-trading. Later: guardian-pause, collect-native.
//
// The configs start exactly as the legacy stack's did on deploy day (2026-10-18): paused, zero fees and ceilings, the
// standard curve, 1 SOL opening bounds; then the reviewed governed stages apply the approved economics one by one, each
// a recorded policy change.
import { isDeepStrictEqual } from 'node:util'
import BN from 'bn.js'
import { derivedAddresses, LOADER, pk } from '../pins.mjs'
import { value } from '../config.mjs'
import { readAccounts, rentExemption } from '../rpc.mjs'
import { plain, sol } from '../preview.mjs'
import { check, cdecode, gsection, gview, hex, owned, simpleMessage } from './common.mjs'
import { payerRow, programDataState } from './admin.mjs'

const ROLES = Object.freeze(['launch', 'swap', 'gate', 'token'])
const CONFIG_SIZE = Object.freeze({ launch: 250, swap: 189 }), GOVERNANCE_SIZE = 348
// The legacy stack's deploy-day starting state (mainnet launch and swap Configs before launch-config and swap-config).
export const LAUNCH_CONFIG_START = Object.freeze({ launch_fee_lamports: '0', lp_fee_bps: 0, max_creator_fee_bps: 0, sniper_window_secs: '0', sniper_start_bps: 0,
  curve_bps: 7500, supply: '1000000000000000', decimals: 6, min_virtual_quote: '1000000000', max_virtual_quote: '1000000000', paused: true,
  rule_bounds: Object.freeze({ max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: 0, min_max_wallet_bps: 1, max_max_wallet_bps: 1, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 }) })
export const SWAP_CONFIG_START = Object.freeze({ protocol_fee_bps: 0, pool_creation_fee_lamports: '0', paused: true, launch_protocol_share_bps: 0 })

export const requireStack = (ctx, stage) => check(ctx.stack, `${stage} sets up our own stack: pass --stack FILE --stack-idls DIR`)
const bn = v => new BN(String(v))
function startArgs(ctx, role) {
  const k = pk, r = ctx.roles
  if (role === 'launch') return { admin: k(r.admin), treasury: k(r.treasury), quote_mint: k(ctx.quoteMint), ...LAUNCH_CONFIG_START,
    launch_fee_lamports: bn(LAUNCH_CONFIG_START.launch_fee_lamports), sniper_window_secs: bn(0), supply: bn(LAUNCH_CONFIG_START.supply),
    min_virtual_quote: bn(LAUNCH_CONFIG_START.min_virtual_quote), max_virtual_quote: bn(LAUNCH_CONFIG_START.max_virtual_quote), rule_bounds: { ...LAUNCH_CONFIG_START.rule_bounds } }
  return { admin: k(r.admin), fee_collector: k(r.treasury), treasury: k(r.treasury), ...SWAP_CONFIG_START, pool_creation_fee_lamports: bn(0) }
}
// A deployed program of the stack: linked ProgramData holding the stack build's trimmed ELF, upgradeable only by the
// stack's upgrade authority (the gate may already be immutable).
function programRow(ctx, accounts, role) {
  const d = derivedAddresses(ctx.programs, ctx.quoteMint), address = ctx.programs[role], dataAddress = d[`${role}ProgramData`]
  const program = accounts.get(address), data = accounts.get(dataAddress)
  check(program && data, `${role} program ${address} is not deployed (program ${program ? 'present' : 'absent'}, ProgramData ${data ? 'present' : 'absent'})`)
  const link = Buffer.from(program.dataBase64, 'base64')
  check(program.owner === LOADER && program.executable && link.length === 36 && link.readUInt32LE(0) === 2 && pk(link.subarray(4)).toBase58() === dataAddress, `${role} program linkage differs`)
  const state = programDataState(data, ctx.elf[role])
  check(state.elfMatches, `${role} deployed code differs from the stack build's pin ${ctx.elf[role].sha256.slice(0, 12)}…`)
  check(state.authority === ctx.stack.upgradeAuthority || (role === 'gate' && state.authority === null), `${role} upgrade authority ${state.authority} is not the stack's ${ctx.stack.upgradeAuthority}`)
  return `${role.padEnd(6)} ${address}: ELF ${ctx.elf[role].sha256.slice(0, 16)}… (${ctx.elf[role].length} bytes) deploy slot ${state.deploySlot}; upgrade authority ${state.authority ?? 'NONE (immutable)'}`
}
const programAddresses = ctx => { const d = derivedAddresses(ctx.programs, ctx.quoteMint); return ROLES.flatMap(role => [ctx.programs[role], d[`${role}ProgramData`]]) }

// Read-only: the stack's four programs are deployed exactly as its build pins them. Nothing to execute.
export const stackVerify = {
  name: 'stack-verify',
  async build(ctx) {
    requireStack(ctx, 'stack-verify')
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, programAddresses(ctx))
    const rows = ROLES.map(role => programRow(ctx, snapshot.accounts, role))
    return { observedSlot: snapshot.slot, notes: ['read-only check: nothing to sign or execute'], verified: true,
      sections: [{ title: `our stack ${ctx.stack.id} (${ctx.stack.status}; build ${ctx.stack.build.name}, hook-lab ${ctx.stack.build.source.commit.slice(0, 12)})`, rows },
        { title: 'identity', rows: [`quote marker ${ctx.quoteMint}`, `upgrade authority ${ctx.stack.upgradeAuthority}`, `kit program (named by the launch code; its accounts stay absent) ${ctx.stack.kitProgram}`, 'no bridge on this stack'] }] }
  },
}

// Read-only: the quote marker is a canonical Mint of the stack's token program that nobody controls (no hook, no mint,
// freeze, hook or metadata authority), and the launch Config (once it exists) names it as its quote mint.
export const quoteMarker = {
  name: 'quote-marker',
  async build(ctx) {
    requireStack(ctx, 'quote-marker')
    const d = derivedAddresses(ctx.programs, ctx.quoteMint), snapshot = await readAccounts(ctx.readers, ctx.genesis, [ctx.quoteMint, d.launchConfig])
    const account = owned(snapshot.accounts, ctx.quoteMint, ctx.programs.token, 'quote marker')
    const bytes = Buffer.from(account.dataBase64, 'base64'), mint = cdecode(ctx, 'token', 'Mint', account)
    const encoded = Buffer.concat([bytes.subarray(0, 8), ctx.abi.coders.token.types.encode('Mint', mint)])
    check(bytes.subarray(0, encoded.length).equals(encoded) && bytes.subarray(encoded.length).every(b => b === 0), 'Quote marker is not a canonical Mint')
    check(mint.version === 1 && !mint.mint_authority && !mint.freeze_authority && !mint.hook_authority && !mint.metadata_authority && !mint.hook_program
      && mint.hook_flags === 0 && mint.hook_signer_bump === 0 && mint.reserved.every(v => v === 0), 'Quote marker has a hook or an authority; it must be inert')
    const config = snapshot.accounts.get(d.launchConfig)
    if (config) check(cdecode(ctx, 'launch', 'Config', config).quote_mint.toBase58() === ctx.quoteMint, 'The launch Config names another quote mint than the stack\'s marker')
    return { observedSlot: snapshot.slot, notes: ['read-only check: nothing to sign or execute'], verified: true,
      sections: [{ title: 'quote marker (internal: never shown to customers)', rows: [`mint ${ctx.quoteMint} owned by token program ${ctx.programs.token}`,
        `decimals ${mint.decimals}; supply ${mint.supply}; max supply ${mint.max_supply}; no mint, freeze, hook or metadata authority; no hook`,
        config ? 'the launch Config names it as quote mint' : 'launch Config not created yet (launch-config-init names it)'] }] }
  },
}

function configInitStage(role) {
  const stage = `${role}-config-init`
  return {
    name: stage,
    async build(ctx, pinned) {
      requireStack(ctx, stage)
      check(ctx.roles.upgrade === ctx.stack.upgradeAuthority, 'The config\'s upgrade role is not the stack\'s upgrade authority')
      const d = derivedAddresses(ctx.programs, ctx.quoteMint), config = role === 'launch' ? d.launchConfig : d.swapConfig
      const snapshot = await readAccounts(ctx.readers, ctx.genesis, [...programAddresses(ctx), config, ctx.quoteMint, ctx.roles.payer, ctx.roles.upgrade])
      if (snapshot.accounts.get(config)) return { blocked: `${role} Config ${config} already exists`, observedSlot: snapshot.slot }
      const programs = ROLES.map(r => programRow(ctx, snapshot.accounts, r))
      check(snapshot.accounts.get(ctx.quoteMint)?.owner === ctx.programs.token, 'The quote marker does not exist yet; hook-lab\'s deploy creates it (run quote-marker)')
      const args = startArgs(ctx, role), rent = BigInt((await rentExemption(ctx.readers, [CONFIG_SIZE[role]]))[CONFIG_SIZE[role]])
      const instruction = ctx.ix.initConfig(ctx.programs, role, { authority: ctx.roles.upgrade, payer: ctx.roles.payer, args })
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000, instructionDebitLamports: String(rent) })
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: `${role} Config (new account ${config})`, rows: Object.entries(plain(args)).map(([k, v]) => `${k}: ${JSON.stringify(v)}`) },
          { title: 'starting state', rows: ['paused, zero fees and ceilings, 1 SOL opening bounds: as the legacy stack started on deploy day; the governed stages that follow apply the approved economics',
            role === 'launch' ? `quote mint = our quote marker ${ctx.quoteMint}` : `fee collector and treasury = treasury ${ctx.roles.treasury}`] },
          { title: 'deployed programs (checked)', rows: programs },
          { title: 'funds', rows: [payerRow(ctx, snapshot), `rent ${sol(rent)} paid by payer for the ${CONFIG_SIZE[role]}-byte Config; the upgrade authority signs`] }],
        expect: { role, config, args: plain(args) } }
    },
    async verify(ctx, expect) {
      const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.config])
      const c = cdecode(ctx, role, 'Config', owned(snapshot.accounts, expect.config, ctx.programs[role], `${role} config`))
      const args = plain(role === 'launch' ? ctx.ix.launchConfigArgs(c) : ctx.ix.swapConfigArgs(c))
      check(isDeepStrictEqual(args, expect.args) && c.version === 1 && (role === 'launch' ? c.launches : c.pools_created).isZero() && c.reserved.every(v => v === 0), `${role} Config differs from the reviewed starting state`)
      return [`${role} Config ${expect.config} created: ${JSON.stringify(args)}`]
    },
  }
}

// The governance a fresh init_governance writes: revision 0, the gates mirroring the paused Config (launch: creation
// closed; swap: trading closed), the economics digest of the Config as it stands, and the four roles.
function initialState(ctx, role, config, guardian, custodyDigest) {
  const d = derivedAddresses(ctx.programs, ctx.quoteMint), args = role === 'launch' ? ctx.ix.launchConfigArgs(config) : ctx.ix.swapConfigArgs(config)
  return { genesis: [...pk(ctx.genesis).toBuffer()], program: pk(ctx.programs[role]), config: pk(role === 'launch' ? d.launchConfig : d.swapConfig),
    roles: { upgrade: pk(ctx.stack.upgradeAuthority), admin: config.admin, treasury: config.treasury, guardian: pk(guardian) }, revision: new BN(0),
    gates: role === 'launch' ? { creation: config.paused, trading: false } : { creation: false, trading: config.paused },
    config_digest: [...ctx.ix.economicsDigest(role, ctx.programs[role], args)], custody_digest: [...custodyDigest], pending_admin: null }
}
function governanceInitStage(role) {
  const stage = `${role}-governance-init`
  return {
    name: stage,
    async build(ctx, pinned) {
      requireStack(ctx, stage)
      const custody = value(ctx.config, 'stackCustodyDigest')
      check(typeof custody === 'string', `${stage} needs stackCustodyDigest in the config file (the custody manifest digest the governance records); it is never defaulted`)
      const d = derivedAddresses(ctx.programs, ctx.quoteMint), config = role === 'launch' ? d.launchConfig : d.swapConfig, governance = role === 'launch' ? d.launchGovernance : d.swapGovernance
      const snapshot = await readAccounts(ctx.readers, ctx.genesis, [...programAddresses(ctx), config, governance, ctx.roles.payer])
      if (snapshot.accounts.get(governance)) return { blocked: `${role} governance ${governance} already exists`, observedSlot: snapshot.slot }
      ROLES.forEach(r => programRow(ctx, snapshot.accounts, r))
      const c = cdecode(ctx, role, 'Config', owned(snapshot.accounts, config, ctx.programs[role], `${role} config (run ${role}-config-init first)`))
      check(c.admin.toBase58() === ctx.roles.admin, `${role} Config admin is not the admin role`)
      const digestBytes = Buffer.from(custody, 'hex'), state = initialState(ctx, role, c, ctx.roles.guardian, digestBytes)
      const rent = BigInt((await rentExemption(ctx.readers, [GOVERNANCE_SIZE]))[GOVERNANCE_SIZE])
      const instruction = ctx.ix.initGovernance(ctx.programs, role, { admin: ctx.roles.admin, payer: ctx.roles.payer, genesis: ctx.genesis, guardian: ctx.roles.guardian, custodyDigest: digestBytes })
      const { review, blockhash } = await simpleMessage(ctx, { stage, payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 60000, instructionDebitLamports: String(rent) })
      const view = gview(ctx, role, state)
      return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
        sections: [{ title: `${role} governance (new account ${governance})`, rows: [`genesis ${ctx.genesis}`, `roles: upgrade ${ctx.stack.upgradeAuthority}; admin ${ctx.roles.admin}; treasury ${c.treasury.toBase58()}; guardian ${ctx.roles.guardian}`,
          `revision 0; gates creation=${view.gates.creation} trading=${view.gates.trading} (true = closed; mirrors the paused Config)`, `custody digest ${custody}`, `predicted commitment ${view.commitment}`] },
          { title: 'funds', rows: [payerRow(ctx, snapshot), `rent ${sol(rent)} paid by payer for the ${GOVERNANCE_SIZE}-byte governance; the admin signs`] }],
        expect: { role, governance, commitment: view.commitment } }
    },
    async verify(ctx, expect) {
      const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.governance])
      const g = cdecode(ctx, role, 'Governance', owned(snapshot.accounts, expect.governance, ctx.programs[role], `${role} governance`))
      check(gview(ctx, role, g.state).commitment === expect.commitment, `${role} governance differs from the predicted initial state`)
      return [`${role} governance ${expect.governance} initialized; commitment ${expect.commitment}`]
    },
  }
}

// collect-native --mint MINT: our stack's platform share of one coin's native-SOL fees, to the swap Config's fee
// collector (the treasury), through collect_protocol_fees_native. Permissionless: the payer cranks it.
export const collectNative = {
  name: 'collect-native',
  async build(ctx, pinned) {
    requireStack(ctx, 'collect-native')
    const mint = ctx.options?.mint
    check(typeof mint === 'string' && pk(mint).toBase58() === mint, 'collect-native requires --mint MINT (the coin whose platform fees to collect)')
    const d = derivedAddresses(ctx.programs, ctx.quoteMint), S = ctx.programs.swap
    const instruction = ctx.ix.collectProtocolFeesNative(ctx.programs, ctx.quoteMint, { cranker: ctx.roles.payer, mint, collector: ctx.roles.treasury })
    const pool = instruction.keys[2].pubkey.toBase58(), policy = instruction.keys[6].pubkey.toBase58()
    check(ctx.abi.idls.swap.instructions.some(ix => ix.name === 'collect_protocol_fees_native'), 'The stack\'s swap build has no collect_protocol_fees_native')
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [d.swapConfig, pool, policy, ctx.roles.payer, ctx.roles.treasury])
    const config = cdecode(ctx, 'swap', 'Config', owned(snapshot.accounts, d.swapConfig, S, 'swap config'))
    check(config.fee_collector.toBase58() === ctx.roles.treasury, 'The swap Config\'s fee collector is not the treasury role')
    const p = cdecode(ctx, 'swap', 'Pool', owned(snapshot.accounts, pool, S, 'pool'))
    check(p.base_mint.toBase58() === mint && p.quote_mint.toBase58() === ctx.quoteMint, 'Pool binding differs')
    owned(snapshot.accounts, policy, S, 'inclusive fee policy')
    const owed = BigInt(p.protocol_fees_quote.toString())
    if (owed === 0n) return { blocked: `nothing to collect: pool ${pool} holds no platform fees`, observedSlot: snapshot.slot }
    const { review, blockhash } = await simpleMessage(ctx, { stage: 'collect-native', payer: ctx.roles.payer, instructions: [instruction], pinned, snapshot, units: 100000 })
    const before = snapshot.accounts.get(ctx.roles.treasury)?.lamports ?? '0'
    return { observedSlot: snapshot.slot, review, pinned: { blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight },
      sections: [{ title: 'platform fee collection (native SOL)', rows: [`pool ${pool} (coin ${mint}) owes ${sol(owed)} to the treasury ${ctx.roles.treasury}`,
        `treasury balance ${sol(before)} -> ${sol(BigInt(before) + owed)}`, 'the creator\'s share stays with the launch account (the creator claims it in SOL)'] },
        { title: 'funds', rows: [payerRow(ctx, snapshot), 'the payer only cranks (network fee)'] }],
      expect: { pool, owed: String(owed), treasuryBefore: String(before) } }
  },
  async verify(ctx, expect) {
    const snapshot = await readAccounts(ctx.readers, ctx.genesis, [expect.pool, ctx.roles.treasury])
    const p = cdecode(ctx, 'swap', 'Pool', owned(snapshot.accounts, expect.pool, ctx.programs.swap, 'pool'))
    check(p.protocol_fees_quote.isZero(), 'The pool still owes platform fees')
    check(BigInt(snapshot.accounts.get(ctx.roles.treasury)?.lamports ?? 0) >= BigInt(expect.treasuryBefore) + BigInt(expect.owed), 'The treasury did not receive the platform fees')
    return [`collected ${sol(expect.owed)} from ${expect.pool} to the treasury`]
  },
}

export const stackStages = Object.freeze({ 'stack-verify': stackVerify, 'quote-marker': quoteMarker,
  'launch-config-init': configInitStage('launch'), 'swap-config-init': configInitStage('swap'),
  'launch-governance-init': governanceInitStage('launch'), 'swap-governance-init': governanceInitStage('swap'), 'collect-native': collectNative })
// Stages that only make sense on the legacy (bridged, invited) stack.
export const LEGACY_ONLY_STAGES = Object.freeze(new Set(['grant', 'customer-grant', 'alt', 'canary-prepare', 'canary-gates-open-creation', 'canary-launch',
  'canary-gates-close-creation', 'canary-holdings', 'canary-buy', 'canary-sell', 'collect']))
export const STACK_ONLY_STAGES = Object.freeze(new Set(Object.keys(stackStages)))
export const STACK_STAGE_ORDER = Object.freeze(['stack-verify', 'quote-marker', 'launch-config-init', 'swap-config-init', 'launch-governance-init', 'swap-governance-init',
  'gate-finalize', 'launch-config', 'swap-config', 'launch-fee', 'launch-usd-bounds', 'native-launches', 'open-creation', 'launch-table', 'trade-table',
  'open-launches', 'open-trading', 'guardian-pause', 'collect-native'])
