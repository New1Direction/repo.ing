import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { STREAM_PLATFORMS, createRepoStreams, parseStreamUrl, readRepoStream, streamView } from '../src/repo-streams.mjs'
import { encryptGithubSession } from '../app/lib/auth.mjs'
import * as route from '../app/api/builders/stream/route.js'

test('stream links: https only, allowlisted hosts exactly, a real path, canonical form', () => {
  const accepted = {
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    ' https://youtube.com/@builder/live ': 'https://youtube.com/@builder/live',
    'https://youtu.be/dQw4w9WgXcQ#t=30': 'https://youtu.be/dQw4w9WgXcQ',
    'https://TWITCH.tv/builder': 'https://twitch.tv/builder',
    'https://www.twitch.tv/builder': 'https://www.twitch.tv/builder',
    'https://x.com/i/broadcasts/1abcDEF': 'https://x.com/i/broadcasts/1abcDEF',
    'https://kick.com/builder': 'https://kick.com/builder',
  }
  for (const [input, href] of Object.entries(accepted)) assert.equal(parseStreamUrl(input), href)
  assert.deepEqual(Object.keys(STREAM_PLATFORMS).sort(), ['kick.com', 'twitch.tv', 'www.twitch.tv', 'www.youtube.com', 'x.com', 'youtu.be', 'youtube.com'])
  for (const input of ['http://twitch.tv/builder', 'https://twitch.tv', 'https://twitch.tv/', 'https://twitch.tv/?ref=1', 'https://m.youtube.com/watch?v=1',
    'https://twitter.com/builder', 'https://www.x.com/builder', 'https://youtube.com.evil.example/live', 'https://evil.example/https://youtube.com/live',
    'https://twitch.tv@evil.example/builder', 'https://user:pass@twitch.tv/builder', 'https://twitch.tv:8443/builder', 'https://twitch.tv./builder',
    'https://xn--twtch-pya.tv/builder', 'javascript:alert(1)//twitch.tv/x', 'data:text/html,<a>', 'twitch.tv/builder', '//twitch.tv/builder', '', '   ', null, 42, {}]) {
    assert.throws(() => parseStreamUrl(input), /https link|limited/, String(input))
  }
  assert.throws(() => parseStreamUrl(`https://kick.com/${'a'.repeat(290)}`), /300 characters/)
  assert.equal(parseStreamUrl(`https://kick.com/${'a'.repeat(283)}`).length, 300)
})

test('a stream is live only until its window ends; a stored link that fails the rules is never shown', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const row = until => ({ url: 'https://twitch.tv/builder', liveUntil: until })
  assert.deepEqual(streamView(row(new Date(now + 60_000)), now), { url: 'https://twitch.tv/builder', platform: 'Twitch', live: true, liveUntil: '2026-10-01T12:01:00.000Z' })
  assert.deepEqual(streamView(row(new Date(now)), now), { url: 'https://twitch.tv/builder', platform: 'Twitch', live: false, liveUntil: null })
  assert.equal(streamView(row(null), now).live, false)
  assert.equal(streamView({ url: 'https://youtu.be/abc', liveUntil: null }, now).platform, 'YouTube')
  assert.equal(streamView({ url: 'https://evil.example/live', liveUntil: null }, now), null)
  assert.equal(streamView(undefined, now), null)
})

const ADMIN = { verified: true, permission: 'admin', githubRepoId: 77n, githubUserId: 9001n, verifiedAt: new Date() }
function fakePool(rows = [{ url: 'https://twitch.tv/builder', liveUntil: null }]) {
  const queries = []
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return { rows } } }
}

