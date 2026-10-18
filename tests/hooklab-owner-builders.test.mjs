// Byte-level builder tests: JS ports versus the upstream SDK, pinned PDAs, and wire layouts.
import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { runSdk, sdkAvailable } from './fixtures/hooklab-owner-sdk.mjs'
import { PROGRAMS, QUOTE_MINT, MAINNET_ROLES, MAINNET_DERIVED, derivedAddresses, holdingAddress, authorizationAddress, canaryAddresses, LOADER, SYSTEM } from '../src/hooklab-owner-driver/pins.mjs'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import * as build from '../src/hooklab-owner-driver/instructions.mjs'

const hex = b => Buffer.from(b).toString('hex')
const k = v => new PublicKey(v)
const view = ix => ({ programId: ix.programId.toBase58(), dataHex: hex(ix.data), keys: ix.keys.map(m => ({ pubkey: m.pubkey.toBase58(), isSigner: m.isSigner, isWritable: m.isWritable })) })
const stateFixture = (program, config, revision, gates) => ({
  genesis: hex(new PublicKey('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d').toBuffer()), program, config,
  roles: { upgrade: MAINNET_ROLES.upgrade, admin: MAINNET_ROLES.admin, treasury: MAINNET_ROLES.treasury, guardian: MAINNET_ROLES.guardian },
  revision: String(revision), gates, configDigest: '8d839ce46d3ae0a6d90b12fec0e170e6bc19dea3b6ee8d1c9c70fc0c59dd4102', custodyDigest: '58ab093cc13198d5bb35e92df45e22cc7a0dd5e379c3f99acbd8c8b0c4c76e8a' })
const anchorState = s => ({ genesis: [...Buffer.from(s.genesis, 'hex')], program: k(s.program), config: k(s.config),
  roles: Object.fromEntries(Object.entries(s.roles).map(([r, v]) => [r, k(v)])), revision: new BN(s.revision), gates: s.gates,
  config_digest: [...Buffer.from(s.configDigest, 'hex')], custody_digest: [...Buffer.from(s.custodyDigest, 'hex')], pending_admin: null })
const d = derivedAddresses()
const launchState = stateFixture(PROGRAMS.launch, d.launchConfig, 7, { creation: true, trading: false })
const swapState = stateFixture(PROGRAMS.swap, d.swapConfig, 3, { creation: false, trading: true })
const expected = '11'.repeat(32)
const launchArgs = { admin: MAINNET_ROLES.admin, treasury: MAINNET_ROLES.treasury, quoteMint: QUOTE_MINT, launchFeeLamports: '0', lpFeeBps: 0, maxCreatorFeeBps: 100,
  sniperWindowSecs: 0, sniperStartBps: 0, curveBps: 7500, supply: '1000000000000000', decimals: 6, minVirtualQuote: '1000000000', maxVirtualQuote: '1000000000', paused: true,
  ruleBounds: { maxHolderFeeBps: 0, maxBurnBps: 0, maxRulesFeeBps: 100, minMaxWalletBps: 1, maxMaxWalletBps: 1, maxCreatorLockSecs: 0, maxEarlyWindowSecs: 0, maxEarlyLockSecs: 0 } }
const swapArgs = { admin: MAINNET_ROLES.admin, protocolFeeBps: 0, feeCollector: MAINNET_ROLES.treasury, treasury: MAINNET_ROLES.treasury, poolCreationFeeLamports: '0', paused: true, launchProtocolShareBps: 2500 }
const snake = a => ({ admin: k(a.admin), treasury: k(a.treasury), quote_mint: k(a.quoteMint), launch_fee_lamports: new BN(a.launchFeeLamports), lp_fee_bps: a.lpFeeBps,
  max_creator_fee_bps: a.maxCreatorFeeBps, sniper_window_secs: new BN(a.sniperWindowSecs), sniper_start_bps: a.sniperStartBps, curve_bps: a.curveBps, supply: new BN(a.supply),
  decimals: a.decimals, min_virtual_quote: new BN(a.minVirtualQuote), max_virtual_quote: new BN(a.maxVirtualQuote), paused: a.paused,
  rule_bounds: { max_holder_fee_bps: 0, max_burn_bps: 0, max_rules_fee_bps: a.ruleBounds.maxRulesFeeBps, min_max_wallet_bps: 1, max_max_wallet_bps: 1, max_creator_lock_secs: 0, max_early_window_secs: 0, max_early_lock_secs: 0 } })

