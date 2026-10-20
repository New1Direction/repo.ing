// IDL-driven instruction builders for the owner driver. Pure: no RPC, keys or signing.
// Every builder takes explicit production program IDs (never SDK fixture defaults).
import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { AddressLookupTableProgram, ComputeBudgetProgram, SystemProgram, TransactionInstruction } from '@solana/web3.js'
import { loadArtifacts } from './artifacts.mjs'
import { LOADER, SYSTEM, NATIVE_MINT, pk, kb, pda, holdingAddress, derivedAddresses, authorizationAddress } from './pins.mjs'

const check = (ok, message) => { if (!ok) throw Error(message) }
const digest = (...parts) => createHash('sha256').update(Buffer.concat(parts.map(p => Buffer.from(p)))).digest()
const bytes32 = value => { const b = Buffer.from(value); check(b.length === 32, 'Expected a 32-byte commitment'); return [...b] }
const u64 = value => { const v = BigInt(String(value)); check(v >= 0n && v <= 0xffffffffffffffffn, 'Expected u64'); return new BN(v.toString(10)) }

export const transfer = (from, to, lamports) => SystemProgram.transfer({ fromPubkey: pk(from), toPubkey: pk(to), lamports: BigInt(String(lamports)) })
export const lookupCreate = (authority, payer, recentSlot) => AddressLookupTableProgram.createLookupTable({ authority: pk(authority), payer: pk(payer), recentSlot })
export const lookupExtend = (authority, payer, table, addresses) => AddressLookupTableProgram.extendLookupTable({ authority: pk(authority), payer: pk(payer), lookupTable: pk(table), addresses: addresses.map(pk) })
export const budget = (units, microLamports) => [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: BigInt(String(microLamports)) })]
// Builders bound to one program stack's ABI: the legacy bundle-2 IDLs (the named exports below) or our own stack's IDLs
// (ctx.ix in the owner driver: instructionsFor(stack abi)). abiSource: { idls, coders } or a function returning them.
export function instructionsFor(abiSource) {
  const abi = () => typeof abiSource === 'function' ? abiSource() : abiSource
  /** Encode an Anchor instruction from the pinned IDL. Fixed IDL addresses must match unless the IDL
   * is a cross-network artifact (token/bridge), where the explicit production program ID wins. */
  function idlInstruction(role, name, args, values, { programId, remaining = [], crossNetworkIdl = false } = {}) {
    const { idls, coders } = abi()
    const definition = idls[role].instructions.find(ix => ix.name === name)
    check(definition, `Missing pinned ABI instruction ${role}.${name}`)
    const program = programId ?? idls[role].address
    const keys = definition.accounts.map(account => {
      const fixed = account.address
      const address = values[account.name] ?? (account.name === 'program' ? program : fixed)
      check(address, `Missing account ${role}.${name}.${account.name}`)
      if (fixed && !crossNetworkIdl) check(address === fixed, `Fixed account ${role}.${name}.${account.name} differs`)
      return { pubkey: pk(address), isSigner: !!account.signer, isWritable: !!account.writable }
    })
    return new TransactionInstruction({ programId: pk(program), keys: [...keys, ...remaining.map(m => ({ pubkey: pk(m.address), isSigner: !!m.signer, isWritable: !!m.writable }))],
      data: coders[role].instruction.encode(name, args) })
  }

  // Governance commitment = sha256("hook-lab/governance-state/1\0" || borsh(State)).
  function governanceCommitment(role, state) {
    return digest(Buffer.from('hook-lab/governance-state/1\0'), abi().coders[role].types.encode('State', state))
  }
  function economicsDigest(role, programId, configArgs) {
    const { coders } = abi()
    return digest(Buffer.from(`hook-lab/${role}-governed-economics/1\0`), kb(programId),
      coders[role].types.encode('ConfigArgs', { ...configArgs, admin: pk(SYSTEM), treasury: pk(SYSTEM), paused: false }))
  }
  function launchConfigArgs(config) {
    return { admin: config.admin, treasury: config.treasury, quote_mint: config.quote_mint, launch_fee_lamports: config.launch_fee_lamports,
      lp_fee_bps: config.lp_fee_bps, max_creator_fee_bps: config.max_creator_fee_bps, sniper_window_secs: config.sniper_window_secs,
      sniper_start_bps: config.sniper_start_bps, curve_bps: config.curve_bps, supply: config.supply, decimals: config.decimals,
      min_virtual_quote: config.min_virtual_quote, max_virtual_quote: config.max_virtual_quote, paused: config.paused, rule_bounds: { ...config.rule_bounds } }
  }
  function swapConfigArgs(config) {
    return { admin: config.admin, protocol_fee_bps: config.protocol_fee_bps, fee_collector: config.fee_collector, treasury: config.treasury,
      pool_creation_fee_lamports: config.pool_creation_fee_lamports, paused: config.paused, launch_protocol_share_bps: config.launch_protocol_share_bps }
  }
  const governKeys = (programs, role, authority) => {
    const d = derivedAddresses(programs)
    return { authority, config: role === 'launch' ? d.launchConfig : d.swapConfig, governance: role === 'launch' ? d.launchGovernance : d.swapGovernance }
  }
  function governedSetConfig(programs, role, admin, expected, args) {
    return idlInstruction(role, 'governed_set_config', { expected: bytes32(expected), args }, governKeys(programs, role, admin), { programId: programs[role] })
  }
  function governanceSetGates(programs, role, admin, expected, gates) {
    return idlInstruction(role, 'governance_action', { expected: bytes32(expected), action: { SetGates: [{ creation: !!gates.creation, trading: !!gates.trading }] } },
      governKeys(programs, role, admin), { programId: programs[role] })
  }
  function initCreatorAuthorization(programs, { admin, payer, creator, enabled = true, expiresAtSlot, maxLaunches, expectedGovernance }) {
    const d = derivedAddresses(programs)
    return idlInstruction('launch', 'init_creator_authorization', { creator: pk(creator),
      args: { enabled: !!enabled, expires_at_slot: u64(expiresAtSlot), max_launches: u64(maxLaunches) }, expected_governance: bytes32(expectedGovernance) },
    { admin, payer, config: d.launchConfig, governance: d.launchGovernance, authorization: authorizationAddress(creator, programs.launch), system_program: SYSTEM },
    { programId: programs.launch })
  }
  // Re-enable an existing creator grant (lifetime quota never resets; consumed launches stay counted).
  function setCreatorAuthorization(programs, { admin, creator, enabled = true, expiresAtSlot, maxLaunches, expectedGovernance }) {
    const d = derivedAddresses(programs)
    return idlInstruction('launch', 'set_creator_authorization', {
      args: { enabled: !!enabled, expires_at_slot: u64(expiresAtSlot), max_launches: u64(maxLaunches) }, expected_governance: bytes32(expectedGovernance) },
    { admin, config: d.launchConfig, governance: d.launchGovernance, authorization: authorizationAddress(creator, programs.launch) },
    { programId: programs.launch })
  }
  // Upgradeable loader SetAuthority (tag 4) without a new authority: irreversible immutability.
  function loaderFinalize(programData, currentAuthority) {
    return new TransactionInstruction({ programId: pk(LOADER), data: Buffer.from([4, 0, 0, 0]),
      keys: [{ pubkey: pk(programData), isSigner: false, isWritable: true }, { pubkey: pk(currentAuthority), isSigner: true, isWritable: false }] })
  }
  function createHolding(programs, { payer, mint, owner }) {
    const d = derivedAddresses(programs)
    return idlInstruction('token', 'create_holding', {}, { payer, mint, owner, holding: holdingAddress(mint, owner, programs.token),
      system_program: SYSTEM, event_authority: d.tokenEventAuthority, program: programs.token }, { programId: programs.token, crossNetworkIdl: true })
  }
  function claimCreatorFees(programs, quoteMint, { creator, launch }) {
    const d = derivedAddresses(programs)
    return idlInstruction('launch', 'claim_creator_fees', {}, { creator, launch, quote_mint: quoteMint, launch_quote: holdingAddress(quoteMint, launch, programs.token),
      creator_quote: holdingAddress(quoteMint, creator, programs.token), token_program: programs.token, token_event_authority: d.tokenEventAuthority,
      event_authority: d.launchEventAuthority }, { programId: programs.launch })
  }
  // Admin-signed quote-token route (used where no bridge exists, e.g. the local validator).
  function collectProtocolFeesQuote(programs, quoteMint, { admin, pool, collector, inclusiveFeePolicy }) {
    const d = derivedAddresses(programs)
    return idlInstruction('swap', 'collect_protocol_fees', { quote_hook_accounts: 0 }, { admin, config: d.swapConfig, pool, quote_mint: quoteMint,
      quote_vault: holdingAddress(quoteMint, pool, programs.token), collector_quote: holdingAddress(quoteMint, collector, programs.token),
      token_program: programs.token, token_event_authority: d.tokenEventAuthority, event_authority: d.swapEventAuthority },
    { programId: programs.swap, remaining: [{ address: inclusiveFeePolicy }] })
  }
  // Permissionless SOL route: the bridge unwraps the pool's bridged-SOL protocol fees to the collector.
  function collectProtocolFeesSol(programs, quoteMint, { cranker, pool, collector, inclusiveFeePolicy }) {
    const d = derivedAddresses(programs)
    return idlInstruction('swap', 'collect_protocol_fees_sol', {}, { cranker, config: d.swapConfig, pool, quote_vault: holdingAddress(quoteMint, pool, programs.token),
      collector, bridge_program: programs.bridge, bridge_config: d.bridgeConfig, sol_wrapper: d.bridgeNativeWrapper, sol_vault: d.bridgeSolVault,
      bridged_sol_mint: quoteMint, bridge_event_authority: d.bridgeEventAuthority, token_program: programs.token, token_event_authority: d.tokenEventAuthority,
      system_program: SYSTEM, event_authority: d.swapEventAuthority }, { programId: programs.swap, remaining: [{ address: inclusiveFeePolicy }] })
  }
  // Bridge wrap_sol into the user's existing quote holding. The vendored bridge IDL names a non-production
  // address; only its discriminator/layout is reused, every account is the production derivation.
  function wrapSol(programs, quoteMint, { user, lamports }) {
    const d = derivedAddresses(programs)
    return idlInstruction('bridge', 'wrap_sol', { lamports: u64(lamports) }, { user, config: d.bridgeConfig, wrapper: d.bridgeNativeWrapper, sol_vault: d.bridgeSolVault,
      wrapped_mint: quoteMint, user_wrapped: holdingAddress(quoteMint, user, programs.token), token_program: programs.token, token_event_authority: d.tokenEventAuthority,
      system_program: SYSTEM, event_authority: d.bridgeEventAuthority, program: programs.bridge }, { programId: programs.bridge, crossNetworkIdl: true })
  }
  // Bridge unwrap_sol: burns `amount` raw bridged SOL from the user's quote holding and pays the same lamports out of
  // the bridge vault to the user. Same eleven accounts as wrap_sol.
  function unwrapSol(programs, quoteMint, { user, amount }) {
    const d = derivedAddresses(programs)
    return idlInstruction('bridge', 'unwrap_sol', { amount: u64(amount) }, { user, config: d.bridgeConfig, wrapper: d.bridgeNativeWrapper, sol_vault: d.bridgeSolVault,
      wrapped_mint: quoteMint, user_wrapped: holdingAddress(quoteMint, user, programs.token), token_program: programs.token, token_event_authority: d.tokenEventAuthority,
      system_program: SYSTEM, event_authority: d.bridgeEventAuthority, program: programs.bridge }, { programId: programs.bridge, crossNetworkIdl: true })
  }
  // kit: the kit program the stack's launch code names (src/hooklab-stack.mjs kitOf). The token program's signer of its
  // callbacks is a fixed graduate account even for coins without a kit.
  // Permissionless `graduate` for a Hooks coin. Builds only: nothing here signs or sends it. Hooks coins have no kit, so
  // its five optional accounts are absent, passed as the launch program's id read-only (as the program's own client
  // does). The max-wallet gate is the custom hook, so its slice follows as remaining accounts: the gate, the token
  // program's signer for it, then its registry's extras (policy, launch), all read-only as the registry lists them.
  // graduate's token_hook_signer: the token program's signer for the kit (bundle 2 and the builds before the independent
  // stack) or for the gate (hook-lab independent e775165, its TOKEN_HOOK_AUTHORITY). The launch IDL fixes which one;
  // nothing else is accepted.
  function tokenHookSigner(accounts, T, kit, G) {
    const forKit = pda(T, 'hook-authority', kb(kit)), fixed = accounts.find(a => a.name === 'token_hook_signer')?.address
    if (!fixed) return forKit
    check([forKit, pda(T, 'hook-authority', kb(G))].includes(fixed), 'Fixed account launch.graduate.token_hook_signer differs')
    return fixed
  }
  function graduateHookCoin(programs, quoteMint, { cranker, mint, kit }) {
    check(kit, 'The kit program is required (it comes from the stack\'s profile)')
    const { launch: L, swap: S, gate: G, token: T } = programs, d = derivedAddresses(programs, quoteMint)
    const launch = pda(L, 'launch', kb(mint)), pool = pda(S, 'pool', kb(mint), kb(quoteMint), Buffer.alloc(2), kb(L)), lpMint = pda(S, 'lp', kb(pool))
    const accounts = abi().idls.launch.instructions.find(ix => ix.name === 'graduate').accounts
    const absent = Object.fromEntries(accounts.filter(a => a.optional).map(a => [a.name, L]))
    const ix = idlInstruction('launch', 'graduate', {}, { cranker: pk(cranker).toBase58(), launch, mint, quote_mint: quoteMint, pool,
      launch_reserve: holdingAddress(mint, launch, T), base_vault: holdingAddress(mint, pool, T), quote_vault: holdingAddress(quoteMint, pool, T), lp_mint: lpMint,
      launch_lp: holdingAddress(lpMint, launch, T), hook_signer: pda(L, 'hook-authority'), swap_program: S, dex_event_authority: d.swapEventAuthority, token_program: T,
      token_hook_signer: tokenHookSigner(accounts, T, kit, G), token_event_authority: d.tokenEventAuthority, ...absent, event_authority: d.launchEventAuthority },
    { programId: L, remaining: [{ address: G }, { address: pda(T, 'hook-authority', kb(G)) }, { address: pda(G, 'policy-v2', kb(mint)) }, { address: launch }] })
    return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((k, i) => accounts[i]?.optional ? { ...k, isWritable: false } : k) })
  }

  // Our own stack's first-time setup (owner-driver stack stages): init_config_v2, the upgrade authority signs and the payer
  // pays the rent; init_governance, the admin signs and the payer pays.
  function initConfig(programs, role, { authority, payer, args }) {
    const d = derivedAddresses(programs), program = programs[role]
    return idlInstruction(role, 'init_config_v2', { args }, { authority, payer, config: role === 'launch' ? d.launchConfig : d.swapConfig,
      program_data: role === 'launch' ? d.launchProgramData : d.swapProgramData, system_program: SYSTEM,
      event_authority: role === 'launch' ? d.launchEventAuthority : d.swapEventAuthority, program }, { programId: program })
  }
  function initGovernance(programs, role, { admin, payer, genesis, guardian, custodyDigest }) {
    const d = derivedAddresses(programs), program = programs[role]
    return idlInstruction(role, 'init_governance', { args: { genesis: bytes32(pk(genesis).toBuffer()), guardian: pk(guardian), custody_digest: bytes32(custodyDigest) } },
      { admin, payer, config: role === 'launch' ? d.launchConfig : d.swapConfig, governance: role === 'launch' ? d.launchGovernance : d.swapGovernance,
        program_data: role === 'launch' ? d.launchProgramData : d.swapProgramData, system_program: SYSTEM }, { programId: program })
  }
  // The guardian's emergency pause: governance_action Pause(Gates). gates names what to close (true = close); the guardian
  // has no action that opens anything.
  function governancePause(programs, role, guardian, expected, gates) {
    check(gates.creation || gates.trading, 'A pause closes at least one gate')
    return idlInstruction(role, 'governance_action', { expected: bytes32(expected), action: { Pause: [{ creation: !!gates.creation, trading: !!gates.trading }] } },
      governKeys(programs, role, guardian), { programId: programs[role] })
  }
  // Our own stack's platform fee collection (hook-lab independent build; collect_protocol_fees_sol and the bridge do not
  // exist there): collect_protocol_fees_native, no arguments. Accounts: cranker (signer), config, pool (writable), collector
  // (writable), event authority, program; remaining: the pool's InclusiveFeePolicy, read-only. Hand-encoded (the
  // discriminator is sha256("global:collect_protocol_fees_native")[..8]) and, when the stack's swap IDL has it, checked
  // against the IDL's own definition.
  function collectProtocolFeesNative(programs, quoteMint, { cranker, mint, collector }) {
    const S = programs.swap, L = programs.launch, d = derivedAddresses(programs, quoteMint)
    const pool = pda(S, 'pool', kb(mint), kb(quoteMint), Buffer.alloc(2), kb(L)), policy = pda(S, 'inclusive-fee-policy', kb(pool))
    const data = digest(Buffer.from('global:collect_protocol_fees_native')).subarray(0, 8)
    const keys = [[cranker, true, false], [d.swapConfig, false, false], [pool, false, true], [collector, false, true], [d.swapEventAuthority, false, false], [S, false, false]]
      .map(([address, isSigner, isWritable]) => ({ pubkey: pk(address), isSigner, isWritable }))
    const definition = abi().idls.swap.instructions.find(ix => ix.name === 'collect_protocol_fees_native')
    if (definition) check(Buffer.from(definition.discriminator).equals(data) && definition.args.length === 0
      && JSON.stringify(definition.accounts.map(a => [a.name, !!a.signer, !!a.writable])) === JSON.stringify([['cranker', true, false], ['config', false, false], ['pool', false, true],
        ['collector', false, true], ['event_authority', false, false], ['program', false, false]]), 'collect_protocol_fees_native ABI differs from the stack\'s swap IDL')
    return new TransactionInstruction({ programId: pk(S), data: Buffer.from(data), keys: [...keys, { pubkey: pk(policy), isSigner: false, isWritable: false }] })
  }
  return Object.freeze({ transfer, lookupCreate, lookupExtend, budget, idlInstruction, governanceCommitment, economicsDigest, launchConfigArgs, swapConfigArgs, governedSetConfig, governanceSetGates, initCreatorAuthorization, setCreatorAuthorization, loaderFinalize, createHolding, claimCreatorFees, collectProtocolFeesQuote, collectProtocolFeesSol, wrapSol, unwrapSol, graduateHookCoin, initConfig, initGovernance, governancePause, collectProtocolFeesNative })
}
const LEGACY = instructionsFor(loadArtifacts)
export const { idlInstruction, governanceCommitment, economicsDigest, launchConfigArgs, swapConfigArgs, governedSetConfig, governanceSetGates, initCreatorAuthorization, setCreatorAuthorization, loaderFinalize, createHolding, claimCreatorFees, collectProtocolFeesQuote, collectProtocolFeesSol, wrapSol, unwrapSol, graduateHookCoin, initConfig, initGovernance, governancePause, collectProtocolFeesNative } = LEGACY
export { NATIVE_MINT, pda }
