import { isSlippageError, swapInstructionIndex } from '../../src/trade-slippage.mjs'

// reason 'slippage': the session's own swap instruction failed on its minimum output (the price moved while signing).
// Without the session the failing instruction cannot be identified, so the failure stays unclassified.
function failure(err, signature, session) {
  const slippage = session?.signature === signature && isSlippageError(err, swapInstructionIndex(session.prepared?.transaction?.instructions))
  return slippage ? { state: 'failed', signature, reason: 'slippage', slippageBps: session.prepared.slippageBps ?? null } : { state: 'failed', signature }
}

export async function tradeStatus(connection, signature, session, lastValidBlockHeight) {
  if (session?.signature === signature && session.result) return session.result
  const found = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
  if (found?.err) return failure(found.err, signature, session)
  if (found && ['confirmed', 'finalized'].includes(found.confirmationStatus)) {
    if (session?.signature === signature) {
      try {
        const verified = await session.engine.verifyTrade(session.prepared, signature)
        return { state: 'confirmed', signature, tokenDelta: verified.tokenDelta.toString(),
          solDelta: verified.solDelta.toString(), feeIndexing: 'pending' }
      } catch { /* Keep the chain result visible while detailed verification catches up. */ }
    }
    return { state: 'chainConfirmed', signature }
  }
  const expiry = session?.prepared.lastValidBlockHeight ?? Number(lastValidBlockHeight)
  if (!found && Number.isSafeInteger(expiry) && expiry > 0 && await connection.getBlockHeight('confirmed') > expiry + 20) {
    return { state: 'expired', signature }
  }
  return { state: 'pending', signature }
}
