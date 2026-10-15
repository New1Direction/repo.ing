// Expiry height and slot must describe the same finalized bank.
export async function provablyExpiredUnlanded(connection, signature, lastValidBlockHeight) {
  const { absoluteSlot, blockHeight } = await connection.getEpochInfo('finalized')
  if (!Number.isSafeInteger(absoluteSlot) || !Number.isSafeInteger(blockHeight) ||
      BigInt(blockHeight) <= BigInt(lastValidBlockHeight)) return false
  const { context, value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })
  return context.slot >= absoluteSlot && !value[0]
}
