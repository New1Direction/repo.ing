import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import {
  ActivationType, BaseFeeMode, buildCurveWithCustomSqrtPrices, CollectFeeMode,
  createSqrtPrices, DynamicBondingCurveClient, MigrationFeeOption, MigrationOption,
  TokenAuthorityOption, TokenDecimal, TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const expectedPartner = 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3'
const expectedConfig = 'D7oz8xQ4seaNaEgiDS4fu3YJfmUvR5iPuznxuqKV4u1c'
const mainnetGenesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const send = process.argv.includes('--send')
if (send) assert.equal(process.env.APPROVED_DBC_CONFIG, expectedConfig,
  'Set APPROVED_DBC_CONFIG to the reviewed config address to send')

function keychainKeypair(service, expected) {
  const result = spawnSync('security', ['find-generic-password', '-s', service, '-a', 'production', '-w'],
    { encoding: 'utf8' })
  assert.equal(result.status, 0, `${service} is unavailable in Keychain`)
  const bytes = bs58.decode(result.stdout.trim())
  assert.equal(bytes.length, 64, `${service} has an unexpected key length`)
  const signer = Keypair.fromSecretKey(bytes)
  assert.equal(signer.publicKey.toBase58(), expected, `${service} does not match the reviewed address`)
  return signer
}

const variables = spawnSync('railway', ['variable', 'list', '--service', 'web', '--environment', 'production',
  '--project', '507c3e92-c0a7-4c83-8622-172e88509b68', '--json'], { encoding: 'utf8' })
assert.equal(variables.status, 0, 'Could not read the production RPC URL')
const rpc = JSON.parse(variables.stdout).SOLANA_RPC_URL
assert(rpc?.startsWith('https://'), 'Production RPC URL is missing or not HTTPS')
const connection = new Connection(rpc, 'confirmed')
assert.equal(await connection.getGenesisHash(), mainnetGenesis, 'RPC is not Solana mainnet')

const partner = keychainKeypair('repo.ing.dbc.partner', expectedPartner)
const config = keychainKeypair('repo.ing.dbc.config', expectedConfig)
const existing = await connection.getAccountInfo(config.publicKey, 'confirmed')
assert.equal(existing, null, 'Config address already has an account; inspect it before sending anything')

const client = new DynamicBondingCurveClient(connection, 'confirmed')
const curve = buildCurveWithCustomSqrtPrices({
  token: { tokenType: TokenType.SPLToken, tokenBaseDecimal: TokenDecimal.SIX,
    tokenQuoteDecimal: TokenDecimal.NINE, tokenAuthorityOption: TokenAuthorityOption.Immutable,
    totalTokenSupply: 1_000_000_000, leftover: 1000 },
  fee: { baseFeeParams: { baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
    feeSchedulerParam: { startingFeeBps: 175, endingFeeBps: 175, numberOfPeriod: 0, totalDuration: 0 } },
    dynamicFeeEnabled: false, collectFeeMode: CollectFeeMode.QuoteToken,
    creatorTradingFeePercentage: 71, poolCreationFee: 0, enableFirstSwapWithMinFee: false },
  migration: { migrationOption: MigrationOption.MET_DAMM_V2,
    migrationFeeOption: MigrationFeeOption.FixedBps100,
    migrationFee: { feePercentage: 0, creatorFeePercentage: 0 } },
  liquidityDistribution: { partnerLiquidityPercentage: 0, partnerPermanentLockedLiquidityPercentage: 50,
    creatorLiquidityPercentage: 0, creatorPermanentLockedLiquidityPercentage: 50 },
  lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0,
    cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
  activationType: ActivationType.Timestamp,
  sqrtPrices: createSqrtPrices([0.000000001, 0.00000000105, 0.000000002, 0.000001],
    TokenDecimal.SIX, TokenDecimal.NINE),
  liquidityWeights: [2, 1, 1],
})
const tx = await client.partner.createConfig({ config: config.publicKey,
  feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey,
  payer: partner.publicKey, quoteMint: NATIVE_MINT, ...curve })
tx.feePayer = partner.publicKey
tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
const fee = (await connection.getFeeForMessage(tx.compileMessage(), 'confirmed')).value
const rent = await connection.getMinimumBalanceForRentExemption(1048, 'confirmed')
const balance = await connection.getBalance(partner.publicKey, 'confirmed')
assert.equal(tx.instructions.length, 1, 'Unexpected instruction count')
console.log(JSON.stringify({ network: 'mainnet', partner: expectedPartner, config: expectedConfig,
  quoteMint: NATIVE_MINT.toBase58(), fixedFeeBps: 175, creatorSharePercent: 71,
  instructions: tx.instructions.length, feeLamports: fee, rentLamports: rent,
  estimatedTotalLamports: fee + rent, partnerBalanceLamports: balance, broadcast: send }, null, 2))

if (send) {
  assert(balance >= fee + rent + 1_000_000, 'Partner wallet needs more SOL for fee, rent, and buffer')
  const simulation = await connection.simulateTransaction(tx, [partner, config])
  assert.equal(simulation.value.err, null, `Simulation failed: ${JSON.stringify(simulation.value.err)}`)
  const signature = await sendAndConfirmTransaction(connection, tx, [partner, config], { commitment: 'confirmed' })
  const account = await client.state.getPoolConfig(new PublicKey(expectedConfig))
  assert(account, 'Transaction confirmed but config account was not readable')
  console.log(JSON.stringify({ signature, config: expectedConfig, accountReadable: true }))
}
