import { createHash } from 'node:crypto'
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from './launch-curve.mjs'
import { isApprovedLaunchFee, readFeeSchedule, STANDARD_FEE_NUMERATOR } from './launch-fee.mjs'
import { MULTISIG_VAULT } from './custody-multisig.mjs'

// Builds and reviews the createConfig transaction for the launch-fee config. Chain-agnostic: the mainnet script
// (scripts/create-launch-fee-config.mjs) and the local-validator tests run exactly this code.
export const DBC_PROGRAM_ID = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
export const LAUNCH_FEE_PROFILE = 'launch-fee'

// Mainnet snapshot tested locally through launch, fee accounting/claims and DAMM migration on 2026-10-23.
// Includes allocated trailing bytes. A program upgrade requires a new review, never a configurable bypass.
export const CUSTODY_DBC_EXECUTABLE_SHA256 = 'e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47'

// The only decoded PoolConfig fields allowed to differ from the flat config it replaces.
export const LAUNCH_FEE_FIELDS = Object.freeze(['poolFees.baseFee.cliffFeeNumerator', 'poolFees.baseFee.firstFactor',
  'poolFees.baseFee.secondFactor', 'poolFees.baseFee.thirdFactor', 'poolFees.baseFee.baseFeeMode', 'enableFirstSwapWithMinFee'])

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

// Same hash as scripts/prepare-liquidity-config.mjs: program, ordered account metas and instruction data.
export function instructionSha256(tx) {
  return sha256(JSON.stringify(tx.instructions.map(ix => ({ program: ix.programId.toBase58(),
    keys: ix.keys.map(key => ({ key: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })),
    data: ix.data.toString('base64') }))))
}

export async function buildLaunchFeeConfigTransaction({ connection, config, partner, leftoverReceiver, payer = partner }) {
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const curve = buildLaunchCurve(LAUNCH_FEE_PROFILE)
  const tx = await dbc.partner.createConfig({ config: new PublicKey(config), feeClaimer: new PublicKey(partner),
    leftoverReceiver: new PublicKey(leftoverReceiver), payer: new PublicKey(payer), quoteMint: NATIVE_MINT, ...curve })
  if (tx.instructions.length !== 1 || !tx.instructions[0].programId.equals(DBC_PROGRAM_ID)) throw Error('Unexpected config transaction shape')
  tx.feePayer = new PublicKey(payer)
  return { tx, curve, instructionSha256: instructionSha256(tx) }
}

const plain = value => {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof PublicKey) return value.toBase58()
  if (typeof value === 'object' && value.constructor?.name === 'BN') return value.toString()
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]))
  return value
}

// Paths of every differing leaf between two decoded PoolConfig accounts (keys and integers compared as text).
export function configDifferences(left, right) {
  const differences = []
  const walk = (a, b, path) => {
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key)
    } else if (a !== b) differences.push(path)
  }
  walk(plain(left), plain(right), '')
  return differences
}

