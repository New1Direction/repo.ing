import assert from 'node:assert/strict'
import { Connection, PublicKey } from '@solana/web3.js'
import { buildLaunchFeeConfigTransaction, configDifferences, LAUNCH_FEE_FIELDS, reviewLaunchFeeConfig } from '../src/launch-fee-config.mjs'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { EXTRA_20_SCHEDULE, feeNumeratorAt, feePercentLabel, isApprovedLaunchFee, LAUNCH_FEE_SCHEDULE, readFeeSchedule } from '../src/launch-fee.mjs'
import { MULTISIG_VAULT } from '../src/custody-multisig.mjs'
import { MAINNET_ROLES } from '../src/hooklab-owner-driver/pins.mjs'

// Recovery review only. No key creation/read, signing, send, retry or production configuration write.
// Supply an independently custody-backed fresh config PUBLIC address and explicit HTTPS RPC:
// SOLANA_RPC_URL=... node scripts/create-launch-fee-config.mjs --config <public-address> [--schedule extra-20]
// extra-20 (owner, 2026-10-26): 20% extra falling to 0 over 120 s, reviewed against the live custody config Fy2bh, from which it
// may differ only in the base fee fields.
// A simulation neither approves funding nor authorizes new fee/leftover distributions.
const args = process.argv.slice(2)
assert(!args.includes('--execute'), 'Review-only: execution requires a separately approved safe signing plan')
const extra20 = args.length === 4 && args[2] === '--schedule' && args[3] === 'extra-20'
assert(args[0] === '--config' && (args.length === 2 || extra20), 'Usage: create-launch-fee-config.mjs --config <public-address> [--schedule extra-20] (review only)')
const config = new PublicKey(args[1]).toBase58()
const SCHEDULE = extra20 ? EXTRA_20_SCHEDULE : LAUNCH_FEE_SCHEDULE
const payer = MAINNET_ROLES.payer
assert(PublicKey.isOnCurve(new PublicKey(config).toBytes()) && config !== payer, 'Fresh signing config address required')
assert(process.env.SOLANA_RPC_URL?.startsWith('https://'), 'Explicit HTTPS SOLANA_RPC_URL required; no provider credential fallback')
const connection = new Connection(process.env.SOLANA_RPC_URL, 'confirmed')
assert.equal(await connection.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'RPC is not Solana mainnet')

const reference = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'
const { tx, instructionSha256 } = await buildLaunchFeeConfigTransaction({ connection, config, payer,
  partner: MULTISIG_VAULT, leftoverReceiver: MULTISIG_VAULT, schedule: SCHEDULE })
const review = await reviewLaunchFeeConfig({ connection, tx, config, payer, reference, custodyReplacement: true })
assert(isApprovedLaunchFee(review.decoded), 'Simulated config does not carry an approved launch fee')
// The live custody config new launches use today: the new one may differ from it only in the base fee fields.
const live = 'Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7'
const liveInfo = await connection.getAccountInfo(new PublicKey(live), 'confirmed')
const liveDifferences = configDifferences(review.decoded, new DynamicBondingCurveClient(connection, 'confirmed').state.getProgram().coder.accounts.decode('poolConfig', liveInfo.data))
assert(liveDifferences.every(path => LAUNCH_FEE_FIELDS.includes(path)), `Differs from ${live} beyond the fee: ${liveDifferences.join(', ')}`)
const schedule = readFeeSchedule(review.decoded)
console.log(JSON.stringify({ network: 'mainnet', config, payer, feeClaimer: MULTISIG_VAULT,
  leftoverReceiver: MULTISIG_VAULT, referenceConfig: reference, differsFromReferenceOnlyIn: review.differences, liveConfig: live, differsFromLiveOnlyIn: liveDifferences,
  launchFee: { mode: extra20 ? 'linear fee scheduler, timestamp activation' : 'exponential fee scheduler, timestamp activation',
    cliffFeeNumerator: SCHEDULE.cliffFeeNumerator.toString(), numberOfPeriod: SCHEDULE.numberOfPeriod,
    periodSeconds: SCHEDULE.periodFrequency.toString(), reduction: SCHEDULE.reductionFactor.toString(),
    endFeeNumerator: schedule.endNumerator.toString(), launcherFirstBuyFee: feePercentLabel(schedule.endNumerator),
    feeAtSeconds: Object.fromEntries([0,3,30,60,90,117,120,180].map(seconds => [seconds,
      feePercentLabel(feeNumeratorAt(schedule,0n,BigInt(seconds)))])) },
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes,
  rentLamports: review.rentLamports, networkFeeLamports: review.networkFeeLamports,
  totalDebitLamports: review.totalDebitLamports, payerBalanceLamports: review.payerBalanceLamports,
  unsignedSimulationPassed: true, broadcast: false, executionAuthorized: false,
  blockers: ['Fresh config signer custody', 'Exact creation funding approval',
    'Vault governance verification and receipt-backed collection/payout integration', 'Independent new-launch acceptance'],
}, null, 2))
