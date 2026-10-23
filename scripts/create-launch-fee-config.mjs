import assert from 'node:assert/strict'
import { Connection, PublicKey } from '@solana/web3.js'
import { buildLaunchFeeConfigTransaction, reviewLaunchFeeConfig } from '../src/launch-fee-config.mjs'
import { feeNumeratorAt, feePercentLabel, LAUNCH_FEE_SCHEDULE, readFeeSchedule } from '../src/launch-fee.mjs'
import { MULTISIG_VAULT } from '../src/custody-multisig.mjs'
import { MAINNET_ROLES } from '../src/hooklab-owner-driver/pins.mjs'

// Recovery review only. No key creation/read, signing, send, retry or production configuration write.
// Supply an independently custody-backed fresh config PUBLIC address and explicit HTTPS RPC:
// SOLANA_RPC_URL=... node scripts/create-launch-fee-config.mjs --config <public-address>
// A simulation neither approves funding nor authorizes new fee/leftover distributions.
const args = process.argv.slice(2)
assert(!args.includes('--execute'), 'Review-only: execution requires a separately approved safe signing plan')
assert(args.length === 2 && args[0] === '--config', 'Usage: create-launch-fee-config.mjs --config <public-address> (review only)')
const config = new PublicKey(args[1]).toBase58()
const payer = MAINNET_ROLES.payer
assert(PublicKey.isOnCurve(new PublicKey(config).toBytes()) && config !== payer, 'Fresh signing config address required')
assert(process.env.SOLANA_RPC_URL?.startsWith('https://'), 'Explicit HTTPS SOLANA_RPC_URL required; no provider credential fallback')
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed')
assert.equal(await connection.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'RPC is not Solana mainnet')

const reference = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'
const { tx, instructionSha256 } = await buildLaunchFeeConfigTransaction({ connection, config, payer,
  partner: MULTISIG_VAULT, leftoverReceiver: MULTISIG_VAULT })
const review = await reviewLaunchFeeConfig({ connection, tx, config, payer, reference, custodyReplacement: true })
const schedule = readFeeSchedule(review.decoded)
console.log(JSON.stringify({ network: 'mainnet', config, payer, feeClaimer: MULTISIG_VAULT,
  leftoverReceiver: MULTISIG_VAULT, referenceConfig: reference, differsFromReferenceOnlyIn: review.differences,
  launchFee: { mode: 'exponential fee scheduler, timestamp activation',
    cliffFeeNumerator: LAUNCH_FEE_SCHEDULE.cliffFeeNumerator.toString(), numberOfPeriod: LAUNCH_FEE_SCHEDULE.numberOfPeriod,
    periodSeconds: LAUNCH_FEE_SCHEDULE.periodFrequency.toString(), reductionFactorBps: LAUNCH_FEE_SCHEDULE.reductionFactor.toString(),
    endFeeNumerator: schedule.endNumerator.toString(), launcherFirstBuyFee: feePercentLabel(schedule.endNumerator),
    feeAtSeconds: Object.fromEntries([0,5,10,30,60,90,120,150,180].map(seconds => [seconds,
      feePercentLabel(feeNumeratorAt(schedule,0n,BigInt(seconds)))])) },
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes,
  rentLamports: review.rentLamports, networkFeeLamports: review.networkFeeLamports,
  totalDebitLamports: review.totalDebitLamports, payerBalanceLamports: review.payerBalanceLamports,
  unsignedSimulationPassed: true, broadcast: false, executionAuthorized: false,
  blockers: ['Fresh config signer custody', 'Exact creation funding approval',
    'Vault governance verification and receipt-backed collection/payout integration', 'Independent new-launch acceptance'],
}, null, 2))