test('every change needs a fresh (≤60 s) admin result for exactly this repository; a bad link never reaches GitHub', async () => {
  let checks = 0
  const verify = result => async ({ githubRepoId }) => { checks++; assert.equal(githubRepoId, 77n); return result }
  const pool = fakePool(), streams = createRepoStreams({ pool })
  await assert.rejects(streams.save({ githubRepoId: '77', url: 'https://evil.example/live', verifyAuthority: verify(ADMIN) }), /https link/)
  assert.equal(checks, 0)
  for (const result of [null, { ...ADMIN, verified: false }, { ...ADMIN, permission: 'write' }, { ...ADMIN, githubRepoId: 78n }, { ...ADMIN, githubUserId: undefined },
    { ...ADMIN, verifiedAt: undefined }, { ...ADMIN, verifiedAt: new Date(Date.now() - 61_000) }]) {
    await assert.rejects(streams.save({ githubRepoId: '77', url: 'https://twitch.tv/builder', verifyAuthority: verify(result) }), /admin permission/)
    await assert.rejects(streams.setLive({ githubRepoId: '77', live: true, verifyAuthority: verify(result) }), /admin permission/)
    await assert.rejects(streams.remove({ githubRepoId: '77', verifyAuthority: verify(result) }), /admin permission/)
  }
  await assert.rejects(streams.save({ githubRepoId: '0', url: 'https://twitch.tv/builder', verifyAuthority: verify(ADMIN) }), /Invalid repository/)
  await assert.rejects(streams.setLive({ githubRepoId: '77', live: 'yes', verifyAuthority: verify(ADMIN) }), /Invalid live state/)
  assert.equal(pool.queries.length, 0, 'nothing is written without authority')

  assert.deepEqual(await streams.save({ githubRepoId: '77', url: 'https://twitch.tv/builder#x', verifyAuthority: verify(ADMIN) }),
    { url: 'https://twitch.tv/builder', platform: 'Twitch', live: false, liveUntil: null })
  assert.deepEqual(pool.queries.at(-1).params, ['77', 'https://twitch.tv/builder', '9001'])
  await streams.setLive({ githubRepoId: '77', live: true, verifyAuthority: verify(ADMIN) })
  assert.deepEqual(pool.queries.at(-1).params, ['77', true, '9001', 6])
  await streams.remove({ githubRepoId: '77', verifyAuthority: verify(ADMIN) })
  assert.match(pool.queries.at(-1).sql, /^delete from repo_streams/)
  await assert.rejects(createRepoStreams({ pool: fakePool([]) }).setLive({ githubRepoId: '77', live: true, verifyAuthority: verify(ADMIN) }), /Add a stream link first/)
  assert.equal(await readRepoStream(fakePool(), 'not-a-repo'), null)
})

test('stream HTTP boundary: same-origin POST with the GitHub session for this repository; public read-only GET', async t => {
  const old = { ...process.env }, oldPool = globalThis.__gitfunPool
  t.after(() => {
    for (const key of ['GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET', 'APP_ORIGIN', 'DATABASE_URL']) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key] }
    globalThis.__gitfunPool = oldPool
  })
  process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test-only'; process.env.GITHUB_APP_CLIENT_SECRET = randomBytes(32).toString('hex'); process.env.APP_ORIGIN = 'https://repo.ing'
  process.env.DATABASE_URL = 'postgres://test-only'
  const writes = []
  globalThis.__gitfunPool = { query: async (sql, params) => {
    if (!/^select url/.test(sql)) writes.push(sql)
    return { rows: [{ url: 'https://kick.com/builder', liveUntil: new Date(Date.now() + 3_600_000) }] }
  } }
  const session = repoId => encryptGithubSession({ repoId, permission: 'admin', githubUserId: '123', accessToken: 'ghu_test_only',
    sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
  const post = (cookie, body, origin = 'https://repo.ing') => route.POST({ url: 'https://repo.ing/api/builders/stream', headers: new Headers({ origin }),
    cookies: { get: () => cookie ? { value: cookie } : undefined }, json: async () => body })
  const save = { action: 'save', repoId: '77', url: 'https://kick.com/builder' }
  for (const [response, status] of [[await post(undefined, save), 403], [await post(session('77'), save, 'https://evil.example'), 403],
    [await post(session('78'), save), 403], [await post(session('77'), { ...save, action: 'rename' }), 400],
    [await post(session('77'), { ...save, url: 'http://kick.com/builder' }), 400]]) {
    assert.equal(response.status, status)
    assert.match(response.headers.get('cache-control'), /no-store/)
    assert.ok((await response.json()).error)
  }
  assert.equal(writes.length, 0)
  const read = await route.GET(new Request('https://repo.ing/api/builders/stream?repo=77'))
  assert.equal(read.status, 200)
  const { stream } = await read.json()
  assert.deepEqual([stream.url, stream.platform, stream.live], ['https://kick.com/builder', 'Kick', true])
  assert.equal((await route.GET(new Request('https://repo.ing/api/builders/stream?repo=abc'))).status, 400)
})
