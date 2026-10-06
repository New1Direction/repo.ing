import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Connection, Keypair, PublicKey, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { BUNDLE_VAULT_PROGRAM_ID, platformAddress, routerAddress } from '../src/bundle-vault.mjs'
import { readBundleConfig } from '../src/bundle-config.mjs'
import { buildBundlePlatformTransaction, bundlePlatformTerms, bundleProgramState, platformDifferences, readBundlePlatform,
  simulateSetup } from '../src/bundle-setup.mjs'

// Sets the Bundle launch platform account (docs/BUNDLE_LAUNCH.md, "Mainnet setup", step 3): first creates the router PDA's and the
// treasury owner's wrapped SOL accounts when they are missing, then init_platform, which only the program's upgrade authority may
// sign. The wallets come from the flags (no defaults); the DAMM v2 config from the bundle config; the shares, cooldown, grace
// period and loosest vault policy from BUNDLE_DEFAULTS (src/bundle-launch.mjs). Refused unless the deployed program is exactly the
// reviewed build (tests/fixtures/validator/bundle_vault.so) and the config passes every bundle config check. DRY RUN BY DEFAULT:
// simulates it unsigned against mainnet and prints every value, the exact debit and the instruction hash; nothing is signed or
// sent. --execute sends it, signed by the keypair given with --upgrade-authority, only when those values are approved in the
// environment. --set builds set_platform instead (later changes, for bundles created afterwards), signed by the current admin
// (--admin-keypair); --admin then names the admin that takes over (the same key to keep it).
//
//   SOLANA_RPC_URL=<https mainnet RPC> node scripts/init-bundle-platform.mjs --config <bundle config> --admin <key> \
//     --launch-signer <key> --operator <key> [--operator <key> ...] --ops-wallet <key> --treasury-owner <key>
//   APPROVED_BUNDLE_PLATFORM_INSTRUCTION_SHA256=<hash> APPROVED_BUNDLE_PLATFORM_DEBIT_LAMPORTS=<lamports> \
//     node scripts/init-bundle-platform.mjs <the same flags> --upgrade-authority <keypair.json> --execute
//
// SOLANA_RPC_URL (https, mainnet by genesis hash) is required: the script reads no other setting.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const CREATOR = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' // the creator signer: the bundle config's leftover receiver
const REFERENCE_CONFIG = '8TXNGgx6g5TcsVCYt7wz3cAxJkynzzBZWXeQtXZaz6A3' // the live SOL launch-fee config: equal but for the fee claimer
const REVIEWED_BUILD = new URL('../tests/fixtures/validator/bundle_vault.so', import.meta.url)
const USAGE = 'Usage: SOLANA_RPC_URL=<https mainnet RPC> node scripts/init-bundle-platform.mjs --config <bundle config> --admin <key> ' +
  '--launch-signer <key> --operator <key> [--operator <key> ...] --ops-wallet <key> --treasury-owner <key> ' +
  '[--upgrade-authority <keypair.json> | --set --admin-keypair <keypair.json>] [--execute]'

const args = process.argv.slice(2)
const VALUES = new Set(['--config', '--admin', '--launch-signer', '--operator', '--ops-wallet', '--treasury-owner', '--upgrade-authority', '--admin-keypair'])
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--execute' || args[i] === '--set') continue
  assert(VALUES.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), USAGE)
  assert(args[i] === '--operator' || args.indexOf(args[i]) === i, `${USAGE}\n${args[i]} is given twice`)
  i++
}
const option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined }
const execute = args.includes('--execute'), set = args.includes('--set')
const key = name => { try { return new PublicKey(option(name)) } catch { assert.fail(`${USAGE}\n${name} must be a base58 public key`) } }
const operators = args.flatMap((arg, i) => arg === '--operator' ? [args[i + 1]] : []).map(value => {
  try { return new PublicKey(value) } catch { assert.fail(`${USAGE}\n--operator must be a base58 public key`) }
})
const wallets = { config: key('--config'), admin: key('--admin'), launchSigner: key('--launch-signer'), opsWallet: key('--ops-wallet'),
  treasuryOwner: key('--treasury-owner') }
assert(operators.length >= 1 && operators.length <= 4, `${USAGE}\nGive 1 to 4 --operator keys`)

const rpc = process.env.SOLANA_RPC_URL
assert(rpc?.startsWith('https://'), `${USAGE}\nSOLANA_RPC_URL is missing or not HTTPS`)
const connection = new Connection(rpc, 'confirmed')
assert.equal(await connection.getGenesisHash(), MAINNET_GENESIS, 'RPC is not Solana mainnet')

const program = await bundleProgramState(connection, { program: readFileSync(REVIEWED_BUILD) })
assert(program.matchesReviewedBuild, 'The deployed bundle program differs from tests/fixtures/validator/bundle_vault.so, the reviewed build')
// Refuses a config that init_platform would refuse, or a look-alike: any field but the fee claimer unlike the live launch-fee config.
const poolConfig = await readBundleConfig(connection, wallets.config, { leftoverReceiver: CREATOR, reference: REFERENCE_CONFIG })
const terms = bundlePlatformTerms({ ...wallets, operators, poolConfig })
const existing = await readBundlePlatform(connection)
const shown = value => JSON.parse(JSON.stringify(value, (_, item) => item instanceof PublicKey ? item.toBase58() : item))
const intended = shown({ ...terms, treasuryOwner: undefined })