test('pinned PDAs reproduce independently recorded mainnet addresses', () => {
  for (const name of ['launchConfig', 'launchGovernance', 'swapConfig', 'swapGovernance', 'gateProgramData', 'bridgeConfig', 'bridgeSolVault', 'bridgeNativeWrapper']) assert.equal(d[name], MAINNET_DERIVED[name], name)
  assert.equal(holdingAddress(QUOTE_MINT, MAINNET_ROLES.creator), MAINNET_DERIVED.creatorQuote)
  assert.equal(holdingAddress(QUOTE_MINT, MAINNET_ROLES.treasury), MAINNET_DERIVED.treasuryQuote)
  assert.equal(authorizationAddress(MAINNET_ROLES.creator), MAINNET_DERIVED.creatorAuthorization)
  const c = canaryAddresses(PROGRAMS, QUOTE_MINT, MAINNET_ROLES.mint)
  assert.equal(new Set(Object.values(c)).size, Object.keys(c).length)
})

test('pinned artifacts load only with reviewed hashes', () => {
  const a = loadArtifacts()
  assert.equal(a.idls.launch.address, PROGRAMS.launch)
  assert.equal(a.profile.capability.protocolShareBps, 2500)
})

test('JS builders are byte-identical to the upstream SDK builders with production program IDs', { skip: !sdkAvailable() && 'upstream SDK checkout not present' }, () => {
  const sdk = runSdk({ admin: MAINNET_ROLES.admin, payer: MAINNET_ROLES.payer, creator: MAINNET_ROLES.creator, expiresAtSlot: '458950000', maxLaunches: '1', expected, launchState, swapState, launchArgs, swapArgs })
  assert.equal(hex(build.governanceCommitment('launch', anchorState(launchState))), sdk.launchCommitment)
  assert.equal(hex(build.governanceCommitment('swap', anchorState(swapState))), sdk.swapCommitment)
  const exp = Buffer.from(expected, 'hex')
  assert.deepEqual(view(build.initCreatorAuthorization(PROGRAMS, { admin: MAINNET_ROLES.admin, payer: MAINNET_ROLES.payer, creator: MAINNET_ROLES.creator, expiresAtSlot: '458950000', maxLaunches: '1', expectedGovernance: exp })), sdk.grant)
  assert.deepEqual(view(build.governanceSetGates(PROGRAMS, 'launch', MAINNET_ROLES.admin, exp, { creation: false, trading: false })), sdk.gatesLaunch)
  assert.deepEqual(view(build.governanceSetGates(PROGRAMS, 'swap', MAINNET_ROLES.admin, exp, { creation: false, trading: true })), sdk.gatesSwap)
  assert.deepEqual(view(build.governedSetConfig(PROGRAMS, 'launch', MAINNET_ROLES.admin, exp, snake(launchArgs))), sdk.launchConfig)
  const s = swapArgs
  assert.deepEqual(view(build.governedSetConfig(PROGRAMS, 'swap', MAINNET_ROLES.admin, exp, { admin: k(s.admin), protocol_fee_bps: 0, fee_collector: k(s.feeCollector), treasury: k(s.treasury),
    pool_creation_fee_lamports: new BN(0), paused: true, launch_protocol_share_bps: 2500 })), sdk.swapConfig)
  assert.equal(sdk.grant.programId, PROGRAMS.launch)
})

test('loader finalization is SetAuthority tag 4 with no new authority', () => {
  const ix = build.loaderFinalize(MAINNET_DERIVED.gateProgramData, MAINNET_ROLES.upgrade)
  assert.equal(ix.programId.toBase58(), LOADER)
  assert.equal(hex(ix.data), '04000000')
  assert.deepEqual(view(ix).keys, [{ pubkey: MAINNET_DERIVED.gateProgramData, isSigner: false, isWritable: true }, { pubkey: MAINNET_ROLES.upgrade, isSigner: true, isWritable: false }])
})

