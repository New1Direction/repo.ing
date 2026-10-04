import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { preparedFromRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { POST as tradeApi } from '../app/api/trade/route.js'

// /api/trade submit after a confirmed trade in a graduated (DAMM v2) pool: a stock-paired one carries its quote mint, yet never
// reaches a curve fee accrual. Like a SOL graduated trade, it is only re-verified once finalized: the worker indexes its swap into
// stock_trade_events and its fees through the positions' checkpoints (src/stock-graduation-monitor.mjs). In-process sessions,
// trader and database, and a scripted JSON-RPC: no PostgreSQL, no RPC endpoint.
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.DBC_CONFIG = '11111111111111111111111111111111'
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
const META = quoteAssetById('meta-xstock')
const queries = [], clientQueries = [], rpc = []
const client = { query: async sql => { clientQueries.push(String(sql).trim().split(/\s+/).slice(0, 3).join(' ')); return { rows: [], fields: [] } }, release() {} }
globalThis.__gitfunPool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 } }, connect: async () => client }
// Every signature is finalized at once: settlement re-verifies it on the first poll.
globalThis.__repoingRpcMeter = { fetch: async (_url, options) => {
  const { id, method, params } = JSON.parse(options.body)
  rpc.push(method)
  const result = method === 'getSignatureStatuses' ? { context: { slot: 1 }, value: params[0].map(() => ({ slot: 1, confirmations: null, err: null,
    confirmationStatus: 'finalized' })) } : null
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
} }
let verified
const verifications = []
const engine = { submitTrade: async (_prepared, sign) => ({ signature: bs58.encode((await sign()).signature), ...verified }),
  verifyTrade: async (prepared, signature, options) => { verifications.push({ quoteMint: prepared.quoteMint, signature, ...options }); return verified } }
const router = Object.assign(async () => engine, { forPhase: () => engine })
globalThis.__gitfunTrader = router
globalThis.__gitfunTraderConfig = process.env.DBC_CONFIG
const sessions = new Map()
globalThis.__gitfunTradeSessionsRouter = router
globalThis.__gitfunTradeSessions = {
  load: async id => sessions.get(id) ?? null,
  markSubmitted: async (session, { signature, signedMessage }) => ({ ...session, signature, signedMessage, submittedAt: Date.now() }),
  saveResult: async (session, result) => ({ ...session, result }),
}
const CP_AMM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG')

// A prepared, signed graduated buy; a stock-paired one carries its quote mint and, like every stock trade, no referral or WSOL.
function preparedTrade(quoteMint) {
  const wallet = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    new TransactionInstruction({ programId: CP_AMM, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }))
  const key = () => Keypair.generate().publicKey.toBase58()
  const record = { v: TRADE_RECORD_VERSION, phase: 'graduated', direction: 'buy', wallet: wallet.publicKey.toBase58(), marketId: 1, githubRepoId: '94911145',
    mint: key(), curve: key(), pool: key(), tokenAVault: key(), tokenBVault: key(), referral: null, wsolRent: null, amountIn: '50000000',
    minimumAmountOut: '900', message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx),
    blockhash, lastValidBlockHeight: 1_000_000, slippageBps: 300, priorityFee: null, referrer: null, tradingFeeLamports: quoteMint ? null : '500000',
    ...quoteMint ? { quoteMint } : {} }
  tx.sign(wallet)
  const id = randomUUID(), prepared = preparedFromRecord(record)
  sessions.set(id, { id, prepared, engine, wallet: record.wallet, createdAt: Date.now() })
  return { id, prepared, transaction: tx.serialize().toString('base64') }
}
async function submit(quoteMint) {
  queries.length = 0; clientQueries.length = 0; verifications.length = 0; rpc.length = 0
  const { id, prepared, transaction } = preparedTrade(quoteMint)
  const response = await tradeApi(new Request('http://localhost/api/trade', { method: 'POST', body: JSON.stringify({ action: 'submit', id, transaction }) }))
  return { status: response.status, body: await response.json(), prepared, alerts: queries.filter(query => /graduation_alerts/.test(query.sql)) }
}

test('a graduated stock trade is re-verified once finalized and never reaches a curve fee accrual; a SOL one as before', async () => {
  verified = { tokenDelta: 5n, solDelta: -5000n, quoteDelta: -50_000_000n, quoteMint: META.mint }
  const stock = await submit(META.mint)
  assert.equal(stock.prepared.quoteMint, META.mint, 'the prepared DAMM trade carries the stock')
  assert.equal(stock.status, 200)
  assert.deepEqual([stock.body.state, stock.body.quoteMint, stock.body.quoteDelta, stock.body.feeIndexing, stock.body.creatorFee],
    ['confirmed', META.mint, '-50000000', 'pending', null])
  assert.deepEqual(verifications, [{ quoteMint: META.mint, signature: stock.body.signature, commitment: 'finalized' }])
  // Neither the stock curve accrual nor the SOL accrual ran (each takes the repository's advisory lock), and nothing failed.
  assert.deepEqual([clientQueries, stock.alerts], [[], []])
  assert.ok(!rpc.includes('getTransaction'), 'the curve settlement read is not taken')

  verified = { tokenDelta: 5n, solDelta: -100_000_000n }
  const sol = await submit(null)
  assert.equal(sol.prepared.quoteMint, null, 'a SOL graduated trade has no quote mint, so its fees can never route to the stock accrual')
  assert.deepEqual([sol.status, sol.body.state, sol.body.quoteMint, sol.body.feeIndexing], [200, 'confirmed', undefined, 'pending'])
  assert.deepEqual(verifications, [{ quoteMint: null, signature: sol.body.signature, commitment: 'finalized' }])
  assert.deepEqual([clientQueries, sol.alerts], [[], []])
})