if (!set && existing) {
  const differences = platformDifferences(existing, terms)
  console.log(JSON.stringify({ alreadySet: true, platform: platformAddress().toBase58(), current: shown(existing), differsIn: differences,
    note: 'init_platform runs once; the admin changes the platform with --set (for bundles created afterwards).' }, null, 2))
  process.exit(differences.length ? 1 : 0)
}
assert(!set || existing, 'There is no platform yet: run without --set first')
const signer = set ? existing.admin : program.upgradeAuthority
assert(signer, 'The bundle program has no upgrade authority, so init_platform cannot run')
const changes = set ? platformDifferences(existing, terms) : null
if (set && !changes.length) {
  console.log(JSON.stringify({ platform: platformAddress().toBase58(), unchanged: true, note: 'The platform already holds exactly these terms.' }, null, 2))
  process.exit(0)
}

const build = () => buildBundlePlatformTransaction({ connection, mode: set ? 'set' : 'init', signer, terms })
const built = await build()
const review = await simulateSetup({ connection, tx: built.tx, payer: signer, created: built.created })
const sol = lamports => `${(Number(lamports) / 1e9).toFixed(6)} SOL`
console.log(JSON.stringify({ network: 'mainnet', instruction: set ? 'set_platform' : 'init_platform', program: BUNDLE_VAULT_PROGRAM_ID.toBase58(),
  deployedProgramIsReviewedBuild: true, reviewedBuildSha256: program.reviewedBuildSha256, platform: platformAddress().toBase58(),
  router: routerAddress().toBase58(), signer: signer.toBase58(), signerIs: set ? 'the current admin' : 'the program\'s upgrade authority',
  terms: { ...intended, treasuryOwner: wallets.treasuryOwner.toBase58() },
  ...set ? { changes: Object.fromEntries(changes.map(field => [field, { from: shown(existing)[field], to: intended[field] }])) } : {},
  createsTokenAccounts: built.createdTokenAccounts.map(String),
  inPlainWords: (set ? 'Changes the terms new Bundle launches copy (bundles already open keep theirs). ' : 'Creates the Bundle launch ' +
    'program\'s settings account, once. ') + 'The admin co-signs every new bundle, can tighten or pause a vault and cancel a raise, ' +
    'and changes these terms; it cannot move vault or backer funds. The launch signer runs each launch transaction. The operators ' +
    '(agent keys) can only trade vaults within the limits. The operations wallet receives 5% of each raise; the treasury owner\'s ' +
    'wrapped SOL account receives repo.ing\'s 20% of the routed fees. It moves no funds. ' +
    `It costs ${sol(review.totalDebitLamports)} (rent and network fee) from ${set ? 'the admin' : 'the upgrade authority'}.`,
  instructionSha256: built.instructionSha256, rentLamports: review.rentLamports, networkFeeLamports: review.networkFeeLamports,
  totalDebitLamports: review.totalDebitLamports, signerBalanceLamports: review.payerBalanceLamports, unsignedSimulationPassed: true,
  broadcast: false }, null, 2))

if (execute) {
  assert.equal(process.env.APPROVED_BUNDLE_PLATFORM_INSTRUCTION_SHA256, built.instructionSha256, 'Exact instructions require approval')
  assert.equal(process.env.APPROVED_BUNDLE_PLATFORM_DEBIT_LAMPORTS, String(review.totalDebitLamports), 'Exact spend requires approval')
  assert(review.payerBalanceLamports >= review.totalDebitLamports + 1_000_000, 'The signer needs the debit plus 0.001 SOL buffer')
  const keyFlag = set ? '--admin-keypair' : '--upgrade-authority'
  assert(option(keyFlag), `${USAGE}\n--execute needs ${keyFlag}`)
  const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path.resolve(option(keyFlag)), 'utf8'))))
  assert(keypair.publicKey.equals(signer), set ? 'The keypair is not the platform\'s admin' : 'The keypair is not the program\'s upgrade authority')
  const fresh = await build()
  assert.equal(fresh.instructionSha256, built.instructionSha256, 'The instructions changed since the review: run the dry run again')
  fresh.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  fresh.tx.sign(keypair)
  const signed = await connection.simulateTransaction(VersionedTransaction.deserialize(fresh.tx.serialize()), { sigVerify: true, commitment: 'confirmed' })
  assert.equal(signed.value.err, null, `Signed preflight failed: ${JSON.stringify(signed.value.err)}`)
  const signature = await sendAndConfirmTransaction(connection, fresh.tx, [keypair], { commitment: 'finalized' })
  const platform = await readBundlePlatform(connection, { commitment: 'finalized' })
  assert.deepEqual(platformDifferences(platform, terms), [], 'The platform account differs from the approved terms')
  console.log(JSON.stringify({ signature, platform: platformAddress().toBase58(), matchesApprovedTerms: true, finalized: true, broadcast: true,
    next: set ? null : `Create the lookup table: node scripts/create-bundle-lookup-table.mjs --config ${wallets.config.toBase58()}` }, null, 2))
}