// The new config must equal the flat 1.75% reference in every field except its base fee, and carry exactly the
// approved launch fee (exponential schedule ending at 1.75%, launcher first buy at 1.75%, timestamp activation).
// Recovery additionally permits both immutable recipients to move to the recovered vault, not arbitrary wallets.
export function assertOnlyLaunchFeeDiffers(candidate, reference, { custodyReplacement = false } = {}) {
  const differences = configDifferences(candidate, reference)
  const recipients = custodyReplacement ? ['feeClaimer', 'leftoverReceiver'] : []
  if (recipients.some(field => plain(candidate[field]) !== MULTISIG_VAULT)) throw Error('Replacement requires recovered custody recipients')
  const versionTransition = custodyReplacement && differences.includes('version')
  if (versionTransition) {
    // DBC 0.2.2 keeps the original migration path for SPL/SOL with no transfer fee.
    // SDK 1.5.13 exposes the new transfer-fee fields as the first five padding0 bytes.
    if (reference.version !== 0 || candidate.version !== 1) throw Error('Unreviewed config version transition')
    if (plain(candidate.quoteMint) !== NATIVE_MINT.toBase58() || candidate.quoteTokenFlag !== 0 || candidate.tokenType !== 0 ||
        candidate.padding0?.length !== 14 || candidate.padding0.some(byte => byte !== 0)) {
      throw Error('Version transition requires SPL/SOL without transfer fees or reserved fields')
    }
  }
  const unexpected = differences.filter(path => !LAUNCH_FEE_FIELDS.includes(path) && !recipients.includes(path) && !(versionTransition && path === 'version'))
  if (unexpected.length) throw Error(`New config differs from the reference beyond the launch fee: ${unexpected.join(', ')}`)
  const old = readFeeSchedule(reference)
  if (old.kind !== 'flat' || old.startNumerator !== STANDARD_FEE_NUMERATOR) throw Error('Reference config is not the flat 1.75% config')
  if (readFeeSchedule(candidate).kind !== 'scheduled' || !isApprovedLaunchFee(candidate)) throw Error('New config does not carry the approved launch fee')
  return differences
}

// Unsigned simulation that captures the payer and the created config account: exact rent, network fee, payer
// debit and account bytes, all before any key is loaded. With a reference config, also proves the simulated
// account is that config plus the launch fee and nothing else.
export async function reviewLaunchFeeConfig({ connection, tx, config, payer, reference = null, custodyReplacement = false }) {
  if (custodyReplacement && !reference) throw Error('Custody replacement requires a reference')
  if (custodyReplacement) {
    const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
    const [programData] = PublicKey.findProgramAddressSync([DBC_PROGRAM_ID.toBuffer()], loader)
    const [program, data] = await connection.getMultipleAccountsInfo([DBC_PROGRAM_ID, programData], 'finalized')
    if (!program?.executable || !program.owner.equals(loader) || program.data.length !== 36 || program.data.readUInt32LE(0) !== 2 ||
        !program.data.subarray(4).equals(programData.toBuffer()) || !data?.owner.equals(loader) || data.data.length < 45 ||
        data.data.readUInt32LE(0) !== 3 || sha256(data.data.subarray(45)) !== CUSTODY_DBC_EXECUTABLE_SHA256) {
      throw Error('Custody replacement requires the reviewed DBC executable')
    }
  }
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const coder = dbc.state.getProgram().coder.accounts
  const configKey = new PublicKey(config), payerKey = new PublicKey(payer)
  tx.feePayer = payerKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const [fee, balance, existing] = await Promise.all([connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    connection.getBalance(payerKey, 'confirmed'), connection.getAccountInfo(configKey, 'confirmed')])
  if (existing) throw Error('Config address already has an account; inspect it before sending anything')
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
  let differences = null
  if (reference) {
    const info = await connection.getAccountInfo(new PublicKey(reference), 'confirmed')
    if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Reference config is missing')
    differences = assertOnlyLaunchFeeDiffers(decoded, coder.decode('poolConfig', info.data), { custodyReplacement })
  } else if (!isApprovedLaunchFee(decoded)) throw Error('Simulated config does not carry the approved launch fee')
  return { accountDataSha256: sha256(data), accountBytes: data.length, rentLamports: created.lamports, networkFeeLamports: fee.value,
    totalDebitLamports, payerBalanceLamports: balance, decoded, differences }
}

// After a send: the account at the reviewed address must be exactly the simulated bytes.
export async function verifyCreatedLaunchFeeConfig({ connection, config, accountDataSha256, commitment = 'finalized' }) {
  const info = await connection.getAccountInfo(new PublicKey(config), commitment)
  if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Created config owner mismatch')
  if (sha256(info.data) !== accountDataSha256) throw Error('Created config differs from the simulated account')
  const decoded = new DynamicBondingCurveClient(connection, commitment).state.getProgram().coder.accounts.decode('poolConfig', info.data)
  if (!isApprovedLaunchFee(decoded)) throw Error('Created config does not carry the approved launch fee')
  return decoded
}
