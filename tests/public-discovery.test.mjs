import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createTrendIntake } from '../src/trend-intake.mjs'
import { createTrendSources } from '../src/trend-sources.mjs'
import { publicDiscoveryOptions, runPublicDiscovery } from '../scripts/run-public-discovery.mjs'

const time = Date.parse('2026-10-23T12:00:00Z')
const observation = (id = '123') => ({ repo: { id, fullName: 'owner/repo', description: 'fixture' },
  observedAt: new Date(time).toISOString(), stars: 50, forks: 3, activity: { complete: false } })
const seed = { health: [{ source: 'github_trending', status: 'OK', count: 1 }], signals: [{
  repository: 'https://github.com/owner/repo', source: 'github_trending', url: 'https://github.com/trending',
  note: 'fixture', occurredAt: new Date(time).toISOString(), expiresAt: new Date(time + 3600000).toISOString() }] }

function fixture({ locked = true, recent = false, allowed = true, failure = null, known = [] } = {}) {
  const queries = [], observed = [], releases = []
  let seeds = 0
  const db = { release: broken => releases.push(broken), async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] }
    if (sql.includes('select checked_at')) return { rows: recent ? [{ checked_at: new Date(time) }] : [] }
    if (sql.includes('as allowed')) {
      if (failure) throw failure
      return { rows: [{ allowed }] }
    }
    if (sql.includes('watched order by')) return { rows: known }
    return { rows: [] }
  } }
  const pool = { connect: async () => db }
  const sources = { seeds: async () => { seeds++; return seed }, observe: async (url, id) => {
    observed.push({ url, id }); return observation()
  } }
  return { pool, sources, queries, observed, releases, seeds: () => seeds }
}

test('discovery-only refresh writes evidence but never synchronizes launches or reviews', async () => {
  const f = fixture()
  const result = await createTrendIntake({ ...f, now: () => time, discoveryOnly: true }).runOnce()
  assert.equal(result.results[0].status, 'OBSERVED')
  assert.ok(f.queries.some(q => q.sql.includes('insert into trend_observations')))
  assert.ok(!f.queries.some(q => /trend_launches|trend_reviews|trade_events|join markets/.test(q.sql)))
  assert.ok(!f.queries.some(q => /set state|approved_config/.test(q.sql)))
  assert.deepEqual(f.releases, [undefined])
})

test('omnibus intake still runs launch synchronization by default', async () => {
  const f = fixture()
  await createTrendIntake({ ...f, now: () => time }).runOnce()
  assert.ok(f.queries.some(q => q.sql.includes('left join trend_launches')))
})

test('discovery-only intake refuses manual enrollment entrypoint', async () => {
  const f = fixture()
  await assert.rejects(() => createTrendIntake({ ...f, discoveryOnly: true }).addManual({}, 'operator'), /DISCOVERY_ONLY/)
  assert.equal(f.seeds(), 0)
  assert.deepEqual(f.queries, [])
})

test('known operator exclusions skip external observation and all candidate writes', async () => {
  const f = fixture({ known: [{ repoId: '123', fullName: 'owner/repo', state: 'detected' }] })
  await createTrendIntake({ ...f, now: () => time, discoveryOnly: true, excluded: new Set(['123']) }).runOnce()
  assert.deepEqual(f.observed, [])
  assert.ok(!f.queries.some(q => /insert into trend_candidates|update trend_candidates/.test(q.sql)))
})

test('new identity with a maintainer opt-out is not persisted', async () => {
  const f = fixture({ allowed: false })
  const result = await createTrendIntake({ ...f, now: () => time, discoveryOnly: true }).runOnce()
  assert.equal(result.results[0].status, 'EXCLUDED')
  assert.ok(!f.queries.some(q => q.sql.includes('insert into trend_candidates')))
})

test('missing opt-out schema fails closed, releases lock and does not report success', async () => {
  const f = fixture({ failure: Object.assign(Error('private DB detail'), { code: '42P01' }) })
  await assert.rejects(() => createTrendIntake({ ...f, now: () => time, discoveryOnly: true }).runOnce())
  assert.ok(!f.queries.some(q => q.sql.includes('insert into trend_candidates')))
  assert.deepEqual(f.releases, [undefined])
})

test('shared throttle and advisory lock prevent additional source requests', async () => {
  for (const options of [{ locked: false }, { recent: true }]) {
    const f = fixture(options)
    const result = await createTrendIntake({ ...f, now: () => time, discoveryOnly: true }).runOnce()
    assert.equal(result.status, options.recent ? 'WAITING' : 'BUSY')
    assert.equal(f.seeds(), 0)
    assert.deepEqual(f.releases, [undefined])
  }
})

test('CLI refuses broad DATABASE_URL and redacts malformed dedicated credentials', () => {
  for (const dedicated of [undefined, 'https://user:DO_NOT_PRINT@example.com/database', 'postgres://localhost/db']) {
    const env = { PATH: process.env.PATH, DATABASE_URL: 'postgres://broad:DO_NOT_PRINT@localhost/db' }
    if (dedicated) env.PUBLIC_DISCOVERY_DATABASE_URL = dedicated
    const result = spawnSync(process.execPath, ['scripts/run-public-discovery.mjs'], { env, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /PUBLIC_DISCOVERY_CONFIG_INVALID/)
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT/)
  }
})

