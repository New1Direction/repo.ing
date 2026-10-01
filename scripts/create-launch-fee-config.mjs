import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Connection, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { buildLaunchFeeConfigTransaction, reviewLaunchFeeConfig, verifyCreatedLaunchFeeConfig } from '../src/launch-fee-config.mjs'
import { feeNumeratorAt, feePercentLabel, LAUNCH_FEE_SCHEDULE, readFeeSchedule } from '../src/launch-fee.mjs'

// Creates the mainnet launch-fee DBC config (docs/LAUNCH_FEE.md). DRY RUN BY DEFAULT: builds the createConfig
// instruction, simulates it unsigned against mainnet and prints the config address, exact payer debit and the
// instruction/account hashes to approve; nothing is signed or sent. --execute sends it only when the reviewed
// values are approved in the environment. Creating the config does not change DBC_CONFIG or any market.
//
//   node scripts/create-launch-fee-config.mjs                     # review (generates the config key once)
//   APPROVED_LAUNCH_FEE_CONFIG=<address> APPROVED_LAUNCH_FEE_INSTRUCTION_SHA256=<hash> \
//   APPROVED_LAUNCH_FEE_DEBIT_LAMPORTS=<lamports> node scripts/create-launch-fee-config.mjs --execute
//
// SOLANA_RPC_URL (https) selects the RPC; otherwise the production web RPC is read (read-only) from Railway.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const PARTNER = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3' // fee claimer and rent payer, as for every prior config
const LEFTOVER_RECEIVER = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // creator signer: 1% builder allocation reserve
const REFERENCE_CONFIG = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M' // current flat 1.75% builders config
const USAGE = 'Usage: node scripts/create-launch-fee-config.mjs [--keypair <path>] [--execute]'

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const keyFlag = args.indexOf('--keypair')
assert(args.every((arg, index) => arg === '--execute' || arg === '--keypair' || (keyFlag >= 0 && index === keyFlag + 1)), USAGE)
assert(keyFlag < 0 || args[keyFlag + 1], USAGE)
const keyPath = keyFlag >= 0 ? path.resolve(args[keyFlag + 1]) : new URL('../secrets/launch-fee-config-keypair.json', import.meta.url)

function productionRpc() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL
  const variables = spawnSync('railway', ['variable', 'list', '--service', 'web', '--environment', 'production',
    '--project', '507c3e92-c0a7-4c83-8622-172e88509b68', '--json'], { encoding: 'utf8' })
  assert.equal(variables.status, 0, 'Set SOLANA_RPC_URL or log in to Railway to read the production RPC')
  return JSON.parse(variables.stdout).SOLANA_RPC_URL
}

const rpc = productionRpc()
assert(rpc?.startsWith('https://'), 'Mainnet RPC URL is missing or not HTTPS')
const connection = new Connection(rpc, 'confirmed')
assert.equal(await connection.getGenesisHash(), MAINNET_GENESIS, 'RPC is not Solana mainnet')

// The config address is a fresh keypair, created once and kept outside Git (secrets/ is ignored, mode 0600).
if (!existsSync(keyPath)) {
  assert(!execute, 'Review the config before sending: run without --execute first')
  mkdirSync(path.dirname(keyPath instanceof URL ? keyPath.pathname : keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600, flag: 'wx' })
}
const configSigner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
const config = configSigner.publicKey.toBase58()

const { tx, instructionSha256 } = await buildLaunchFeeConfigTransaction({ connection, config, partner: PARTNER,
  leftoverReceiver: LEFTOVER_RECEIVER })
const review = await reviewLaunchFeeConfig({ connection, tx, config, payer: PARTNER, reference: REFERENCE_CONFIG })
const schedule = readFeeSchedule(review.decoded)
const feeAt = seconds => feePercentLabel(feeNumeratorAt(schedule, 0n, BigInt(seconds)))
const reviewed = { network: 'mainnet', config, partner: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER, referenceConfig: REFERENCE_CONFIG,
  differsFromReferenceOnlyIn: review.differences, launchFee: { mode: 'exponential fee scheduler, timestamp activation',
    cliffFeeNumerator: LAUNCH_FEE_SCHEDULE.cliffFeeNumerator.toString(), numberOfPeriod: LAUNCH_FEE_SCHEDULE.numberOfPeriod,
    periodSeconds: LAUNCH_FEE_SCHEDULE.periodFrequency.toString(), reductionFactorBps: LAUNCH_FEE_SCHEDULE.reductionFactor.toString(),
    endFeeNumerator: schedule.endNumerator.toString(), launcherFirstBuyFee: feePercentLabel(schedule.endNumerator),
    feeAtSeconds: Object.fromEntries([0, 5, 10, 30, 60, 90, 120, 150, 180].map(seconds => [seconds, feeAt(seconds)])) },
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes,
  rentLamports: review.rentLamports, networkFeeLamports: review.networkFeeLamports, totalDebitLamports: review.totalDebitLamports,
  partnerBalanceLamports: review.payerBalanceLamports, unsignedSimulationPassed: true, broadcast: false }
const reviewFile = path.join(tmpdir(), 'repo-ing-launch-fee-config-review.json')
writeFileSync(reviewFile, JSON.stringify(reviewed, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ ...reviewed, reviewFile }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_LAUNCH_FEE_CONFIG, config, 'Config address requires explicit approval')
  assert.equal(process.env.APPROVED_LAUNCH_FEE_INSTRUCTION_SHA256, instructionSha256, 'Exact instruction requires approval')
  assert.equal(process.env.APPROVED_LAUNCH_FEE_DEBIT_LAMPORTS, String(review.totalDebitLamports), 'Exact spend requires approval')
  assert(review.payerBalanceLamports >= review.totalDebitLamports + 1_000_000, 'Partner wallet needs the debit plus 0.001 SOL buffer')
  const secret = spawnSync('security', ['find-generic-password', '-s', 'repo.ing.dbc.partner', '-a', 'production', '-w'], { encoding: 'utf8' })
  assert.equal(secret.status, 0, 'Protected partner key unavailable')
  const partner = Keypair.fromSecretKey(bs58.decode(secret.stdout.trim()))
  assert.equal(partner.publicKey.toBase58(), PARTNER, 'Keychain partner key does not match the reviewed partner')
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(partner, configSigner)
  const signed = await connection.simulateTransaction(VersionedTransaction.deserialize(tx.serialize()), { sigVerify: true, commitment: 'confirmed' })
  assert.equal(signed.value.err, null, `Signed preflight failed: ${JSON.stringify(signed.value.err)}`)
  const signature = await sendAndConfirmTransaction(connection, tx, [partner, configSigner], { commitment: 'finalized' })
  await verifyCreatedLaunchFeeConfig({ connection, config, accountDataSha256: review.accountDataSha256 })
  console.log(JSON.stringify({ signature, config, finalized: true, accountMatchesReview: true, broadcast: true }, null, 2))
}
