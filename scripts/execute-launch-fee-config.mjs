import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Connection, Keypair, PublicKey, sendAndConfirmRawTransaction } from '@solana/web3.js'
import { buildLaunchFeeConfigTransaction, reviewLaunchFeeConfig, verifyCreatedLaunchFeeConfig } from '../src/launch-fee-config.mjs'
import { EXTRA_20_SCHEDULE, readFeeSchedule, feeNumeratorAt, feePercentLabel } from '../src/launch-fee.mjs'
import { MULTISIG_VAULT } from '../src/custody-multisig.mjs'
import { MAINNET_ROLES } from '../src/hooklab-owner-driver/pins.mjs'

// Creates the owner-approved early-fee DBC config (2026-10-26): 20% extra on top of 1.75%, falling to 0 extra over 120 s,
// fee claimer and leftover receiver = the multisig vault, payer 3eCF, total cost capped. It refuses unless the transaction
// it builds is exactly the reviewed one (instruction and simulated account hashes), then reads the account back from two
// independently operated providers. Keys arrive as paths (with-custody-keys.sh pipes / the config key file) and are wiped.
//   SOLANA_RPC_URL=... VERIFICATION_RPC_URL=... PAYER_KEY=<path> CONFIG_KEY=<path> node scripts/execute-launch-fee-config.mjs \
//     --config <address> --instruction-sha256 <hex> --account-sha256 <hex> --cap-lamports <n>
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => i % 2 ? pairs : [...pairs, [all[i].replace(/^--/, ''), all[i + 1]]], []))
for (const name of ['config', 'instruction-sha256', 'account-sha256', 'cap-lamports']) assert(args[name], `--${name} required`)
for (const name of ['SOLANA_RPC_URL', 'VERIFICATION_RPC_URL', 'PAYER_KEY', 'CONFIG_KEY']) assert(process.env[name], `${name} required`)
const primary = new Connection(process.env.SOLANA_RPC_URL, 'confirmed'), verification = new Connection(process.env.VERIFICATION_RPC_URL, 'confirmed')
assert.notEqual(new URL(primary.rpcEndpoint).hostname, new URL(verification.rpcEndpoint).hostname, 'two independent providers required')
for (const c of [primary, verification]) assert.equal(await c.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'mainnet only')

const loadKey = (path, expected) => {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')))
  // Keypair keeps a reference to the array it is given: hand it a copy, then wipe the bytes read from the file.
  const key = Keypair.fromSecretKey(Uint8Array.from(bytes)); bytes.fill(0)
  assert.equal(key.publicKey.toBase58(), expected, 'key does not match its role')
  return key
}
const config = new PublicKey(args.config).toBase58(), payer = MAINNET_ROLES.payer, cap = BigInt(args['cap-lamports'])
assert(cap <= 10_000_000n, 'the approved cap is 0.01 SOL')
assert.equal(await primary.getAccountInfo(new PublicKey(config)), null, 'the config account already exists')

const { tx, instructionSha256 } = await buildLaunchFeeConfigTransaction({ connection: primary, config, payer,
  partner: MULTISIG_VAULT, leftoverReceiver: MULTISIG_VAULT, schedule: EXTRA_20_SCHEDULE })
assert.equal(instructionSha256, args['instruction-sha256'], 'instruction differs from the reviewed one')
const review = await reviewLaunchFeeConfig({ connection: primary, tx, config, payer, reference: '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M', custodyReplacement: true })
assert.equal(review.accountDataSha256, args['account-sha256'], 'simulated account differs from the reviewed one')
assert(BigInt(review.totalDebitLamports) <= cap, `cost ${review.totalDebitLamports} is over the cap ${cap}`)
const before = BigInt(await primary.getBalance(new PublicKey(payer), 'confirmed'))

const keys = [loadKey(process.env.PAYER_KEY, payer), loadKey(process.env.CONFIG_KEY, config)]
try {
  const latest = await primary.getLatestBlockhash('confirmed')
  tx.recentBlockhash = latest.blockhash; tx.lastValidBlockHeight = latest.lastValidBlockHeight
  tx.sign(...keys)
} finally { for (const key of keys) key.secretKey.fill(0) }
const signature = await sendAndConfirmRawTransaction(primary, tx.serialize(), { commitment: 'finalized', skipPreflight: false, maxRetries: 3 })
console.log(JSON.stringify({ signature }))

const readBack = {}
for (const [name, connection] of [['primary', primary], ['verification', verification]]) {
  let decoded
  for (let i = 0; i < 30 && !decoded; i++) {
    try { decoded = await verifyCreatedLaunchFeeConfig({ connection, config, accountDataSha256: args['account-sha256'] }) }
    catch (error) { if (i === 29) throw error; await new Promise(resolve => setTimeout(resolve, 2_000)) }
  }
  const schedule = readFeeSchedule(decoded)
  readBack[name] = { feeClaimer: decoded.feeClaimer.toBase58(), leftoverReceiver: decoded.leftoverReceiver.toBase58(),
    feeAt: Object.fromEntries([0, 60, 120].map(s => [s, feePercentLabel(feeNumeratorAt(schedule, 0n, BigInt(s)))])) }
  assert.equal(readBack[name].feeClaimer, MULTISIG_VAULT); assert.equal(readBack[name].leftoverReceiver, MULTISIG_VAULT)
}
const after = BigInt(await primary.getBalance(new PublicKey(payer), 'finalized'))
assert(before - after <= cap, `payer spent ${before - after}, over the cap`)
console.log(JSON.stringify({ config, signature, payerSpentLamports: String(before - after), readBack }, null, 2))
