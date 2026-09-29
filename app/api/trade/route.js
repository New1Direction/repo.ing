import { estimateTradeCosts, preflightTrade } from '../../../src/trade-costs.mjs'
import { randomUUID } from 'node:crypto'
import { Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createFeeAccrual } from '../../../src/fee-accrual.mjs'
import { database, chain, configAddress } from '../../lib/server.mjs'
import { tradeStatus } from '../../lib/trade-status.mjs'
import { settleConfirmedTrade } from '../../lib/trade-settlement.mjs'
import { tradeRouter as trader } from '../../lib/trader.mjs'
import { publicError } from '../../lib/public-error.mjs'
const SAFE = /^(Trading is not configured|Invalid trade|Invalid transaction signature|Transaction (does not match|did not swap)|Prepared trade|Wallet returned|Trade (was not prepared|failed|size guide|simulation|transaction|balances)|You need approximately|No executable output|Network cost estimate|Account setup estimate|Repository has no indexed|Canonical|Buy balances|Sell balances|Quote fee|Pool and mint|Input amount|Fixed DBC|Unsupported trade action)/
export const runtime = 'nodejs'
const sessions = globalThis.__gitfunTradeSessions ??= new Map()
const SESSION_LIFETIME_MS = 10 * 60 * 1000
// The referrer is only a hint: each trader validates it and resolves the referral account itself.
function prepareTrade(engine, body, referrer) {
  const args = { githubRepoId: body.githubRepoId, wallet: body.wallet, referrer: typeof referrer === 'string' ? referrer : null,
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
    for (const [id, session] of sessions) {
      if (Date.now() - session.createdAt > SESSION_LIFETIME_MS) sessions.delete(id)
    }
    if (body.action === 'depth') return Response.json(await (await trader()(body.githubRepoId)).buyDepth(body.githubRepoId), { headers: { 'Cache-Control': 'no-store' } })
    if (body.action === 'quote') {
      if (body.direction !== 'buy' && body.direction !== 'sell') throw new Error('Invalid trade direction')
      const engine = await trader()(body.githubRepoId)
      const args = { githubRepoId: body.githubRepoId, wallet: body.wallet,
        [body.direction === 'sell' ? 'amountBaseUnits' : 'amountLamports']: body.amountBaseUnits }
      const quote = body.direction === 'sell' ? await engine.quoteSell(args) : await engine.quoteBuy(args)
      return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'costs') {
      if (!['buy', 'sell'].includes(body.direction)) throw new Error('Invalid trade direction')
      const engine = await trader()(body.githubRepoId)
      const prepared = await prepareTrade(engine, body, null)
      // Read-only preview. Only prepare creates a signable session and simulates it.
      return Response.json({ costs: await estimateTradeCosts(chain(), prepared) }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'prepare') {
      if (!['buy', 'sell'].includes(body.direction)) throw new Error('Invalid trade direction')
      const engine = await trader()(body.githubRepoId)
      const build = async referrer => {
        const prepared = await prepareTrade(engine, body, referrer)
        const costs = await estimateTradeCosts(chain(), prepared)
        await preflightTrade(chain(), prepared, costs)
        return { prepared, costs }
      }
      let built
      // A referral must never cost the trader a trade: if anything fails with one, retry once without it.
      try { built = await build(body.referrer) }
      catch (error) { if (!body.referrer) throw error; built = await build(null) }
      const { prepared, costs } = built
      const id = randomUUID()
      sessions.set(id, { prepared, engine, wallet: body.wallet, createdAt: Date.now() })
      return Response.json({ id, costs, transaction: prepared.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        minimumAmountOut: prepared.minimumAmountOut.toString(), slippageBps: prepared.slippageBps,
        lastValidBlockHeight: prepared.lastValidBlockHeight }, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'status') {
      if (!validSignature(body.signature)) throw new Error('Invalid transaction signature')
      const session = sessions.get(body.id)
      if (session?.signature && session.signature !== body.signature) throw new Error('Transaction does not match prepared trade')
      const status = await tradeStatus(chain(), body.signature, session, body.lastValidBlockHeight)
      return Response.json(status, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'submit') {
      const session = sessions.get(body.id)
      if (!session || Date.now() - session.createdAt > 120000) throw new Error('Prepared trade expired; try again')
      const signed = Transaction.from(Buffer.from(body.transaction, 'base64'))
      if (!signed.signature || !Buffer.from(signed.serializeMessage()).equals(Buffer.from(session.prepared.transaction.serializeMessage())) ||
          signed.feePayer?.toBase58() !== session.wallet || !signed.verifySignatures()) {
        throw new Error('Wallet returned an altered or unsigned trade transaction')
      }
      const signature = bs58.encode(signed.signature)
      if (session.signature && session.signature !== signature) throw new Error('Prepared trade already has a different signature')
      session.signature = signature
      let result
      try { result = await session.engine.submitTrade(session.prepared, async () => signed) }
      catch {
        const status = await tradeStatus(chain(), signature, session, session.prepared.lastValidBlockHeight)
          .catch(() => ({ state: 'pending', signature }))
        return Response.json(status, { headers: { 'Cache-Control': 'no-store' } })
      }
      const connection = chain()
      const { feeIndexing, creatorFee } = await settleConfirmedTrade({ connection, db: database(), engine: session.engine,
        prepared: session.prepared, signature: result.signature,
        recordFees: args => createFeeAccrual({ pool: database(), connection, config: configAddress() }).recordTradeFees(args) })
      session.result = { state: 'confirmed', signature: result.signature, tokenDelta: result.tokenDelta.toString(),
        solDelta: result.solDelta.toString(), feeIndexing, creatorFee }
      return Response.json(session.result, { headers: { 'Cache-Control': 'no-store' } })
    }
    throw new Error('Unsupported trade action')
  } catch (error) { return Response.json({ error: publicError(error, SAFE, 'Trade failed. Refresh the quote and try again.', 'trade') }, { status: 400, headers: { 'Cache-Control': 'no-store' } }) }
}
