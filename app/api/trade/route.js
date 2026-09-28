import { estimateTradeCosts, preflightTrade } from '../../../src/trade-costs.mjs'
import { randomUUID } from 'node:crypto'
import { Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import { createCanonicalTrader } from '../../../src/canonical-trade.mjs'
import { createFeeAccrual } from '../../../src/fee-accrual.mjs'
import { database, chain, configAddress } from '../../lib/server.mjs'
import { tradeStatus } from '../../lib/trade-status.mjs'
export const runtime = 'nodejs'
const sessions = globalThis.__gitfunTradeSessions ??= new Map()
const SESSION_LIFETIME_MS = 10 * 60 * 1000
function trader() {
  const pool = database(), config = configAddress()
  if (!pool || !config) throw new Error('Trading is not configured')
  if (!globalThis.__gitfunTrader || globalThis.__gitfunTraderConfig !== config) {
    globalThis.__gitfunTrader = createCanonicalTrader({ pool, connection: chain(), config })
    globalThis.__gitfunTraderConfig = config
  }
  return globalThis.__gitfunTrader
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
    if (body.action === 'depth') return Response.json(await trader().buyDepth(body.githubRepoId), { headers: { 'Cache-Control': 'no-store' } })
    if (body.action === 'quote') {
      if (body.direction !== 'buy' && body.direction !== 'sell') throw new Error('Invalid trade direction')
      const engine = trader()
      const args = { githubRepoId: body.githubRepoId, wallet: body.wallet,
        [body.direction === 'sell' ? 'amountBaseUnits' : 'amountLamports']: body.amountBaseUnits }
      const quote = body.direction === 'sell' ? await engine.quoteSell(args) : await engine.quoteBuy(args)
      return Response.json(quote, { headers: { 'Cache-Control': 'no-store' } })
    }
    if (body.action === 'prepare') {
      if (!['buy', 'sell'].includes(body.direction)) throw new Error('Invalid trade direction')
      const engine = trader()
      const args = { githubRepoId: body.githubRepoId, wallet: body.wallet,
        [body.direction === 'sell' ? 'amountBaseUnits' : 'amountLamports']: body.amountBaseUnits }
      const prepared = body.direction === 'sell' ? await engine.prepareSell(args) : await engine.prepareBuy(args)
      const costs = await estimateTradeCosts(chain(), prepared)
      await preflightTrade(chain(), prepared, costs)
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
      let feeIndexing = 'pending'
      let creatorFee = null
      const connection = chain()
      for (let attempt = 0; attempt < 120; attempt++) {
        const finalized = await connection.getTransaction(result.signature,
          { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => null)
        if (finalized) {
          try {
            const accrued = await createFeeAccrual({ pool: database(), connection, config: configAddress() })
              .recordTradeFees({ githubRepoId: session.prepared.githubRepoId, signatures: [result.signature] })
            feeIndexing = 'recorded'
            creatorFee = accrued.creditedBaseUnits.toString()
          } catch (error) { feeIndexing = `pending: ${error.message}` }
          break
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      session.result = { state: 'confirmed', signature: result.signature, tokenDelta: result.tokenDelta.toString(),
        solDelta: result.solDelta.toString(), feeIndexing, creatorFee }
      return Response.json(session.result, { headers: { 'Cache-Control': 'no-store' } })
    }
    throw new Error('Unsupported trade action')
  } catch (error) { return Response.json({ error: error.message || 'Trade failed' }, { status: 400, headers: { 'Cache-Control': 'no-store' } }) }
}
