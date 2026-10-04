import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js'
import { preparedFromRecord, serializeUnsigned, TRADE_RECORD_VERSION } from '../src/trade-record.mjs'
import { quoteAssetById } from '../src/quote-assets.mjs'
import { POST as tradeApi } from '../app/api/trade/route.js'

// /api/trade submit after a confirmed curve trade: the fees of a stock-paired trade (its prepared quote mint) are recorded by
// the stock accrual, a SOL trade's exactly as before by the SOL accrual. In-process sessions, trader and database, and a
// scripted JSON-RPC: no PostgreSQL, no RPC endpoint. Each accrual is told apart by how it fails on the empty database.
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.DBC_CONFIG = '11111111111111111111111111111111'
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
const META = quoteAssetById('meta-xstock')
const FINALIZED = JSON.parse(readFileSync(new URL('./fixtures/dbc-stock-swaps-local.json', import.meta.url))).buy
const queries = [], clientQueries = []
const client = { query: async sql => {
  clientQueries.push(typeof sql === 'string' ? sql.trim().split(/\s+/).slice(0, 3).join(' ') : 'drizzle select')
  return /pg_advisory_lock/.test(sql) ? { rows: [{ locked: true }] } : { rows: [], fields: [] }
}, release() {} }
globalThis.__gitfunPool = { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 } }, connect: async () => client }
// The trade is finalized as soon as it is confirmed: settlement reads it once and records its fees.
globalThis.__repoingRpcMeter = { fetch: async (_url, options) => {
  const { id, method } = JSON.parse(options.body)
  const result = method === 'getTransaction' ? FINALIZED : null
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200 })
} }
let verified
const engine = { submitTrade: async (_prepared, sign) => ({ signature: bs58.encode((await sign()).signature), ...verified }) }
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
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

// A prepared, signed curve buy; a stock-paired one carries its quote mint, no referral and no wrapped SOL.
function preparedTrade(quoteMint) {
  const wallet = Keypair.generate(), blockhash = Keypair.generate().publicKey.toBase58()
  const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    new TransactionInstruction({ programId: DBC, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }))
  const record = { v: TRADE_RECORD_VERSION, phase: 'curve', direction: 'buy', wallet: wallet.publicKey.toBase58(), marketId: 1, githubRepoId: '94911145',
    mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(), referral: null, wsolRent: null,
    amountIn: '50000000', minimumAmountOut: '900', message: Buffer.from(tx.serializeMessage()).toString('base64'), transaction: serializeUnsigned(tx),
    blockhash, lastValidBlockHeight: 1_000_000, slippageBps: 300, priorityFee: null, ...quoteMint ? { quoteMint } : {} }
  tx.sign(wallet)
  const id = randomUUID()
  sessions.set(id, { id, prepared: preparedFromRecord(record), engine, wallet: record.wallet, createdAt: Date.now() })
  return { id, transaction: tx.serialize().toString('base64') }
}
async function submit(quoteMint) {
  queries.length = 0; clientQueries.length = 0
  const { id, transaction } = preparedTrade(quoteMint)
  const response = await tradeApi(new Request('http://localhost/api/trade', { method: 'POST', body: JSON.stringify({ action: 'submit', id, transaction }) }))
  const alert = queries.find(query => /insert into graduation_alerts/.test(query.sql))
  return { status: response.status, body: await response.json(), alert: alert && { kind: alert.params[2], detail: JSON.parse(alert.params[3]) } }
}

test('a stock-paired trade\'s fees go to the stock accrual; a SOL trade\'s to the SOL accrual, as before', async t => {
  t.mock.method(console, 'error', () => {})
  verified = { tokenDelta: 5n, solDelta: -5000n, quoteDelta: -50_000_000n, quoteMint: META.mint }
  const stock = await submit(META.mint)
  assert.equal(stock.status, 200)
  assert.deepEqual([stock.body.state, stock.body.quoteMint, stock.body.feeIndexing], ['confirmed', META.mint, 'pending'])
  assert.deepEqual([stock.alert.kind, stock.alert.detail.code, stock.alert.detail.reason],
    ['TRADE_VERIFICATION_FAILED', 'FEE_INDEXING', 'Repository has no indexed stock-paired market'])
  assert.deepEqual(clientQueries, ['select pg_advisory_lock($1::bigint)', 'select github_repo_id::text as', 'select pg_advisory_unlock($1::bigint)'])

  verified = { tokenDelta: 5n, solDelta: -100_000_000n }
  const sol = await submit(null)
  assert.equal(sol.status, 200)
  assert.deepEqual([sol.body.state, sol.body.quoteMint, sol.body.feeIndexing], ['confirmed', undefined, 'pending'])
  assert.deepEqual([sol.alert.kind, sol.alert.detail.code, sol.alert.detail.reason],
    ['TRADE_VERIFICATION_FAILED', 'FEE_INDEXING', 'Repository has no indexed canonical market'])
  assert.deepEqual(clientQueries, ['select pg_advisory_lock($1::bigint)', 'drizzle select', 'select pg_advisory_unlock($1::bigint)'])
})
