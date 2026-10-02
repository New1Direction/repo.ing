import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, SendTransactionError, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import { preparedFromRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { POST as tradeApi } from '../app/api/trade/route.js'

// /api/trade submit and status with an in-process session store, trader and database, and a scripted JSON-RPC answering
// the route's own chain() connection: no PostgreSQL, no RPC endpoint.
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.DBC_CONFIG = '11111111111111111111111111111111'
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
const queries = []
globalThis.__gitfunPool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 } } }
// The signature's on-chain status (null: not seen yet); block height stays far below every trade's expiry.
let onChain = null
globalThis.__repoingRpcMeter = { fetch: async (_url, options) => {
  const { id, method } = JSON.parse(options.body)
  const result = method === 'getSignatureStatuses' ? { context: { slot: 1 }, value: [onChain] } : method === 'getBlockHeight' ? 10 : null
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
} }
let submitError = null
const engine = { submitTrade: async () => { throw submitError } }
const router = Object.assign(async () => engine, { forPhase: () => engine })
globalThis.__gitfunTrader = router
globalThis.__gitfunTraderConfig = process.env.DBC_CONFIG
const sessions = new Map(), saved = []
globalThis.__gitfunTradeSessionsRouter = router
globalThis.__gitfunTradeSessions = {
  load: async id => sessions.get(id) ?? null,
  markSubmitted: async (session, { signature, signedMessage }) => ({ ...session, signature, signedMessage, submittedAt: session.submittedAt ?? Date.now() }),
  saveResult: async (session, result) => { saved.push(result); return { ...session, result } },
}

const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const referrer = Keypair.generate().publicKey.toBase58()

// A prepared curve trade whose swap is instruction 3 (two compute-budget instructions and a transfer come first), signed.
function preparedTrade({ slippageBps = 300 } = {}) {
  const wallet = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: wallet.publicKey, lamports: 1 }),
    new TransactionInstruction({ programId: DBC, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }))
  const record = { v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: wallet.publicKey.toBase58(), marketId: 1, githubRepoId: '42',
    mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
    referral: getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(referrer)).toBase58(), referrer, tradingFeeLamports: '17500',
    wsolRent: null, amountIn: '100000000', minimumAmountOut: '900', message: Buffer.from(tx.serializeMessage()).toString('base64'),
    transaction: serializeUnsigned(tx), blockhash, lastValidBlockHeight: 1_000_000, slippageBps, priorityFee: null }
  tx.sign(wallet)
  return { record, signed: tx.serialize().toString('base64'), signature: bs58.encode(tx.signature) }
}

function session(trade, extra = {}) {
  const id = randomUUID()
  sessions.set(id, { id, prepared: preparedFromRecord(trade.record), engine, wallet: trade.record.wallet, createdAt: Date.now(), ...extra })
  return id
}
const call = async body => {
  const response = await tradeApi(new Request('http://localhost/api/trade', { method: 'POST', body: JSON.stringify(body) }))
  return { status: response.status, body: await response.json() }
}
const preflightRefusal = index => new SendTransactionError({ action: 'simulate', signature: '',
  transactionMessage: `Transaction simulation failed: Error processing Instruction ${index}: custom program error: 0x1772`, logs: [] })
const failedOnChain = (index, code) => ({ slot: 2, confirmations: null, err: { InstructionError: [index, { Custom: code }] }, confirmationStatus: 'confirmed' })
const outcomes = () => queries.filter(q => /insert into trade_outcomes/.test(q.sql)).map(q => q.params[1])

test('a first submission refused at preflight on its own swap says nothing was sent, without a terminal outcome', async () => {
  queries.length = 0
  onChain = null
  const trade = preparedTrade()
  submitError = preflightRefusal(3)
  const { status, body } = await call({ action: 'submit', id: session(trade), transaction: trade.signed })
  assert.equal(status, 409)
  assert.deepEqual({ code: body.code, slippageBps: body.slippageBps }, { code: 'SLIPPAGE_EXCEEDED', slippageBps: 300 })
  assert.match(body.error, /more than your 3% slippage limit before this trade was sent.*Nothing was spent/)
  assert.deepEqual(outcomes(), ['submitted'], 'no failed outcome: the landing alert only counts landing problems')
  assert.deepEqual(saved, [])
})