test('collect_protocol_fees_sol matches the Rust client account order plus the inclusive policy', () => {
  const c = canaryAddresses(PROGRAMS, QUOTE_MINT, MAINNET_ROLES.mint)
  const ix = build.collectProtocolFeesSol(PROGRAMS, QUOTE_MINT, { cranker: MAINNET_ROLES.creator, pool: c.pool, collector: MAINNET_ROLES.treasury, inclusiveFeePolicy: c.inclusiveFeePolicy })
  const keys = view(ix).keys
  assert.deepEqual(keys.map(m => m.pubkey), [MAINNET_ROLES.creator, d.swapConfig, c.pool, c.quoteVault, MAINNET_ROLES.treasury, PROGRAMS.bridge, MAINNET_DERIVED.bridgeConfig,
    MAINNET_DERIVED.bridgeNativeWrapper, MAINNET_DERIVED.bridgeSolVault, QUOTE_MINT, d.bridgeEventAuthority, PROGRAMS.token, d.tokenEventAuthority, SYSTEM, d.swapEventAuthority, PROGRAMS.swap, c.inclusiveFeePolicy])
  assert.deepEqual(keys.map(m => m.isWritable), [false, false, true, true, true, false, false, true, true, true, false, false, false, false, false, false, false])
  assert.deepEqual(keys.map(m => m.isSigner), [true, ...Array(16).fill(false)])
  // Anchor discriminator sha256("global:collect_protocol_fees_sol")[0..8], no args.
  assert.equal(ix.data.length, 8)
})

test('wrap_sol uses production bridge derivations only', () => {
  const ix = build.wrapSol(PROGRAMS, QUOTE_MINT, { user: MAINNET_ROLES.creator, lamports: '2000000' })
  assert.equal(ix.programId.toBase58(), PROGRAMS.bridge)
  const keys = view(ix).keys.map(m => m.pubkey)
  assert.deepEqual(keys, [MAINNET_ROLES.creator, MAINNET_DERIVED.bridgeConfig, MAINNET_DERIVED.bridgeNativeWrapper, MAINNET_DERIVED.bridgeSolVault, QUOTE_MINT,
    MAINNET_DERIVED.creatorQuote, PROGRAMS.token, d.tokenEventAuthority, SYSTEM, d.bridgeEventAuthority, PROGRAMS.bridge])
  assert.equal(ix.data.subarray(8).readBigUInt64LE(), 2000000n)
})

test('claim_creator_fees, create_holding and quote collection bind production programs', () => {
  const c = canaryAddresses(PROGRAMS, QUOTE_MINT, MAINNET_ROLES.mint)
  const claim = view(build.claimCreatorFees(PROGRAMS, QUOTE_MINT, { creator: MAINNET_ROLES.creator, launch: c.launch }))
  assert.equal(claim.keys[3].pubkey, c.launchQuote); assert.equal(claim.keys[4].pubkey, MAINNET_DERIVED.creatorQuote)
  const holding = view(build.createHolding(PROGRAMS, { payer: MAINNET_ROLES.creator, mint: MAINNET_ROLES.mint, owner: MAINNET_ROLES.creator }))
  assert.equal(holding.programId, PROGRAMS.token); assert.equal(holding.keys[3].pubkey, holdingAddress(MAINNET_ROLES.mint, MAINNET_ROLES.creator))
  assert.equal(holding.keys.at(-1).pubkey, PROGRAMS.token)
  const quote = view(build.collectProtocolFeesQuote(PROGRAMS, QUOTE_MINT, { admin: MAINNET_ROLES.admin, pool: c.pool, collector: MAINNET_ROLES.treasury, inclusiveFeePolicy: c.inclusiveFeePolicy }))
  assert.equal(quote.keys[5].pubkey, MAINNET_DERIVED.treasuryQuote); assert.equal(quote.keys.at(-1).pubkey, c.inclusiveFeePolicy)
})

test('economics digest matches the on-chain mainnet swap governance digest for the current swap config', () => {
  // Current mainnet swap config (2026-10-18): protocol 0, share 0, fee collector = treasury, paused.
  const digest = build.economicsDigest('swap', PROGRAMS.swap, { admin: k(MAINNET_ROLES.admin), protocol_fee_bps: 0, fee_collector: k(MAINNET_ROLES.treasury),
    treasury: k(MAINNET_ROLES.treasury), pool_creation_fee_lamports: new BN(0), paused: true, launch_protocol_share_bps: 0 })
  const onchain = [32, 2, 216, 73, 87, 110, 161, 72, 138, 98, 211, 209, 80, 66, 167, 1, 106, 33, 124, 186, 14, 151, 65, 186, 254, 201, 25, 195, 125, 136, 40, 2]
  assert.equal(hex(digest), hex(onchain))
})
