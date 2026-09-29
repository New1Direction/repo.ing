import { recordTradeVerificationFailure } from '../../src/trade-verification-alerts.mjs'

const ATTEMPTS = 120
const POLL_MS = 250
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

// After a submitted trade confirms, wait (bounded) for finality. Graduated swaps reach charts through the DAMM
// trade indexer and fees through position checkpoints, so recording them here would double count: only re-verify
// the receipt. Curve trades index their fees here. A failure never changes the trader's confirmed result; it is
// logged and recorded as an operator alert (see recordTradeVerificationFailure).
export async function settleConfirmedTrade({ connection, db, engine, prepared, signature, recordFees, sleep = pause }) {
  const alert = async (stage, error) => {
    console.error(`trade ${stage} failed`, { signature, error: error.message })
    try { await recordTradeVerificationFailure(db, { signature, prepared, stage, error }) }
    catch (alertError) { console.error('trade verification alert could not be recorded', { signature, error: alertError.message }) }
  }
  if (prepared.phase === 'graduated') {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const status = (await connection.getSignatureStatuses([signature]).catch(() => null))?.value[0]
      if (status?.confirmationStatus === 'finalized') {
        try { await engine.verifyTrade(prepared, signature, { commitment: 'finalized' }) }
        catch (error) { await alert('FINALIZED_VERIFICATION', error) }
        break
      }
      await sleep(POLL_MS)
    }
    return { feeIndexing: 'pending', creatorFee: null }
  }
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const finalized = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => null)
    if (finalized) {
      try {
        const accrued = await recordFees({ githubRepoId: prepared.githubRepoId, signatures: [signature] })
        return { feeIndexing: 'recorded', creatorFee: accrued.creditedBaseUnits.toString() }
      } catch (error) { await alert('FEE_INDEXING', error) }
      break
    }
    await sleep(POLL_MS)
  }
  return { feeIndexing: 'pending', creatorFee: null }
}
