import { acceptSignedTrade, sessionFromRow } from './trade-sessions.mjs'
import { prepareCheckedTrade } from './trade-prepare.mjs'
import { recordTestDammCheckpoint } from './existing-market-test-accounting.mjs'
import { TEST_PLAN } from './existing-market-test-run.mjs'

// This adapter is independent of the ordinary live/rebroadcast route. Its only
// sender consumes durable first-use permission before a single RPC invocation.
export function createTestTradingHandler({ run, connection, router, checkpoint, recordCurve,
  submissionEnabled = false, recordCheckpoint = recordTestDammCheckpoint,
  restore = pending => sessionFromRow({ ...pending, wallet: pending.record.wallet }, phase => router.forPhase(phase)) }) {
  const preparedResponse = pending => ({ id: pending.id, testOnly: true, reviewOnly: !submissionEnabled,
    step: pending.step + 1, costs: pending.costs, transaction: pending.record.transaction,
    minimumAmountOut: pending.record.minimumAmountOut, slippageBps: 100, lastValidBlockHeight: pending.record.lastValidBlockHeight })
  return async body => {
    if (body.action === 'prepare') {
      const state = await run.request(body)
      if (state.pending) return preparedResponse(state.pending)
      const step = TEST_PLAN.steps[state.step]
      // Captured and later persisted BEFORE the unsigned message is returned.
      const before = step.phase === 'graduated' ? await checkpoint(step.githubRepoId) : null
      const engine = await router(body.githubRepoId)
      const { prepared, costs } = await prepareCheckedTrade({ engine, connection, direction: body.direction,
        githubRepoId: body.githubRepoId, wallet: body.wallet, amountBaseUnits: body.amountBaseUnits, referrer: null, slippageBps: 100 })
      return preparedResponse((await run.reserve(body, { record: prepared.record, costs, before })).pending)
    }
    if (body.action === 'submit') {
      if (!submissionEnabled) throw Error('Test submission disabled')
      const loaded = await run.load(body.id)
      if (loaded.completed) throw Error('Test attempt already finalized; use status')
      const session = restore(loaded.pending)
      const accepted = acceptSignedTrade(session, body.transaction)
      const permit = await run.claimVerifiedSignature(body.id, accepted)
      if (permit.send) {
        try {
          const signature = await connection.sendRawTransaction(accepted.signed.serialize(), { skipPreflight: false, maxRetries: 0 })
          if (signature !== accepted.signature) throw Error('RPC returned a different signature')
        } catch {
          await run.stop(body.id, 'send failed or uncertain; reconcile only, no retry')
          return { state: 'stopped', signature: accepted.signature, reconciliationRequired: true }
        }
      }
      return { state: 'pending', signature: accepted.signature }
    }
    if (body.action !== 'status') throw Error('Test action disabled')
    const loaded = await run.load(body.id)
    if (loaded.completed) {
      if (loaded.completed.signature !== body.signature) throw Error('Test signature mismatch')
      return loaded.completed.result
    }
    const pending = loaded.pending
    if (!pending.signature || pending.signature !== body.signature) throw Error('Test signature mismatch')
    const tx = await connection.getTransaction(pending.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
    if (!tx) return { state: loaded.state.phase === 'stopped' ? 'stopped' : 'pending', signature: pending.signature }
    const meta = tx.meta
    if (meta?.err) {
      await run.stop(body.id, 'finalized transaction failed; no retry')
      return { state: 'stopped', signature: pending.signature, chainError: true }
    }
    let verified
    try {
      if (!meta || !Number.isSafeInteger(meta.fee) || meta.fee < 0 || BigInt(meta.fee) > BigInt(pending.costs.networkFee) ||
        tx.transaction.signatures[0] !== pending.signature ||
        Buffer.from(tx.transaction.message.serialize()).toString('base64') !== pending.signedMessage ||
        !Number.isSafeInteger(meta.preBalances[0]) || !Number.isSafeInteger(meta.postBalances[0]) ||
        BigInt(meta.preBalances[0]) - BigInt(meta.postBalances[0]) > BigInt(pending.gross)) throw Error('Test finalized receipt mismatch')
      const session = restore(pending)
      verified = await session.engine.verifyTrade(session.prepared, pending.signature, { commitment: 'finalized' })
      if (BigInt(verified.slot) !== BigInt(tx.slot) || BigInt(verified.solDelta) !== BigInt(meta.postBalances[0]) - BigInt(meta.preBalances[0])) {
        throw Error('Test finalized receipt mismatch')
      }
    } catch (error) {
      await run.stop(body.id, 'finalized receipt verification failed; review required')
      throw error
    }
    // A late RPC bank or ledger outage holds the same step pending. Retrying
    // accounting is allowed; preparing/rebroadcasting/replacing a swap is not.
    let after, curve
    if (pending.record.phase === 'graduated') {
      after = await checkpoint(pending.record.githubRepoId)
      if (BigInt(after.slot) < BigInt(tx.slot) || BigInt(pending.before.slot) > BigInt(tx.slot)) throw Error('Test checkpoint does not bracket finalized receipt')
    } else {
      curve = await recordCurve({ githubRepoId: pending.record.githubRepoId, signatures: [pending.signature] })
      if (!curve.eventKeys?.length) throw Error('Test curve receipt accounting missing')
    }
    const evidence = { signature: pending.signature, slot: Number(tx.slot), tokenDelta: String(verified.tokenDelta),
      solDelta: String(verified.solDelta), networkFee: String(meta.fee) }
    return run.settle(body.id, evidence, (client, current) => current.record.phase === 'graduated'
      ? recordCheckpoint(client, { runId: TEST_PLAN.id, step: current.step + 1, githubRepoId: current.record.githubRepoId,
        signature: current.signature, before: current.before, after })
      : { status: 'recorded', eventKeys: curve.eventKeys })
  }
}
