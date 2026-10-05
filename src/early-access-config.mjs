import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, VersionedTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, TokenType, deriveDbcEventAuthority, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildEarlyAccessCurve } from './launch-curve.mjs'
import { DBC_PROGRAM_ID, LAUNCH_FEE_FIELDS, configDifferences, instructionSha256, sha256 } from './launch-fee-config.mjs'
import { STANDARD_FEE_NUMERATOR, readFeeSchedule } from './launch-fee.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, platformAddress } from './early-access-hook.mjs'

// The contributor early access DBC config (docs/EARLY_ACCESS.md): built with create_config_with_transfer_hook, then reviewed
// field by field before it is sent and again as the account on chain. Chain-agnostic: scripts/create-early-access-config.mjs
// (mainnet, dry run by default), the early access launcher and the chain tests run exactly this code.

// Anchor discriminators (DBC IDL, SDK 1.5.13).
export const CONFIG_WITH_TRANSFER_HOOK_DISCRIMINATOR = Buffer.from([40, 220, 194, 251, 41, 199, 123, 253])
const CREATE_CONFIG_WITH_TRANSFER_HOOK = Buffer.from([216, 37, 1, 57, 88, 226, 25, 41])
// ConfigWithTransferHook is { config: PoolConfig, transfer_hook_program, padding_0: [u64; 6] } after the discriminator.
const PADDING_BYTES = 6 * 8

const key = value => new PublicKey(value)
const coderFor = connection => new DynamicBondingCurveClient(connection, 'confirmed').state.getProgram().coder

// The addresses every early access launch shares, in the order the lookup table holds them (docs/EARLY_ACCESS.md).
export function earlyAccessLookupAddresses(config, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID) {
  return [deriveDbcPoolAuthority(), deriveDbcEventAuthority(), DBC_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, SystemProgram.programId,
    ASSOCIATED_TOKEN_PROGRAM_ID, SYSVAR_INSTRUCTIONS_PUBKEY, NATIVE_MINT, key(hookProgram), platformAddress(hookProgram), key(config)]
}

export async function buildEarlyAccessConfigTransaction({ connection, config, partner, leftoverReceiver, payer = partner,
  hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID }) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const curve = buildEarlyAccessCurve()
  const tx = await dbc.partner.createConfigWithTransferHook({ config: key(config), feeClaimer: key(partner), leftoverReceiver: key(leftoverReceiver),
    payer: key(payer), quoteMint: NATIVE_MINT, transferHookProgram: key(hookProgram), ...curve })
  tx.feePayer = key(payer)
  assertEarlyAccessConfigTransaction(tx, { coder: dbc.state.getProgram().coder, config, partner, leftoverReceiver, payer, hookProgram, curve })
  return { tx, curve, instructionSha256: instructionSha256(tx) }
}

// The built transaction: one DBC create_config_with_transfer_hook whose accounts are exactly the expected ones and whose
// parameters are exactly buildEarlyAccessCurve(). coder: the DBC program's Anchor coder.
export function assertEarlyAccessConfigTransaction(tx, { coder, config, partner, leftoverReceiver, payer = partner,
  hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, curve = buildEarlyAccessCurve() }) {
  if (tx.instructions.length !== 1) throw Error('Unexpected config transaction shape')
  const [ix] = tx.instructions
  if (!ix.programId.equals(DBC_PROGRAM_ID) || !ix.data.subarray(0, 8).equals(CREATE_CONFIG_WITH_TRANSFER_HOOK)) {
    throw Error('Config transaction is not a DBC create_config_with_transfer_hook')
  }
  const expected = [[config, true, true], [partner, false, false], [leftoverReceiver, false, false], [NATIVE_MINT, false, false],
    [hookProgram, false, false], [payer, true, true], [SystemProgram.programId, false, false], [deriveDbcEventAuthority(), false, false],
    [DBC_PROGRAM_ID, false, false]]
  if (ix.keys.length !== expected.length || ix.keys.some((meta, i) => !meta.pubkey.equals(key(expected[i][0])) ||
      meta.isSigner !== expected[i][1] || meta.isWritable !== expected[i][2])) {
    throw Error('Config transaction accounts differ from the expected config, fee claimer, leftover receiver, quote mint, hook and payer')
  }
  const decoded = coder.instruction.decode(ix.data)
  const parameters = decoded?.data?.config_parameters ?? decoded?.data?.configParameters
  if (!parameters) throw Error('Config transaction parameters could not be read')
  // The instruction carries the fixed-size padding the curve leaves empty: it must be zero.
  const { padding = [], ...terms } = parameters, { padding: _unused, ...expectedTerms } = curve
  if ([...padding].some(value => String(value) !== '0')) throw Error('Config transaction padding is not zero')
  const differing = configDifferences(terms, expectedTerms)
  if (differing.length) throw Error(`Config transaction parameters differ from the early access curve in: ${differing.join(', ')}`)
  return true
}

