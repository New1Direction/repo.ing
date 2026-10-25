import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs, canonicalJSON, digest, createRpcTape, openSnapshot, queryNames } from '../scripts/shadow/boundary.mjs'
const runner = process.env.SHADOW_RUNNER_PATH ?? 'scripts/shadow/runner.mjs'

test('market acquisition clocks survive long cycles and reject missing, reordered and stale timing', async () => {
  const { computeShadow } = await import('../scripts/shadow/compute.mjs')
  const { curvePacket } = await import('./fixtures/shadow-packet.mjs')
  const { packet, tape } = await curvePacket('chart')
  const at = packet.at, later = new Date(Date.parse(at) + 480000).toISOString()
  packet.timings = [{ repoId: packet.db.markets[0].repoId, startedAt: at, acquiredAt: at, validatedAt: at }]
  packet.completedAt = later
  const output = await computeShadow(packet, tape)
  assert.deepEqual(output.markets[0].asOf, packet.timings[0])
  assert.deepEqual(await computeShadow(packet, createRpcTape({ entries: tape.entries })), output)
  const replay = p => computeShadow(p, createRpcTape({ entries: tape.entries }))
  for (const change of [p => delete p.timings, p => delete p.timings[0].acquiredAt,
    p => p.timings[0].validatedAt = new Date(Date.parse(at) - 1).toISOString(),
    p => p.timings[0].repoId = '999', p => p.completedAt = new Date(Date.parse(at) - 1).toISOString()]) {
    const bad = structuredClone(packet); change(bad)
    await assert.rejects(replay(bad), /SHADOW_TIMING_INVALID/)
  }
  const reordered = structuredClone(packet)
  reordered.db.markets.push({ ...reordered.db.markets[0], repoId: '9999999999' })
  reordered.timings[0].validatedAt = new Date(Date.parse(at) + 1).toISOString()
  reordered.timings.push({ ...packet.timings[0], repoId: '9999999999' })
  await assert.rejects(replay(reordered), /SHADOW_TIMING_INVALID/)
  await assert.rejects(replay({ ...packet, version: 1 }), /SHADOW_PACKET_INVALID/)
  for (const [age, succeeds] of [[120000, true], [120001, false]]) {
    const p = structuredClone(packet)
    p.timings[0].acquiredAt = p.timings[0].validatedAt = new Date(Date.parse(at) + age).toISOString()
    if (succeeds) await replay(p)
    else await assert.rejects(replay(p), /STALE_PROGRESS/)
  }
  for (const [age, succeeds] of [[300000, true], [300001, false]]) {
    const p = structuredClone(packet)
    p.timings[0].validatedAt = new Date(Date.parse(at) + age).toISOString()
    if (succeeds) await replay(p)
    else await assert.rejects(replay(p), /STALE_PROGRESS/)
  }
  // Timestamp changes invalidate the saved envelope, even when the new time is otherwise plausible.
  const dir = mkdtempSync(join(tmpdir(), 'repoing-shadow-timing-'))
  try {
    const body = { ...packet, rpc: tape.entries }, originalDigest = digest(body)
    body.timings[0].acquiredAt = new Date(Date.parse(at) + 1).toISOString()
    const path = join(dir, 'packet.json')
    writeFileSync(path, canonicalJSON({ packet: body, digest: originalDigest }))
    const run = spawnSync(process.execPath, [runner, 'replay', 'chart', '--read-only', path], { encoding: 'utf8' })
    assert.equal(run.status, 1); assert.equal(run.stdout, ''); assert.equal(run.stderr, 'SHADOW_FAILED\n')
  } finally { rmSync(dir, { recursive: true }) }
})

