import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import pg from 'pg'
import bs58 from 'bs58'
import { PublicKey, Transaction, ComputeBudgetProgram, SystemProgram } from '@solana/web3.js'
import { createTestRun, TEST_PLAN } from '../src/existing-market-test-run.mjs'
import { recordTestDammCheckpoint } from '../src/existing-market-test-accounting.mjs'

// A disposable local database only. The tests never connect through application credentials.
const url = process.env.TEST_GUARD_DATABASE_URL
const options = { skip: !url }
const wallet = 'DrAhCGXsHLNdJ9ihhRBkyKZSzY446qKg1Dcx6zEm9dmi'
function prepared(step, amount = '1000000') {
  const tx = new Transaction({ feePayer: new PublicKey(wallet), recentBlockhash: SystemProgram.programId.toBase58() })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2000000 }),
      SystemProgram.transfer({ fromPubkey: new PublicKey(wallet), toPubkey: SystemProgram.programId, lamports: 1 }))
  // Synthetic unsigned record tests persistence/budgets, not the canonical swap decoder.
  return { v: 1, wallet, marketId: '1', githubRepoId: step.githubRepoId, direction: step.direction, phase: step.phase,
    mint: step.mint, pool: step.pool, curve: step.curve, tokenAVault: SystemProgram.programId.toBase58(), tokenBVault: wallet,
    amountIn: amount, minimumAmountOut: '1', referral: null, wsolRent: null, slippageBps: 100,
    transaction: tx.serialize({ requireAllSignatures: false }).toString('base64'), message: tx.serializeMessage().toString('base64'),
    blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 123 }
}
const costs = direction => ({ networkFee: '805000', priorityFee: '800000', accountDeposits: direction === 'buy' ? '1488440' : '0',
  refundableDeposit: '1488440', shortfall: '0' })
