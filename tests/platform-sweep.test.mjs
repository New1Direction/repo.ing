import test from 'node:test'
import assert from 'node:assert/strict'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { BUYBACK_WALLETS } from '../app/lib/buyback-receipts.mjs'
import { CUSTODY_WALLET, DUST_LAMPORTS, KEEP_LAMPORTS, PARTNER_WALLET, SWEEP_PACE_MS, claimOne, claimPlan, runPlatformSweep,
  sol, sweepHeadline, transferSurplus } from '../src/platform-sweep.mjs'
import { allocationReview, listPlatformFees, platformFeeReview } from '../src/platform-fee-operations.mjs'

const partner = { publicKey: new PublicKey(PARTNER_WALLET) }
const blockhash = Keypair.generate().publicKey.toBase58()
const forbidden = name => () => { throw Error(`${name} must not run`) }

function chainFake({ balance = 1_000_000_000, fee = 5000, send = forbidden('sendRawTransaction'), err = null } = {}) {
  const calls = { sent: [] }
  return { calls, getBalance: async () => balance, getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 100 }),
    getFeeForMessage: async () => ({ value: fee }),
    sendRawTransaction: async raw => { calls.sent.push(raw); return send(raw) },
    confirmTransaction: async () => ({ value: { err } }) }
}

function summaryFake(states) {
  let i = 0
  return async () => states[Math.min(i++, states.length - 1)]
}
const summaryState = (over = {}) => ({ available: '0', buybackReserve: '600000000', buybackAhead: '0',
  allocated: { buyback: '0', liquidity: '0', treasury: '0' },
  activePolicy: { version: 1, buybackPermille: 600, liquidityPermille: 200 }, ...over })

function feeFake(sequence, claims) {
  const reads = [], claimed = []
  const service = { status: async () => { reads.push(1); return sequence[Math.min(reads.length - 1, sequence.length - 1)] },
    claim: async ({ review }) => { claimed.push(review); const next = claims[claimed.length - 1]; if (next instanceof Error) throw next; return next(review) } }
  return { reads, claimed, feeService: () => service }
}

const rows = [
  { repoId: '1', fullName: 'a/one', dbc: { enrolled: true, available: '5000000', receiver: PARTNER_WALLET }, damm: { enrolled: true, available: '3000000' } },
  { repoId: '2', fullName: 'b/two', dbc: { enrolled: true, available: String(DUST_LAMPORTS - 1n) }, damm: { enrolled: false, available: '0' } },
  { repoId: '3', fullName: 'c/three', dbc: { enrolled: true, error: 'RPC disagreement', available: null }, damm: { enrolled: true, available: '0' } },
]

test('claim plan skips dust, disabled DBC collection and zero balances; unreadable rows are reported', () => {
  const plan = claimPlan(rows, { dbcEnabled: false })
  assert.deepEqual(plan.map(p => [p.repoId, p.phase, p.status]), [
    ['1', 'DBC', 'skipped-disabled'], ['1', 'DAMM', 'planned'], ['2', 'DBC', 'skipped-dust'], ['3', 'DBC', 'unreadable']])
  assert.equal(claimPlan(rows, { dbcEnabled: true })[0].status, 'planned')
})

test('claim builds the review from a fresh read and retries once on a stale amount', async () => {
  const fake = feeFake([{ enrolled: true, available: '3000000' }, { enrolled: true, available: '3100000' }],
    [Error('Reviewed amount differs from indexed fees; refresh and review again'), review => ({ signature: 'sig', amount: review.amount })])
  const result = await claimOne({ repoId: '1', phase: 'DAMM', available: '3000000' }, { feeService: fake.feeService, partner })
  assert.equal(fake.reads.length, 2)
  assert.deepEqual(fake.claimed.map(r => r.amount), ['3000000', '3100000'])
  assert.equal(fake.claimed[1].receiver, PARTNER_WALLET)
  assert.equal(fake.claimed[1].purpose, 'platform-fee-review')
  assert.deepEqual({ status: result.status, amount: result.amount, attempts: result.attempts }, { status: 'claimed', amount: '3100000', attempts: 2 })
})

