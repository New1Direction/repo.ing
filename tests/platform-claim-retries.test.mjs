import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Keypair } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createDbcPlatformFees } from '../src/platform-dbc-fees.mjs'
import { createPlatformFees } from '../src/platform-fees.mjs'
import { retryRpcRead } from '../src/rpc-usage.mjs'

// The real claim services with stubbed chain and database: the reads a claim makes before it signs go through the
// caller's `retryRead` (the sweep retries transient RPC errors there); the operator panel passes none.
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const rateLimited = () => Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"}}')
const forbidden = (name, calls) => async () => { calls.push(name); throw Error(`${name} must not run`) }

function retrying() {
  const reasons = []
  const retryRead = read => retryRpcRead(read, { random: () => 0.5, sleep: async () => {}, onRetry: info => reasons.push(info.reason) })
  return { reasons, retryRead }
}

// Queries answer by SQL text; advisory locks always succeed.
function fakePool(answer) {
  const queries = []
  const client = { release: () => {}, query: async sql => { queries.push(sql); return { rows: answer(sql) ?? [] } } }
  return { queries, connect: async () => client }
}

test('only reads before signing may retry: in both claim services every retryRead call precedes the signing step', () => {
  for (const file of ['src/platform-dbc-fees.mjs', 'src/platform-fees.mjs']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    const signing = source.indexOf('signedWithPriorityFee(connection')
    assert.ok(signing > 0, `${file}: signing step not found`)
    assert.ok(source.lastIndexOf('retryRead(') < signing, `${file}: retryRead used after signing`)
  }
})

test('DBC claim: a rate-limited read before signing is retried, a non-transient error is not, and the claim stops unsigned', async () => {
  const signing = []
  let genesisReads = 0
  const connection = { rpcEndpoint: 'https://rpc.test',
    getGenesisHash: async () => { if (genesisReads++ === 0) throw rateLimited(); return MAINNET_GENESIS },
    getLatestBlockhash: forbidden('getLatestBlockhash', signing), sendRawTransaction: forbidden('sendRawTransaction', signing) }
  const verification = { rpcEndpoint: 'https://verify.test', getGenesisHash: async () => MAINNET_GENESIS }
  // No finalized market row, so the claim's own market check fails with a non-transient error.
  const pool = fakePool(() => [])
  const service = createDbcPlatformFees({ pool, connection, verification, config: Keypair.generate().publicKey.toBase58(),
    partner: Keypair.generate(), env: { PLATFORM_DBC_COLLECTION_ENABLED: 'true' } })
  const review = { purpose: 'platform-fee-review', phase: 'DBC', repoId: '7', amount: '5000000', expiresAt: Date.now() + 60_000 }
  const { reasons, retryRead } = retrying()
  await assert.rejects(service.claim({ review, retryRead }), /^Error: Market is not finalized and indexed$/)
  assert.deepEqual(reasons, ['HTTP 429'])
  assert.equal(genesisReads, 2)
  assert.equal(pool.queries.filter(sql => /from markets/.test(sql)).length, 1, 'the market check is not retried')
  assert.deepEqual(signing, [])

  genesisReads = 0
  await assert.rejects(service.claim({ review }), /^Error: 429 Too Many Requests/, 'without retryRead the 429 fails at once')
  assert.equal(genesisReads, 1)
})

test('DAMM claim: the graduated-position read is retried while limited, then the claim stops unsigned', async () => {
  const signing = [], partner = Keypair.generate()
  const config = Keypair.generate().publicKey, mint = Keypair.generate().publicKey
  const market = { githubRepoId: '7', mint: mint.toBase58(), pool: deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58(),
    creatorWallet: Keypair.generate().publicKey.toBase58() }
  const connection = { rpcEndpoint: 'https://rpc.test', getAccountInfoAndContext: async () => { throw rateLimited() },
    getLatestBlockhash: forbidden('getLatestBlockhash', signing), sendRawTransaction: forbidden('sendRawTransaction', signing) }
  const pool = fakePool(sql => (/from markets/.test(sql) ? [market] : /platform_fee_events/.test(sql) ? [{ earned: '5000000' }] : []))
  const service = createPlatformFees({ pool, connection, config: config.toBase58(), partner })
  const review = { purpose: 'platform-fee-review', phase: 'DAMM', repoId: '7', amount: '5000000',
    receiver: partner.publicKey.toBase58(), expiresAt: Date.now() + 60_000 }
  const { reasons, retryRead } = retrying()
  await assert.rejects(service.claim({ review, retryRead }), /^Error: 429 Too Many Requests/)
  assert.deepEqual(reasons, ['HTTP 429', 'HTTP 429', 'HTTP 429'], 'four tries in all')
  assert.equal(pool.queries.filter(sql => /status='pending'/.test(sql)).length, 1, 'only the chain read is retried')
  assert.deepEqual(signing, [])

  await assert.rejects(service.claim({ review }), /^Error: 429 Too Many Requests/, 'without retryRead the 429 fails at once')
  assert.equal(reasons.length, 3)
})
