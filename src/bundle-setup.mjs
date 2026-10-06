import { createHash } from 'node:crypto'
import { AddressLookupTableProgram, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DBC_PROGRAM_ID, configDifferences, instructionSha256, sha256 } from './launch-fee-config.mjs'
import { BUNDLE_DEFAULTS } from './bundle-launch.mjs'
import { BUNDLE_VAULT_PROGRAM_ID, MAX_OPERATORS, decodePlatform, initPlatformInstruction, platformAddress, programDataAddress, routerAddress,
  setPlatformInstruction, tokenAccountOf } from './bundle-vault.mjs'
import { bundleDammConfig, decodeBundleConfig } from './bundle-config.mjs'

// The Bundle launch mainnet setup (docs/BUNDLE_LAUNCH.md, "Mainnet setup"): the bundle config's review, the program's deployment
// and upgrade authority, the platform account (init_platform, later set_platform) and the shared lookup table. Each step is built
// and simulated unsigned first: the payer must lose exactly the network fee plus the rent of the accounts the step creates.
// Chain-agnostic: scripts/create-bundle-config.mjs, scripts/init-bundle-platform.mjs and scripts/create-bundle-lookup-table.mjs
// (mainnet, dry run by default) and tests/bundle-setup-chain.test.mjs run exactly this code.

const key = value => new PublicKey(value)
const coderFor = connection => new DynamicBondingCurveClient(connection, 'confirmed').state.getProgram().coder
// The upgradeable loader's ProgramData account: [u32 kind = 3][u64 slot][Option<Pubkey> upgrade authority], then the program.
const PROGRAM_DATA_HEADER = 45

// An address with no account, or only lamports someone sent to it (a system account without data): anyone can fund a public
// address such as the platform PDA, and the program and the token program still create their accounts there.
const unused = info => !info || (info.owner.equals(SystemProgram.programId) && info.data.length === 0)

// Unsigned simulation of a setup transaction. created: the accounts it must create (none may exist yet, beyond lamports sent to
// them). Returns the exact payer debit, which must be the network fee plus the rent the created accounts receive, and the created
// accounts as simulated.
export async function simulateSetup({ connection, tx, payer, created = [] }) {
  const payerKey = key(payer), addresses = created.map(key)
  tx.feePayer = payerKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  const [fee, balance, existing] = await Promise.all([connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
    connection.getBalance(payerKey, 'confirmed'), addresses.length ? connection.getMultipleAccountsInfo(addresses, 'confirmed') : []])
  const taken = addresses.filter((_, i) => !unused(existing[i]))
  if (taken.length) throw Error(`Already exists, inspect it before sending anything: ${taken.map(String).join(', ')}`)
  if (!Number.isSafeInteger(fee.value)) throw Error('Network fee unavailable')
  const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false,
    replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [payerKey, ...addresses].map(String) } })
  if (simulation.value.err) {
    throw Error(`Unsigned simulation failed: ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).slice(-4).join(' | ')}`)
  }
  const [payerAfter, ...accounts] = simulation.value.accounts ?? []
  if (!payerAfter || accounts.length !== addresses.length || accounts.some(account => !account)) throw Error('Simulation did not create every expected account')
  const rentLamports = accounts.reduce((sum, account, i) => sum + account.lamports - (existing[i]?.lamports ?? 0), 0)
  const totalDebitLamports = balance - payerAfter.lamports
  if (totalDebitLamports !== rentLamports + fee.value) throw Error('Unexpected simulated payer debit')
  return { rentLamports, networkFeeLamports: fee.value, totalDebitLamports, payerBalanceLamports: balance, accounts,
    unitsConsumed: simulation.value.unitsConsumed ?? null }
}

// ------------------------------------------------------------------ config

