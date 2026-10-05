import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Connection, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { buildEarlyAccessConfigTransaction, reviewEarlyAccessConfig, verifyCreatedEarlyAccessConfig } from '../src/early-access-config.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID } from '../src/early-access-hook.mjs'

// Creates the contributor early access DBC config on mainnet (docs/EARLY_ACCESS.md). DRY RUN BY DEFAULT: builds the
// create_config_with_transfer_hook instruction, checks it, simulates it unsigned against mainnet, checks the simulated account
// (the builders curve with a Token-2022 base and the early access hook, the same terms as the live SOL launch-fee config but its
// fee), and prints the config address, the exact payer debit and the instruction hash to approve; nothing is signed or sent.
// --execute sends it only when those reviewed values are approved in the environment. Creating the config launches nothing and
// changes no market: launches use it only once EARLY_ACCESS_DBC_CONFIG names it and early access is switched on.
//
//   node scripts/create-early-access-config.mjs
//   APPROVED_EARLY_ACCESS_CONFIG=<address> APPROVED_EARLY_ACCESS_CONFIG_INSTRUCTION_SHA256=<hash> \
//     APPROVED_EARLY_ACCESS_CONFIG_DEBIT_LAMPORTS=<lamports> node scripts/create-early-access-config.mjs --execute
//
// SOLANA_RPC_URL (https) selects the RPC; otherwise the production web RPC is read (read-only) from Railway.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const PARTNER = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3' // fee claimer and rent payer, as for every prior config
const LEFTOVER_RECEIVER = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the creator signer, as on the builders configs
const REFERENCE_CONFIG = '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3' // the live SOL launch-fee config (docs/LAUNCH_FEE.md)
const USAGE = 'Usage: node scripts/create-early-access-config.mjs [--keypair <path>] [--execute]'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute')
const known = new Set(['--execute', '--keypair'])
assert(args.every((arg, index) => known.has(arg) || known.has(args[index - 1])), USAGE)
const keyPath = option('--keypair') ? path.resolve(option('--keypair')) : new URL('../secrets/early-access-config-keypair.json', import.meta.url)

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
const hookProgram = await connection.getAccountInfo(EARLY_ACCESS_HOOK_PROGRAM_ID, 'confirmed')
assert(hookProgram?.executable, `The early access hook program ${EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58()} is not deployed: deploy it first`)

// The config address is a fresh keypair, created once and kept outside Git (secrets/ is ignored, mode 0600).
if (!existsSync(keyPath)) {
  assert(!execute, 'Review the config before sending: run without --execute first')
  mkdirSync(path.dirname(keyPath instanceof URL ? keyPath.pathname : keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600, flag: 'wx' })
}
const configSigner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
const config = configSigner.publicKey.toBase58()

const { tx, curve, instructionSha256 } = await buildEarlyAccessConfigTransaction({ connection, config, partner: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER })
const review = await reviewEarlyAccessConfig({ connection, tx, config, payer: PARTNER, feeClaimer: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER,
  reference: REFERENCE_CONFIG, curve })
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
const reviewed = { network: 'mainnet', config, partner: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER, transferHookProgram: EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58(),
  referenceConfig: REFERENCE_CONFIG,
  inPlainWords: 'Creates the Meteora settings account that contributor early access markets launch on. The same curve and split as ' +
    'today\'s SOL launches (85 SOL graduation, 1% builder allocation, 71% of the fee after Meteora\'s 20% to builders and 29% to ' +
    'repo.ing, half of the graduated pool\'s liquidity permanently locked for each side), with a flat 1.75% trading fee and no ' +
    'launch fee. Its tokens are Token-2022 tokens whose transfers run the early access hook until the curve is full. It holds no ' +
    `funds, launches nothing and changes no market. It costs ${sol(review.totalDebitLamports)} (rent and network fee) from the partner wallet.`,
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes, rentLamports: review.rentLamports,
  networkFeeLamports: review.networkFeeLamports, totalDebitLamports: review.totalDebitLamports, partnerBalanceLamports: review.payerBalanceLamports,
  unsignedSimulationPassed: true, sameTermsAsReferenceButFeeAndToken: true, broadcast: false }
const reviewFile = path.join(tmpdir(), 'repo-ing-early-access-config-review.json')
writeFileSync(reviewFile, JSON.stringify(reviewed, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ ...reviewed, reviewFile }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_EARLY_ACCESS_CONFIG, config, 'Config address requires explicit approval')
  assert.equal(process.env.APPROVED_EARLY_ACCESS_CONFIG_INSTRUCTION_SHA256, instructionSha256, 'Exact instruction requires approval')
  assert.equal(process.env.APPROVED_EARLY_ACCESS_CONFIG_DEBIT_LAMPORTS, String(review.totalDebitLamports), 'Exact spend requires approval')
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
  await verifyCreatedEarlyAccessConfig({ connection, config, accountDataSha256: review.accountDataSha256 })
  console.log(JSON.stringify({ signature, config, finalized: true, accountMatchesReview: true, broadcast: true,
    next: `Set EARLY_ACCESS_DBC_CONFIG=${config} on web and worker, then create the lookup table: node scripts/create-early-access-lookup-table.mjs --config ${config}` }, null, 2))
}
