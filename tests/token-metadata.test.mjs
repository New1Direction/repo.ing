import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenMetadataJson } from '../app/lib/token-metadata.mjs'

const mint = '59PXVfJ28HLYpdYLz8rt8ziE9EWbK4mS8xvq38NUQ1Be'
const origin = 'https://repo.ing'

test('repo.ing\'s own token gets the official description, the home page and repo.ing\'s X account', () => {
  const json = tokenMetadataJson({ mint, origin, market: { repoId: '1388219884', name: 'repo.ing', symbol: 'REPOING', hasImage: true, fullName: 'New1Direction/repo.ing' } })
  assert.equal(json.description, 'The official token of repo.ing, the market layer for open source. Every trade pays builders, and 60% of platform fees buy back $REPOING.')
  assert.doesNotMatch(json.description, /does not imply endorsement/)
  assert.equal(json.external_url, origin)
  assert.equal(json.website, origin)
  assert.equal(json.github, 'https://github.com/New1Direction/repo.ing')
  assert.equal(json.twitter, 'https://x.com/repodoting')
  assert.deepEqual(json.extensions, { website: json.website, github: json.github, twitter: json.twitter })
  assert.equal(json.image, `${origin}/api/token-image/${mint}`)
})

test('metadata without a synced repository keeps the numeric-id description and omits GitHub', () => {
  const json = tokenMetadataJson({ mint: 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A', origin, market: { repoId: '42', name: 'x', symbol: 'X', hasImage: false, fullName: null } })
  assert.equal(json.description, 'Token for public GitHub repository 42 on repo.ing.')
  assert.equal(json.github, undefined)
  assert.equal(json.image, `${origin}/api/repo-logo/42?v=4`)
})

test('community tokens for other repositories never carry repo.ing\'s X account', () => {
  const json = tokenMetadataJson({ mint: 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A', origin, market: { repoId: '9', name: 'x', symbol: 'X', hasImage: true, fullName: 'someone/project' } })
  assert.equal(json.twitter, undefined)
  assert.equal(json.extensions.twitter, undefined)
})

test('community tokens name their repository, keep the disclaimer and link their market page', () => {
  const other = 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A'
  const json = tokenMetadataJson({ mint: other, origin, market: { repoId: '9', name: 'x', symbol: 'X', hasImage: true, fullName: 'someone/project' } })
  assert.match(json.description, /^\$X is the repo\.ing market for github\.com\/someone\/project\./)
  assert.match(json.description, /does not imply endorsement/)
  assert.equal(json.external_url, `${origin}/token/${other}`)
  assert.equal(json.website, `${origin}/token/${other}`)
})

// The short link early access launches carry (/m/<GitHub repository id>) serves what /api/token-metadata/<mint> serves for that
// repository's market; anything but a GitHub repository id is refused before the database is read.
test('the short metadata link reads the market by repository id; the mint link by mint', async () => {
  const { GET: byRepo } = await import('../app/m/[id]/route.js')
  const { GET: byMint } = await import('../app/api/token-metadata/[mint]/route.js')
  const queries = [], mint = 'E859MeM9CYWAoQGcNLQYgg8qHPim1EQN4LYqveubrJ6A'
  let row = { mint, status: 'confirmed', repoId: '1296269', name: 'Hello', symbol: 'HELLO', hasImage: false, fullName: 'octocat/Hello-World', quoteAssetId: null }
  const sqls = []
  const saved = { url: process.env.DATABASE_URL, origin: process.env.APP_ORIGIN, pool: globalThis.__gitfunPool }
  Object.assign(process.env, { DATABASE_URL: 'postgres://unused', APP_ORIGIN: origin })
  globalThis.__gitfunPool = { query: async (sql, params) => { sqls.push(sql); queries.push([sql.match(/where (m\.\w+) = \$1/)[1], params]); return { rows: params[0] === '404' ? [] : [row] } } }
  try {
    const short = await byRepo(new Request('https://repo.ing/m/1296269'), { params: Promise.resolve({ id: '1296269' }) })
    assert.equal(short.status, 200)
    const json = await short.json()
    assert.deepEqual([json.name, json.symbol, json.external_url, json.github], ['Hello', 'HELLO', `${origin}/token/${mint}`, 'https://github.com/octocat/Hello-World'])
    assert.equal(short.headers.get('cache-control'), 'public, max-age=300')
    // By repository id: early access markets only, and only once the launch was sent (an id is guessable, an unsent mint is not).
    assert.match(sqls[0], /m\.early_access_end is not null and m\.status in \('submitted', 'confirmed', 'ambiguous'\)/)
    assert.doesNotMatch(sqls[0], /prepared/)
    const long = await byMint(new Request(`https://repo.ing/api/token-metadata/${mint}`), { params: Promise.resolve({ mint }) })
    assert.deepEqual(await long.json(), json)
    assert.match(sqls[1], /m\.mint = \$1 and m\.status in \('prepared', 'submitted', 'confirmed', 'ambiguous'\)/)
    assert.doesNotMatch(sqls[1], /early_access_end/)
    // A launch sent but not yet confirmed: served, never cached (a failed attempt's row is reused with a new mint).
    row = { ...row, status: 'submitted' }
    const sent = await byRepo(new Request('https://repo.ing/m/1296269'), { params: Promise.resolve({ id: '1296269' }) })
    assert.equal(sent.headers.get('cache-control'), 'no-store')
    assert.deepEqual(queries, [['m.github_repo_id', ['1296269']], ['m.mint', [mint]], ['m.github_repo_id', ['1296269']]])
    assert.equal((await byRepo(new Request('https://repo.ing/m/404'), { params: Promise.resolve({ id: '404' }) })).status, 404)
    for (const id of ['0', '01', 'abc', '1e9', '99999999999999999999', '4503599627370496']) {
      const refused = await byRepo(new Request(`https://repo.ing/m/${id}`), { params: Promise.resolve({ id }) })
      assert.equal(refused.status, 400, id)
    }
    assert.equal(queries.length, 4, 'a refused id reads nothing')
  } finally {
    for (const [name, value] of [['DATABASE_URL', saved.url], ['APP_ORIGIN', saved.origin]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
    globalThis.__gitfunPool = saved.pool
  }
})
