import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'

// Defaults to unsigned simulation. Creating this config does not seed a market,
// change DBC_CONFIG, or alter any existing token. Send only after exact review.
const partnerAddress = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3'
const partnerPublicKey = new PublicKey(partnerAddress)
const send = process.argv.includes('--send')
const profile = process.argv.includes('--builders') ? 'builders' : 'balanced'
const creatorSignerAddress = 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1'
assert(process.argv.slice(2).every(arg => arg === '--send' || arg === '--builders'), 'Unexpected argument')
const keyPath = new URL(profile === 'builders' ? '../secrets/liquidity-config-keypair-builders.json' : '../secrets/liquidity-config-keypair.json', import.meta.url)
if (!existsSync(keyPath)) {
  assert(!send, 'Prepare and review the config before sending')
  mkdirSync(new URL('../secrets/', import.meta.url), { recursive: true, mode: 0o700 })
  writeFileSync(keyPath, JSON.stringify([...Keypair.generate().secretKey]), { mode: 0o600, flag: 'wx' })
}
const config = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8'))))
const variables = spawnSync('railway', ['variable', 'list', '--service', 'web', '--environment', 'production',
  '--project', '507c3e92-c0a7-4c83-8622-172e88509b68', '--json'], { encoding: 'utf8' })
assert.equal(variables.status, 0, 'Could not load the production RPC')
const rpc = JSON.parse(variables.stdout).SOLANA_RPC_URL
assert(rpc?.startsWith('https://'), 'Missing HTTPS RPC')
const connection = new Connection(rpc, 'confirmed')
assert.equal(await connection.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'Not mainnet')
assert.equal(await connection.getAccountInfo(config.publicKey), null, 'Config exists; inspect finality before retrying')
const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
const curve = buildLaunchCurve(profile)
const leftoverReceiver = profile === 'builders' ? new PublicKey(creatorSignerAddress) : partnerPublicKey
const tx = await dbc.partner.createConfig({ config: config.publicKey, feeClaimer: partnerPublicKey,
  leftoverReceiver, payer: partnerPublicKey, quoteMint: NATIVE_MINT, ...curve })
assert.equal(tx.instructions.length, 1)
assert.equal(tx.instructions[0].programId.toBase58(), 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const instructionSha256 = createHash('sha256').update(JSON.stringify(tx.instructions.map(ix => ({
  program: ix.programId.toBase58(), keys: ix.keys.map(key => ({ key: key.pubkey.toBase58(), signer: key.isSigner, writable: key.isWritable })),
  data: ix.data.toString('base64'),
})))).digest('hex')
tx.feePayer = partnerPublicKey
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
const [fee, balance] = await Promise.all([
  connection.getFeeForMessage(tx.compileMessage()), connection.getBalance(partnerPublicKey),
])
assert(Number.isSafeInteger(fee.value), 'Network fee unavailable')
const simulation = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
  sigVerify: false, replaceRecentBlockhash: true,
  accounts: { encoding: 'base64', addresses: [partnerAddress, config.publicKey.toBase58()] },
})
assert.equal(simulation.value.err, null, `Unsigned simulation failed: ${JSON.stringify(simulation.value.err)}`)
const [payerAfter, created] = simulation.value.accounts ?? []
assert(created && payerAfter && created.owner === tx.instructions[0].programId.toBase58(), 'Missing simulated config account')
const total = balance - payerAfter.lamports
assert.equal(total, created.lamports + fee.value, 'Unexpected simulated payer debit')
const accountDataSha256 = createHash('sha256').update(Buffer.from(created.data[0], 'base64')).digest('hex')
const reviewed = { network: 'mainnet', profile, partner: partnerAddress, leftoverReceiver: leftoverReceiver.toBase58(),
  config: config.publicKey.toBase58(), instructionSha256, accountDataSha256, migrationQuoteThresholdLamports: '85000000000',
  builderReserveTokens: profile === 'builders' ? '10001000' : '1000',
  fixedFeeBps: 175, creatorTradingFeePercentage: 71, tokenSupply: '1000000000', tokenDecimals: 6,
  creatorPermanentLockedLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 50,
  rentLamports: created.lamports, networkFeeLamports: fee.value, totalDebitLamports: total,
  partnerBalanceLamports: balance, unsignedSimulationPassed: true, broadcast: false }
writeFileSync('/tmp/repo-ing-liquidity-mainnet-review.json', JSON.stringify(reviewed, null, 2) + '\n', { mode: 0o600 })
console.log(JSON.stringify(reviewed, null, 2))
if (send) {
  assert.equal(process.env.APPROVED_LIQUIDITY_CONFIG, reviewed.config, 'Config address requires explicit approval')
  assert.equal(process.env.APPROVED_LIQUIDITY_INSTRUCTION_SHA256, instructionSha256, 'Exact instruction requires approval')
  assert.equal(process.env.APPROVED_LIQUIDITY_MAX_DEBIT_LAMPORTS, String(total), 'Exact spend requires approval')
  const result = spawnSync('security', ['find-generic-password', '-s', 'repo.ing.dbc.partner', '-a', 'production', '-w'], { encoding: 'utf8' })
  assert.equal(result.status, 0, 'Protected partner key unavailable')
  const partner = Keypair.fromSecretKey(bs58.decode(result.stdout.trim()))
  assert.equal(partner.publicKey.toBase58(), partnerAddress)
  const checked = await connection.simulateTransaction(tx, [partner, config])
  assert.equal(checked.value.err, null, 'Signed preflight failed')
  const signature = await sendAndConfirmTransaction(connection, tx, [partner, config], { commitment: 'finalized' })
  const finalizedAccount = await connection.getAccountInfo(config.publicKey, 'finalized')
  assert(finalizedAccount?.owner.equals(tx.instructions[0].programId), 'Finalized config owner mismatch')
  assert.equal(createHash('sha256').update(finalizedAccount.data).digest('hex'), accountDataSha256, 'Finalized config differs from the simulated account')
  const fixed = await new DynamicBondingCurveClient(connection, 'finalized').state.getPoolConfig(config.publicKey)
  assert(fixed && fixed.migrationQuoteThreshold.eq(curve.migrationQuoteThreshold) && fixed.sqrtStartPrice.eq(curve.sqrtStartPrice), 'Finalized curve mismatch')
  console.log(JSON.stringify({ signature, config: reviewed.config, finalized: true, broadcast: true }))
}