// A ConfigWithTransferHook account's bytes → { config: PoolConfig, transferHookProgram }. Anything else throws.
export function decodeEarlyAccessConfig(data, coder) {
  const buffer = Buffer.from(data)
  if (!buffer.subarray(0, 8).equals(CONFIG_WITH_TRANSFER_HOOK_DISCRIMINATOR)) throw Error('Not a DBC config with a transfer hook')
  const decoded = coder.accounts.decode('configWithTransferHook', buffer)
  const hook = decoded.transferHookProgram ?? decoded.transfer_hook_program
  if (!decoded.config || !hook) throw Error('Not a DBC config with a transfer hook')
  const padding = buffer.subarray(buffer.length - PADDING_BYTES)
  if (padding.some(byte => byte !== 0)) throw Error('Early access config padding is not zero')
  return { config: decoded.config, transferHookProgram: key(hook) }
}

// The curve terms the account must hold: supplies, start price, graduation threshold and every curve point (then zero padding).
export function earlyAccessCurveDifferences(poolConfig, curve = buildEarlyAccessCurve()) {
  const expected = { preMigrationTokenSupply: curve.tokenSupply?.preMigrationTokenSupply, postMigrationTokenSupply: curve.tokenSupply?.postMigrationTokenSupply,
    sqrtStartPrice: curve.sqrtStartPrice, migrationQuoteThreshold: curve.migrationQuoteThreshold, collectFeeMode: curve.collectFeeMode,
    migrationOption: curve.migrationOption, activationType: curve.activationType, tokenType: curve.tokenType, tokenDecimal: curve.tokenDecimal,
    partnerLiquidityPercentage: curve.partnerLiquidityPercentage, partnerPermanentLockedLiquidityPercentage: curve.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: curve.creatorLiquidityPercentage, creatorPermanentLockedLiquidityPercentage: curve.creatorPermanentLockedLiquidityPercentage,
    migrationFeeOption: curve.migrationFeeOption, creatorTradingFeePercentage: curve.creatorTradingFeePercentage,
    tokenUpdateAuthority: curve.tokenUpdateAuthority, poolCreationFee: curve.poolCreationFee,
    'poolFees.baseFee.cliffFeeNumerator': curve.poolFees.baseFee.cliffFeeNumerator, 'poolFees.baseFee.baseFeeMode': curve.poolFees.baseFee.baseFeeMode,
    'poolFees.baseFee.firstFactor': curve.poolFees.baseFee.firstFactor, 'poolFees.baseFee.secondFactor': curve.poolFees.baseFee.secondFactor,
    'poolFees.baseFee.thirdFactor': curve.poolFees.baseFee.thirdFactor }
  const read = (object, path) => path.split('.').reduce((value, part) => value?.[part], object)
  const differing = Object.entries(expected).filter(([path, value]) =>
    configDifferences({ value: read(poolConfig, path) }, { value }).length).map(([path]) => path)
  const points = poolConfig.curve ?? [], zero = point => String(point.sqrtPrice) === '0' && String(point.liquidity) === '0'
  const pointsMatch = points.length >= curve.curve.length && curve.curve.every((point, i) =>
    String(points[i].sqrtPrice) === String(point.sqrtPrice) && String(points[i].liquidity) === String(point.liquidity)) &&
    points.slice(curve.curve.length).every(zero)
  if (!pointsMatch) differing.push('curve')
  return differing
}

