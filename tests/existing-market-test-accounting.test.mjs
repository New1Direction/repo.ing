import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DynamicBondingCurveClient, MigrationOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk'
import { readTestDammCheckpoint as read, recordTestDammCheckpoint as record } from '../src/existing-market-test-accounting.mjs'

const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const signature = n => bs58.encode(Buffer.alloc(64, n))
const hash = evidence => createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
function snapshot(slot, creatorEarned = '10000000000000000000', partnerEarned = '7000000000000000000', creatorClaimed = '10', partnerClaimed = '3') {
  const role = (n, earned, claimed) => {
    const evidence = { migration: signature(9), accounts: [key(1), key(n), key(n + 10)].map(address => ({
      address, owner: key(8), data: Buffer.from(`fixture-${slot}-${address}`).toString('base64'),
    })) }
    return { position: key(n), earned, claimed, available: String(BigInt(earned) - BigInt(claimed)), evidence, hash: hash(evidence) }
  }
  return { githubRepoId: '42', pool: key(1), slot: String(slot), creator: role(2, creatorEarned, creatorClaimed),
    partner: role(3, partnerEarned, partnerClaimed) }
}
// Stateful SQL boundary double: no chain, credentials, shared DB, or production ledger access.
function database() {
  const baselines = [], checkpoints = []
  return { baselines, checkpoints, async query(sql, p) {
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
    if (/^select/i.test(sql.trim())) {
      if (sql.includes('existing_market_test_damm_baselines')) return { rows: baselines.filter(r => r.github_repo_id === p[0]) }
      if (sql.includes('where signature=')) return { rows: checkpoints.filter(r => r.signature === p[0] || (r.run_id === p[1] && r.step === p[2])) }
      if (sql.includes('existing_market_test_damm_checkpoints')) return { rows: checkpoints.filter(r => r.github_repo_id === p[0]).slice(-1) }
    }
    if (sql.startsWith('insert into existing_market_test_damm_baselines')) {
      baselines.push({ github_repo_id: p[0], snapshot: JSON.parse(p[1]) }); return { rows: [] }
    }
    if (sql.startsWith('insert into existing_market_test_damm_checkpoints')) {
      checkpoints.push({ id: p[0], run_id: p[1], step: p[2], github_repo_id: p[3], signature: p[4],
        market_sequence: p[5], payload_hash: p[6], before_snapshot: JSON.parse(p[7]), after_snapshot: JSON.parse(p[8]),
        accounting_baseline: JSON.parse(p[9]), result: JSON.parse(p[10]) })
      return { rows: [] }
    }
    throw Error(`Unexpected SQL (production writes forbidden): ${sql}`)
  } }
}
const input = (before, after, step = 1) => ({ runId: 'local-run', githubRepoId: '42', step, signature: signature(step), before, after })

test('reserves a large historical baseline; only asymmetric new earnings enter the test ledger', async () => {
  const db = database(), before = snapshot(100), after = snapshot(101, '10000000000000000013', '7000000000000000007')
  const result = await record(db, input(before, after))
  assert.equal(result.status, 'recorded')
  assert.equal(result.creatorDelta, '13'); assert.equal(result.partnerDelta, '7')
  assert.deepEqual(result.historicalReserved, { creator: '9999999999999999990', partner: '6999999999999999997' })
  assert.equal(result.attribution, 'finalized-account-interval-not-exclusive-swap')
  assert.equal(db.baselines.length, 1); assert.equal(db.checkpoints.length, 1)
  assert.deepEqual(db.baselines[0].snapshot, before)
  assert.ok(result.evidenceLink.includes(db.checkpoints[0].id))
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('claims reduce availability but do not create or erase earned deltas', async () => {
  const db = database(), before = snapshot(100), after = snapshot(101, before.creator.earned, before.partner.earned, '100', '400')
  const result = await record(db, input(before, after))
  assert.equal(result.creatorDelta, '0'); assert.equal(result.partnerDelta, '0')
  assert.equal(result.creatorClaimedDelta, '90'); assert.equal(result.partnerClaimedDelta, '397')
})

test('subsequent runs retain the original baseline and account explicitly for fees in the inter-step gap', async () => {
  const db = database(), start = snapshot(100), first = snapshot(101, '10000000000000000013', '7000000000000000007')
  await record(db, input(start, first))
  const before = snapshot(103, '10000000000000000018', '7000000000000000009')
  const after = snapshot(104, '10000000000000000029', '7000000000000000012')
  const result = await record(db, { ...input(before, after, 2), runId: 'another-run' })
  assert.equal(result.creatorDelta, '16'); assert.equal(result.partnerDelta, '5')
  assert.deepEqual(result.gapDelta, { creator: '5', partner: '2' })
  assert.deepEqual(result.observedIntervalDelta, { creator: '11', partner: '3' })
  assert.equal(db.baselines.length, 1)
  assert.deepEqual(db.checkpoints[1].accounting_baseline, first)
})

test('replay returns the exact receipt, even after later checkpoints; contradictory reuse fails', async () => {
  const db = database(), before = snapshot(100), after = snapshot(101, '10000000000000000013', '7000000000000000007')
  const request = input(before, after), receipt = await record(db, request)
  // PostgreSQL JSONB reorders keys, including those inside evidence objects.
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, reorder(value[k])])) : value
  db.baselines[0].snapshot = reorder(db.baselines[0].snapshot)
  db.checkpoints[0].after_snapshot = reorder(db.checkpoints[0].after_snapshot)
  await record(db, input(after, snapshot(102, '10000000000000000017', '7000000000000000009'), 2))
  assert.deepEqual(await record(db, reorder(request)), receipt)
  assert.equal(db.checkpoints.length, 2)
  await assert.rejects(record(db, { ...request, after: snapshot(103, '10000000000000000014') }), /contradict/i)
  await assert.rejects(record(db, { ...request, signature: signature(5) }), /contradict/i)
  await assert.rejects(record(db, { ...request, runId: 'different' }), /contradict/i)
})