test('capture binds real market clocks, replays exactly and refuses stale acquisition without relabeling', async () => {
  const { computeShadow } = await import('../scripts/shadow/compute.mjs')
  const { curvePacket } = await import('./fixtures/shadow-packet.mjs')
  for (const lane of ['chart', 'accounting']) {
    const { packet, tape } = await curvePacket(lane, new Date(Math.floor(Date.now() / 1000) * 1000).toISOString())
    delete packet.timings; delete packet.completedAt
    const captured = await computeShadow(packet, tape, { capture: true })
    assert.ok(Date.parse(packet.timings[0].acquiredAt) >= Date.parse(packet.at))
    assert.ok(Date.parse(packet.timings[0].validatedAt) >= Date.parse(packet.timings[0].acquiredAt))
    assert.deepEqual(await computeShadow(packet, createRpcTape({ entries: tape.entries })), captured)
    // An already frozen capture may not silently acquire a new clock.
    await assert.rejects(computeShadow(packet, tape, { capture: true }), /SHADOW_TIMING_INVALID/)
  }
  const { packet, tape } = await curvePacket('chart', new Date(Math.floor((Date.now() - 121000) / 1000) * 1000).toISOString())
  delete packet.timings; delete packet.completedAt
  await assert.rejects(computeShadow(packet, tape, { capture: true }), /STALE_PROGRESS/)
  assert.equal(packet.completedAt, undefined)
  assert.deepEqual(packet.timings, [])
})

test('isolated chart and accounting compute nonempty, deterministic frozen windows with per-event fee rounding', async () => {
  const { computeShadow } = await import('../scripts/shadow/compute.mjs')
  const { curvePacket } = await import('./fixtures/shadow-packet.mjs')
  for (const lane of ['chart', 'accounting']) {
    const { packet, tape } = await curvePacket(lane)
    const output = await computeShadow(packet, tape)
    assert.equal(output.markets.length, 1)
    assert.equal(output.markets[0].transactions, 2)
    assert.equal(output.markets[0].events, 2)
    if (lane === 'accounting') {
      assert.equal(output.markets[0].creditedBaseUnits, '3') // floor(2*.71) + floor(4*.71), not floor(6*.71)=4.
      assert.equal(output.markets[0].partnerBaseUnits, '3')
    }
    const replay = createRpcTape({ entries: tape.entries })
    assert.deepEqual(await computeShadow(packet, replay), output)
    assert.equal(replay.calls, 0)
    const dir = mkdtempSync(join(tmpdir(), 'repoing-shadow-'))
    try {
      const path = join(dir, 'packet.json'), body = { ...packet, rpc: tape.entries }
      writeFileSync(path, canonicalJSON({ packet: body, digest: digest(body) }), { mode: 0o600 })
      const run = spawnSync(process.execPath, [runner, 'replay', lane, '--read-only', path],
        { encoding: 'utf8', env: { PATH: process.env.PATH, DATABASE_URL: 'SECRET_SENTINEL' } })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(run.stderr, '')
      assert.equal(JSON.parse(run.stdout).result.outputDigest, output.outputDigest)
      body.rpc[Object.keys(body.rpc)[0]] = 'tampered'
      writeFileSync(path, canonicalJSON({ packet: body, digest: '0'.repeat(64) }))
      const bad = spawnSync(process.execPath, [runner, 'replay', lane, '--read-only', path], { encoding: 'utf8' })
      assert.equal(bad.status, 1)
      assert.equal(bad.stdout, '')
      assert.equal(bad.stderr, 'SHADOW_FAILED\n')
    } finally { rmSync(dir, { recursive: true }) }
    // Missing evidence is a failure, never a skipped market or a successful empty cycle.
    await assert.rejects(computeShadow(packet, createRpcTape()), /SHADOW_RPC_MISSING/)
  }
})

