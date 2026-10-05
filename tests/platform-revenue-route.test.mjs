import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import { BUYBACK_RECEIPTS, BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { clearFinalizedTransactionCache } from '../src/finalized-transaction.mjs'
import { BUYBACK_IMPORT_REFUSALS } from '../src/platform-revenue.mjs'
import { registerRpcEndpoint } from '../src/rpc-usage.mjs'
import * as revenue from '../app/api/platform-revenue/route.js'

// The operator's own path through /api/platform-revenue. tests/platform-operator.test.mjs covers who is refused (401, 403);
// those answers return before the route touches the database, the signer or the chain, so they could not show that the
// route had lost its imports of all three. What recording a buyback accepts is in tests/buyback-import.test.mjs.
const ENV = ['GITHUB_APP_CLIENT_SECRET', 'PLATFORM_OPERATOR_GITHUB_IDS', 'APP_ORIGIN', 'DATABASE_URL', 'PLATFORM_PARTNER_SECRET_KEY', 'SOLANA_RPC_URL',
  'PLATFORM_FEE_TREASURY_WALLET']
const RPC_URL = 'http://127.0.0.1:8899'
// Real mainnet buys (raw getTransaction results), keyed by signature.
const TXS = JSON.parse(readFileSync(new URL('./fixtures/repoing-buyback-transactions.json', import.meta.url), 'utf8'))
const custodyBuy = BUYBACK_RECEIPTS.find(receipt => receipt.source === 'custody'), teamBuy = BUYBACK_RECEIPTS.find(receipt => receipt.source === 'team')
// A ledger with nothing claimed: totals are zero and lists are empty. With a buyback share, it also has one allocation.
const ZERO = { amount: '0', buyback: '0', liquidity: '0', treasury: '0', assigned: '0', n: 0, b: '0', s: '0' }
function ledger({ buybackShare = null, fault = null, connectFault = null } = {}) {
  const statements = []
  const query = async (sql, params = []) => {
    const text = sql.replace(/\s+/g, ' ').trim()
    statements.push(text)
    if (fault) throw fault
    if (buybackShare !== null) {
      if (/^select allocation_group from platform_revenue_allocations order by created_at desc/.test(text)) return { rows: [{ allocation_group: 'group-1' }] }
      if (/^select policy_version from platform_revenue_allocations/.test(text)) return { rows: [{ policy_version: 1 }] }
      if (/sum\(buyback_amount\).* where allocation_group/.test(text)) return { rows: [{ buyback: buybackShare }] }
      if (/^insert into buyback_intents/.test(text)) return { rows: [{ id: 1, idempotencyKey: params[0], amount: params[2], status: 'settled', signature: params[10] }] }
    }
    return { rows: /count\(\*\)|coalesce\(sum/.test(text) && !/group by/.test(text) ? [ZERO] : [] }
  }
  return { statements, query, connect: async () => { if (connectFault) throw connectFault; return { query, release() {} } } }
}
const found = call => Response.json({ jsonrpc: '2.0', id: call.id, result: TXS[call.params[0]] ?? null })

// rpc: how the provider answers a call (default: the fixture transaction, or null for an unknown signature).
// env: settings on top of the operator's (undefined removes one).
async function asOperator(run, { pool = ledger(), rpc: provider = found, env = {} } = {}) {
  const endpoints = globalThis.__repoingRpcEndpoints
  const saved = { env: Object.fromEntries(ENV.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, meter: globalThis.__repoingRpcMeter,
    endpoint: endpoints.get(RPC_URL), warn: console.warn }
  try {
    const settings = { GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'), PLATFORM_OPERATOR_GITHUB_IDS: '123', APP_ORIGIN: 'https://repo.ing',
      DATABASE_URL: 'postgres://test-only', PLATFORM_PARTNER_SECRET_KEY: JSON.stringify([...Keypair.generate().secretKey]),
      PLATFORM_FEE_TREASURY_WALLET: BUYBACK_WALLETS.custody, SOLANA_RPC_URL: undefined, ...env }
    for (const [key, value] of Object.entries(settings)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    globalThis.__gitfunPool = pool
    const rpc = [], warned = []
    // Every RPC call is answered here; nothing reaches a network. The transaction reader asks the endpoint directly.
    const answer = async (_url, init) => {
      const call = JSON.parse(init.body)
      rpc.push([call.method, call.params?.[1]?.maxSupportedTransactionVersion])
      return provider(call)
    }
    globalThis.__repoingRpcMeter = { fetch: answer }
    registerRpcEndpoint(RPC_URL, answer)
    clearFinalizedTransactionCache()
    console.warn = (...line) => warned.push(line)
    const cookie = encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '123', accessToken: 'ghu_test_only',
      sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60000 })
    const request = (body, { signedIn = true } = {}) => ({ url: 'https://repo.ing/api/platform-revenue', headers: new Headers({ origin: 'https://repo.ing' }),
      cookies: { get: () => signedIn ? { value: cookie } : undefined }, json: async () => { if (body instanceof Error) throw body; return body } })
    const post = async (body, options) => { const response = await revenue.POST(request(body, options)); return [response.status, await response.json()] }
    const record = async (signature, review) => post({ action: 'intent.import', signature, review: review ?? (await (await revenue.GET(request())).json()).reviews.import })
    return await run({ request, post, record, pool, rpc, warned })
  } finally {
    for (const [key, value] of Object.entries(saved.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    globalThis.__gitfunPool = saved.pool; globalThis.__repoingRpcMeter = saved.meter; console.warn = saved.warn
    if (saved.endpoint) endpoints.set(RPC_URL, saved.endpoint); else endpoints.delete(RPC_URL)
    clearFinalizedTransactionCache()
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

test('recording a custody buyback reads the chain and stores what went into the swap', () => asOperator(async ({ record, rpc, pool, warned }) => {
  assert.deepEqual(await record(custodyBuy.signature), [200, { result: { id: 1, idempotencyKey: `import.${custodyBuy.signature.slice(0, 56)}`,
    amount: custodyBuy.spentLamports, status: 'settled', signature: custodyBuy.signature } }])
  // One read, in the form that returns every transaction version.
  assert.deepEqual(rpc, [['getTransaction', 1]])
  assert.match(pool.statements.at(-1), /pg_advisory_unlock/)
  assert.deepEqual(warned, [])
}, { pool: ledger({ buybackShare: '9000000000' }) }))

test('a refusal says why, in the service\'s own fixed words', () => asOperator(async ({ record, rpc, warned }) => {
  // Refused before anything is read.
  assert.deepEqual(await record('not-a-signature'), [409, { status: 'failed', error: BUYBACK_IMPORT_REFUSALS.signature }])
  assert.deepEqual(rpc, [])
  // A real buy by the team wallet is not a custody buyback; one the chain does not have is not a finalized success.
  assert.deepEqual(await record(teamBuy.signature), [409, { status: 'failed', error: BUYBACK_IMPORT_REFUSALS.notBuyback }])
  assert.deepEqual(await record('5'.repeat(88)), [409, { status: 'failed', error: BUYBACK_IMPORT_REFUSALS.unfinalized }])
  // Larger than the newest allocation has left for buybacks.
  assert.deepEqual(await record(custodyBuy.signature), [409, { status: 'failed', error: BUYBACK_IMPORT_REFUSALS.reserve }])
  // None of these is a fault.
  assert.deepEqual(warned, [])
}, { pool: ledger({ buybackShare: '1000' }) }))

test('a provider failure is answered in fixed words and logged by kind, never echoed', async () => {
  const failing = (rpc, refusal, code) => asOperator(async ({ record, warned, pool }) => {
    assert.deepEqual(await record(custodyBuy.signature), [409, { status: 'failed', error: refusal }])
    assert.deepEqual(warned, [['platform_revenue_failed', { where: 'intent.import', code }]])
    assert.ok(!pool.statements.some(statement => /pg_advisory_lock/.test(statement)), 'the ledger lock was never taken')
  }, { rpc })
  // An HTTP failure, with the provider's own words in the body.
  await failing(() => new Response('{"note":"the provider says the limit exceeds your plan"}', { status: 503 }), BUYBACK_IMPORT_REFUSALS.unread, 503)
  // A JSON-RPC error on a successful HTTP response.
  await failing(call => Response.json({ jsonrpc: '2.0', id: call.id, error: { code: -32004, message: 'Block not available for slot' } }), BUYBACK_IMPORT_REFUSALS.unread, 'error')
  // A transaction format the reader does not know: trying again would not help, and it says so.
  await failing(call => Response.json({ jsonrpc: '2.0', id: call.id, result: { ...TXS[call.params[0]], version: 2 } }), BUYBACK_IMPORT_REFUSALS.unreadable, 'error')
})

const GENERAL = { status: 'failed', error: 'Refresh this page to review platform revenue and try again.' }

test('whatever is answered in general words is logged by kind, so a route that stopped working cannot go unnoticed', async () => {
  // The database is gone while the summary is read.
  await asOperator(async ({ request, warned }) => {
    const response = await revenue.GET(request())
    assert.deepEqual([response.status, (await response.json()).error], [503, 'Platform revenue is temporarily unavailable. Try refreshing.'])
    assert.deepEqual(warned, [['platform_revenue_failed', { where: 'summary', code: '57P01' }]])
  }, { pool: ledger({ fault: Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' }) }) })
  // A fault in the code itself, the kind that kept this route broken for a week.
  await asOperator(async ({ record, warned }) => {
    assert.deepEqual(await record(custodyBuy.signature), [409, GENERAL])
    assert.deepEqual(warned, [['platform_revenue_failed', { where: 'intent.import', code: 'ReferenceError' }]])
  }, { pool: ledger({ connectFault: new ReferenceError('partnerSigner is not defined') }) })
  // A setting that is missing on the service.
  await asOperator(async ({ post, warned }) => {
    assert.deepEqual(await post({ action: 'intent.simulate', id: 1 }), [409, GENERAL])
    assert.deepEqual(warned, [['platform_revenue_failed', { where: 'intent.simulate', code: 'error' }]])
  }, { env: { PLATFORM_PARTNER_SECRET_KEY: undefined } })
})

test('ordinary refusals are not faults: an old review, an unknown action, a request from another page', () => asOperator(async ({ request, post, record, warned }) => {
  assert.deepEqual(await record(custodyBuy.signature, 'not-a-review'), [409, GENERAL])
  assert.deepEqual(await post({ action: 'intent.remove' }), [409, GENERAL])
  // A name every object has is not an action.
  assert.deepEqual(await post({ action: 'constructor' }), [409, GENERAL])
  assert.deepEqual(await post(null), [409, GENERAL])
  const elsewhere = { ...request({ action: 'allocate' }), headers: new Headers({ origin: 'https://example.com' }) }
  assert.equal((await revenue.POST(elsewhere)).status, 409)
  assert.deepEqual(warned, [])
}))

test('an anonymous request is refused before its body is read, and logs nothing', () => asOperator(async ({ post, warned }) => {
  assert.deepEqual(await post(new SyntaxError('Unexpected token'), { signedIn: false }), [401, { error: 'Sign in with your operator GitHub account.' }])
  assert.deepEqual(await post({ action: 'intent.import', signature: custodyBuy.signature }, { signedIn: false }), [401, { error: 'Sign in with your operator GitHub account.' }])
  assert.deepEqual(warned, [])
}))
