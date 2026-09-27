import test from 'node:test'
import assert from 'node:assert/strict'
import { POST } from '../app/api/resolve/route.js'

test('an indexed market resolves during a GitHub API rate limit', async () => {
  const oldDatabaseUrl = process.env.DATABASE_URL
  const oldPool = globalThis.__gitfunPool
  const oldFetch = globalThis.fetch
  process.env.DATABASE_URL = 'postgres://test-only'
  globalThis.__gitfunPool = {
    async query(sql, params) {
      assert.match(sql, /m\.launch_finality = 'finalized'/)
      assert.deepEqual(params, ['New1Direction/OntologyEX'])
      return { rows: [{ repoId: '1266706783', mint: '3tcPoGD2xeZEkLYr3yMqtZxNQF5iThhsDjZ7u7TkJoSF' }] }
    },
  }
  globalThis.fetch = async () => { throw new Error('GitHub API rate limited') }
  try {
    const response = await POST(new Request('https://repo.ing/api/resolve', {
      method: 'POST', body: JSON.stringify({ url: 'github.com/New1Direction/OntologyEX' }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      repoId: '1266706783', mint: '3tcPoGD2xeZEkLYr3yMqtZxNQF5iThhsDjZ7u7TkJoSF',
    })
  } finally {
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = oldDatabaseUrl
    globalThis.__gitfunPool = oldPool
    globalThis.fetch = oldFetch
  }
})