test('claim failures surface: a non-stale error is not retried, a second stale error stops', async () => {
  const hard = feeFake([{ enrolled: true, available: '3000000' }], [Error('Platform fee preflight failed')])
  await assert.rejects(claimOne({ repoId: '1', phase: 'DAMM' }, { feeService: hard.feeService, partner }), /preflight failed/)
  assert.equal(hard.claimed.length, 1)
  const stale = Error('Platform claim terms changed; refresh and review again')
  const twice = feeFake([{ enrolled: true, available: '3000000', termsHash: 'h' }], [stale, stale])
  await assert.rejects(claimOne({ repoId: '1', phase: 'DBC' }, { feeService: twice.feeService, partner }), /refresh and review again/)
  assert.equal(twice.claimed.length, 2)
  assert.equal(twice.claimed[0].maxNetworkFeeLamports, '810000')
})

test('claim re-read below dust is skipped without claiming', async () => {
  const fake = feeFake([{ enrolled: true, available: '10' }], [])
  const result = await claimOne({ repoId: '1', phase: 'DAMM' }, { feeService: fake.feeService, partner })
  assert.equal(result.status, 'skipped-dust')
  assert.equal(fake.claimed.length, 0)
})

test('transfer guards refuse a wrong signer or destination', async () => {
  const connection = chainFake()
  await assert.rejects(transferSurplus({ connection, signer: Keypair.generate(), execute: true }), /signer is not the partner wallet/)
  await assert.rejects(transferSurplus({ connection, signer: partner, destination: Keypair.generate().publicKey.toBase58(), execute: true }),
    /destination is not the custody wallet/)
  assert.equal(CUSTODY_WALLET, BUYBACK_WALLETS.custody)
  assert.equal(connection.calls.sent.length, 0)
})

test('transfer keeps 0.05 SOL plus fee and skips below 0.01 SOL', async () => {
  const planned = await transferSurplus({ connection: chainFake({ balance: 1_000_000_000 }), signer: partner, execute: false })
  assert.equal(planned.status, 'planned')
  assert.equal(planned.amount, sol(1_000_000_000n - KEEP_LAMPORTS - 5000n))
  const small = await transferSurplus({ connection: chainFake({ balance: 59_000_000 }), signer: partner, execute: true })
  assert.equal(small.status, 'skipped-below-minimum')
})

test('transfer execute sends exactly the surplus to custody and confirms', async t => {
  t.mock.method(Transaction.prototype, 'sign', function () {})
  let sent
  t.mock.method(Transaction.prototype, 'serialize', function () { sent = this; return Buffer.from('signed') })
  const connection = chainFake({ balance: 2_000_000_000, send: async () => 'transfer-sig' })
  const result = await transferSurplus({ connection, signer: partner, execute: true })
  assert.equal(result.signature, 'transfer-sig')
  const [ix] = sent.instructions
  assert.equal(ix.keys[0].pubkey.toBase58(), PARTNER_WALLET)
  assert.equal(ix.keys[1].pubkey.toBase58(), CUSTODY_WALLET)
  assert.equal(ix.data.readBigUInt64LE(4), 2_000_000_000n - KEEP_LAMPORTS - 5000n)
  const failed = chainFake({ balance: 2_000_000_000, send: async () => 'bad', err: { InstructionError: [0, 'x'] } })
  await assert.rejects(transferSurplus({ connection: failed, signer: partner, execute: true }), /Transfer bad failed/)
})

