import { VersionedTransaction } from '@solana/web3.js'

export function launchCostBreakdown({ balance, after, networkFee, initialBuyLamports }) {
  if (![balance, after, networkFee].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Launch cost estimate is unavailable; refresh the review')
  }
  const buy = BigInt(initialBuyLamports), total = BigInt(balance) - BigInt(after)
  const deposits = total - buy - BigInt(networkFee)
  if (buy < 0n || deposits < 0n) throw new Error('Wallet balance changed; refresh the launch review')
  return { balance: String(balance), initialBuy: buy.toString(), networkFee: String(networkFee),
    accountDeposits: deposits.toString(), total: total.toString() }
}

// Read-only simulation of the exact prepared message. The user has not signed
// it and this function never broadcasts. A failed simulation blocks review.
export async function estimateLaunchCosts(connection, transaction, initialBuyLamports) {
  const payer = transaction.feePayer
  const unavailable = () => { throw new Error('Could not check launch costs. Please retry shortly.') }
  const before = await connection.getBalanceAndContext(payer, 'confirmed').catch(unavailable)
  const encoded = transaction.serialize({ requireAllSignatures: false, verifySignatures: false })
  const [simulation, fee] = await Promise.all([
    connection.simulateTransaction(VersionedTransaction.deserialize(encoded), {
      commitment: 'confirmed', sigVerify: false, minContextSlot: before.context.slot,
      accounts: { encoding: 'base64', addresses: [payer.toBase58()] },
    }),
    connection.getFeeForMessage(transaction.compileMessage(), 'confirmed'),
  ]).catch(unavailable)
  if (simulation.value.err) {
    const insufficient = simulation.value.logs?.some(line => /insufficient (lamports|funds)/i.test(line)) ||
      ['AccountNotFound', 'InsufficientFundsForFee'].includes(simulation.value.err)
    throw new Error(insufficient ? 'Your wallet needs more SOL for the initial buy and launch account costs.' :
      'Launch simulation did not pass. Refresh the review before approving in your wallet.')
  }
  return launchCostBreakdown({ balance: before.value, after: simulation.value.accounts?.[0]?.lamports,
    networkFee: fee.value, initialBuyLamports })
}
