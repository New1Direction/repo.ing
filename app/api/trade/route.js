import { estimateTradeCosts } from '../../../src/trade-costs.mjs'
import { prepareCheckedTrade } from '../../../src/trade-prepare.mjs'
import { acceptSignedTrade, TRADE_WINDOW_CLOSED } from '../../../src/trade-sessions.mjs'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { createFeeAccrual } from '../../../src/fee-accrual.mjs'
import { database, chain, configAddress } from '../../lib/server.mjs'
import { tradeResultFields, tradeStatus } from '../../lib/trade-status.mjs'
import { settleConfirmedTrade } from '../../lib/trade-settlement.mjs'
import { tradeRouter as trader } from '../../lib/trader.mjs'
import { tradeSessions } from '../../lib/trade-sessions.mjs'
import { publicError } from '../../lib/public-error.mjs'
import { statusOutcome, submitOutcome, trackTradeOutcome } from '../../lib/trade-tracking.mjs'
import { recordReferredTrade } from '../../../src/referral-leaderboard.mjs'
import { DEFAULT_SLIPPAGE_BPS, isPreflightSlippageError, parseSlippageBps, SLIPPAGE_EXCEEDED, slippageLabel, swapInstructionIndex } from '../../../src/trade-slippage.mjs'
const SAFE = /^(The trade window closed|Trading is not configured|Invalid trade|Invalid transaction signature|Invalid slippage|Transaction (does not match|did not swap)|Prepared trade|Wallet returned|Trade (was not prepared|failed|size guide|simulation|transaction|balances)|You need approximately|No executable output|Network cost estimate|Account setup estimate|Repository has no indexed|Canonical|Buy balances|Sell balances|Quote fee|Pool and mint|Input amount|Fixed DBC|Unsupported trade action)/
export const runtime = 'nodejs'
// Sessions live in trade_sessions (see src/trade-sessions.mjs), so a deploy or another replica can finish a trade.
// A missing or expired session (or a slow approval) means nothing was broadcast: the client shows this as not
// submitted and its next attempt prepares a fresh transaction.
const track = (fields, session) => trackTradeOutcome(database(), fields, { session })
// A swap stopped by its own minimum (the market moved past the trader's chosen limit) is not a landing failure: it gets no
// terminal outcome, so it never counts toward TRADE_LANDING_DEGRADED or the health page's success rate.
const landingOutcome = (outcome, status) => status.reason === 'slippage' ? null : outcome
// Best effort, after the swap is verified: a referred trade feeds the public referral leaderboard.
const recordReferral = (session, signature) => recordReferredTrade(database(), session.prepared, signature)
// The referrer is only a hint: each trader validates it and resolves the referral account itself.
function prepareTrade(engine, body, referrer, slippageBps) {
  const args = { githubRepoId: body.githubRepoId, wallet: body.wallet, referrer: typeof referrer === 'string' ? referrer : null, slippageBps,
    [body.direction === 'sell' ? 'amountBaseUnits' : 'amountLamports']: body.amountBaseUnits }
  return body.direction === 'sell' ? engine.prepareSell(args) : engine.prepareBuy(args)
}
function validSignature(signature) {
  try { return typeof signature === 'string' && signature.length <= 88 && bs58.decode(signature).length === 64 }
  catch { return false }
}
export async function POST(request) {
  try {
    const body = await request.json()
    if (body.action === 'depth') return Response.json(await (await trader()(body.githubRepoId)).buyDepth(body.githubRepoId), { headers: { 'Cache-Control': 'no-store' } })
    if (body.action === 'quote') {
      if (body.direction !== 'buy' && body.direction !== 'sell') throw new Error('Invalid trade direction')
      const slippageBps = parseSlippageBps(body.slippageBps)
      const engine = await trader()(body.githubRepoId)
      const args = { githubRepoId: body.githubRepoId, wallet: body.wallet, slippageBps,
        [body.direction === 'sell' ? 'amountBaseUnits' : 'amountLamports']: body.amountBaseUnits }
      const quote = body.direction === 'sell' ? await engine.quoteSell(args) : await engine.quoteBuy(args)
      return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'costs') {
      if (!['buy', 'sell'].includes(body.direction)) throw new Error('Invalid trade direction')
      const slippageBps = parseSlippageBps(body.slippageBps)
      const engine = await trader()(body.githubRepoId)
      const prepared = await prepareTrade(engine, body, null, slippageBps)
      // Read-only preview. Only prepare creates a signable session and simulates it.
      return Response.json({ costs: await estimateTradeCosts(chain(), prepared) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'prepare') {
      if (!['buy', 'sell'].includes(body.direction)) throw new Error('Invalid trade direction')
      const slippageBps = parseSlippageBps(body.slippageBps)
      const engine = await trader()(body.githubRepoId)
      const build = referrer => prepareCheckedTrade({ engine, connection: chain(), direction: body.direction, githubRepoId: body.githubRepoId,
        wallet: body.wallet, amountBaseUnits: body.amountBaseUnits, referrer, slippageBps })
      let built
      // A referral must never cost the trader a trade: if anything fails with one, retry once without it.
      try { built = await build(body.referrer) }
      catch (error) { if (!body.referrer) throw error; built = await build(null) }
      const { prepared, costs } = built
      const id = randomUUID()
      const session = await tradeSessions().create(id, { prepared, wallet: prepared.record.wallet })
      await track({ attemptKey: id, outcome: 'prepared', prepared }, session)
      return Response.json({ id, costs, transaction: prepared.record.transaction,
        minimumAmountOut: prepared.minimumAmountOut.toString(), slippageBps: prepared.slippageBps,
        lastValidBlockHeight: prepared.lastValidBlockHeight }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'status') {
      if (!validSignature(body.signature)) throw new Error('Invalid transaction signature')
      const session = await tradeSessions().load(body.id).catch(() => null)
      if (session?.signature && session.signature !== body.signature) throw new Error('Transaction does not match prepared trade')
      const status = await tradeStatus(chain(), body.signature, session, body.lastValidBlockHeight)
      const outcome = landingOutcome(statusOutcome(status.state, { hasSession: Boolean(session) }), status)
      if (outcome) await track({ attemptKey: session ? body.id : `sig:${body.signature}`, outcome, prepared: session?.prepared ?? null,
        signature: body.signature, signToConfirmMs: outcome === 'confirmed' && session?.submittedAt ? Date.now() - session.submittedAt : null }, session)
      // Only a receipt verified against this session's own prepared record counts toward the leaderboard.
      if (status.state === 'confirmed' && session?.signature === body.signature) await recordReferral(session, body.signature)
      return Response.json(status, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'submit') {
      const store = tradeSessions()
      const loaded = await store.load(body.id)
      // Checked against the exact reviewed message bytes stored at prepare, not a rebuilt transaction.
      const { signed, signature, signedMessage } = acceptSignedTrade(loaded, body.transaction)
      // A repeat of an earlier submit of this signature may follow a broadcast that is still in flight.
      const firstSubmission = !loaded.signature
      // Recorded (first signature wins across replicas) before anything is broadcast, so any instance can verify it.
      let session = await store.markSubmitted(loaded, { signature, signedMessage })
      const attempt = { attemptKey: body.id, prepared: session.prepared, signature }
      await track({ ...attempt, outcome: 'submitted', prepareToSignMs: session.submittedAt - session.createdAt }, session)
      let result
      try { result = await session.engine.submitTrade(session.prepared, async () => signed) }
      catch (error) {
        // The RPC node simulated the signed swap, saw the price already past its minimum and never forwarded it. Only a first
        // submission can say so. Like any slippage stop (see landingOutcome), it records no terminal outcome.
        if (firstSubmission && isPreflightSlippageError(error, swapInstructionIndex(session.prepared.transaction.instructions))) {
          const slippageBps = session.prepared.slippageBps ?? DEFAULT_SLIPPAGE_BPS
          return Response.json({ error: `The price moved more than your ${slippageLabel(slippageBps)} slippage limit before this trade was sent, so it was stopped. Nothing was spent.`,
            code: SLIPPAGE_EXCEEDED, slippageBps }, { status: 409, headers: { 'Cache-Control': 'no-store' } })
        }
        const status = await tradeStatus(chain(), signature, session, session.prepared.lastValidBlockHeight)
          .catch(() => ({ state: 'pending', signature }))
        const outcome = landingOutcome(submitOutcome(status.state), status)
        if (outcome) await track({ ...attempt, outcome, error: outcome === 'confirmed' ? null : error,
          signToConfirmMs: outcome === 'confirmed' ? Date.now() - session.submittedAt : null }, session)
        if (status.state === 'confirmed') await recordReferral(session, signature)
        return Response.json(status, { headers: { 'Cache-Control': 'no-store' } })
      }
      await track({ ...attempt, outcome: 'confirmed', signToConfirmMs: Date.now() - session.submittedAt }, session)
      await recordReferral(session, result.signature)
      const connection = chain()
      const { feeIndexing, creatorFee } = await settleConfirmedTrade({ connection, db: database(), engine: session.engine,
        prepared: session.prepared, signature: result.signature,
        recordFees: args => createFeeAccrual({ pool: database(), connection, config: configAddress() }).recordTradeFees(args) })
      session = await store.saveResult(session, { state: 'confirmed', signature: result.signature, ...tradeResultFields(result), feeIndexing, creatorFee })
      return Response.json(session.result, { headers: { 'Cache-Control': 'no-store' } })
    }
    throw new Error('Unsupported trade action')
  } catch (error) {
    return Response.json({ error: publicError(error, SAFE, 'Trade failed. Refresh the quote and try again.', 'trade'),
      ...(error?.code === TRADE_WINDOW_CLOSED ? { code: TRADE_WINDOW_CLOSED } : {}) }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
}