test('dry run performs no claims, allocations or sends and reports the buyback reserve', async () => {
  const report = await runPlatformSweep({ execute: false, dbcEnabled: true, listFees: async () => rows,
    feeService: () => ({ status: forbidden('status'), claim: forbidden('claim') }),
    summary: summaryFake([summaryState({ available: '2000000' })]), allocate: forbidden('allocate'),
    connection: chainFake(), signer: partner, balanceOf: async () => 123_000_000 })
  assert.equal(report.ok, true, report.error)
  assert.equal(report.claimedTotal, sol(8_000_000n))
  assert.equal(report.allocation.status, 'planned')
  assert.deepEqual(report.allocation.split, { buyback: sol(6_000_000n), liquidity: sol(2_000_000n), treasury: sol(2_000_000n) })
  // Only this run's planned buyback split may move; 0.006 SOL is below the transfer minimum.
  assert.equal(report.transfer.status, 'skipped-below-minimum')
  assert.equal(report.transfer.amount, sol(6_000_000n))
  assert.deepEqual(report.buyback, { reserve: '0.600000000', ahead: '0.000000000', custodyWallet: CUSTODY_WALLET, custodyBalance: '0.123000000' })
  assert.match(sweepHeadline(report), /BUY BACK: 0\.600000000 SOL of \$REPOING from FgzeY/)
})

test('execute claims, allocates only unallocated revenue, transfers, and reports X = buybackReserve', async t => {
  t.mock.method(Transaction.prototype, 'sign', function () {})
  t.mock.method(Transaction.prototype, 'serialize', function () { return Buffer.from('signed') })
  const fake = feeFake([{ enrolled: true, available: '3000000' }], [review => ({ signature: 'claim-sig', amount: review.amount })])
  const allocations = []
  const report = await runPlatformSweep({ execute: true, dbcEnabled: false, listFees: async () => rows, feeService: fake.feeService,
    summary: summaryFake([summaryState({ available: '3000000' }),
      summaryState({ allocated: { buyback: '1800000000', liquidity: '600000', treasury: '600000' }, buybackReserve: '300000000' })]),
    allocate: async args => { allocations.push(args); return { group: 'g', policyVersion: 1, claims: 1, claimedAmount: '3000000' } },
    connection: chainFake({ send: async () => 'transfer-sig' }), signer: partner, balanceOf: async () => 0 })
  assert.equal(report.ok, true, report.error)
  assert.equal(fake.claimed.length, 1)
  assert.equal(allocations.length, 1)
  assert.equal(allocations[0].createdBy, 'platform-sweep')
  assert.equal(allocations[0].review.purpose, 'platform-revenue-allocate')
  assert.equal(allocations[0].review.policyVersion, 1)
  assert.deepEqual(report.allocation.split, { buyback: '1.800000000', liquidity: '0.000600000', treasury: '0.000600000' })
  assert.equal(report.transfer.signature, 'transfer-sig')
  assert.equal(report.transfer.amount, sol(300_000_000n))
  assert.equal(report.buyback.reserve, '0.300000000')

  const idle = await runPlatformSweep({ execute: true, dbcEnabled: false, listFees: async () => [], feeService: fake.feeService,
    summary: summaryFake([summaryState()]), allocate: forbidden('allocate'),
    connection: chainFake({ balance: 50_000_000 }), signer: partner, balanceOf: async () => 0 })
  assert.equal(idle.ok, true, idle.error)
  assert.equal(idle.allocation.status, 'nothing-to-allocate')
  assert.equal(idle.transfer.status, 'skipped-below-minimum')
})

