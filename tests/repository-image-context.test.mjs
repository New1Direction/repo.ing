import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { repositoryImageContext } from '../src/repository-image-context.mjs'
import { resolvePublicRepositoryById } from '../src/github.mjs'
import { POST } from '../app/api/repo-images/[repo]/route.js'

const id = '1086419061'
const github = { id: Number(id), name: 'hindsight', full_name: 'vectorize-io/hindsight',
  owner: { login: 'vectorize-io', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  private: false, visibility: 'public', archived: false, updated_at: '2026-09-28T00:00:00Z' }
const fetchRepo = (body = github, status = 200) => async () => new Response(JSON.stringify(body), { status })

for (const [name, body, status, message] of [
  ['private', { ...github, private: true }, 200, /Private/],
  ['archived', { ...github, archived: true }, 200, /Archived/],
  ['wrong identity', { ...github, id: 123 }, 200, /identity mismatch/],
  ['missing', {}, 404, /not found/],
  ['rate limited', {}, 403, /HTTP 403/],
]) {
  test(`fresh image context rejects ${name} without persisting`, async () => {
    const pool = { query: async sql => { assert.match(sql, /^select /); return { rows: [] } } }
    await assert.rejects(repositoryImageContext(pool, id, key => resolvePublicRepositoryById(key, fetchRepo(body, status))), message)
  })
}

test('direct launch image context verifies immutable ID and persists canonical repo', async () => {
  let saved
  const pool = { query: async (sql, args) => {
    if (sql.startsWith('select')) return { rows: [] }
    saved = args
    assert.match(sql, /on conflict \(github_repo_id\) do update/)
    return { rows: [] }
  } }
  const context = await repositoryImageContext(pool, id, key => resolvePublicRepositoryById(key, async url => {
    assert.equal(url, `https://api.github.com/repositories/${id}`)
    return fetchRepo()()
  }))
  assert.equal(context.record.name, 'hindsight')
  assert.deepEqual(saved.slice(0, 4), [id, 'vectorize-io', 'hindsight', 'vectorize-io/hindsight'])
})

test('already resolved image context avoids another GitHub lookup', async () => {
  const record = { owner: 'vectorize-io', name: 'hindsight', avatar_url: null, archived: false }
  const context = await repositoryImageContext({ query: async () => ({ rows: [record] }) }, id, () => { throw Error('Unexpected lookup') })
  assert.equal(context.record, record)
})

test('invalid IDs cannot trigger queries or external requests', async () => {
  await assert.rejects(repositoryImageContext({ query: () => { throw Error('Unexpected query') } }, '../other'), /Invalid repository/)
})

test('upload succeeds from an already-open direct launch with no repository row', async () => {
  const old = { origin: process.env.APP_ORIGIN, url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  let persisted = false
  process.env.APP_ORIGIN = 'https://repo.ing'
  process.env.DATABASE_URL = 'postgres://test-only'
  globalThis.__gitfunPool = { query: async sql => {
    if (sql.startsWith('select')) return { rows: [] }
    persisted = true
    return { rows: [] }
  } }
  globalThis.fetch = fetchRepo()
  try {
    const png = await sharp({ create: { width: 128, height: 128, channels: 3, background: '#22bb99' } }).png().toBuffer()
    const response = await POST(new Request(`https://repo.ing/api/repo-images/${id}`, {
      method: 'POST', headers: { origin: 'https://repo.ing', 'content-type': 'image/png' }, body: png,
    }), { params: Promise.resolve({ repo: id }) })
    const result = await response.json()
    assert.equal(response.status, 200, JSON.stringify(result))
    assert.equal(persisted, true)
    assert.match(result.image, /^data:image\/png;base64,/)
  } finally {
    if (old.origin === undefined) delete process.env.APP_ORIGIN
    else process.env.APP_ORIGIN = old.origin
    if (old.url === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = old.url
    globalThis.__gitfunPool = old.pool
    globalThis.fetch = old.fetch
  }
})
