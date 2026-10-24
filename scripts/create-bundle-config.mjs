import assert from 'node:assert/strict'
import { Connection, PublicKey } from '@solana/web3.js'
import { BUNDLE_VAULT_PROGRAM_ID, routerAddress } from '../src/bundle-vault.mjs'
import { buildBundleConfigTransaction, bundleDammConfig } from '../src/bundle-config.mjs'
import { bundleProgramState, reviewBundleConfig } from '../src/bundle-setup.mjs'
import { MULTISIG_VAULT } from '../src/custody-multisig.mjs'
import { MAINNET_ROLES } from '../src/hooklab-owner-driver/pins.mjs'
import { verifyCreatedLaunchFeeConfig } from '../src/launch-fee-config.mjs'

// Recovery review only: no key generation/read, plaintext key files, signing or submission.
// Supply a separately custody-backed fresh config PUBLIC address and explicit HTTPS RPC:
// SOLANA_RPC_URL=... node scripts/create-bundle-config.mjs --config <public-address>
// New bundle terms match the finalized safe ordinary config except for the router fee claimer.
// Program governance, platform recipients, funding and execution still require their own acceptance.
const args = process.argv.slice(2)
assert(!args.includes('--execute'), 'Review-only: execution requires a separately approved safe signing plan')
assert(args.length === 2 && args[0] === '--config', 'Usage: create-bundle-config.mjs --config <public-address> (review only)')
const config = new PublicKey(args[1]).toBase58(), payer = MAINNET_ROLES.payer
assert(PublicKey.isOnCurve(new PublicKey(config).toBytes()) && config !== payer, 'Fresh signing config address required')
assert(process.env.SOLANA_RPC_URL?.startsWith('https://'), 'Explicit HTTPS SOLANA_RPC_URL required; no provider credential fallback')
const connection = new Connection(process.env.SOLANA_RPC_URL, { commitment: 'confirmed', disableRetryOnRateLimit: true })
assert.equal(await connection.getGenesisHash(), '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'RPC is not Solana mainnet')

const reference = 'Fy2bhQbNPxLPShPxEuTnYzusWgSpSVEgCZ9cbby32TU7'
const safe = await verifyCreatedLaunchFeeConfig({ connection, config: reference,
  accountDataSha256: 'f0214c67a087ff43c60574ee706de6f407248d91afa6780c22f6a2656461c896' })
assert.equal(safe.feeClaimer.toBase58(), MULTISIG_VAULT)
assert.equal(safe.leftoverReceiver.toBase58(), MULTISIG_VAULT)
const program = await bundleProgramState(connection, { commitment: 'finalized' })
const { tx, instructionSha256 } = await buildBundleConfigTransaction({ connection, config, payer, leftoverReceiver: MULTISIG_VAULT })
const review = await reviewBundleConfig({ connection, tx, config, payer, leftoverReceiver: MULTISIG_VAULT, reference })
assert.deepEqual(review.differences, ['feeClaimer'])
console.log(JSON.stringify({ network: 'mainnet', config, payer, feeClaimer: routerAddress().toBase58(),
  leftoverReceiver: MULTISIG_VAULT, referenceConfig: reference, bundleProgram: BUNDLE_VAULT_PROGRAM_ID.toBase58(),
  observedUpgradeAuthority: program.upgradeAuthority?.toBase58() ?? null, governanceAccepted: false,
  differsFromReferenceOnlyIn: review.differences, dammConfig: bundleDammConfig(review.decoded).toBase58(),
  instructionSha256, accountDataSha256: review.accountDataSha256, accountBytes: review.accountBytes,
  rentLamports: review.rentLamports, networkFeeLamports: review.networkFeeLamports, totalDebitLamports: review.totalDebitLamports,
  payerBalanceLamports: review.payerBalanceLamports, unsignedSimulationPassed: true, broadcast: false, executionAuthorized: false,
  blockers: ['Fresh config signer custody', 'Exact creation funding approval', 'Bundle program governance and safe platform recipients',
    'Independent bundle launch, routing and receipt acceptance'],
}, null, 2))