test('a failed claim is skipped and reported while the rest runs; a wrong signer stops before claiming', async () => {
  const fake = feeFake([{ enrolled: true, available: '3000000' }], [Error('Signature X has expired: block height exceeded.')])
  const report = await runPlatformSweep({ execute: true, dbcEnabled: false, listFees: async () => rows, feeService: fake.feeService,
    summary: summaryFake([summaryState()]), allocate: forbidden('allocate'), connection: chainFake({ send: forbidden('send') }), signer: partner, balanceOf: async () => 0 })
  assert.equal(report.ok, true, report.error)
  assert.equal(report.claimErrors, 1)
  assert.equal(report.claims.find(c => c.status === 'failed').repoId, '1')
  assert.equal(report.allocation.status, 'nothing-to-allocate')
  assert.equal(report.transfer.status, 'skipped-below-minimum')
  assert.match(sweepHeadline(report), /SKIPPED DAMM .*expired/)
  assert.equal(report.buyback.reserve, '0.600000000')

  const wrong = await runPlatformSweep({ execute: true, dbcEnabled: true, listFees: forbidden('listFees'), feeService: fake.feeService,
    summary: summaryFake([summaryState()]), allocate: forbidden('allocate'), connection: chainFake(), signer: Keypair.generate(), balanceOf: async () => 0 })
  assert.equal(wrong.ok, false)
  assert.match(wrong.error, /signer is not the partner wallet/)
})

test('shared listing keeps the panel rows: enrolment, errors, reviews only for positive balances, largest first', async () => {
  let released = false
  const pool = { connect: async () => ({ release: () => { released = true }, query: async () => ({ rows: [
    { repoId: '1', mint: 'm1', fullName: 'a/one', graduated: false },
    { repoId: '2', mint: 'm2', fullName: 'b/two', graduated: true }] }) }) }
  const status = { DBC: { 1: { enrolled: true, available: '5', receiver: 'R', state: 'available' }, 2: { enrolled: false } },
    DAMM: { 2: new Error('boom') } }
  const feeService = phase => ({ status: async id => { const v = status[phase][id]; if (v instanceof Error) throw v; return v } })
  const repos = await listPlatformFees({ pool, feeService, review: (id, phase) => `${phase}:${id}` })
  assert.equal(released, true)
  assert.deepEqual(repos, [
    { repoId: '1', mint: 'm1', fullName: 'a/one', dbc: { enrolled: true, available: '5', receiver: 'R', state: 'available', latest: null, review: 'DBC:1' },
      damm: { enrolled: false, available: '0', review: null } },
    { repoId: '2', mint: 'm2', fullName: 'b/two', dbc: { enrolled: false, available: '0', review: null },
      damm: { enrolled: true, error: 'boom', available: null, review: null } }])
})

test('shared reviews keep the operator panel shape', () => {
  const partnerKey = new PublicKey(PARTNER_WALLET)
  assert.deepEqual(platformFeeReview({ sessionId: 's', repoId: 7, phase: 'DBC', data: { available: '9', receiver: 'R', termsHash: 'h' }, partner: partnerKey, now: 1000 }),
    { purpose: 'platform-fee-review', sessionId: 's', repoId: '7', phase: 'DBC', amount: '9', receiver: 'R', termsHash: 'h', maxNetworkFeeLamports: '810000', expiresAt: 601000 })
  assert.deepEqual(platformFeeReview({ sessionId: 's', repoId: '7', phase: 'DAMM', data: { available: '9' }, partner: partnerKey, now: 1000 }),
    { purpose: 'platform-fee-review', sessionId: 's', repoId: '7', phase: 'DAMM', amount: '9', receiver: PARTNER_WALLET, expiresAt: 601000 })
  assert.deepEqual(allocationReview({ sessionId: 's', policyVersion: 2, now: 1000 }),
    { purpose: 'platform-revenue-allocate', sessionId: 's', policyVersion: 2, expiresAt: 601000 })
})

test('transfer is capped at the buyback share owed so liquidity and treasury stay in the partner wallet', async () => {
  const capped = await transferSurplus({ connection: chainFake({ balance: 1_000_000_000 }), signer: partner, execute: false, capLamports: 250_000_000n })
  assert.equal(capped.amount, sol(250_000_000n))
  const nothingOwed = await transferSurplus({ connection: chainFake({ balance: 1_000_000_000 }), signer: partner, execute: false, capLamports: 0n })
  assert.equal(nothingOwed.status, 'skipped-below-minimum')
  const surplusSmaller = await transferSurplus({ connection: chainFake({ balance: 100_000_000 }), signer: partner, execute: false, capLamports: 900_000_000n })
  assert.equal(surplusSmaller.amount, sol(100_000_000n - KEEP_LAMPORTS - 5000n))
})