test('rejects decreasing counters, changed identity, overlapping slots, and malformed economics/evidence before inserts', async () => {
  const cases = [
    s => { s.creator.earned = '999'; s.creator.available = '989' },
    s => { s.partner.claimed = '2'; s.partner.available = String(BigInt(s.partner.earned) - 2n) },
    s => { s.creator.available = '1' },
    s => { s.slot = '99' },
    s => { s.slot = '100' }, // A single finalized bank cannot have changed evidence.
    s => { s.githubRepoId = '43' },
    s => { s.pool = key(4) },
    s => { s.creator.position = key(4) },
    s => { s.creator.position = key(4); s.creator.evidence.accounts[1].address = key(4); s.creator.hash = hash(s.creator.evidence) },
    s => { s.partner.hash = 'f'.repeat(64) },
    s => { s.creator.earned = 10000000000000000000 },
    s => { s.creator.earned = '-1' },
    s => { s.creator.evidence.accounts[0].data = 'broken'; s.creator.hash = hash(s.creator.evidence) },
  ]
  for (const mutate of cases) {
    const db = database(), after = snapshot(101)
    mutate(after)
    await assert.rejects(record(db, input(snapshot(100), after)))
    assert.equal(db.baselines.length + db.checkpoints.length, 0)
  }
  const db = database()
  await record(db, input(snapshot(100), snapshot(102)))
  await assert.rejects(record(db, input(snapshot(101), snapshot(103), 2)), /slot|overlap/i)
  assert.equal(db.checkpoints.length, 1)
})

test('missing proofs and missing proof tables fail closed before any chain discovery or writes', async () => {
  for (const query of [async () => ({ rows: [] }), async () => { throw Object.assign(Error('missing table'), { code: '42P01' }) }]) {
    await assert.rejects(read({ connection: {}, db: { query }, config: key(4), market: { githubRepoId: '42' } }), /proof|missing table/i)
  }
})