test('graduated chart and accounting windows replay cold and reject entitlement decreases', async () => {
  const { computeShadow } = await import('../scripts/shadow/compute.mjs')
  const { graduatedPacket } = await import('./fixtures/shadow-packet.mjs')
  for (const lane of ['chart', 'accounting']) {
    const { packet, tape } = await graduatedPacket(lane)
    const result = await computeShadow(packet, tape)
    if (lane === 'chart') {
      assert.equal(result.markets[0].phase, 'GRADUATED')
      assert.equal(result.markets[0].events, 2)
    } else {
      assert.equal(result.markets[0].creditedBaseUnits, '0')
      assert.ok(BigInt(result.markets[0].graduatedCredit) > 0n)
      // Asymmetric pre-existing credits must subtract from their own side only.
      packet.db.graduated = [{ github_repo_id: packet.db.markets[0].repoId, amount_base_units: '7' }]
      packet.db.platform = [{ github_repo_id: packet.db.markets[0].repoId, amount_base_units: '11' }]
      const offset = await computeShadow(packet, createRpcTape({ entries: tape.entries }))
      assert.equal(BigInt(result.markets[0].graduatedCredit) - BigInt(offset.markets[0].graduatedCredit), 7n)
      assert.equal(BigInt(result.markets[0].partnerCredit) - BigInt(offset.markets[0].partnerCredit), 11n)
      packet.db.graduated[0].amount_base_units = String(BigInt(result.markets[0].graduatedCredit) + 1n)
      await assert.rejects(computeShadow(packet, createRpcTape({ entries: tape.entries })), /SHADOW_ENTITLEMENT_DECREASED/)
      packet.db.graduated = []; packet.db.platform = []
    }
    const dir = mkdtempSync(join(tmpdir(), 'repoing-graduated-shadow-'))
    try {
      const path = join(dir, 'packet.json'), body = { ...packet, rpc: tape.entries }
      writeFileSync(path, canonicalJSON({ packet: body, digest: digest(body) }), { mode: 0o600 })
      const run = spawnSync(process.execPath, [runner, 'replay', lane, '--read-only', path], { encoding: 'utf8' })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(JSON.parse(run.stdout).result.outputDigest, result.outputDigest)
    } finally { rmSync(dir, { recursive: true }) }
  }
})

test('shadow CLI has no default/live mode and rejects unknown or surplus flags before connecting', () => {
  for (const args of [[], ['--shadow'], ['capture', 'chart', 'packet'],
    ['capture', 'chart', '--read-only', 'packet', '--unpaced'],
    ['capture', 'chart', '--read-only', 'packet', '--rpc-delay-ms=0'],
    ['capture', 'chart', '--read-only', 'packet', '--live'], ['replay', 'fees', '--read-only', 'packet']]) {
    assert.throws(() => parseArgs(args), /SHADOW_ARGUMENTS/)
    const run = spawnSync(process.execPath, [runner, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, RECOVERY_FEE_DATABASE_URL: 'SECRET_SENTINEL' },
    })
    assert.equal(run.status, 1)
    assert.equal(run.stdout, '')
    assert.equal(run.stderr, 'SHADOW_ARGUMENTS\n')
  }
  assert.deepEqual(parseArgs(['replay', 'accounting', '--read-only', 'packet']),
    { mode: 'replay', lane: 'accounting', path: 'packet' })
})

test('canonical digests ignore object insertion order, but preserve order and exact economic values', () => {
  assert.equal(digest({ b: 3n, a: [1, 2] }), digest({ a: [1, 2], b: '3' }))
  assert.notEqual(digest({ a: [1, 2] }), digest({ a: [2, 1] }))
  assert.notEqual(digest({ fee: '9007199254740993' }), digest({ fee: '9007199254740992' }))
  assert.equal(canonicalJSON({ time: new Date('2026-01-01Z') }), '{"time":"2026-01-01T00:00:00.000Z"}')
})

