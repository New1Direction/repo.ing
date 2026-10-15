// Pure evidence interpretation, not an RPC client or a retry policy. No record is mutated.
// A finalized transaction is not proof of expected accounts/economics or launch readiness.
export function reconcileHookLabStep(snapshot, stepId, evidence) {
  const result = (state, reason) => Object.freeze({ state, reason, executionEnabled: false, canRetry: false, launchReady: false })
  const reviewed = snapshot.events.find(event => event.type === 'reviewed' && event.stepId === stepId)
  if (!reviewed) return result('unreviewed', 'No immutable reviewed message')
  const signed = snapshot.events.filter(event => event.type === 'signature-recorded' && event.stepId === stepId)
  if (!signed.length) {
    if (snapshot.events.some(event => event.type === 'binding-invalidated')) return result('invalidated', 'Wallet or plan changed')
    if (evidence?.genesisHash === snapshot.binding.genesisHash && Number.isSafeInteger(evidence.finalizedBlockHeight) && evidence.finalizedBlockHeight > reviewed.expiry.lastValidBlockHeight) return result('expired-unproven', 'Review expired without recorded signatures; a missing local record does not prove non-submission')
    return result('reviewed', 'No signatures recorded')
  }
  const feePayer = signed.find(event => event.signer === reviewed.requiredSigners[0])
  if (!feePayer) return result('partially-signed', 'Retain identities and all signatures; do not regenerate')
  if (!evidence || evidence.genesisHash !== snapshot.binding.genesisHash || evidence.signature !== feePayer.signature) return result('ambiguous', 'Missing evidence or wrong network/signature')
  const status = evidence.status
  if (!status) return result('ambiguous', 'Missing status is not proof of absence, even after expiry or a history search')
  if (!Number.isSafeInteger(status.slot) || status.slot < 0 || status.err === undefined) return result('ambiguous', 'Incomplete status evidence')
  if (status.confirmationStatus === 'finalized') return result(status.err === null ? 'finalized-success' : 'finalized-failure', 'Finalized transaction status only; account postconditions still require independent verification')
  if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'processed') return result('pending-finality', 'Non-finalized success or failure may disappear on a fork')
  return result('ambiguous', 'Unrecognized finality evidence')
}
