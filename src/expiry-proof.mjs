// A signed transaction may be abandoned only when a node that has seen the blockhash expire
// also has no record of the signature. Separate RPC calls can hit different (lagging) nodes,
// so the history lookup must come from a node at least as current as the expiry observation;
// otherwise a payout that landed could be marked aborted and paid again.
export async function provablyExpiredUnlanded(connection, signature, lastValidBlockHeight) {
  const observedSlot = await connection.getSlot('finalized')
  const height = await connection.getBlockHeight({ commitment: 'finalized', minContextSlot: observedSlot })
  if (BigInt(height) <= BigInt(lastValidBlockHeight)) return false
  const { context, value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
  return context.slot >= observedSlot && !value[0]
}