test('RPC tape rejects sends, unknown reads, nonfinalized requests, overflow and missing replay inputs', async () => {
  let calls = 0
  const options = { endpoints: { primary: 'https://rpc.invalid/SECRET_SENTINEL' }, maxCalls: 1,
    fetchImpl: async () => { calls++; return new Response(JSON.stringify({ result: 'genesis' })) } }
  for (const [method, params] of [['sendTransaction', ['signed']], ['getProgramAccounts', ['key']],
    ['getAccountInfo', ['key', { commitment: 'confirmed' }]]]) {
    const denied = createRpcTape(options)
    await assert.rejects(denied.request('primary', method, params), /SHADOW_RPC_DENIED/)
    assert.throws(() => denied.assertSafe(), /SHADOW_RPC_DENIED/)
    await assert.rejects(denied.request('primary', 'getGenesisHash', []), /SHADOW_RPC_DENIED/)
  }
  assert.equal(calls, 0)
  const tape = createRpcTape(options)
  assert.equal(await tape.request('primary', 'getGenesisHash', []), 'genesis')
  assert.equal(await tape.request('primary', 'getGenesisHash', []), 'genesis')
  await assert.rejects(tape.request('primary', 'getBlockTime', [12]), /SHADOW_RPC_LIMIT/)
  assert.equal(calls, 1)
  assert.ok(!canonicalJSON(tape.entries).includes('SECRET_SENTINEL'))
  const replay = createRpcTape({ entries: tape.entries })
  assert.equal(await replay.request('primary', 'getGenesisHash', []), 'genesis')
  await assert.rejects(replay.request('primary', 'getBlockTime', [12]), /SHADOW_RPC_MISSING/)
  const bounded = createRpcTape({ entries: tape.entries, maxCalls: 1 })
  for (let i = 0; i < 5; i++) await bounded.request('primary', 'getGenesisHash', [])
  await assert.rejects(bounded.request('primary', 'getGenesisHash', []), /SHADOW_RPC_LIMIT/)
})

test('RPC pacing shares endpoint origins across aliases and holds concurrency through body completion', async () => {
  const starts = [], ends = [], active = new Map(), peaks = new Map()
  const tape = createRpcTape({ endpoints: { primary: 'https://primary.invalid/key',
    verification: 'https://ARCHIVE.invalid:443/verify?secret=SECRET_SENTINEL', archive: 'https://archive.invalid/archive' },
    fetchImpl: async endpoint => {
      const origin = new URL(endpoint).origin
      const ordinal = starts.filter(s => s.origin === origin).length
      starts.push({ origin, at: performance.now() })
      active.set(origin, (active.get(origin) ?? 0) + 1)
      peaks.set(origin, Math.max(peaks.get(origin) ?? 0, active.get(origin)))
      return new Response(new ReadableStream({ async start(controller) {
        // A headers-only slot would release while this first body is still streaming.
        if (origin === 'https://archive.invalid' && ordinal === 0) await delay(1100)
        controller.enqueue(new TextEncoder().encode('{"result":"ok"}'))
        ends.push({ origin, at: performance.now() })
        active.set(origin, active.get(origin) - 1)
        controller.close()
      } }))
    } })
  assert.deepEqual(await Promise.all([
    tape.request('verification', 'getGenesisHash', []),
    tape.request('archive', 'getBlockTime', [12]),
    tape.request('verification', 'getBlockTime', [13]),
    tape.request('primary', 'getGenesisHash', []),
  ]), ['ok', 'ok', 'ok', 'ok'])
  const archiveStarts = starts.filter(s => s.origin === 'https://archive.invalid')
  const archiveEnds = ends.filter(s => s.origin === 'https://archive.invalid')
  assert.equal(archiveStarts.length, 3)
  assert.equal(peaks.get('https://archive.invalid'), 1)
  assert.ok(archiveStarts[1].at >= archiveEnds[0].at)
  for (let i = 1; i < archiveStarts.length; i++) assert.ok(archiveStarts[i].at - archiveStarts[i - 1].at >= 1000)
  assert.ok(starts.find(s => s.origin === 'https://primary.invalid').at < archiveEnds[0].at, 'different origins do not share a queue')
  assert.ok(!canonicalJSON(tape.entries).includes('SECRET_SENTINEL'))
})