const request = (step, amount = '1000000') => ({ wallet, githubRepoId: step.githubRepoId, direction: step.direction, amountBaseUnits: amount, slippageBps: 100 })
function checkpoint(step, slot, creatorEarned, partnerEarned) {
  const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
  const role = (n, earned, claimed) => {
    const evidence = { migration: bs58.encode(Buffer.alloc(64, 9)), accounts: [step.pool, key(n), key(n + 10)]
      .map(address => ({ address, owner: key(8), data: Buffer.from(`bank-${slot}-${address}`).toString('base64') })) }
    return { position: key(n), earned: String(earned), claimed: String(claimed), available: String(earned - claimed), evidence,
      hash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') }
  }
  return { githubRepoId: step.githubRepoId, pool: step.pool, slot: String(slot), creator: role(2, creatorEarned, 10n), partner: role(3, partnerEarned, 3n) }
}

test('durable one-use sequence: concurrent consumption, restart, exact sell, no replay or seventh attempt', options, async () => {
  assert.match(url, /^postgres:\/\/[^@]+@127\.0\.0\.1:55439\/guardtest$/)
  const db = new pg.Pool({ connectionString: url })
  const runtimeDb = new pg.Pool({ connectionString: url, options: '-c role=repoing_existing_market_trader' })
  try {
    await db.query('drop table if exists existing_market_test_runs')
    await db.query("do $$ begin create role repoing_existing_market_trader; exception when duplicate_object then null; end $$")
    await db.query(readFileSync(new URL('../scripts/existing-market-test-run.sql', import.meta.url), 'utf8'))
    await db.query('drop table if exists existing_market_test_damm_checkpoints, existing_market_test_damm_baselines; create table if not exists graduated_migration_proofs (github_repo_id bigint)')
    await db.query(readFileSync(new URL('../scripts/existing-market-test-accounting.sql', import.meta.url), 'utf8'))
    let at = 1000
    let run = createTestRun({ db: runtimeDb, now: () => at })
    await assert.rejects(run.request(request(TEST_PLAN.steps[0])), /disabled/)
    await db.query('update existing_market_test_runs set enabled=true') // disposable operator approval
    for (let index = 0; index < 6; index++) {
      const step = TEST_PLAN.steps[index], amount = step.direction === 'buy' ? '1000000' : '37'
      await assert.rejects(run.request({ ...request(step, amount), wallet: SystemProgram.programId.toBase58() }), /plan/)
      await assert.rejects(run.request({ ...request(step, amount), wallet: 'DkD5CeqH6uR5ChaaHAWusGWvfjMq5xLzsJGYoiT1J9g9' }), /plan/)
      await assert.rejects(run.request({ ...request(step, amount), slippageBps: 101 }), /plan/)
      await assert.rejects(run.request({ ...request(step, amount), referrer: wallet }), /plan/)
      if (step.direction === 'sell') await assert.rejects(run.request(request(step, '36')), /plan/)
      const input = request(step, amount)
      const check = await run.request(input)
      assert.equal(check.step, index)
      const buy = step.direction === 'buy'
      const before = step.phase === 'graduated' ? checkpoint(step, buy ? 90 : 103, buy ? 100000n : 100018n, buy ? 70000n : 70009n) : null
      const after = step.phase === 'graduated' ? checkpoint(step, buy ? 101 : 104, buy ? 100013n : 100029n, buy ? 70007n : 70012n) : null
      const reservations = await Promise.all([0, 1].map(() => run.reserve(input, { record: prepared(step, amount), costs: costs(step.direction), before })))
      assert.equal(reservations[0].pending.id, reservations[1].pending.id)
      const pending = reservations[0].pending
      const signature = bs58.encode(Buffer.alloc(64, index + 1))
      // The adapter cryptographically verifies first; the durable guard consumes verified evidence only.
      const outcomes = await Promise.all([0, 1].map(() => run.claimVerifiedSignature(pending.id, { signature, signedMessage: pending.record.message })))
      assert.equal(outcomes.filter(x => x.send).length, 1)
      await assert.rejects(run.claimVerifiedSignature(pending.id, { signature: 'replacement', signedMessage: pending.record.message }), /signature/)
      await assert.rejects(run.request(input), /pending/)
      at += 600001 // regular trade_sessions would now have expired
      run = createTestRun({ db: runtimeDb, now: () => at })
      assert.equal((await run.load(pending.id)).pending.signature, signature)
      await assert.rejects(run.settle(pending.id, { signature, slot: 100, tokenDelta: step.direction === 'buy' ? '37' : '-37' }, async client => {
        if (after) await recordTestDammCheckpoint(client, { runId: TEST_PLAN.id, step: index + 1, githubRepoId: step.githubRepoId, signature, before, after })
        throw Error('accounting unavailable')
      }), /accounting unavailable/)
      assert.equal((await run.load(pending.id)).state.phase, 'submitted')
      assert.equal((await db.query('select count(*)::int as n from existing_market_test_damm_checkpoints')).rows[0].n, Math.max(0, index - 2))
      const result = await run.settle(pending.id, { signature, slot: 100, tokenDelta: step.direction === 'buy' ? '37' : '-37' }, async client => {
        assert.equal((await client.query('select 1 as n')).rows[0].n, 1)
        return after ? recordTestDammCheckpoint(client, { runId: TEST_PLAN.id, step: index + 1, githubRepoId: step.githubRepoId, signature, before, after }) : { status: 'recorded' }
      })
      assert.equal(result.step, index + 1)
      if (after) assert.equal(result.accounting.creatorDelta, buy ? '13' : '16')
      assert.equal((await run.settle(pending.id, { signature, slot: 100, tokenDelta: step.direction === 'buy' ? '37' : '-37' }, () => { throw Error('duplicate accounting') })).step, index + 1)
    }
    assert.equal((await run.inspect()).state.spent, '21225960')
    assert.equal((await run.inspect()).state.phase, 'completed')
    assert.equal((await db.query('select count(*)::int as n from existing_market_test_damm_checkpoints')).rows[0].n, 4)
    assert.equal((await db.query('select count(*)::int as n from existing_market_test_damm_baselines')).rows[0].n, 2)
    await assert.rejects(run.request(request(TEST_PLAN.steps[0])), /completed/)
    // Runtime role cannot create/rearm a run, disable evidence, or modify approval.
    const client = await db.connect()
    try {
      await client.query('set role repoing_existing_market_trader')
      await assert.rejects(client.query('update existing_market_test_runs set enabled=true'), /permission denied/)
      await assert.rejects(client.query('delete from existing_market_test_runs'), /permission denied/)
      await assert.rejects(client.query('delete from existing_market_test_damm_checkpoints'), /permission denied/)
      await assert.rejects(client.query('update existing_market_test_damm_baselines set snapshot=\'{}\'::jsonb'), /permission denied/)
      await client.query('reset role')
    } finally { client.release() }
  } finally { await runtimeDb.end(); await db.end() }
})

test('expiry stops permanently; malformed or excessive costs never reserve', options, async () => {
  const db = new pg.Pool({ connectionString: url })
  try {
    await db.query('drop table if exists existing_market_test_runs')
    await db.query(readFileSync(new URL('../scripts/existing-market-test-run.sql', import.meta.url), 'utf8'))
    await db.query('update existing_market_test_runs set enabled=true')
    let at = 1000
    const run = createTestRun({ db, now: () => at }), step = TEST_PLAN.steps[0], input = request(step)
    for (const invalid of [{ networkFee: '805001' }, { accountDeposits: '1488441' }, { refundableDeposit: '1488441' }, { networkFee: '-1' }, { shortfall: '1' }]) {
      await assert.rejects(run.reserve(input, { record: prepared(step), costs: { ...costs('buy'), ...invalid } }), /cost|balance/)
    }
    const state = await run.reserve(input, { record: prepared(step), costs: costs('buy') })
    at += 120001
    await assert.rejects(run.claimVerifiedSignature(state.pending.id, { signature: 'expired', signedMessage: state.pending.record.message }), /expired/)
    assert.equal((await run.inspect()).state.phase, 'stopped')
    await assert.rejects(run.request(input), /stopped/)
  } finally { await db.end() }
})

test('uncertain send reconciles without another send permission or advancing to a sell', options, async () => {
  const db = new pg.Pool({ connectionString: url })
  try {
    await db.query('drop table if exists existing_market_test_runs')
    await db.query(readFileSync(new URL('../scripts/existing-market-test-run.sql', import.meta.url), 'utf8'))
    await db.query('update existing_market_test_runs set enabled=true')
    const run = createTestRun({ db }), step = TEST_PLAN.steps[0], input = request(step)
    const { pending } = await run.reserve(input, { record: prepared(step), costs: costs('buy') })
    const verified = { signature: 'verified-only-fixture', signedMessage: pending.record.message }
    assert.equal((await run.claimVerifiedSignature(pending.id, verified)).send, true)
    await run.stop(pending.id, 'send uncertainty')
    assert.equal((await run.claimVerifiedSignature(pending.id, verified)).send, false)
    const result = await run.settle(pending.id, { signature: verified.signature, slot: 9, tokenDelta: '71' }, async () => ({ status: 'recorded' }))
    assert.equal(result.stopped, true)
    await assert.rejects(run.request(request(TEST_PLAN.steps[1], '71')), /stopped/)
  } finally { await db.end() }
})
