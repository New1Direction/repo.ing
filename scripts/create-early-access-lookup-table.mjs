import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { EARLY_ACCESS_FEE_CLAIMER, earlyAccessLookupAddresses, readEarlyAccessConfig } from '../src/early-access-config.mjs'

// Creates the address lookup table every contributor early access launch is built with (docs/EARLY_ACCESS.md): one table
// holding the keys all those launches share, so the launch fits one v0 transaction. DRY RUN BY DEFAULT: checks the config is
// the early access config, builds the create and extend instructions, simulates them unsigned against mainnet and prints the
// addresses, their hash and the exact debit to approve; nothing is signed or sent. --execute sends it only when those values
// are approved in the environment, then prints the table's address for EARLY_ACCESS_LOOKUP_TABLE.
//
//   node scripts/create-early-access-lookup-table.mjs --config <EARLY_ACCESS_DBC_CONFIG>
//   APPROVED_LOOKUP_TABLE_ADDRESSES_SHA256=<hash> APPROVED_LOOKUP_TABLE_DEBIT_LAMPORTS=<lamports> \
//     node scripts/create-early-access-lookup-table.mjs --config <address> --execute
//
// The partner wallet pays and is the table's authority: it can add entries, or deactivate and close the table (launches then
// need a new one); no one can change an entry. The table's address depends on the slot it is created at, so it is known only
// after --execute. SOLANA_RPC_URL (https) selects the RPC; otherwise the production web RPC is read (read-only) from Railway.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const PARTNER = EARLY_ACCESS_FEE_CLAIMER.toBase58() // fee claimer, payer and the table's authority
const CREATOR = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the launch co-signer: the config's leftover receiver
const USAGE = 'Usage: node scripts/create-early-access-lookup-table.mjs --config <early access config> [--execute]'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute')
const known = new Set(['--execute', '--config'])
assert(args.every((arg, index) => known.has(arg) || known.has(args[index - 1])), USAGE)
let config
try { config = new PublicKey(option('--config')) } catch { assert.fail(`${USAGE}\n--config must be the early access config's address`) }

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
await readEarlyAccessConfig(connection, config, { leftoverReceiver: new PublicKey(CREATOR), feeClaimer: EARLY_ACCESS_FEE_CLAIMER })

const addresses = earlyAccessLookupAddresses(config)
const addressesSha256 = createHash('sha256').update(addresses.map(address => address.toBase58()).join('\n')).digest('hex')
const partnerKey = new PublicKey(PARTNER)
async function build() {
  const recentSlot = await connection.getSlot('finalized')
  const [create, table] = AddressLookupTableProgram.createLookupTable({ authority: partnerKey, payer: partnerKey, recentSlot })
  const extend = AddressLookupTableProgram.extendLookupTable({ payer: partnerKey, authority: partnerKey, lookupTable: table, addresses })
  const tx = new Transaction({ feePayer: partnerKey, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash }).add(create, extend)
  return { tx, table }
}

const { tx, table } = await build()
const [balance, fee, rent] = await Promise.all([connection.getBalance(partnerKey, 'confirmed'), connection.getFeeForMessage(tx.compileMessage(), 'confirmed'),
  connection.getMinimumBalanceForRentExemption(56 + 32 * addresses.length)])
const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true,
  commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [PARTNER, table.toBase58()] } })
assert.equal(simulation.value.err, null, `Unsigned simulation failed: ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).slice(-4).join(' | ')}`)
const [partnerAfter, created] = simulation.value.accounts ?? []
assert(created?.owner === AddressLookupTableProgram.programId.toBase58(), 'Simulation did not create a lookup table')
const totalDebitLamports = balance - partnerAfter.lamports
assert.equal(totalDebitLamports, rent + fee.value, 'Unexpected simulated payer debit')
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
console.log(JSON.stringify({ network: 'mainnet', config: config.toBase58(), authority: PARTNER, addresses: addresses.map(String), addressesSha256,
  inPlainWords: `Creates a list of ${addresses.length} addresses every early access launch uses, so a launch fits one transaction. It holds ` +
    `no funds and changes no market. It costs ${sol(totalDebitLamports)} (rent and network fee) from the partner wallet.`,
  rentLamports: rent, networkFeeLamports: fee.value, totalDebitLamports, partnerBalanceLamports: balance, dryRunTableAddress: table.toBase58(),
  note: 'The table address is fixed only when it is created (it depends on the slot).', unsignedSimulationPassed: true, broadcast: false }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_LOOKUP_TABLE_ADDRESSES_SHA256, addressesSha256, 'The exact addresses require approval')
  assert.equal(process.env.APPROVED_LOOKUP_TABLE_DEBIT_LAMPORTS, String(totalDebitLamports), 'Exact spend requires approval')
  assert(balance >= totalDebitLamports + 1_000_000, 'Partner wallet needs the debit plus 0.001 SOL buffer')
  const secret = spawnSync('security', ['find-generic-password', '-s', 'repo.ing.dbc.partner', '-a', 'production', '-w'], { encoding: 'utf8' })
  assert.equal(secret.status, 0, 'Protected partner key unavailable')
  const partner = Keypair.fromSecretKey(bs58.decode(secret.stdout.trim()))
  assert.equal(partner.publicKey.toBase58(), PARTNER, 'Keychain partner key does not match the reviewed partner')
  const fresh = await build()
  fresh.tx.sign(partner)
  const signed = await connection.simulateTransaction(VersionedTransaction.deserialize(fresh.tx.serialize()), { sigVerify: true, commitment: 'confirmed' })
  assert.equal(signed.value.err, null, `Signed preflight failed: ${JSON.stringify(signed.value.err)}`)
  const signature = await sendAndConfirmTransaction(connection, fresh.tx, [partner], { commitment: 'finalized' })
  const state = (await connection.getAddressLookupTable(fresh.table, { commitment: 'finalized' })).value?.state
  assert.deepEqual(state?.addresses.map(String), addresses.map(String), 'The created table differs from the reviewed addresses')
  console.log(JSON.stringify({ signature, lookupTable: fresh.table.toBase58(), finalized: true, broadcast: true,
    next: `Set EARLY_ACCESS_LOOKUP_TABLE=${fresh.table.toBase58()} on web and worker.` }, null, 2))
}
