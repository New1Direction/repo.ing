import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, deriveTokenBadgeAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildStockLaunchCurve } from './launch-curve.mjs'
import { DBC_PROGRAM_ID, configDifferences, instructionSha256, sha256 } from './launch-fee-config.mjs'
import { isApprovedLaunchFee } from './launch-fee.mjs'

// Builds and reviews the createConfig transaction for one stock pair's DBC config (docs/STOCK_QUOTES.md). Chain-agnostic: the
// mainnet script (scripts/create-stock-quote-config.mjs) and the stock-pair chain test run exactly this code.

// Every term a stock config must share with the live SOL launch-fee config it is reviewed against: fees and the launch-fee
// schedule, the creator/partner split, the locked liquidity, migration, token, activation and fee recipients. Only the quote
// (mint, Token-2022 flag) and the curve built for its decimals and graduation threshold may differ.
export const STOCK_CONFIG_MUST_MATCH = Object.freeze(['feeClaimer', 'leftoverReceiver', 'poolFees', 'partnerLiquidityVestingInfo',
  'creatorLiquidityVestingInfo', 'collectFeeMode', 'migrationOption', 'activationType', 'tokenDecimal', 'version', 'tokenType',
  'partnerPermanentLockedLiquidityPercentage', 'partnerLiquidityPercentage', 'creatorPermanentLockedLiquidityPercentage',
  'creatorLiquidityPercentage', 'migrationFeeOption', 'fixedTokenSupplyFlag', 'creatorTradingFeePercentage', 'tokenUpdateAuthority',
  'migrationFeePercentage', 'creatorMigrationFeePercentage', 'lockedVestingConfig', 'migratedCollectFeeMode', 'migratedDynamicFee',
  'migratedPoolFeeBps', 'migratedPoolBaseFeeMode', 'enableFirstSwapWithMinFee', 'migratedCompoundingFeeBps', 'poolCreationFee',
  'migratedPoolBaseFeeBytes'])

const wholeUnits = (graduation, decimals) => {
  if (!Number.isInteger(graduation) || graduation <= 0) throw Error('Graduation threshold must be a positive whole number of the stock')
  return BigInt(graduation) * 10n ** BigInt(decimals)
}

export async function buildStockQuoteConfigTransaction({ connection, config, asset, graduation, partner, leftoverReceiver, payer = partner }) {
  wholeUnits(graduation, asset.decimals)
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const quoteMint = new PublicKey(asset.mint)
  const curve = buildStockLaunchCurve({ quoteDecimals: asset.decimals, migrationQuoteThreshold: graduation })
  const tx = await dbc.partner.createConfig({ config: new PublicKey(config), feeClaimer: new PublicKey(partner),
    leftoverReceiver: new PublicKey(leftoverReceiver), payer: new PublicKey(payer), quoteMint,
    tokenBadge: deriveTokenBadgeAddress(quoteMint), ...curve })
  if (tx.instructions.length !== 1 || !tx.instructions[0].programId.equals(DBC_PROGRAM_ID)) throw Error('Unexpected config transaction shape')
  tx.feePayer = new PublicKey(payer)
  return { tx, curve, instructionSha256: instructionSha256(tx) }
}

// The candidate (decoded PoolConfig) is the reference's terms quoted in the asset: same terms field by field, the asset's mint
// through Token-2022, the requested graduation threshold, and the approved launch fee.
// curve: the buildStockLaunchCurve result the transaction was built from; its supply, start price and curve points must be what
// the account holds.
export function assertStockConfig(candidate, reference, { asset, graduation, curve = null }) {
  const differing = STOCK_CONFIG_MUST_MATCH.filter(field => configDifferences({ [field]: candidate[field] }, { [field]: reference[field] }).length)
  if (differing.length) throw Error(`Stock config differs from the SOL launch-fee config in: ${differing.join(', ')}`)
  if (!new PublicKey(candidate.quoteMint).equals(new PublicKey(asset.mint))) throw Error('Stock config does not quote the asset mint')
  if (candidate.quoteTokenFlag !== 1) throw Error('Stock config does not quote through Token-2022')
  if (candidate.migrationQuoteThreshold.toString() !== wholeUnits(graduation, asset.decimals).toString()) throw Error('Unexpected graduation threshold')
  if (!isApprovedLaunchFee(candidate)) throw Error('Stock config does not carry the approved launch fee')
  if (curve) {
    const expected = { preMigrationTokenSupply: curve.tokenSupply?.preMigrationTokenSupply, postMigrationTokenSupply: curve.tokenSupply?.postMigrationTokenSupply,
      sqrtStartPrice: curve.sqrtStartPrice }
    const differing = Object.keys(expected).filter(field => configDifferences({ [field]: candidate[field] }, { [field]: expected[field] }).length)
    // The account keeps the curve in a fixed-size array: the built points first, then zero padding.
    const points = candidate.curve ?? [], zero = point => String(point.sqrtPrice) === '0' && String(point.liquidity) === '0'
    const pointsMatch = points.length >= curve.curve.length && curve.curve.every((point, i) =>
      String(points[i].sqrtPrice) === String(point.sqrtPrice) && String(points[i].liquidity) === String(point.liquidity)) &&
      points.slice(curve.curve.length).every(zero)
    if (!pointsMatch) differing.push('curve')
    if (differing.length) throw Error(`Stock config differs from the curve it was built from in: ${differing.join(', ')}`)
  }
  return true
}

// Unsigned simulation (as reviewLaunchFeeConfig): exact rent, network fee and payer debit, and the simulated account checked
// against the reference config before any key is loaded.
export async function reviewStockQuoteConfig({ connection, tx, config, payer, reference, asset, graduation, curve = null }) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const coder = dbc.state.getProgram().coder.accounts
  const configKey = new PublicKey(config), payerKey = new PublicKey(payer)
  tx.feePayer = payerKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const [fee, balance, existing, referenceInfo] = await Promise.all([connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    connection.getBalance(payerKey, 'confirmed'), connection.getAccountInfo(configKey, 'confirmed'),
    connection.getAccountInfo(new PublicKey(reference), 'confirmed')])
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
  const decoded = coder.decode('poolConfig', data)
  assertStockConfig(decoded, coder.decode('poolConfig', referenceInfo.data), { asset, graduation, curve })
  return { accountDataSha256: sha256(data), accountBytes: data.length, rentLamports: created.lamports, networkFeeLamports: fee.value,
    totalDebitLamports, payerBalanceLamports: balance, decoded }
}

// After a send: the account at the reviewed address must be exactly the simulated bytes.
export async function verifyCreatedStockQuoteConfig({ connection, config, accountDataSha256, commitment = 'finalized' }) {
  const info = await connection.getAccountInfo(new PublicKey(config), commitment)
  if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Created config owner mismatch')
  if (sha256(info.data) !== accountDataSha256) throw Error('Created config differs from the simulated account')
  return true
}