test('RPC pacing fails closed on HTTP errors without retrying queued aliases or falling back', async () => {
  for (const status of [429, 500, 503]) {
    let calls = 0
    const tape = createRpcTape({ endpoints: { verification: 'https://archive.invalid/a', archive: 'https://archive.invalid/b' },
      fetchImpl: async () => { calls++; return new Response('SECRET_SENTINEL', { status }) } })
    const results = await Promise.allSettled([
      tape.request('verification', 'getGenesisHash', []),
      tape.request('archive', 'getGenesisHash', []),
      tape.request('verification', 'getBlockTime', [10]),
    ])
    assert.deepEqual(results.map(r => [r.status, r.reason?.message]), Array(3).fill(['rejected', 'SHADOW_RPC_FAILED']))
    await assert.rejects(tape.request('archive', 'getBlockTime', [11]), /^Error: SHADOW_RPC_FAILED$/)
    assert.equal(calls, 1)
    assert.deepEqual(tape.entries, {})
  }
  let calls = 0
  const missing = createRpcTape({ endpoints: { primary: 'https://primary.invalid' },
    fetchImpl: async () => { calls++; return new Response('{"result":1}') } })
  await assert.rejects(missing.request('archive', 'getGenesisHash', []), /^Error: SHADOW_RPC_FAILED$/)
  assert.equal(calls, 0, 'a missing endpoint must not fall back to another provider')
})

test('RPC failure aborts another origin body and paced wait, including cached fallback', { timeout: 3000 }, async () => {
  let calls = 0, bodyAborted = false
  const tape = createRpcTape({ endpoints: { primary: 'https://primary.invalid', verification: 'https://verify.invalid', archive: 'https://archive.invalid' },
    fetchImpl: async (endpoint, { signal }) => {
      calls++
      if (endpoint.includes('primary')) return new Response('{"result":1}')
      if (endpoint.includes('verify')) { await delay(30); return new Response(null, { status: 429 }) }
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => { bodyAborted = true; controller.error(Error('SECRET_SENTINEL')) }, { once: true })
      } }))
    } })
  await tape.request('primary', 'getGenesisHash', [])
  const results = await Promise.allSettled([
    tape.request('primary', 'getBlockTime', [11]),
    tape.request('archive', 'getGenesisHash', []),
    tape.request('verification', 'getGenesisHash', []),
  ])
  assert.deepEqual(results.map(r => [r.status, r.reason?.message]), Array(3).fill(['rejected', 'SHADOW_RPC_FAILED']))
  assert.equal(bodyAborted, true)
  assert.equal(calls, 3, 'the paced primary request was never sent')
  await assert.rejects(tape.request('primary', 'getGenesisHash', []), /^Error: SHADOW_RPC_FAILED$/)
  assert.throws(() => tape.assertSafe(), /^Error: SHADOW_RPC_FAILED$/)
})

test('any swallowed write attempt still fails cycle acceptance', async () => {
  const { computeShadow } = await import('../scripts/shadow/compute.mjs')
  const { curvePacket } = await import('./fixtures/shadow-packet.mjs')
  const { packet, tape } = await curvePacket('chart')
  await tape.request('primary', 'sendTransaction', ['never-send']).catch(() => {})
  await assert.rejects(computeShadow(packet, tape), /SHADOW_RPC_DENIED/)
})

