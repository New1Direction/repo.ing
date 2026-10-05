import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import * as revenue from '../app/api/platform-revenue/route.js'

// The operator's own path through /api/platform-revenue. tests/platform-operator.test.mjs covers who is refused (401, 403);
// those answers return before the route touches the database, the signer or the chain, so they could not show that the
// route had lost its imports of all three.
const ENV = ['GITHUB_APP_CLIENT_SECRET', 'PLATFORM_OPERATOR_GITHUB_IDS', 'APP_ORIGIN', 'DATABASE_URL', 'PLATFORM_PARTNER_SECRET_KEY', 'SOLANA_RPC_URL']
// An empty ledger: totals are zero and lists are empty.
const ZERO = { amount: '0', buyback: '0', liquidity: '0', treasury: '0', n: 0, b: '0', s: '0' }
const emptyLedger = () => ({
  statements: [],
  async query(sql) { this.statements.push(sql); return { rows: /count\(\*\)|coalesce\(sum/.test(sql) && !/group by/.test(sql) ? [ZERO] : [] } },
  async connect() { return { query: async () => ({ rows: [] }), release() {} } },
})

async function asOperator(run) {
  const saved = { env: Object.fromEntries(ENV.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, meter: globalThis.__repoingRpcMeter }
  Object.assign(process.env, { GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'), PLATFORM_OPERATOR_GITHUB_IDS: '123', APP_ORIGIN: 'https://repo.ing',
    DATABASE_URL: 'postgres://test-only', PLATFORM_PARTNER_SECRET_KEY: JSON.stringify([...Keypair.generate().secretKey]) })
  delete process.env.SOLANA_RPC_URL
  const pool = globalThis.__gitfunPool = emptyLedger(), rpc = []
  // Every RPC call is answered here; nothing reaches a network.
  globalThis.__repoingRpcMeter = { fetch: async (_url, init) => {
    const call = JSON.parse(init.body)
    rpc.push(call.method)
    return Response.json({ jsonrpc: '2.0', id: call.id, error: { code: -32015, message: 'Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1' } })
  } }
  const cookie = encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '123', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60000 })
  const request = body => ({ url: 'https://repo.ing/api/platform-revenue', headers: new Headers({ origin: 'https://repo.ing' }),
    cookies: { get: () => ({ value: cookie }) }, json: async () => body })
  try { return await run({ request, pool, rpc }) } finally {
    for (const [key, value] of Object.entries(saved.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    globalThis.__gitfunPool = saved.pool; globalThis.__repoingRpcMeter = saved.meter
  }
}

test('an operator reads the revenue summary, its reconciliation and a review for recording a buyback', () => asOperator(async ({ request, pool }) => {
  const response = await revenue.GET(request())
  assert.equal(response.status, 200)
  assert.match(response.headers.get('cache-control'), /no-store/)
  const body = await response.json()
  assert.equal(body.reconciliation.status, 'MATCH')
  assert.deepEqual(body.allocated, { buyback: '0', liquidity: '0', treasury: '0', total: '0' })
  assert.deepEqual(body.intents, [])
  assert.equal(body.reviews.allocate, null, 'nothing is waiting to be allocated')
  assert.equal(typeof body.reviews.import, 'string')
  assert.ok(pool.statements.length > 0, 'the summary came from the database')
}))

test('recording a buyback reaches the chain check, and a refusal says why', () => asOperator(async ({ request, rpc }) => {
  const review = (await (await revenue.GET(request())).json()).reviews.import
  const record = async signature => {
    const response = await revenue.POST(request({ action: 'intent.import', signature, review }))
    return [response.status, await response.json()]
  }
  // Refused before anything is read.
  assert.deepEqual(await record('not-a-signature'), [409, { status: 'failed', error: 'Invalid buyback signature' }])
  assert.deepEqual(rpc, [])
  // A well-formed signature is looked up on chain. The newest transactions use a format this tool cannot read.
  const [status, body] = await record('5'.repeat(88))
  assert.equal(status, 409)
  assert.match(body.error, /newer transaction format/)
  assert.deepEqual(rpc, ['getTransaction'])
}))