test('reader uses proven migration and real finalized account decoding, including recovered NFT custody', async t => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/repoing-graduated-accounts.json', import.meta.url)))
  const pk = value => new PublicKey(value), config = '2YbBp7HDQXUA3bk75yxx1kefcVfYYn3oYBNyJGmvre1M'
  const market = { githubRepoId: '1388219884', mint: '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be',
    pool: 'Gda7Sig9EtVpB7EMVWG1eAAoX8kvq4j68nELsnq3Qfi7', creatorWallet: 'FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1' }
  const [pool, creatorPosition, creatorNftAccount, partnerPosition, partnerNftAccount] = fixture.accounts.map(a => a.address)
  const proof = { curve: market.pool, config, mint: market.mint, pool, signature: signature(9), slot: '451432143', creatorPosition,
    creatorNftAccount, creatorNftMint: '7QdbWrPPAmsGrm2VVc9Eyt2gj4HDnjt7doxv3GUVBUx7', partnerPosition,
    partnerNftAccount, partnerNftMint: '63nLdMVdn7H4QHLQx6jP2mvKmSjANSnib1yx5iujtzYV' }
  const connection = { rpcEndpoint: 'http://checkpoint-fixture.invalid', async getMultipleAccountsInfoAndContext(keys, commitment) {
    assert.equal(commitment, 'finalized')
    return { context: { slot: fixture.slot }, value: keys.map(k => {
      const a = fixture.accounts.find(a => a.address === k.toBase58())
      return { owner: pk(a.owner), data: Buffer.from(a.data, 'base64'), lamports: 1, executable: false }
    }) }
  } }
  const prototype = Object.getPrototypeOf(new DynamicBondingCurveClient(connection, 'finalized').state)
  t.mock.method(prototype, 'getPool', async () => ({ poolState: { config: pk(config), baseMint: pk(market.mint), creator: pk(market.creatorWallet), isMigrated: 1 } }))
  t.mock.method(prototype, 'getPoolConfig', async () => ({ migrationOption: MigrationOption.MET_DAMM_V2, quoteMint: NATIVE_MINT,
    creatorPermanentLockedLiquidityPercentage: 50, partnerPermanentLockedLiquidityPercentage: 50, migrationFeeOption: 2,
    feeClaimer: pk('H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3') }))
  const accounts = Array(15).fill(key(7))
  Object.assign(accounts, { 0: market.pool, 2: config, 4: pool, 5: proof.creatorNftMint, 6: creatorNftAccount, 7: creatorPosition,
    8: proof.partnerNftMint, 9: partnerNftAccount, 10: partnerPosition, 12: CP_AMM_PROGRAM_ID.toBase58(), 13: market.mint, 14: NATIVE_MINT.toBase58() })
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, connection.rpcEndpoint)
    const request = JSON.parse(options.body)
    assert.equal(request.method, 'getTransaction'); assert.equal(request.params[1].commitment, 'finalized')
    return { ok: true, status: 200, async json() { return { result: { version: 'legacy', slot: 451432143, meta: { err: null },
      transaction: { signatures: [proof.signature], message: { accountKeys: ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN', ...accounts],
        instructions: [{ programIdIndex: 0, accounts: accounts.map((_, i) => i + 1), data: bs58.encode(Buffer.from([156,169,230,103,53,228,80,64])) }] } } } } } }
  })
  const db = { async query(sql) { assert.match(sql, /^select /i); assert.match(sql, /graduated_migration_proofs/); return { rows: [proof] } } }
  const normal = await read({ connection, db, config, market })
  assert.equal(normal.githubRepoId, market.githubRepoId); assert.equal(normal.pool, pool)
  assert.equal(normal.slot, String(fixture.slot)); assert.equal(normal.creator.position, creatorPosition)
  assert.notEqual(normal.creator.claimed, normal.partner.claimed)
  assert.notEqual(normal.creator.available, normal.partner.available)
  for (const role of ['creator', 'partner']) {
    assert.equal(BigInt(normal[role].earned), BigInt(normal[role].available) + BigInt(normal[role].claimed))
    assert.equal(normal[role].hash, hash(normal[role].evidence))
  }
  assert.doesNotThrow(() => JSON.stringify(normal))
  // A warm production/read cache cannot hide a newly corrupted persisted proof.
  const originalProofSlot = proof.slot
  proof.slot = '1'
  await assert.rejects(read({ connection, db, config, market }), /proof mismatch/i)
  proof.slot = originalProofSlot
  // The proof can disappear or the table can fail after the initial existence check.
  for (const failure of ['absent', 'missing-table']) {
    let calls = 0
    const lost = { async query() {
      if (++calls === 1) return { rows: [proof] }
      if (failure === 'missing-table') throw Object.assign(Error('table missing'), { code: '42P01' })
      return { rows: [] }
    } }
    await assert.rejects(read({ connection, db: lost, config, market }), /proof/i)
  }
  const data = Buffer.from(fixture.accounts[2].data, 'base64')
  pk(key(6)).toBuffer().copy(data, 32); fixture.accounts[2].data = data.toString('base64')
  await assert.rejects(read({ connection, db, config, market }), /creator position/i)
  const custodyRecovery = { version: 1, poolCreators: [], positions: [{ repoId: market.githubRepoId, curve: market.pool,
    config, mint: market.mint, previousOwner: market.creatorWallet, owner: key(6), role: 'creator', pool, migration: proof.signature,
    position: creatorPosition, nftAccount: creatorNftAccount, nftMint: proof.creatorNftMint }] }
  assert.equal((await read({ connection, db, config, market, custodyRecovery })).creator.earned, normal.creator.earned)
})