test('a re-run never re-sends buyback SOL already moved to custody but not yet spent', async () => {
  // 0.543 SOL is still owed (already sent, not yet bought) and this run claims nothing new.
  const report = await runPlatformSweep({ execute: true, dbcEnabled: false, listFees: async () => [], feeService: () => ({}),
    summary: summaryFake([summaryState({ buybackReserve: '543271422' })]), allocate: forbidden('allocate'),
    connection: chainFake({ balance: 1_000_000_000, send: forbidden('send') }), signer: partner, balanceOf: async () => 0 })
  assert.equal(report.ok, true, report.error)
  assert.equal(report.transfer.status, 'skipped-below-minimum')
  assert.equal(report.buyback.reserve, '0.543271422')
})

// RPC rate limits: status reads go through a real web3.js Connection whose HTTP transport is scripted per market
// account (429, a JSON-RPC error, or the account), so errors reach the sweep exactly as web3.js shapes them.
const rateLimited = () => Error('429 Too Many Requests: {"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"}}')
const listedPool = repos => ({ connect: async () => ({ release: () => {}, query: async () => ({
  rows: repos.map(([repoId, fullName]) => ({ repoId, mint: `m${repoId}`, fullName, graduated: false })) }) }) })

function scriptedStatus(markets) {
  const reads = {}, accounts = {}, scripts = {}
  for (const [repoId, { script }] of Object.entries(markets)) {
    accounts[repoId] = Keypair.generate().publicKey
    scripts[accounts[repoId].toBase58()] = [...script]
  }
  const connection = new Connection('http://rpc.test', { commitment: 'confirmed', disableRetryOnRateLimit: true,
    fetch: async (url, init) => {
      const { id, params: [address] } = JSON.parse(init.body)
      const step = scripts[address].shift() ?? 'account'
      if (step === 429) return new Response('{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests"}}',
        { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '1' } })
      if (step === 'invalid') return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Invalid param: WrongSize' } }))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { context: { slot: 1 }, value: null } }))
    } })
  const feeService = () => ({ claim: forbidden('claim'), status: async repoId => {
    reads[repoId] = (reads[repoId] ?? 0) + 1
    await connection.getAccountInfo(accounts[repoId], 'finalized')
    return markets[repoId].data
  } })
  return { feeService, reads }
}

test('dry run reads one market at a time, retries a 429, and leaves a market unreadable only after its retries', async () => {
  const { feeService, reads } = scriptedStatus({
    1: { script: [429, 'account'], data: { enrolled: true, available: '5000000', receiver: PARTNER_WALLET, state: 'available' } },
    2: { script: [429, 429, 429, 429], data: null },
    3: { script: ['invalid'], data: null } })
  const slept = [], lines = []
  const report = await runPlatformSweep({ execute: false, dbcEnabled: true, feeService,
    listFees: options => listPlatformFees({ pool: listedPool([['1', 'a/one'], ['2', 'b/two'], ['3', 'c/three']]), feeService, ...options }),
    summary: summaryFake([summaryState()]), allocate: forbidden('allocate'), connection: chainFake(), signer: partner,
    balanceOf: async () => 0, sleep: async ms => { slept.push(ms) }, retry: { random: () => 0.5 }, log: line => lines.push(line) })
  assert.equal(report.ok, true, report.error)
  assert.deepEqual(reads, { 1: 2, 2: 4, 3: 1 }, 'four tries for a persistent 429; a non-transient error is not retried')
  assert.equal(SWEEP_PACE_MS, 250)
  assert.deepEqual(slept, [1500, 250, 1500, 3000, 6000, 250], 'backoff before each retry, and a pause between markets')
  const byRepo = Object.fromEntries(report.claims.map(c => [c.repoId, c]))
  assert.deepEqual([byRepo[1].status, byRepo[1].retries], ['planned', 1])
  assert.deepEqual([byRepo[2].status, byRepo[2].retries], ['unreadable', 3])
  assert.match(byRepo[2].error, /429 Too Many Requests/)
  assert.equal(byRepo[3].status, 'unreadable')
  assert.equal('retries' in byRepo[3], false)
  assert.match(byRepo[3].error, /Invalid param/)
  assert.equal(report.rpcRetries, 4)
  assert.match(sweepHeadline(report), /2 repo\/phase\(s\) unreadable after 3 retries, see claims; 4 RPC retries/)
  assert.equal(lines[0], 'retry 1 of 3: DBC a/one in 1.5s after HTTP 429')
})

