import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Connection, Keypair, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { buildStockQuoteConfigTransaction, reviewStockQuoteConfig, verifyCreatedStockQuoteConfig } from '../src/stock-quote-config.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'

// Creates one stock pair's mainnet DBC config (docs/STOCK_QUOTES.md). DRY RUN BY DEFAULT: builds the createConfig instruction,
// simulates it unsigned against mainnet, checks the simulated account is the live SOL launch-fee config's terms quoted in the
// stock, and prints the config address, the exact payer debit and the instruction hash to approve; nothing is signed or sent.
// --execute sends it only when those reviewed values are approved in the environment. Creating the config launches nothing and
// changes no market: launches use it only once STOCK_QUOTE_CONFIGS names it and stock pairs are switched on.
//
//   node scripts/create-stock-quote-config.mjs --asset meta-xstock --graduation 14
//   APPROVED_STOCK_CONFIG=<address> APPROVED_STOCK_CONFIG_INSTRUCTION_SHA256=<hash> APPROVED_STOCK_CONFIG_DEBIT_LAMPORTS=<lamports> \
//     node scripts/create-stock-quote-config.mjs --asset meta-xstock --graduation 14 --execute
//
// --graduation is the curve's graduation threshold in whole units of the stock (for example 14 METAx); it moves with the stock's
// price, not SOL's. SOLANA_RPC_URL (https) selects the RPC; otherwise the production web RPC is read (read-only) from Railway.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const PARTNER = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3' // fee claimer and rent payer, as for every prior config
const LEFTOVER_RECEIVER = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the creator signer, as on the reference config
const REFERENCE_CONFIG = '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3' // the live SOL launch-fee config (docs/LAUNCH_FEE.md)
const USAGE = 'Usage: node scripts/create-stock-quote-config.mjs --asset <asset id> --graduation <whole units> [--keypair <path>] [--execute]'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute')
const known = new Set(['--execute', '--asset', '--graduation', '--keypair'])
assert(args.every((arg, index) => known.has(arg) || known.has(args[index - 1])), USAGE)
const asset = quoteAssetById(option('--asset'))
assert(asset && asset.type === 'TOKENIZED_EQUITY' && asset.enabled, `${USAGE}\n--asset must be an enabled stock asset id from src/quote-assets.mjs`)
const graduation = Number(option('--graduation'))
assert(Number.isInteger(graduation) && graduation > 0, `${USAGE}\n--graduation must be a positive whole number of ${asset.symbol}`)
const keyPath = option('--keypair') ? path.resolve(option('--keypair')) : new URL(`../secrets/stock-config-${asset.assetId}-keypair.json`, import.meta.url)

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

// The config address is a fresh keypair, created once per asset and kept outside Git (secrets/ is ignored, mode 0600).
if (!existsSync(keyPath)) {
  assert(!execute, 'Review the config before sending: run without --execute first')
  mkdirSync(path.dirname(keyPath instanceof URL ? keyPath.pathname : keyPath), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600, flag: 'wx' })
}
const configSigner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
const config = configSigner.publicKey.toBase58()

const { tx, instructionSha256 } = await buildStockQuoteConfigTransaction({ connection, config, asset, graduation, partner: PARTNER,
  leftoverReceiver: LEFTOVER_RECEIVER })
const review = await reviewStockQuoteConfig({ connection, tx, config, payer: PARTNER, reference: REFERENCE_CONFIG, asset, graduation })
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
const reviewed = { network: 'mainnet', asset: asset.assetId, quoteMint: asset.mint, config, partner: PARTNER, leftoverReceiver: LEFTOVER_RECEIVER,
  referenceConfig: REFERENCE_CONFIG, graduationThreshold: `${graduation} ${asset.symbol}`,
  inPlainWords: `Creates the Meteora settings account that new <repo> / ${asset.symbol} markets launch on. Same terms as today's SOL ` +
    `launches: 1.75% trading fee with the same launch-fee window, 71% of the fee after Meteora's 20% to builders and 29% to repo.ing, ` +
    `half of the graduated pool's liquidity permanently locked for each side. Quoted in ${asset.symbol}; a market graduates when its ` +
    `curve holds ${graduation} ${asset.symbol}. It holds no funds, launches nothing and changes no market. It costs ` +
    `${sol(review.totalDebitLamports)} (rent and network fee) from the partner wallet.`,
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes, rentLamports: review.rentLamports,
  networkFeeLamports: review.networkFeeLamports, totalDebitLamports: review.totalDebitLamports, partnerBalanceLamports: review.payerBalanceLamports,
  unsignedSimulationPassed: true, sameTermsAsReference: true, broadcast: false }
const reviewFile = path.join(tmpdir(), `repo-ing-stock-config-${asset.assetId}-review.json`)
writeFileSync(reviewFile, JSON.stringify(reviewed, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify({ ...reviewed, reviewFile }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_STOCK_CONFIG, config, 'Config address requires explicit approval')
  assert.equal(process.env.APPROVED_STOCK_CONFIG_INSTRUCTION_SHA256, instructionSha256, 'Exact instruction requires approval')
  assert.equal(process.env.APPROVED_STOCK_CONFIG_DEBIT_LAMPORTS, String(review.totalDebitLamports), 'Exact spend requires approval')
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
  await verifyCreatedStockQuoteConfig({ connection, config, accountDataSha256: review.accountDataSha256 })
  console.log(JSON.stringify({ signature, config, finalized: true, accountMatchesReview: true, broadcast: true,
    next: `Set STOCK_QUOTE_CONFIGS={"${asset.assetId}":"${config}"} on web and worker; stock pairs stay off until switched on.` }, null, 2))
}
