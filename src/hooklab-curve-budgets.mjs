// Durable one-buy/one-sell reservations, not execution approval. No release/retry/broadcast API.
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { inspectCurveTrialProposal } from './hooklab-curve-activation.mjs'
import { verifyCurvePlan } from './hooklab-curve.mjs'
import { inspectCurveReceipt } from './hooklab-curve-receipts.mjs'

const ownerSchema = z.string().regex(/^[1-9]\d{0,17}$/)
const refuse = text => Object.assign(new Error(text), { status: 409 })

export function curveTrialBudgets(pool, providers, now = Date.now) {
  const expectedProviders = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).length(2).parse(providers)
  if (new Set(expectedProviders).size !== 2) throw refuse('Independent providers required')
  async function transaction(owner, id, work) {
    ownerSchema.parse(owner); z.uuid().parse(id)
    const db = await pool.connect()
    try {
      await db.query('begin')
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`curve-trial:${id}`])
      const row = (await db.query('select * from hook_lab_curve_trials where id=$1 for update', [id])).rows[0]
      if (row && row.github_user_id !== owner) throw refuse('Trial unavailable')
      const result = await work(db, row)
      await db.query('commit')
      return result
    } catch (error) { await db.query('rollback'); throw error }
    finally { db.release() }
  }
  const disabled = row => ({ ...row, canSign: false, canSubmit: false, policyAccepted: false })
  return {
    async create(owner, id, proposal, buyPlan, sellPlan) {
      // Clone at the boundary; async callers cannot mutate a validated proposal before persistence.
      const input = JSON.stringify({ proposal, buyPlan, sellPlan })
      if (Buffer.byteLength(input) > 150000) throw refuse('Trial too large')
      ;({ proposal, buyPlan, sellPlan } = JSON.parse(input))
      inspectCurveTrialProposal(proposal, buyPlan, sellPlan, now())
      return transaction(owner, id, async (db, row) => {
        if (row) {
          if (!isDeepStrictEqual(row.proposal, proposal) || !isDeepStrictEqual(row.buy_plan, buyPlan)
            || !isDeepStrictEqual(row.sell_plan, sellPlan)) throw refuse('Trial identity changed')
          return disabled(row)
        }
        return disabled((await db.query(`insert into hook_lab_curve_trials(id,github_user_id,proposal,buy_plan,sell_plan)
          values($1,$2,$3,$4,$5) returning *`, [id, owner, proposal, buyPlan, sellPlan])).rows[0])
      })
    },
    async reserve(owner, trialId, journalId) {
      z.uuid().parse(journalId)
      return transaction(owner, trialId, async (db, trial) => {
        if (!trial) throw refuse('Trial unavailable')
        // Same journal lock as recovery: a signature cannot race ahead of reservation checks.
        await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`curve:${journalId}`])
        const journal = (await db.query('select * from hook_lab_curve_journal where id=$1 for update', [journalId])).rows[0]
        if (!journal || journal.github_user_id !== owner) throw refuse('Journal unavailable')
        verifyCurvePlan(journal.plan)
        const side = journal.plan.intent.side
        if (!isDeepStrictEqual(journal.plan, trial[`${side}_plan`])) throw refuse('Exact trial message differs')
        const prior = (await db.query('select * from hook_lab_curve_reservations where trial_id=$1 and side=$2', [trialId, side])).rows[0]
        if (prior) {
          if (prior.journal_id !== journalId) throw refuse('Trial operation already reserved')
          return disabled(prior)
        }
        if (trial.stopped) throw refuse('Trial stopped; reservations remain held')
        const nowMs = now()
        inspectCurveTrialProposal(trial.proposal, trial.buy_plan, trial.sell_plan, nowMs)
        if (nowMs < journal.plan.review.observedAtMs || nowMs >= journal.plan.review.reviewExpiresAtMs) {
          throw refuse('Trial review expired or in the future')
        }
        if (journal.partial_transaction) throw refuse('Reserve before any signature is retained')
        if (side === 'sell') {
          const buy = (await db.query(`select j.* from hook_lab_curve_reservations r
            join hook_lab_curve_journal j on j.id=r.journal_id where r.trial_id=$1 and r.side='buy' for update of j`, [trialId])).rows[0]
          if (!buy?.complete || buy.latest_status !== 'candidate-deltas-matched' || !buy.first_finalized) {
            throw refuse('Buy unresolved, failed or conflicting; no sell reservation')
          }
          const observations = buy.first_finalized.observations
          const result = inspectCurveReceipt(buy.plan, buy.partial_transaction, observations, expectedProviders)
          if (result.status !== 'candidate-deltas-matched'
            || !isDeepStrictEqual(observations[0].history.after, journal.plan.observed.accounts)
            || journal.plan.observed.slot < observations[0].receipt.slot) throw refuse('Sell is not bound to finalized buy history')
        }
        // Holds are never released by errors, missing RPC, expiry, disconnect, or process restart.
        const saved = (await db.query(`insert into hook_lab_curve_reservations(trial_id,side,journal_id,input_amount,network_fee_cap)
          values($1,$2,$3,$4,$5) returning *`, [trialId, side, journalId, journal.plan.intent.amountIn,
          journal.plan.intent.maxNetworkFeeLamports])).rows[0]
        return disabled(saved)
      })
    },
    async stop(owner, id) {
      return transaction(owner, id, async (db, row) => {
        if (!row) throw refuse('Trial unavailable')
        return disabled((await db.query('update hook_lab_curve_trials set stopped=true where id=$1 returning *', [id])).rows[0])
      })
    },
    async get(owner, id) {
      return transaction(owner, id, async (db, row) => {
        if (!row) return null
        const held = (await db.query('select * from hook_lab_curve_reservations where trial_id=$1 order by created_at,side', [id])).rows
        return disabled({ ...row, reservations: held, releasable: false })
      })
    },
  }
}