test('the panel listing keeps its defaults: four markets at a time, no pause, no retries', async () => {
  let inFlight = 0, most = 0, reads = 0
  const feeService = () => ({ status: async () => {
    reads++
    most = Math.max(most, ++inFlight)
    await new Promise(resolve => setImmediate(resolve))
    inFlight--
    throw rateLimited()
  } })
  const slept = []
  const rows = await listPlatformFees({ pool: listedPool(['1', '2', '3', '4', '5', '6'].map(id => [id, `r/${id}`])), feeService,
    sleep: async ms => { slept.push(ms) } })
  assert.deepEqual([most, reads, slept], [4, 6, []], 'four at a time, one read each, no pause')
  assert.deepEqual(Object.keys(rows[0].dbc), ['enrolled', 'error', 'available', 'review'])
})

test('a provider that stays limited pauses retries after three markets in a row, until a read succeeds again', async () => {
  const limited = [429, 429, 429, 429]
  const { feeService, reads } = scriptedStatus({
    1: { script: limited, data: null }, 2: { script: limited, data: null }, 3: { script: limited, data: null },
    4: { script: limited, data: null },
    5: { script: ['account'], data: { enrolled: true, available: '0', receiver: PARTNER_WALLET } },
    6: { script: [429, 'account'], data: { enrolled: true, available: '5000000', receiver: PARTNER_WALLET } } })
  const lines = []
  const report = await runPlatformSweep({ execute: false, dbcEnabled: true, feeService,
    listFees: options => listPlatformFees({ pool: listedPool(['1', '2', '3', '4', '5', '6'].map(id => [id, `r/${id}`])), feeService, ...options }),
    summary: summaryFake([summaryState()]), allocate: forbidden('allocate'), connection: chainFake(), signer: partner,
    balanceOf: async () => 0, sleep: async () => {}, log: line => lines.push(line) })
  assert.equal(report.ok, true, report.error)
  assert.deepEqual(reads, { 1: 4, 2: 4, 3: 4, 4: 1, 5: 1, 6: 2 })
  assert.equal(lines.filter(line => line.startsWith('retries paused: 3 reads in a row stayed limited')).length, 1)
  const byRepo = Object.fromEntries(report.claims.map(c => [c.repoId, c]))
  assert.deepEqual(['1', '2', '3', '4'].map(id => [byRepo[id].status, byRepo[id].retries]),
    [['unreadable', 3], ['unreadable', 3], ['unreadable', 3], ['unreadable', undefined]])
  assert.deepEqual([byRepo[6].status, byRepo[6].retries], ['planned', 1], 'retries resume after a success')
  assert.equal(report.rpcRetries, 10)
  assert.match(sweepHeadline(report), /4 repo\/phase\(s\) unreadable after 9 retries, see claims; 10 RPC retries/)
})

