import { VersionedTransaction } from '@solana/web3.js'
import { compiledLaunchInstructions, readLaunchComputeBudget } from './launch-wallet-fees.mjs'

const LAMPORTS_PER_SIGNATURE = 5000n

// networkFee is what the wallet is charged: one base fee per signature plus the reviewed priority fee (limit × price).
// It must cover both, so the network-fee line and the deposits derived from it never hide the priority fee.
export function launchCostBreakdown({ balance, after, networkFee, priorityFee = '0', signatures = 1, initialBuyLamports }) {
  if (![balance, after, networkFee].every(value => Number.isSafeInteger(value) && value >= 0) ||
      !/^\d+$/.test(String(priorityFee)) || !Number.isSafeInteger(signatures) || signatures < 1 ||
      BigInt(networkFee) < BigInt(signatures) * LAMPORTS_PER_SIGNATURE + BigInt(priorityFee)) {
    throw new Error('Launch cost estimate is unavailable; refresh the review')
  }
  const buy = BigInt(initialBuyLamports), total = BigInt(balance) - BigInt(after)
  const deposits = total - buy - BigInt(networkFee)
  if (buy < 0n || deposits < 0n) throw new Error('Wallet balance changed; refresh the launch review')
  return { balance: String(balance), initialBuy: buy.toString(), networkFee: String(networkFee), priorityFee: String(priorityFee),
    accountDeposits: deposits.toString(), total: total.toString() }
}

// Read-only simulation of the exact prepared message, compute budget included: the simulated balance change and
// getFeeForMessage both include the priority fee, so the total is exactly what the wallet pays. The user has not
// signed it and this function never broadcasts. A failed simulation blocks review.
// transaction: the legacy launch, or an early access launch's v0 transaction (docs/EARLY_ACCESS.md), whose fee payer is its first
// static key and whose lookup table the simulation resolves itself.
export async function estimateLaunchCosts(connection, transaction, initialBuyLamports) {
  const versioned = transaction instanceof VersionedTransaction
  const payer = versioned ? transaction.message.staticAccountKeys[0] : transaction.feePayer
  const unavailable = () => { throw new Error('Could not check launch costs. Please retry shortly.') }
  const { priorityFee } = readLaunchComputeBudget(versioned ? compiledLaunchInstructions(transaction.message) : transaction.instructions)
  const message = versioned ? transaction.message : transaction.compileMessage()
  const before = await connection.getBalanceAndContext(payer, 'confirmed').catch(unavailable)
  const encoded = versioned ? transaction.serialize() : transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const [simulation, fee] = await Promise.all([
    connection.simulateTransaction(VersionedTransaction.deserialize(encoded), {
      commitment: 'confirmed', sigVerify: false, minContextSlot: before.context.slot,
      accounts: { encoding: 'base64', addresses: [payer.toBase58()] },
    }),
    connection.getFeeForMessage(message, 'confirmed'),
  ]).catch(unavailable)
  if (simulation.value.err) {
    const insufficient = simulation.value.logs?.some(line => /insufficient (lamports|funds)/i.test(line)) ||
      ['AccountNotFound', 'InsufficientFundsForFee'].includes(simulation.value.err)
    throw new Error(insufficient ? 'Your wallet needs more SOL for the initial buy and launch account costs.' :
      'Launch simulation did not pass. Refresh the review before approving in your wallet.')
  }
  return launchCostBreakdown({ balance: before.value, after: simulation.value.accounts?.[0]?.lamports,
    networkFee: fee.value, priorityFee: priorityFee.toString(), signatures: message.header.numRequiredSignatures, initialBuyLamports })
}
