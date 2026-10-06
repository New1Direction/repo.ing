import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { bundleLookupAddresses, readBundleConfig } from '../src/bundle-config.mjs'
import { buildBundleLookupTableTransaction, lookupAddressesSha256, readBundlePlatform, simulateSetup } from '../src/bundle-setup.mjs'

// Creates the address lookup table every Bundle launch is built with (docs/BUNDLE_LAUNCH.md, "Mainnet setup", step 4): one table
// holding the 14 keys all those launches share (bundleLookupAddresses: DBC's pool and event authorities and program, SPL Token,
// System, the instructions sysvar, wrapped SOL, the bundle program, the bundle config, the associated token program, Metaplex,
// Compute Budget, the platform account and the operations wallet), so the launch fits one v0 transaction. DRY RUN BY DEFAULT:
// checks the config is the bundle config and the platform names it, builds the create and extend instructions, simulates them
// unsigned against mainnet and prints the addresses, their hash and the exact debit to approve; nothing is signed or sent.
// --execute sends it only when those values are approved in the environment, then prints the table's address.
//
//   SOLANA_RPC_URL=<https mainnet RPC> node scripts/create-bundle-lookup-table.mjs --config <bundle config>
//   APPROVED_BUNDLE_LOOKUP_TABLE_ADDRESSES_SHA256=<hash> APPROVED_BUNDLE_LOOKUP_TABLE_DEBIT_LAMPORTS=<lamports> \
//     SOLANA_RPC_URL=<...> node scripts/create-bundle-lookup-table.mjs --config <address> --execute
//
// The partner wallet pays and is the table's authority: it can add entries, or deactivate and close the table (launches then
// need a new one); no one can change an entry. The operations wallet is read from the platform account, so a later set_platform
// that changes it needs a new table (or an added entry). The table's address depends on the slot it is created at, so it is
// known only after --execute. SOLANA_RPC_URL (https, mainnet by genesis hash) is required: the script reads no other setting.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const PARTNER = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3' // payer and the table's authority, as for the early access table
const CREATOR = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the creator signer: the bundle config's leftover receiver
const REFERENCE_CONFIG = '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3' // the live SOL launch-fee config: equal but for the fee claimer
const USAGE = 'Usage: SOLANA_RPC_URL=<https mainnet RPC> node scripts/create-bundle-lookup-table.mjs --config <bundle config> [--execute]'

const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--execute') continue
  assert(args[i] === '--config' && args[i + 1] && !args[i + 1].startsWith('--'), USAGE)
  i++
}
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute')
let config
try { config = new PublicKey(option('--config')) } catch { assert.fail(`${USAGE}\n--config must be the bundle config's address`) }

const rpc = process.env.SOLANA_RPC_URL
assert(rpc?.startsWith('https://'), `${USAGE}\nSOLANA_RPC_URL is missing or not HTTPS`)
const connection = new Connection(rpc, 'confirmed')
assert.equal(await connection.getGenesisHash(), MAINNET_GENESIS, 'RPC is not Solana mainnet')
await readBundleConfig(connection, config, { leftoverReceiver: CREATOR, reference: REFERENCE_CONFIG })
const platform = await readBundlePlatform(connection)
assert(platform, 'There is no bundle platform yet: run scripts/init-bundle-platform.mjs first')
assert(platform.curveConfig.equals(config), `The platform names another bundle config (${platform.curveConfig.toBase58()})`)

const addresses = bundleLookupAddresses(config, platform.opsWallet)
const addressesSha256 = lookupAddressesSha256(addresses)
const partnerKey = new PublicKey(PARTNER)
const { tx, table } = await buildBundleLookupTableTransaction({ connection, authority: partnerKey, addresses })
const review = await simulateSetup({ connection, tx, payer: partnerKey, created: [table] })
assert.equal(review.accounts[0].owner, AddressLookupTableProgram.programId.toBase58(), 'Simulation did not create a lookup table')
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
console.log(JSON.stringify({ network: 'mainnet', config: config.toBase58(), opsWallet: platform.opsWallet.toBase58(), authority: PARTNER,
  addresses: addresses.map(String), addressesSha256,
  inPlainWords: `Creates a list of ${addresses.length} addresses every Bundle launch uses, so a launch fits one transaction. It holds ` +
    `no funds and changes no market. It costs ${sol(review.totalDebitLamports)} (rent and network fee) from the partner wallet.`,
  rentLamports: review.rentLamports, networkFeeLamports: review.networkFeeLamports, totalDebitLamports: review.totalDebitLamports,
  partnerBalanceLamports: review.payerBalanceLamports, dryRunTableAddress: table.toBase58(),
  note: 'The table address is fixed only when it is created (it depends on the slot).', unsignedSimulationPassed: true, broadcast: false }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_BUNDLE_LOOKUP_TABLE_ADDRESSES_SHA256, addressesSha256, 'The exact addresses require approval')
  assert.equal(process.env.APPROVED_BUNDLE_LOOKUP_TABLE_DEBIT_LAMPORTS, String(review.totalDebitLamports), 'Exact spend requires approval')
  assert(review.payerBalanceLamports >= review.totalDebitLamports + 1_000_000, 'Partner wallet needs the debit plus 0.001 SOL buffer')
  const secret = spawnSync('security', ['find-generic-password', '-s', 'repo.ing.dbc.partner', '-a', 'production', '-w'], { encoding: 'utf8' })
  assert.equal(secret.status, 0, 'Protected partner key unavailable')
  const partner = Keypair.fromSecretKey(bs58.decode(secret.stdout.trim()))
  assert.equal(partner.publicKey.toBase58(), PARTNER, 'Keychain partner key does not match the reviewed partner')
  const fresh = await buildBundleLookupTableTransaction({ connection, authority: partnerKey, addresses })
  fresh.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  fresh.tx.sign(partner)
  const signed = await connection.simulateTransaction(VersionedTransaction.deserialize(fresh.tx.serialize()), { sigVerify: true, commitment: 'confirmed' })
  assert.equal(signed.value.err, null, `Signed preflight failed: ${JSON.stringify(signed.value.err)}`)
  const signature = await sendAndConfirmTransaction(connection, fresh.tx, [partner], { commitment: 'finalized' })
  const state = (await connection.getAddressLookupTable(fresh.table, { commitment: 'finalized' })).value?.state
  assert.deepEqual(state?.addresses.map(String), addresses.map(String), 'The created table differs from the reviewed addresses')
  console.log(JSON.stringify({ signature, lookupTable: fresh.table.toBase58(), finalized: true, broadcast: true,
    next: `Keep for the site (not read by any code yet): BUNDLE_DBC_CONFIG=${config.toBase58()} BUNDLE_LOOKUP_TABLE=${fresh.table.toBase58()}` }, null, 2))
}