// The bundle config's create transaction, simulated: the created account must pass every check (decodeBundleConfig) and, against
// the live SOL launch-fee config (reference: its address), differ from it only in the fee claimer.
export async function reviewBundleConfig({ connection, tx, config, payer, leftoverReceiver, reference, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const coder = coderFor(connection)
  const referenceInfo = await connection.getAccountInfo(key(reference), 'confirmed')
  if (!referenceInfo?.owner.equals(DBC_PROGRAM_ID)) throw Error('Reference config is missing')
  const review = await simulateSetup({ connection, tx, payer, created: [config] })
  const [created] = review.accounts
  if (created.owner !== DBC_PROGRAM_ID.toBase58()) throw Error('Simulation did not create a DBC config account')
  const data = Buffer.from(created.data[0], 'base64')
  const referenceConfig = coder.accounts.decode('poolConfig', referenceInfo.data)
  const decoded = decodeBundleConfig(data, coder, { router: routerAddress(programId), leftoverReceiver, reference: referenceConfig })
  return { ...review, accountDataSha256: sha256(data), accountBytes: data.length, decoded, differences: configDifferences(decoded, referenceConfig) }
}

// After a send: the account at the reviewed address must be exactly the simulated bytes.
export async function verifyCreatedBundleConfig({ connection, config, accountDataSha256, leftoverReceiver, programId = BUNDLE_VAULT_PROGRAM_ID,
  commitment = 'finalized' }) {
  const info = await connection.getAccountInfo(key(config), commitment)
  if (!info?.owner.equals(DBC_PROGRAM_ID)) throw Error('Created config owner mismatch')
  if (sha256(info.data) !== accountDataSha256) throw Error('Created config differs from the simulated account')
  return decodeBundleConfig(info.data, coderFor(connection), { router: routerAddress(programId), leftoverReceiver })
}

// ----------------------------------------------------------------- program

// The deployed program: its upgrade authority (init_platform's only signer) and whether its bytes are exactly `program` (the
// reviewed build, tests/fixtures/validator/bundle_vault.so). ProgramData may be longer than the program (zero-filled).
export async function bundleProgramState(connection, { program = null, programId = BUNDLE_VAULT_PROGRAM_ID, commitment = 'confirmed' } = {}) {
  const [account, programData] = await connection.getMultipleAccountsInfo([key(programId), programDataAddress(programId)], commitment)
  if (!account?.executable) throw Error(`The bundle program ${key(programId).toBase58()} is not deployed: deploy it first`)
  if (!programData || programData.data.readUInt32LE(0) !== 3) throw Error('The bundle program has no ProgramData account')
  const upgradeAuthority = programData.data[12] === 1 ? new PublicKey(programData.data.subarray(13, PROGRAM_DATA_HEADER)) : null
  const deployed = programData.data.subarray(PROGRAM_DATA_HEADER)
  const matches = program ? deployed.subarray(0, program.length).equals(Buffer.from(program)) && deployed.subarray(program.length).every(byte => byte === 0) : null
  return { upgradeAuthority, programDataBytes: programData.data.length, programDataLamports: programData.lamports, matchesReviewedBuild: matches,
    reviewedBuildSha256: program ? createHash('sha256').update(program).digest('hex') : null }
}

// ---------------------------------------------------------------- platform

// The platform's terms: the wallets the owner names (no defaults), the bundle config and the DAMM v2 config it migrates into, and
// BUNDLE_DEFAULTS' shares, cooldown, grace period and loosest vault policy. treasury: the treasury owner's wrapped SOL account.
export function bundlePlatformTerms({ admin, launchSigner, operators, opsWallet, treasuryOwner, config, poolConfig, defaults = BUNDLE_DEFAULTS,
  programId = BUNDLE_VAULT_PROGRAM_ID }) {
  const wallets = { admin, launchSigner, opsWallet, treasuryOwner, config }
  for (const [name, value] of Object.entries(wallets)) if (!value || key(value).equals(PublicKey.default)) throw Error(`${name} must be a public key`)
  const operatorKeys = (operators ?? []).map(key)
  if (!operatorKeys.length || operatorKeys.length > MAX_OPERATORS) throw Error(`1 to ${MAX_OPERATORS} operators`)
  if (new Set(operatorKeys.map(String)).size !== operatorKeys.length || operatorKeys.some(o => o.equals(PublicKey.default))) {
    throw Error('Operators must be distinct, non-default keys')
  }
  return Object.freeze({ admin: key(admin), launchSigner: key(launchSigner), operators: operatorKeys, opsWallet: key(opsWallet),
    treasuryOwner: key(treasuryOwner), treasury: tokenAccountOf(treasuryOwner, NATIVE_MINT), routerSol: tokenAccountOf(routerAddress(programId), NATIVE_MINT),
    curveConfig: key(config), dammConfig: bundleDammConfig(poolConfig), backerBps: defaults.backerBps, opsBps: defaults.opsBps,
    launchCooldownSecs: defaults.launchCooldownSecs, launchGraceSecs: defaults.launchGraceSecs, limits: { ...defaults.limits } })
}

// Every field of a decoded platform account that differs from the terms (empty: exactly the terms).
export function platformDifferences(platform, terms) {
  const text = value => JSON.stringify(value, (_, item) => item instanceof PublicKey ? item.toBase58() : item)
  const fields = ['admin', 'launchSigner', 'operators', 'opsWallet', 'treasury', 'routerSol', 'curveConfig', 'dammConfig', 'backerBps', 'opsBps',
    'launchCooldownSecs', 'launchGraceSecs', 'limits']
  return fields.filter(field => text(platform[field]) !== text(terms[field]))
}

export async function readBundlePlatform(connection, { programId = BUNDLE_VAULT_PROGRAM_ID, commitment = 'confirmed' } = {}) {
  const info = await connection.getAccountInfo(platformAddress(programId), commitment)
  if (unused(info)) return null
  if (!info.owner.equals(key(programId))) throw Error('The platform address holds an account the bundle program does not own')
  return decodePlatform(info.data)
}

// init_platform (signer: the program's upgrade authority) or set_platform (signer: the current admin; terms.admin takes over),
// preceded by the router's and the treasury's wrapped SOL accounts when they do not exist yet (the signer pays their rent).
export async function buildBundlePlatformTransaction({ connection, mode, signer, terms, programId = BUNDLE_VAULT_PROGRAM_ID }) {
  if (mode !== 'init' && mode !== 'set') throw Error('mode is init or set')
  const payer = key(signer), router = routerAddress(programId)
  const accounts = [[router, terms.routerSol], [terms.treasuryOwner, terms.treasury]]
  const infos = await connection.getMultipleAccountsInfo(accounts.map(([, account]) => account), 'confirmed')
  const missing = accounts.filter((_, i) => !infos[i]?.owner.equals(TOKEN_PROGRAM_ID))
  const args = { treasury: terms.treasury, curveConfig: terms.curveConfig, launchSigner: terms.launchSigner, operators: terms.operators,
    opsWallet: terms.opsWallet, dammConfig: terms.dammConfig, backerBps: terms.backerBps, opsBps: terms.opsBps, launchCooldownSecs: terms.launchCooldownSecs,
    launchGraceSecs: terms.launchGraceSecs, limits: terms.limits, programId }
  const platformIx = mode === 'init'
    ? initPlatformInstruction({ ...args, upgradeAuthority: payer, admin: terms.admin })
    : setPlatformInstruction({ ...args, admin: payer, newAdmin: terms.admin })
  const tx = new Transaction({ feePayer: payer }).add(...missing.map(([owner, account]) =>
    createAssociatedTokenAccountIdempotentInstruction(payer, account, owner, NATIVE_MINT)), platformIx)
  const created = [...missing.map(([, account]) => account), ...mode === 'init' ? [platformAddress(programId)] : []]
  return { tx, created, createdTokenAccounts: missing.map(([, account]) => account), instructionSha256: instructionSha256(tx) }
}

// ------------------------------------------------------------ lookup table

// One table holding bundleLookupAddresses(); payer and authority (it can add entries, or deactivate and close the table, never
// change an entry). The table's address depends on the slot, so it is fixed only when the transaction lands.
export async function buildBundleLookupTableTransaction({ connection, authority, addresses }) {
  const authorityKey = key(authority)
  const recentSlot = await connection.getSlot('finalized')
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: authorityKey, payer: authorityKey, recentSlot })
  const extend = AddressLookupTableProgram.extendLookupTable({ payer: authorityKey, authority: authorityKey, lookupTable: table, addresses })
  return { tx: new Transaction({ feePayer: authorityKey }).add(create, extend), table }
}

export const lookupAddressesSha256 = addresses => createHash('sha256').update(addresses.map(address => key(address).toBase58()).join('\n')).digest('hex')