// The account on chain (decoded): our hook, wrapped SOL quoted through SPL Token, a Token-2022 base, the expected fee claimer and
// leftover receiver, a flat 1.75% fee with no first-swap rule and no dynamic fee, and every curve term of buildEarlyAccessCurve().
// feeClaimer: null skips that one check (the launcher does not know the partner wallet). reference: a decoded PoolConfig of the
// live SOL launch-fee config, which must differ only in the launch fee and the token type (the builders curve it is built on).
export function assertEarlyAccessConfig(decoded, { feeClaimer, leftoverReceiver, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID,
  curve = buildEarlyAccessCurve(), reference = null }) {
  const { config, transferHookProgram } = decoded
  if (!transferHookProgram.equals(key(hookProgram))) throw Error('Early access config uses another transfer hook program')
  if (!key(config.quoteMint).equals(NATIVE_MINT) || config.quoteTokenFlag !== 0) throw Error('Early access config does not quote wrapped SOL')
  if (config.tokenType !== TokenType.Token2022) throw Error('Early access config does not create Token-2022 mints')
  if (feeClaimer !== null && !key(config.feeClaimer).equals(key(feeClaimer))) throw Error('Early access config has another fee claimer')
  if (!key(config.leftoverReceiver).equals(key(leftoverReceiver))) throw Error('Early access config has another leftover receiver')
  let schedule
  try { schedule = readFeeSchedule(config) } catch { schedule = null }
  if (schedule?.kind !== 'flat' || schedule.startNumerator !== STANDARD_FEE_NUMERATOR || schedule.firstSwapMinFee) {
    throw Error('Early access config is not the flat 1.75% fee')
  }
  if (Number(config.poolFees.dynamicFee.initialized) !== 0) throw Error('Early access config has a dynamic fee')
  const differing = earlyAccessCurveDifferences(config, curve)
  if (differing.length) throw Error(`Early access config differs from the early access curve in: ${differing.join(', ')}`)
  if (reference) {
    const unexpected = configDifferences(config, reference).filter(path => !LAUNCH_FEE_FIELDS.includes(path) && path !== 'tokenType')
    if (unexpected.length) throw Error(`Early access config differs from the SOL launch-fee config beyond the fee and token type: ${unexpected.join(', ')}`)
  }
  return true
}

// Unsigned simulation (as reviewStockQuoteConfig): exact rent, network fee and payer debit, and the simulated account checked
// before any key is loaded. reference: the live SOL launch-fee config's address.
export async function reviewEarlyAccessConfig({ connection, tx, config, payer, feeClaimer, leftoverReceiver, reference,
  hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, curve = buildEarlyAccessCurve() }) {
  const coder = coderFor(connection)
  const configKey = key(config), payerKey = key(payer)
  tx.feePayer = payerKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const [fee, balance, existing, referenceInfo] = await Promise.all([connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    connection.getBalance(payerKey, 'confirmed'), connection.getAccountInfo(configKey, 'confirmed'), connection.getAccountInfo(key(reference), 'confirmed')])
  if (existing) throw Error('Config address already has an account; inspect it before sending anything')
  if (!referenceInfo?.owner.equals(DBC_PROGRAM_ID)) throw Error('Reference config is missing')
  if (!Number.isSafeInteger(fee.value)) throw Error('Network fee unavailable')
  const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
    accounts: { encoding: 'base64', addresses: [payerKey.toBase58(), configKey.toBase58()] } })
  if (simulation.value.err) throw Error(`Unsigned simulation failed: ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).slice(-4).join(' | ')}`)
  const [payerAfter, created] = simulation.value.accounts ?? []
  if (!created || !payerAfter || created.owner !== DBC_PROGRAM_ID.toBase58()) throw Error('Simulation did not create a DBC config account')
  const data = Buffer.from(created.data[0], 'base64')
  const totalDebitLamports = balance - payerAfter.lamports
  if (totalDebitLamports !== created.lamports + fee.value) throw Error('Unexpected simulated payer debit')
  const decoded = decodeEarlyAccessConfig(data, coder)
  assertEarlyAccessConfig(decoded, { feeClaimer, leftoverReceiver, hookProgram, curve, reference: coder.accounts.decode('poolConfig', referenceInfo.data) })
  return { accountDataSha256: sha256(data), accountBytes: data.length, rentLamports: created.lamports, networkFeeLamports: fee.value,
    totalDebitLamports, payerBalanceLamports: balance, decoded }
}

// After a send: the account at the reviewed address must be exactly the simulated bytes.
export async function verifyCreatedEarlyAccessConfig({ connection, config, accountDataSha256, commitment = 'finalized' }) {
  const info = await connection.getAccountInfo(key(config), commitment)
  if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Created config owner mismatch')
  if (sha256(info.data) !== accountDataSha256) throw Error('Created config differs from the simulated account')
  return decodeEarlyAccessConfig(info.data, coderFor(connection))
}

// The config a launch uses, read from chain and checked (the launcher, at every prepare): the creator signer is the leftover
// receiver, as on every builders config (src/builder-allocation.mjs).
export async function readEarlyAccessConfig(connection, config, { leftoverReceiver, hookProgram = EARLY_ACCESS_HOOK_PROGRAM_ID, commitment = 'confirmed' }) {
  const info = await connection.getAccountInfo(key(config), commitment)
  if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Early access config is missing')
  const decoded = decodeEarlyAccessConfig(info.data, coderFor(connection))
  assertEarlyAccessConfig(decoded, { feeClaimer: null, leftoverReceiver, hookProgram })
  return decoded
}
