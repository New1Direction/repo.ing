import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Connection, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { BUNDLE_VAULT_PROGRAM_ID, routerAddress } from '../src/bundle-vault.mjs'
import { buildBundleConfigTransaction, bundleDammConfig } from '../src/bundle-config.mjs'
import { bundleProgramState, reviewBundleConfig, verifyCreatedBundleConfig } from '../src/bundle-setup.mjs'

// Creates the Bundle launch DBC config on mainnet (docs/BUNDLE_LAUNCH.md, "Mainnet setup", step 2). DRY RUN BY DEFAULT: builds the
// create_config instruction (the 85 SOL launch-fee curve of standard launches, with the bundle program's router PDA as fee
// claimer), checks it, simulates it unsigned against mainnet, checks the simulated account (what init_platform requires, and equal
// to the live SOL launch-fee config in every field but the fee claimer), and prints the config address, the exact payer debit and
// the instruction hash to approve; nothing is signed or sent. --execute sends it only when those reviewed values are approved in
// the environment. Creating the config launches nothing and changes no market; the platform account names it next.
//
//   SOLANA_RPC_URL=<https mainnet RPC> node scripts/create-bundle-config.mjs
//   APPROVED_BUNDLE_CONFIG=<address> APPROVED_BUNDLE_CONFIG_INSTRUCTION_SHA256=<hash> \
//     APPROVED_BUNDLE_CONFIG_DEBIT_LAMPORTS=<lamports> SOLANA_RPC_URL=<...> node scripts/create-bundle-config.mjs --execute
//
// SOLANA_RPC_URL (https, mainnet by genesis hash) is required: the script reads no other setting.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const PARTNER = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3' // rent payer, as for every prior config (it is not the fee claimer here)
const LEFTOVER_RECEIVER = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the creator signer: 1% builder allocation reserve, as on the launch-fee config
const REFERENCE_CONFIG = '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3' // the live SOL launch-fee config (docs/LAUNCH_FEE.md)
const USAGE = 'Usage: SOLANA_RPC_URL=<https mainnet RPC> node scripts/create-bundle-config.mjs [--keypair <path>] [--execute]'

const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--execute') continue
  assert(args[i] === '--keypair' && args[i + 1] && !args[i + 1].startsWith('--'), USAGE)
  i++
}
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute')
const keyPath = option('--keypair') ? path.resolve(option('--keypair')) : new URL('../secrets/bundle-config-keypair.json', import.meta.url)

const rpc = process.env.SOLANA_RPC_URL
assert(rpc?.startsWith('https://'), `${USAGE}\nSOLANA_RPC_URL is missing or not HTTPS`)
const connection = new Connection(rpc, 'confirmed')
assert.equal(await connection.getGenesisHash(), MAINNET_GENESIS, 'RPC is not Solana mainnet')
// The order is deploy, then config: a config whose router belongs to a program that does not exist would be useless.
await bundleProgramState(connection)

// The config address is a fresh keypair, created once and kept outside Git (secrets/ is ignored, mode 0600).
if (!existsSync(keyPath)) {
  assert(!execute, 'Review the config before sending: run without --execute first')
  mkdirSync(path.dirname(keyPath instanceof URL ? keyPath.pathname : keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600, flag: 'wx' })
}
const configSigner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
const config = configSigner.publicKey.toBase58()

const { tx, instructionSha256 } = await buildBundleConfigTransaction({ connection, config, payer: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER })
const review = await reviewBundleConfig({ connection, tx, config, payer: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER, reference: REFERENCE_CONFIG })
assert.deepEqual(review.differences, ['feeClaimer'], 'The config must differ from the live launch-fee config in its fee claimer only')
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
const reviewed = { network: 'mainnet', config, feeClaimer: routerAddress().toBase58(), bundleProgram: BUNDLE_VAULT_PROGRAM_ID.toBase58(), payer: PARTNER,
  leftoverReceiver: LEFTOVER_RECEIVER, referenceConfig: REFERENCE_CONFIG, differsFromReferenceOnlyIn: review.differences,
  dammConfig: bundleDammConfig(review.decoded).toBase58(),
  inPlainWords: 'Creates the Meteora settings account Bundle launch markets launch on. The same curve and split as today\'s SOL ' +
    'launches (85 SOL graduation, 1% builder allocation, the launch fee falling to 1.75%, 71% of the fee after Meteora\'s 20% to ' +
    'builders, half of the graduated pool\'s liquidity permanently locked for each side), except that the partner share of its fees ' +
    'goes to the bundle program\'s router account (which routes it to the vault, the backers and repo.ing), not to the partner ' +
    `wallet. It holds no funds, launches nothing and changes no market. It costs ${sol(review.totalDebitLamports)} (rent and network fee) ` +
    'from the partner wallet.',
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes, rentLamports: review.rentLamports,
  networkFeeLamports: review.networkFeeLamports, totalDebitLamports: review.totalDebitLamports, partnerBalanceLamports: review.payerBalanceLamports,
  unsignedSimulationPassed: true, bundleProgramWouldAcceptIt: true, broadcast: false }
const reviewFile = path.join(tmpdir(), 'repo-ing-bundle-config-review.json')
writeFileSync(reviewFile, JSON.stringify(reviewed, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ ...reviewed, reviewFile }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_BUNDLE_CONFIG, config, 'Config address requires explicit approval')
  assert.equal(process.env.APPROVED_BUNDLE_CONFIG_INSTRUCTION_SHA256, instructionSha256, 'Exact instruction requires approval')
  assert.equal(process.env.APPROVED_BUNDLE_CONFIG_DEBIT_LAMPORTS, String(review.totalDebitLamports), 'Exact spend requires approval')
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
  await verifyCreatedBundleConfig({ connection, config, accountDataSha256: review.accountDataSha256, leftoverReceiver: LEFTOVER_RECEIVER })
  console.log(JSON.stringify({ signature, config, finalized: true, accountMatchesReview: true, broadcast: true,
    next: `Init the platform with this config: node scripts/init-bundle-platform.mjs --config ${config} --admin <key> --launch-signer <key> ` +
      '--operator <key> --ops-wallet <key> --treasury-owner <key>' }, null, 2))
}