test('dedicated connection settings cannot be overridden by broad runtime or URL options', () => {
  const url = 'postgres://discovery:fixture@127.0.0.1:55439/isolated?sslmode=disable'
  const { options, excluded } = publicDiscoveryOptions({ PUBLIC_DISCOVERY_DATABASE_URL: url,
    PGUSER: 'broad', PGPASSWORD: 'broad', PGOPTIONS: '-c role=postgres', DBC_CONFIG: 'ignored',
    PROMOTION_EXCLUDED_REPO_IDS: '123, 456, hf:model/name, not-an-id' })
  assert.equal(options.user, 'discovery'); assert.equal(options.password, 'fixture')
  assert.equal(options.database, 'isolated'); assert.equal(options.max, 1)
  assert.equal(options.options, '-c role=repoing_public_discovery -c search_path=pg_catalog,public')
  assert.deepEqual([...excluded], ['123', '456'])
  for (const suffix of ['&options=-c%20role=postgres', '&sslmode=require', '&sslkey=/secret']) {
    assert.throws(() => publicDiscoveryOptions({ PUBLIC_DISCOVERY_DATABASE_URL: url + suffix }), /CONFIG_INVALID/)
  }
  assert.throws(() => publicDiscoveryOptions({ PUBLIC_DISCOVERY_DATABASE_URL: url.replace('127.0.0.1', 'remote.example') }), /CONFIG_INVALID/)
})

test('entrypoint closes the pool on role mismatch or database failure without calling sources', async () => {
  for (const failure of [null, Error('private connection string')]) {
    let ended = 0
    const createPool = () => ({ query: async () => { if (failure) throw failure; return { rows: [{ role: 'postgres' }] } }, end: async () => { ended++ } })
    await assert.rejects(() => runPublicDiscovery({ env: { PUBLIC_DISCOVERY_DATABASE_URL: 'postgres://d:fixture@localhost/db?sslmode=disable' },
      createPool, sources: { seeds: () => assert.fail('must not read sources') } }))
    assert.equal(ended, 1)
  }
})

test('standalone module graph and BUSY run do not load chain/signing/app modules', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    registerHooks({resolve(specifier, context, next) {
      if (/solana|meteora|market-config|run-worker/.test(specifier) || specifier.includes('/app/')) throw Error('FORBIDDEN_DEPENDENCY');
      return next(specifier, context);
    }});
    const {runPublicDiscovery}=await import('./scripts/run-public-discovery.mjs');
    let ended=false;
    const db={query:async()=>({rows:[{locked:false}]}),release(){}};
    const result=await runPublicDiscovery({env:{PUBLIC_DISCOVERY_DATABASE_URL:'postgres://d:fixture@localhost/db?sslmode=disable'},
      createPool:()=>({query:async()=>({rows:[{role:'repoing_public_discovery'}]}),connect:async()=>db,end:async()=>{ended=true}})});
    if(result.status!=='BUSY'||!ended)throw Error('BAD_RESULT');
  `], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 0, result.stderr)
})

test('source identity failures do not refresh candidate freshness or persist evidence', async () => {
  for (const bad of [{ private: true }, { id: 124 }, { archived: true }]) {
    const f = fixture({ known: [{ repoId: '123', fullName: 'owner/repo', state: 'detected' }] })
    const actual = createTrendSources({ now: () => time, pause: async () => {}, fetchImpl: async () => Response.json({
      id: 123, full_name: 'owner/repo', owner: { login: 'owner' }, name: 'repo', private: false,
      archived: false, stargazers_count: 10, forks_count: 2, ...bad,
    }) })
    const result = await createTrendIntake({ ...f, sources: { seeds: f.sources.seeds, observe: actual.observe }, discoveryOnly: true, now: () => time }).runOnce()
    assert.equal(result.results[0].status, 'UNAVAILABLE')
    assert.ok(!f.queries.some(q => q.sql.includes('insert into trend_candidates')))
    assert.ok(f.queries.some(q => q.sql.startsWith('update trend_candidates set error=')))
  }
})

test('one run observes at most five repositories, with no retry on source failure', async () => {
  const f = fixture()
  let observed = 0
  f.sources.seeds = async () => ({ health: seed.health, signals: Array.from({ length: 100 }, (_, n) => ({
    ...seed.signals[0], repository: `https://github.com/owner/repo${n}` })) })
  f.sources.observe = async () => { observed++; throw Error('SOURCE_RATE_LIMITED') }
  const result = await createTrendIntake({ ...f, discoveryOnly: true, now: () => time }).runOnce()
  assert.equal(observed, 5); assert.equal(result.results.length, 5)
  assert.ok(result.results.every(row => row.code === 'SOURCE_RATE_LIMITED'))
  assert.ok(!f.queries.some(q => q.sql.includes('insert into trend_observations')))
})

test('discovery rejects stale/future observations rather than replaying historical evidence', async () => {
  for (const delta of [-7 * 3600000, 120000]) {
    const f = fixture()
    f.sources.observe = async () => ({ ...observation(), observedAt: new Date(time + delta).toISOString() })
    const result = await createTrendIntake({ ...f, discoveryOnly: true, now: () => time }).runOnce()
    assert.equal(result.results[0].status, 'UNAVAILABLE')
    assert.ok(!f.queries.some(q => q.sql.includes('insert into trend_observations')))
  }
})

test('CLI hard deadline terminates a stalled database handshake with a redacted failure', async () => {
  const server = createServer(socket => socket.destroy())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    // Accelerate only the CLI's five-minute wall clock; leave connection/query timers unchanged.
    const preload = `const original=setTimeout;globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===300000?10:ms,...args)`
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, 'scripts/run-public-discovery.mjs'], {
      env: { PATH: process.env.PATH, PUBLIC_DISCOVERY_DATABASE_URL: `postgres://d:DO_NOT_PRINT@127.0.0.1:${server.address().port}/db?sslmode=disable` },
      encoding: 'utf8', timeout: 2000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /PUBLIC_DISCOVERY_DEADLINE/)
    assert.doesNotMatch(result.stderr + result.stdout, /DO_NOT_PRINT/)
  } finally { server.close() }
})