test('a repeated submit, or a refusal elsewhere, never claims "nothing was sent"', async () => {
  onChain = null
  const trade = preparedTrade()
  submitError = preflightRefusal(3)
  // The same signature submitted again: an earlier broadcast may still be in flight, so the status path answers.
  const repeat = await call({ action: 'submit', id: session(trade, { signature: trade.signature, submittedAt: Date.now() }), transaction: trade.signed })
  assert.equal(repeat.status, 200)
  assert.deepEqual(repeat.body, { state: 'pending', signature: trade.signature })
  // A refusal raised by another instruction (a wallet assertion, an account setup) is not a slippage refusal.
  submitError = preflightRefusal(4)
  const other = preparedTrade()
  const elsewhere = await call({ action: 'submit', id: session(other), transaction: other.signed })
  assert.equal(elsewhere.status, 200)
  assert.equal(elsewhere.body.state, 'pending')
})

test('a swap that landed and failed on its own minimum is reported as slippage and is not a landing failure', async () => {
  // Submit: the broadcast landed, then failed with ExceededSlippage on the swap instruction.
  queries.length = 0
  const trade = preparedTrade()
  submitError = Error('Trade failed: {"InstructionError":[3,{"Custom":6002}]}')
  onChain = failedOnChain(3, 6002)
  const submitted = await call({ action: 'submit', id: session(trade), transaction: trade.signed })
  assert.equal(submitted.status, 200)
  assert.deepEqual(submitted.body, { state: 'failed', signature: trade.signature, reason: 'slippage', slippageBps: 300 })
  assert.deepEqual(outcomes(), ['submitted'])
  // Status poll of a submitted trade that failed the same way: still no terminal outcome.
  queries.length = 0
  const polledTrade = preparedTrade()
  const id = session(polledTrade, { signature: polledTrade.signature, submittedAt: Date.now() })
  const polled = await call({ action: 'status', id, signature: polledTrade.signature, lastValidBlockHeight: 1_000_000 })
  assert.equal(polled.body.reason, 'slippage')
  assert.deepEqual(outcomes(), [])
  // Any other on-chain failure is still a failed landing outcome.
  onChain = failedOnChain(3, 6017)
  const other = await call({ action: 'status', id, signature: polledTrade.signature, lastValidBlockHeight: 1_000_000 })
  assert.deepEqual(other.body, { state: 'failed', signature: polledTrade.signature })
  assert.deepEqual(outcomes(), ['failed'])
})

test('a status poll records the referral only for the session\'s own verified signature', async () => {
  queries.length = 0
  const trade = preparedTrade()
  const result = { state: 'confirmed', signature: trade.signature, tokenDelta: '5', solDelta: '-100000000', feeIndexing: 'recorded' }
  const id = session(trade, { signature: trade.signature, submittedAt: Date.now(), result })
  const other = preparedTrade()
  const forged = await call({ action: 'status', id, signature: other.signature, lastValidBlockHeight: 1_000_000 })
  assert.equal(forged.status, 400)
  assert.match(forged.body.error, /does not match prepared trade/)
  assert.equal(queries.some(q => /trade_referrers/.test(q.sql)), false)
  const polled = await call({ action: 'status', id, signature: trade.signature, lastValidBlockHeight: 1_000_000 })
  assert.deepEqual(polled.body, result)
  const inserts = queries.filter(q => /insert into trade_referrers/.test(q.sql))
  assert.deepEqual(inserts.map(q => q.params), [[trade.signature, referrer, '42', 'curve', 'buy', '17500']])
})