test('RPC provider errors and transaction log strings never reach packets/errors', async () => {
  const bad = createRpcTape({ endpoints: { primary: 'https://rpc.invalid/SECRET_SENTINEL' },
    fetchImpl: async () => { throw Error('SECRET_SENTINEL') } })
  await assert.rejects(bad.request('primary', 'getGenesisHash', []), e => e.message === 'SHADOW_RPC_FAILED')
  const logs = createRpcTape({ endpoints: { primary: 'https://rpc.invalid' }, fetchImpl: async () =>
    new Response(JSON.stringify({ result: { meta: { err: null, logMessages: ['SECRET_SENTINEL'] } } })) })
  await logs.request('primary', 'getTransaction', ['sig', { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 1 }])
  assert.ok(!canonicalJSON(logs.entries).includes('SECRET_SENTINEL'))
})

test('database boundary rejects writes, DDL, advisory locks and session escape, with real read-only enforcement',
  { skip: !process.env.SHADOW_TEST_DATABASE_URL }, async () => {
    const pg = (await import('pg')).default
    const url = new URL(process.env.SHADOW_TEST_DATABASE_URL)
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.pathname, '/repoing_shadow_test')
    const admin = new pg.Client({ connectionString: url.href })
    await admin.connect()
    try {
      const { drizzle } = await import('drizzle-orm/node-postgres')
      const { migrate } = await import('drizzle-orm/node-postgres/migrator')
      await admin.query('drop schema public cascade; create schema public; drop schema if exists drizzle cascade; drop schema if exists recovery_charts cascade')
      await migrate(drizzle(admin), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
      const roles = new Set((await admin.query('select rolname from pg_roles')).rows.map(r => r.rolname))
      for (const file of ['recovery-accounting-roles.sql', 'recovery-chart-role.sql']) {
        await admin.query(readFileSync(new URL('../scripts/' + file, import.meta.url), 'utf8')
          .replace(/^CREATE ROLE (\w+) .*;$/gm, (line, role) => roles.has(role) ? '' : line))
      }
      await admin.query('alter role repoing_chart_recovery login; alter role repoing_fee_indexer login')
      await admin.query('create table if not exists public.shadow_probe(n int); truncate public.shadow_probe')
      // Independent engine check: even a role that could write cannot do so in this session.
      const guarded = new pg.Client({ connectionString: url.href, options: '-c default_transaction_read_only=on' })
      await guarded.connect()
      try {
        for (const sql of ['insert into public.shadow_probe values(1)', 'update public.shadow_probe set n=1',
          'delete from public.shadow_probe', 'create table public.forbidden(n int)']) {
          await assert.rejects(guarded.query(sql), e => e.code === '25006')
        }
      } finally { await guarded.end() }
      for (const lane of ['chart', 'accounting']) {
        const roleUrl = new URL(url); roleUrl.username = lane === 'chart' ? 'repoing_chart_recovery' : 'repoing_fee_indexer'
        const snapshot = await openSnapshot({ connectionString: roleUrl.href }, lane)
        try {
          for (const sql of ['insert into shadow_probe values(1)', 'delete from shadow_probe', 'create table x(n int)',
            'select pg_advisory_lock(10)', 'select pg_try_advisory_xact_lock(11)', 'set transaction read write', 'commit']) {
            await assert.rejects(snapshot.read(sql), /SHADOW_QUERY_DENIED/)
          }
          assert.equal(snapshot.identity.readOnly, true)
          assert.throws(() => snapshot.assertSafe(), /SHADOW_QUERY_DENIED/)
          for (const name of queryNames(lane)) assert.ok(Array.isArray(await snapshot.read(name)))
          const before = await snapshot.read('cursors')
          await admin.query("insert into pool_fee_cursors(pool,last_signature,last_slot) values($1,'sentinel',99) on conflict(pool) do update set last_slot=pool_fee_cursors.last_slot+1", [lane])
          assert.deepEqual(await snapshot.read('cursors'), before, 'concurrent writer cannot change the frozen input window')
        } finally { await snapshot.close() }
      }
      assert.equal((await admin.query('select count(*)::int n from public.shadow_probe')).rows[0].n, 0)
      assert.equal((await admin.query("select count(*)::int n from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database())")).rows[0].n, 0)
    } finally { await admin.end() }
  })
