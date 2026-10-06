import { ComputeBudgetProgram, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { CollectFeeMode, DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, TokenType, deriveDbcEventAuthority,
  deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from './launch-curve.mjs'
import { DBC_PROGRAM_ID, configDifferences, instructionSha256 } from './launch-fee-config.mjs'
import { isApprovedLaunchFee, readFeeSchedule } from './launch-fee.mjs'
import { earlyAccessCurveDifferences } from './early-access-config.mjs'
import { BUNDLE_VAULT_PROGRAM_ID, platformAddress, routerAddress } from './bundle-vault.mjs'

// The Bundle launch DBC config (docs/BUNDLE_LAUNCH.md): the 85 SOL launch-fee curve standard launches use, with the bundle
// program's router PDA as its fee claimer, so the partner share of every bundle market's fees is routed by the program (the
// vault's rebate, then backers and repo.ing) and never reaches the partner wallet. Built and checked before it is sent and again
// as the account on chain. Chain-agnostic: scripts/create-bundle-config.mjs (mainnet, dry run by default), the bundle launch path
// and the chain tests run exactly this code.

export const BUNDLE_CURVE_PROFILE = 'launch-fee'
export const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

// Anchor discriminators (DBC IDL, SDK 1.5.13): create_config and the PoolConfig account (DBC_CONFIG_DISC in lib.rs).
const CREATE_CONFIG = Buffer.from([201, 207, 243, 114, 75, 111, 47, 189])
export const POOL_CONFIG_DISCRIMINATOR = Buffer.from([26, 108, 14, 123, 116, 230, 129, 43])
// The PoolConfig bytes apply_platform reads (programs/bundle-vault/src/lib.rs, DBC_CONFIG_*): it accepts the config only when
// these hold. Checked here on the same bytes, so a dry run fails exactly where init_platform would.
export const PROGRAM_CONFIG_OFFSETS = Object.freeze({ quoteMint: 8, feeClaimer: 40, collectFeeMode: 232, tokenType: 237 })

const key = value => new PublicKey(value)
const coderFor = connection => new DynamicBondingCurveClient(connection, 'confirmed').state.getProgram().coder

// Exactly the standard launch-fee curve: the bundle market trades, graduates and pays builders like any other launch.
export const buildBundleCurve = () => buildLaunchCurve(BUNDLE_CURVE_PROFILE)

// The DAMM v2 config the curve migrates into (the bundle's damm_config, which record_graduation checks the pool against).
export function bundleDammConfig(poolConfig) {
  const address = DAMM_V2_MIGRATION_FEE_ADDRESS[Number(poolConfig.migrationFeeOption)]
  if (!address) throw Error('Bundle config has an unknown migration fee option')
  return address
}

// The addresses every bundle launch shares, in the order the lookup table holds them (the launch fits one v0 transaction).
export function bundleLookupAddresses(config, opsWallet, programId = BUNDLE_VAULT_PROGRAM_ID) {
  return [deriveDbcPoolAuthority(), deriveDbcEventAuthority(), DBC_PROGRAM_ID, TOKEN_PROGRAM_ID, SystemProgram.programId, SYSVAR_INSTRUCTIONS_PUBKEY,
    NATIVE_MINT, key(programId), key(config), ASSOCIATED_TOKEN_PROGRAM_ID, METAPLEX_PROGRAM_ID, ComputeBudgetProgram.programId,
    platformAddress(programId), key(opsWallet)]
}

export async function buildBundleConfigTransaction({ connection, config, payer, leftoverReceiver, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const curve = buildBundleCurve(), feeClaimer = routerAddress(programId)
  const tx = await dbc.partner.createConfig({ config: key(config), feeClaimer, leftoverReceiver: key(leftoverReceiver), payer: key(payer),
    quoteMint: NATIVE_MINT, ...curve })
  tx.feePayer = key(payer)
  assertBundleConfigTransaction(tx, { coder: dbc.state.getProgram().coder, config, payer, leftoverReceiver, feeClaimer, curve })
  return { tx, curve, feeClaimer, instructionSha256: instructionSha256(tx) }
}

// The built transaction: one DBC create_config whose accounts are exactly the expected ones (the router as fee claimer) and
// whose parameters are exactly buildBundleCurve(). coder: the DBC program's Anchor coder.
export function assertBundleConfigTransaction(tx, { coder, config, payer, leftoverReceiver, feeClaimer = routerAddress(), curve = buildBundleCurve() }) {
  if (tx.instructions.length !== 1) throw Error('Unexpected config transaction shape')
  const [ix] = tx.instructions
  if (!ix.programId.equals(DBC_PROGRAM_ID) || !ix.data.subarray(0, 8).equals(CREATE_CONFIG)) throw Error('Config transaction is not a DBC create_config')
  const expected = [[config, true, true], [feeClaimer, false, false], [leftoverReceiver, false, false], [NATIVE_MINT, false, false],
    [payer, true, true], [SystemProgram.programId, false, false], [deriveDbcEventAuthority(), false, false], [DBC_PROGRAM_ID, false, false]]
  if (ix.keys.length !== expected.length || ix.keys.some((meta, i) => !meta.pubkey.equals(key(expected[i][0])) ||
      meta.isSigner !== expected[i][1] || meta.isWritable !== expected[i][2])) {
    throw Error('Config transaction accounts differ from the expected config, fee claimer (the router), leftover receiver, quote mint and payer')
  }
  const decoded = coder.instruction.decode(ix.data)
  const parameters = decoded?.data?.config_parameters ?? decoded?.data?.configParameters
  if (!parameters) throw Error('Config transaction parameters could not be read')
  const { padding = [], ...terms } = parameters, { padding: _unused, ...expectedTerms } = curve
  if ([...padding].some(value => String(value) !== '0')) throw Error('Config transaction padding is not zero')
  const differing = configDifferences(terms, expectedTerms)
  if (differing.length) throw Error(`Config transaction parameters differ from the launch-fee curve in: ${differing.join(', ')}`)
  return true
}

// What init_platform / set_platform require of the account's bytes, read where the program reads them. Returns the failures.
export function programConfigFailures(data, router = routerAddress()) {
  const bytes = Buffer.from(data), at = (offset, size) => bytes.subarray(offset, offset + size)
  const failures = []
  if (!at(0, 8).equals(POOL_CONFIG_DISCRIMINATOR)) failures.push('not a DBC PoolConfig account')
  if (!at(PROGRAM_CONFIG_OFFSETS.quoteMint, 32).equals(NATIVE_MINT.toBuffer())) failures.push('quote mint is not wrapped SOL')
  if (!at(PROGRAM_CONFIG_OFFSETS.feeClaimer, 32).equals(key(router).toBuffer())) failures.push('fee claimer is not the bundle router')
  if (bytes[PROGRAM_CONFIG_OFFSETS.collectFeeMode] !== 0) failures.push('fees are not collected in SOL only')
  if (bytes[PROGRAM_CONFIG_OFFSETS.tokenType] !== 0) failures.push('mints are not SPL Token')
  return failures
}

// The account on chain (decoded PoolConfig): what the program requires (the router as fee claimer, wrapped SOL quote through SPL
// Token, fees in SOL only, SPL Token mints) and what we intend (the expected leftover receiver, exactly the approved launch fee, no
// dynamic fee, every curve term of buildBundleCurve()). reference: a decoded PoolConfig of the live SOL launch-fee config, which
// must differ only in the fee claimer.
export function assertBundleConfig(poolConfig, { router = routerAddress(), leftoverReceiver, curve = buildBundleCurve(), reference = null }) {
  if (!key(poolConfig.feeClaimer).equals(key(router))) throw Error('Bundle config has another fee claimer (not the bundle router): its fees would not be routed')
  if (!key(poolConfig.quoteMint).equals(NATIVE_MINT) || Number(poolConfig.quoteTokenFlag) !== 0) throw Error('Bundle config does not quote wrapped SOL')
  if (Number(poolConfig.collectFeeMode) !== CollectFeeMode.QuoteToken) throw Error('Bundle config does not collect fees in SOL only')
  if (Number(poolConfig.tokenType) !== TokenType.SPLToken) throw Error('Bundle config does not create SPL Token mints')
  if (!key(poolConfig.leftoverReceiver).equals(key(leftoverReceiver))) throw Error('Bundle config has another leftover receiver')
  let schedule
  try { schedule = readFeeSchedule(poolConfig) } catch { schedule = null }
  if (schedule?.kind !== 'scheduled' || !isApprovedLaunchFee(poolConfig)) throw Error('Bundle config does not carry the approved launch fee')
  if (Number(poolConfig.poolFees.dynamicFee.initialized) !== 0) throw Error('Bundle config has a dynamic fee')
  // The same field-by-field curve comparison as the early access config (supplies, start price, threshold, split, every point).
  const differing = earlyAccessCurveDifferences(poolConfig, curve)
  if (differing.length) throw Error(`Bundle config differs from the launch-fee curve in: ${differing.join(', ')}`)
  if (reference) {
    const unexpected = configDifferences(poolConfig, reference).filter(path => path !== 'feeClaimer')
    if (unexpected.length) throw Error(`Bundle config differs from the SOL launch-fee config beyond the fee claimer: ${unexpected.join(', ')}`)
  }
  return true
}

// A config account's bytes → its decoded PoolConfig, after the program's own byte checks and ours.
export function decodeBundleConfig(data, coder, { router = routerAddress(), leftoverReceiver, curve, reference = null }) {
  const failures = programConfigFailures(data, router)
  if (failures.length) throw Error(`The bundle program would refuse this config: ${failures.join('; ')}`)
  const poolConfig = coder.accounts.decode('poolConfig', Buffer.from(data))
  assertBundleConfig(poolConfig, { router, leftoverReceiver, curve, reference })
  return poolConfig
}

// The config a bundle launch or a setup script uses, read from chain and checked. A setting that names a look-alike config (the
// launch-fee curve with another fee claimer) is refused. reference: the live SOL launch-fee config's address; with it, every
// field must equal it but the fee claimer (migration fees, migrated pool fees, vesting and the other fields the curve check
// does not cover). The setup scripts always give it; the launch path should too.
export async function readBundleConfig(connection, config, { leftoverReceiver, reference = null, programId = BUNDLE_VAULT_PROGRAM_ID,
  commitment = 'confirmed' }) {
  const [info, referenceInfo] = await connection.getMultipleAccountsInfo([key(config), ...reference ? [key(reference)] : []], commitment)
  if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Bundle config is missing')
  if (reference && !referenceInfo?.owner.equals(DBC_PROGRAM_ID)) throw Error('Reference config is missing')
  const coder = coderFor(connection)
  return decodeBundleConfig(info.data, coder, { router: routerAddress(programId), leftoverReceiver,
    reference: reference ? coder.accounts.decode('poolConfig', referenceInfo.data) : null })
}