test('claim: a 429 on the fresh read or on a read before signing is retried; nothing is retried once signing starts', async () => {
  const slept = [], retry = { random: () => 0.5, sleep: async ms => { slept.push(ms) } }
  let reads = 0, prepared = 0
  const service = {
    status: async () => { if (reads++ === 0) throw rateLimited(); return { enrolled: true, available: '3000000' } },
    claim: async ({ review, retryRead }) => {
      await retryRead(async () => { if (prepared++ === 0) throw rateLimited(); return 'blockhash' })
      return { signature: 'sig', amount: review.amount }
    } }
  const item = { repoId: '1', fullName: 'a/one', phase: 'DAMM', available: '3000000', retries: 2 }
  const result = await claimOne(item, { feeService: () => service, partner, retry })
  assert.deepEqual({ status: result.status, retries: result.retries, attempts: result.attempts }, { status: 'claimed', retries: 4, attempts: 1 })
  assert.deepEqual([reads, prepared, slept], [2, 2, [1500, 1500]])

  // Once the claim has signed, a failure (here: a rate-limited broadcast) fails exactly as before.
  let claims = 0
  const signed = { status: async () => ({ enrolled: true, available: '3000000' }),
    claim: async ({ retryRead }) => { claims++; await retryRead(async () => 'blockhash'); throw rateLimited() } }
  await assert.rejects(claimOne({ repoId: '1', phase: 'DAMM' }, { feeService: () => signed, partner, retry }),
    error => /^Claim DAMM repo 1 failed: 429 Too Many Requests/.test(error.message) && error.claim.attempts === 1 && !('retries' in error.claim))
  assert.equal(claims, 1)
})

test('execute: an unreadable market is never claimed, claims are paced, and a claim that stays limited reports its retries', async () => {
  const slept = [], claimed = []
  const status = { 1: () => ({ enrolled: true, available: '5000000' }), 4: () => { throw rateLimited() } }
  const feeService = () => ({ status: async repoId => status[repoId](),
    claim: async ({ review }) => { claimed.push(review.repoId); return { signature: `sig-${review.repoId}`, amount: review.amount } } })
  const listed = [
    { repoId: '1', fullName: 'a/one', dbc: { enrolled: true, available: '5000000', receiver: PARTNER_WALLET, retries: 1 }, damm: { enrolled: false, available: '0' } },
    { repoId: '2', fullName: 'b/two', dbc: { enrolled: true, error: rateLimited().message, available: null, retries: 3 }, damm: { enrolled: false, available: '0' } },
    { repoId: '4', fullName: 'd/four', dbc: { enrolled: true, available: '4000000', receiver: PARTNER_WALLET }, damm: { enrolled: false, available: '0' } }]
  const report = await runPlatformSweep({ execute: true, dbcEnabled: true, listFees: async () => listed, feeService,
    summary: summaryFake([summaryState()]), allocate: forbidden('allocate'), connection: chainFake({ send: forbidden('send') }),
    signer: partner, balanceOf: async () => 0, sleep: async ms => { slept.push(ms) }, retry: { random: () => 0.5 } })
  assert.equal(report.ok, true, report.error)
  assert.deepEqual(claimed, ['1'])
  assert.deepEqual(slept, [250, 1500, 3000, 6000], 'a pause before the second claim, then its read backs off')
  const byRepo = Object.fromEntries(report.claims.map(c => [c.repoId, c]))
  assert.deepEqual([byRepo[1].status, byRepo[1].retries], ['claimed', 1])
  assert.deepEqual([byRepo[2].status, byRepo[2].retries], ['unreadable', 3])
  assert.deepEqual([byRepo[4].status, byRepo[4].retries], ['failed', 3])
  assert.match(byRepo[4].error, /^429 Too Many Requests/)
  assert.equal(report.claimErrors, 1)
  assert.equal(report.rpcRetries, 3)
  assert.match(sweepHeadline(report), /SKIPPED DBC d\/four: 429 Too Many Requests/)
})
