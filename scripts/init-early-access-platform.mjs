import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, decodePlatform, initPlatformInstruction, platformAddress, programDataAddress } from '../src/early-access-hook.mjs'
import { earlyAccessOracle } from '../src/early-access.mjs'

// Sets the early access hook's platform account once (docs/EARLY_ACCESS.md, init_platform): admin = the launch co-signer (the
// platform creator signer, PLATFORM_CREATOR_SECRET_KEY's public key), which sets each early access token's window and takes a
// non-contributor launcher off its list; oracle = EARLY_ACCESS_ORACLE_SECRET_KEY's public key, which keeps the lists current.
// Only the program's upgrade authority may call it. DRY RUN BY DEFAULT: checks the program and its upgrade authority, simulates
// the instruction unsigned against mainnet and prints what it sets; nothing is signed or sent. --execute sends it, signed by the
// upgrade authority keypair given with --upgrade-authority, only when the admin and oracle are approved in the environment.
//
//   node scripts/init-early-access-platform.mjs --oracle <public key>
//   APPROVED_EARLY_ACCESS_PLATFORM=<admin>:<oracle> node scripts/init-early-access-platform.mjs --oracle <public key> \
//     --upgrade-authority <keypair.json> --execute
//
// --oracle may be left out when EARLY_ACCESS_ORACLE_SECRET_KEY is set (only its public key is used). --admin defaults to the
// production creator signer. SOLANA_RPC_URL (https) selects the RPC; otherwise the production web RPC is read from Railway.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const CREATOR = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the launch co-signer (PLATFORM_CREATOR_SECRET_KEY)
const USAGE = 'Usage: node scripts/init-early-access-platform.mjs [--admin <public key>] [--oracle <public key>] [--upgrade-authority <keypair.json>] [--execute]'

const args = process.argv.slice(2)
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute')
const known = new Set(['--execute', '--admin', '--oracle', '--upgrade-authority'])
assert(args.every((arg, index) => known.has(arg) || known.has(args[index - 1])), USAGE)
const key = (value, name) => { try { return new PublicKey(value) } catch { assert.fail(`${USAGE}\n${name} must be a base58 public key`) } }
const admin = key(option('--admin') ?? CREATOR, '--admin')
const oracle = option('--oracle') ? key(option('--oracle'), '--oracle') : earlyAccessOracle()?.publicKey
assert(oracle, `${USAGE}\nGive --oracle or set EARLY_ACCESS_ORACLE_SECRET_KEY`)
assert(!admin.equals(oracle), 'The admin and the oracle must be different keys')
assert(!admin.equals(PublicKey.default) && !oracle.equals(PublicKey.default), 'Neither key may be the default key')

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

// The upgradeable loader's ProgramData account: [u32 kind = 3][u64 slot][Option<Pubkey> upgrade authority].
const [program, programData, existing] = await Promise.all([connection.getAccountInfo(EARLY_ACCESS_HOOK_PROGRAM_ID, 'confirmed'),
  connection.getAccountInfo(programDataAddress(), 'confirmed'), connection.getAccountInfo(platformAddress(), 'confirmed')])
assert(program?.executable, 'The early access hook program is not deployed')
assert(programData && programData.data.readUInt32LE(0) === 3 && programData.data[12] === 1, 'The hook program has no upgrade authority, so init_platform cannot run')
const upgradeAuthority = new PublicKey(programData.data.subarray(13, 45))
if (existing) {
  const platform = decodePlatform(existing.data)
  console.log(JSON.stringify({ alreadySet: true, admin: platform.admin.toBase58(), oracle: platform.oracle.toBase58(),
    note: 'init_platform runs once; the admin changes keys with set_platform.' }, null, 2))
  process.exit(platform.admin.equals(admin) && platform.oracle.equals(oracle) ? 0 : 1)
}

const build = async () => new Transaction({ feePayer: upgradeAuthority, recentBlockhash: (await connection.getLatestBlockhash('confirmed')).blockhash })
  .add(initPlatformInstruction({ upgradeAuthority, admin, oracle }))
const tx = await build()
const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true,
  commitment: 'confirmed' })
assert.equal(simulation.value.err, null, `Unsigned simulation failed: ${JSON.stringify(simulation.value.err)} ${(simulation.value.logs ?? []).slice(-4).join(' | ')}`)
console.log(JSON.stringify({ network: 'mainnet', program: EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58(), platform: platformAddress().toBase58(),
  upgradeAuthority: upgradeAuthority.toBase58(), admin: admin.toBase58(), oracle: oracle.toBase58(), approval: `${admin.toBase58()}:${oracle.toBase58()}`,
  inPlainWords: 'Names the two keys the early access hook trusts: the admin (repo.ing\'s launch co-signer) sets each early access ' +
    'token\'s window and can take wallets off its list; the oracle adds contributors\' wallets during the window. It moves no funds. ' +
    'Afterwards, hand the program\'s upgrade authority to a multisig (docs/EARLY_ACCESS.md).',
  unsignedSimulationPassed: true, broadcast: false }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_EARLY_ACCESS_PLATFORM, `${admin.toBase58()}:${oracle.toBase58()}`, 'The admin and oracle require explicit approval')
  const keyPath = option('--upgrade-authority')
  assert(keyPath, `${USAGE}\n--execute needs --upgrade-authority`)
  const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.resolve(keyPath), 'utf8'))))
  assert(signer.publicKey.equals(upgradeAuthority), 'The keypair is not the program\'s upgrade authority')
  const fresh = await build()
  fresh.sign(signer)
  const signed = await connection.simulateTransaction(VersionedTransaction.deserialize(fresh.serialize()), { sigVerify: true, commitment: 'confirmed' })
  assert.equal(signed.value.err, null, `Signed preflight failed: ${JSON.stringify(signed.value.err)}`)
  const signature = await sendAndConfirmTransaction(connection, fresh, [signer], { commitment: 'finalized' })
  const platform = decodePlatform((await connection.getAccountInfo(platformAddress(), 'finalized')).data)
  assert(platform.admin.equals(admin) && platform.oracle.equals(oracle), 'The platform account differs from the approved keys')
  console.log(JSON.stringify({ signature, platform: platformAddress().toBase58(), admin: admin.toBase58(), oracle: oracle.toBase58(), finalized: true, broadcast: true }, null, 2))
}
