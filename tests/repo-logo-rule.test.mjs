import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { projectImage, repositoryImagesFromAssets, repositoryImagesFromReadme, repositoryLogoFromAssets, repositoryLogoFromReadme } from '../src/repo-logo.mjs'
import { appModule, offlineFetch } from './fixtures/render-jsx.mjs'

// Token logos (src/repo-logo.mjs, app/api/repo-logo/[repo]/route.js): a README image is the project's logo only when its file name
// or alt text names the repository or its owner, and once a market's logo is found it is kept (repositories.logo_url).
const raw = (owner, repo, path) => `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`
const readmeUrl = (owner, repo) => raw(owner, repo, 'README.md')
const OWNER = 'rynfar', NAME = 'meridian', AVATAR = 'https://avatars.githubusercontent.com/u/42?v=4'
// Without GitHub App settings the README is read anonymously (src/github-app-auth.mjs), so nothing here asks for a token.
async function withoutGithubApp(work) {
  const saved = Object.fromEntries(['GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_INSTALLATION_ID', 'GITHUB_APP_CLIENT_ID'].map(key => [key, process.env[key]]))
  for (const key of Object.keys(saved)) delete process.env[key]
  try { return await work() } finally { for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value }
}
// GitHub's README answer for rynfar/meridian.
const readmeResponse = markdown => Response.json({ encoding: 'base64', size: markdown.length, path: 'README.md',
  download_url: readmeUrl(OWNER, NAME), content: Buffer.from(markdown).toString('base64') })

test('project-logo rule: other projects\' logos are refused, the repository\'s own are accepted', () => {
  const own = (fileName, alt, owner, repo) => projectImage({ fileName, alt, owner, repo }).logo
  // $MERIDIAN (rynfar/meridian): Anthropic's logo in its providers table.
  assert.equal(own('claude.png', 'Claude logo', 'rynfar', 'meridian'), false)
  // $PAPERCLIP: OpenCode's logo among its adapters, with or without alt text.
  assert.equal(own('opencode-logo-light-square.svg', 'OpenCode', 'paperclipai', 'paperclip'), false)
  assert.equal(own('opencode-logo-light-square.svg', '', 'paperclipai', 'paperclip'), false)
  // A generic file name is the project's own logo unless its alt text names something else.
  assert.equal(own('logo.png', '', 'rynfar', 'meridian'), true)
  assert.equal(own('logo.png', 'Claude logo', 'rynfar', 'meridian'), false)
  assert.equal(own('LogoLight@2x.svg', 'logo', 'o', 'r'), true)
  assert.equal(own('logolight.svg', '', 'o', 'r'), true)
  // Named for the repository (case and separators do not matter) or its owner.
  assert.equal(own('meridian-logo.svg', '', 'rynfar', 'meridian'), true)
  assert.equal(own('Paperclip_Logo-Dark.png', '', 'paperclipai', 'paperclip'), true)
  assert.equal(own('repoing-mark.svg', '', 'New1Direction', 'repo.ing'), true)
  assert.equal(own('header.png', 'Meridian logo', 'rynfar', 'meridian'), true)
  assert.equal(own('rynfar-icon.png', '', 'rynfar', 'meridian'), true)
  assert.equal(own('meridian.svg', '', 'rynfar', 'meridian'), true)
  // Someone else's brand is not generic, and a short name must be a whole word.
  assert.equal(own('github-logo.png', '', 'o', 'r'), false)
  assert.equal(own('guide-logo.png', '', 'o', 'ui'), false)
  assert.equal(own('ui-logo.png', '', 'o', 'ui'), true)
})

test('a logo that names the brand in shorter form than the slug passes; another product\'s name still does not', () => {
  const pass = (repo, owner, fileName, alt) => assert.deepEqual(projectImage({ repo, owner, fileName, alt }), { own: true, logo: true }, `${repo} ${fileName}`)
  pass('polkadot-sdk', 'paritytech', 'Polkadot_Logo_Pink.png', 'Polkadot')
  pass('turborepo', 'vercel', 'turbo-logo.svg', 'Turbo')
  pass('react-native-reanimated', 'software-mansion', 'logo.svg', 'Reanimated')
  pass('widgets', 'acme-inc', 'acme-logo.png', 'Acme')
  for (const [repo, owner, fileName, alt] of [['meridian', 'rynfar', 'claude.png', 'Claude logo'], ['paperclip', 'paperclipai', 'opencode-logo-light-square.svg', ''],
    ['openai-tools', 'someone', 'open-source-logo.png', ''], ['turborepo', 'vercel', 'turf-logo.svg', 'Turf']]) {
    assert.deepEqual(projectImage({ repo, owner, fileName, alt }), { own: false, logo: false }, `${repo} ${fileName}`)
  }
})

test('an image that names the project but is not a logo is never picked automatically', () => {
  const image = projectImage({ fileName: 'four-pillars-light.png', alt: 'The four pillars of Paperclip', owner: 'paperclipai', repo: 'paperclip' })
  assert.deepEqual(image, { own: true, logo: false })
  assert.deepEqual(projectImage({ fileName: 'desktop-dashboard.jpg', alt: 'Meridian Desktop showing usage limits', owner: 'rynfar', repo: 'meridian' }),
    { own: true, logo: false })
})

test('$MERIDIAN and $PAPERCLIP READMEs as they are today: no automatic logo, so the owner avatar stays', () => {
  const meridian = `<img src="assets/banner.svg" alt="Meridian — Claude and Antigravity, in your tools." width="920" />
<img src="https://img.shields.io/npm/v/@rynfar/meridian?style=flat-square" alt="npm version" />
<img src="assets/providers/claude.png" width="40" alt="Claude logo" />
<img src="assets/providers/antigravity.png" width="40" alt="Antigravity logo" />
<img src="assets/desktop-dashboard.jpg" alt="Meridian Desktop showing usage limits, cache activity and recent requests. Sample data." />
<img src="assets/how-it-works.svg" alt="Pi, OpenCode and other supported clients connect to Meridian." />`
  assert.equal(repositoryLogoFromReadme(meridian, readmeUrl('rynfar', 'meridian'), 'meridian', 'rynfar'), null)
  const images = repositoryImagesFromReadme(meridian, readmeUrl('rynfar', 'meridian'), 'meridian', 'rynfar')
  assert.ok(images.some(item => item.url.endsWith('/claude.png')), 'still a choice for a launcher')
  assert.ok(images.every(item => !item.logo && item.label === 'README image'))

  const paperclip = `<img src="doc/assets/banner.jpg" alt="Paperclip is the app people use to manage AI agents for work." />
<img src="doc/assets/logos/claude.svg" width="32" height="32" alt="Claude Code" />
<img src="ui/public/brands/opencode-logo-light-square.svg" width="32" height="32" alt="OpenCode" />
<img src="https://raw.githubusercontent.com/paperclipai/paperclip/1ec33ff/doc/assets/four-pillars-light.png" alt="The four pillars of Paperclip">`
  assert.equal(repositoryLogoFromReadme(paperclip, readmeUrl('paperclipai', 'paperclip'), 'paperclip', 'paperclipai'), null)
})

test('the repository\'s own logo is picked first, ahead of other projects\' logos', () => {
  const readme = `![Claude logo](assets/providers/claude.png)
![Meridian logo](assets/meridian-wordmark-dark.png)
![](assets/logo.png)`
  const images = repositoryImagesFromReadme(readme, readmeUrl('rynfar', 'meridian'), 'meridian', 'rynfar')
  assert.deepEqual(images.map(item => [item.url.split('/').pop(), item.logo, item.label]), [
    ['meridian-wordmark-dark.png', true, 'Project logo'], ['logo.png', true, 'Project logo'], ['claude.png', false, 'README image']])
  assert.equal(repositoryLogoFromReadme(readme, readmeUrl('rynfar', 'meridian'), 'meridian', 'rynfar'), raw('rynfar', 'meridian', 'assets/meridian-wordmark-dark.png'))
  assert.equal(repositoryLogoFromReadme('<img src="./paperclip-logo.svg">', readmeUrl('paperclipai', 'paperclip'), 'paperclip', 'paperclipai'),
    raw('paperclipai', 'paperclip', 'paperclip-logo.svg'))
})

test('asset-directory logos follow the same rule', () => {
  const entry = name => ({ type: 'file', name, download_url: raw('rynfar', 'meridian', `assets/${name}`) })
  const entries = [entry('claude-icon.png'), entry('antigravity-logo.png'), entry('logo-mark.png')]
  assert.equal(repositoryLogoFromAssets(entries, { owner: 'rynfar', name: 'meridian' }), raw('rynfar', 'meridian', 'assets/logo-mark.png'))
  assert.equal(repositoryLogoFromAssets(entries.slice(0, 2), { owner: 'rynfar', name: 'meridian' }), null)
  assert.deepEqual(repositoryImagesFromAssets(entries.slice(0, 1), { owner: 'rynfar', name: 'meridian' }).map(item => [item.logo, item.label]),
    [[false, 'Repository image']])
  assert.equal(repositoryLogoFromAssets([entry('meridian-icon.png')], { owner: 'rynfar', name: 'meridian' }), raw('rynfar', 'meridian', 'assets/meridian-icon.png'))
})

test('the launch form preselects only the project\'s own logo; other README images come after the owner avatar', async () => {
  const { repositoryImageSuggestions } = await import('../app/lib/repo-images.mjs')
  // Distinct artwork per URL (the suggestions are deduplicated by their bytes).
  const colors = new Map()
  const png = async url => {
    if (!colors.has(url)) colors.set(url, `#${(0x204060 + colors.size * 0x101010).toString(16)}`)
    return new Response(await sharp({ create: { width: 64, height: 64, channels: 3, background: colors.get(url) } }).png().toBuffer(),
      { headers: { 'content-type': 'image/png' } })
  }
  const suggest = async (repoId, markdown) => {
    const net = offlineFetch([[/^https:\/\/api\.github\.com\/repos\/rynfar\/meridian\/readme$/, () => readmeResponse(markdown)],
      [/^https:\/\/(?:raw|avatars)\.githubusercontent\.com\//, png]])
    try { return (await withoutGithubApp(() => repositoryImageSuggestions(repoId, { owner: OWNER, name: NAME, avatar_url: AVATAR })))
      .map(item => [item.label, item.source.split('/').pop()]) } finally { net.restore() }
  }
  const claude = '<img src="assets/providers/claude.png" width="40" alt="Claude logo" />'
  // $MERIDIAN today: the owner avatar is preselected; Anthropic's logo is still offered, after it.
  assert.deepEqual(await suggest('900101', claude), [['Owner avatar', '42?v=4'], ['README image', 'claude.png']])
  assert.deepEqual(await suggest('900102', `${claude}\n![Meridian logo](assets/meridian-logo.png)`),
    [['Project logo', 'meridian-logo.png'], ['Owner avatar', '42?v=4'], ['README image', 'claude.png']])
})

// The logo route against a fake pool and GitHub: what it stores, and what it never stores.
const { GET: repoLogo } = await appModule('app/api/repo-logo/[repo]/route.js')

function fakeRepositories(rows) {
  const queries = []
  return { queries, rows, query: async (sql, params = []) => {
    queries.push(sql)
    const row = rows.get(String(params[0]))
    if (/^select r\.owner/.test(sql.trim())) return { rows: row ? [{ owner: OWNER, name: NAME, avatar_url: AVATAR, ...row }] : [] }
    if (/^update repositories set logo_url = null/.test(sql.trim())) {
      if (row && row.logo_url === params[1]) { row.logo_url = null; return { rows: [], rowCount: 1 } }
      return { rows: [], rowCount: 0 }
    }
    if (/^update repositories set logo_url/.test(sql.trim())) {
      if (!row || row.logo_url) return { rows: [] }
      row.logo_url = params[1]
      return { rows: [{ logo_url: params[1] }] }
    }
    if (/^select logo_url from repositories/.test(sql.trim())) return { rows: row ? [{ logo_url: row.logo_url }] : [] }
    throw Error(`unexpected query: ${sql}`)
  } }
}

async function withLogoRoute(rows, readme, work, routes = []) {
  const saved = { url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool }
  const pool = fakeRepositories(rows)
  process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
  globalThis.__gitfunPool = pool
  const net = offlineFetch([[/^https:\/\/api\.github\.com\/repos\/rynfar\/meridian\/readme$/, () => readme()], ...routes])
  const logo = async repo => (await repoLogo(new Request(`https://repo.ing/api/repo-logo/${repo}?v=3`), { params: Promise.resolve({ repo }) })).headers.get('location')
  try { return await withoutGithubApp(() => work({ logo, pool, net })) } finally {
    net.restore()
    globalThis.__gitfunPool = saved.pool
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url
  }
}

test('a launched market keeps the first logo that passes the rule; a README edit does not change it', async () => {
  const rows = new Map([['900001', { launched: true, logo_url: null }], ['900002', { launched: true, logo_url: raw(OWNER, NAME, 'assets/meridian-logo.png') }]])
  let markdown = '![Meridian logo](assets/meridian-logo.png)'
  await withLogoRoute(rows, () => readmeResponse(markdown), async ({ logo, pool, net }) => {
    assert.equal(await logo('900001'), raw(OWNER, NAME, 'assets/meridian-logo.png'))
    assert.equal(rows.get('900001').logo_url, raw(OWNER, NAME, 'assets/meridian-logo.png'), 'pinned')
    assert.ok(pool.queries.some(sql => /logo_pinned_at = now\(\)/.test(sql)))
    // Already pinned: served as stored, without reading the README, even after the README now shows another logo. (The only
    // request is the check that the kept file still exists; offline it fails, and a failed check keeps the logo.)
    markdown = '![Meridian](assets/meridian-2.png)'
    const before = net.requested.length
    assert.equal(await logo('900002'), raw(OWNER, NAME, 'assets/meridian-logo.png'))
    assert.deepEqual(net.requested.slice(before), [raw(OWNER, NAME, 'assets/meridian-logo.png')], 'no README read for a pinned logo')
  })
})

test('a kept logo that GitHub answers 404 for is let go and read again; an error or another answer keeps it', async () => {
  const gone = raw(OWNER, NAME, 'assets/old-logo.png'), now = raw(OWNER, NAME, 'assets/meridian-logo.png')
  const rows = new Map([['900011', { launched: true, logo_url: gone }], ['900012', { launched: true, logo_url: gone }],
    ['900013', { launched: true, logo_url: gone }]])
  const status = new Map([['900011', 404], ['900013', 503]])
  let asking = null
  await withLogoRoute(rows, () => readmeResponse('![Meridian logo](assets/meridian-logo.png)'), async ({ logo }) => {
    // 404: unpinned, the README is read again, and its logo is kept instead.
    asking = '900011'
    assert.equal(await logo('900011'), now)
    assert.equal(rows.get('900011').logo_url, now)
    // A network error (offline here) and a 503 keep the stored logo: an outage never unpins.
    asking = '900012'
    assert.equal(await logo('900012'), gone)
    asking = '900013'
    assert.equal(await logo('900013'), gone)
    assert.equal(rows.get('900013').logo_url, gone)
  }, [[/assets\/old-logo\.png$/, (url, init) => {
    assert.equal(init?.method, 'HEAD')
    if (asking === '900012') throw new TypeError('offline')
    return new Response(null, { status: status.get(asking) })
  }]])
})

test('a concurrent resolution that pinned first wins', async () => {
  const rows = new Map([['900003', { launched: true, logo_url: null }]])
  await withLogoRoute(rows, () => readmeResponse('![Meridian logo](assets/meridian-new.png)'), async ({ logo, pool }) => {
    const query = pool.query
    pool.query = async (sql, params) => {
      // Another request stores its logo between this request's read and its write.
      if (/^update repositories/.test(sql.trim())) rows.get('900003').logo_url = raw(OWNER, NAME, 'assets/meridian-old.png')
      return query(sql, params)
    }
    assert.equal(await logo('900003'), raw(OWNER, NAME, 'assets/meridian-old.png'))
  })
})

test('the owner-avatar fallback is never stored: other projects\' logos, an outage, no market', async () => {
  const rows = new Map([['900004', { launched: true, logo_url: null }], ['900005', { launched: true, logo_url: null }],
    ['900006', { launched: false, logo_url: null }], ['900007', { launched: true, logo_url: null }]])
  // $MERIDIAN today: only other projects' logos.
  await withLogoRoute(rows, () => readmeResponse('<img src="assets/providers/claude.png" width="40" alt="Claude logo" />'), async ({ logo, pool }) => {
    assert.equal(await logo('900004'), AVATAR)
    assert.equal(rows.get('900004').logo_url, null)
    assert.ok(!pool.queries.some(sql => /^update/.test(sql.trim())))
  })
  // GitHub down (and a README read refused): the avatar, nothing stored, so the real logo is pinned once GitHub answers.
  await withLogoRoute(rows, () => new Response('unavailable', { status: 503 }), async ({ logo, pool }) => {
    assert.equal(await logo('900005'), AVATAR)
    assert.ok(!pool.queries.some(sql => /^update/.test(sql.trim())))
  })
  await withLogoRoute(rows, () => { throw new TypeError('fetch failed') }, async ({ logo, pool }) => {
    assert.equal(await logo('900007'), AVATAR)
    assert.ok(!pool.queries.some(sql => /^update/.test(sql.trim())))
  })
  assert.equal(rows.get('900005').logo_url, null)
  assert.equal(rows.get('900007').logo_url, null)
  // No market yet: the README logo is shown but not stored (the README may still change before launch).
  await withLogoRoute(rows, () => readmeResponse('![](assets/logo.png)'), async ({ logo, pool }) => {
    assert.equal(await logo('900006'), raw(OWNER, NAME, 'assets/logo.png'))
    assert.equal(rows.get('900006').logo_url, null)
    assert.ok(!pool.queries.some(sql => /^update/.test(sql.trim())))
  })
})

test('a README lockup is stored as the mark beside it, and never in its place when that directory cannot be read', async () => {
  const rows = new Map([['900008', { launched: true, logo_url: null }], ['900009', { launched: true, logo_url: null }]])
  const lockup = () => readmeResponse('![Meridian](assets/meridian-lockup.png)')
  const directory = /^https:\/\/api\.github\.com\/repos\/rynfar\/meridian\/contents\/assets$/
  await withLogoRoute(rows, lockup, async ({ logo, pool }) => {
    assert.equal(await logo('900008'), raw(OWNER, NAME, 'assets/meridian-lockup.png'), 'shown for now')
    assert.equal(rows.get('900008').logo_url, null, 'not stored')
    assert.ok(!pool.queries.some(sql => /^update/.test(sql.trim())))
  }, [[directory, () => new Response('rate limited', { status: 403 })]])
  const entry = name => ({ type: 'file', name, download_url: raw(OWNER, NAME, `assets/${name}`) })
  await withLogoRoute(rows, lockup, async ({ logo }) => {
    assert.equal(await logo('900009'), raw(OWNER, NAME, 'assets/meridian-mark.png'))
    assert.equal(rows.get('900009').logo_url, raw(OWNER, NAME, 'assets/meridian-mark.png'))
  }, [[directory, () => Response.json([entry('meridian-lockup.png'), entry('claude-icon.png'), entry('meridian-mark.png')])]])
})

test('migration 0064 adds the two nullable logo columns, appended last with the largest journal time', () => {
  const sql = readFileSync('drizzle/0064_repository_logos.sql', 'utf8')
  assert.match(sql, /ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "logo_url" text;/)
  assert.match(sql, /ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "logo_pinned_at" timestamptz;/)
  assert.doesNotMatch(sql, /UPDATE|DELETE|DROP/i)
  const { entries } = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8'))
  const last = entries.at(-1)
  assert.equal(last.tag, '0064_repository_logos')
  assert.ok(entries.slice(0, -1).every(entry => entry.when < last.when))
})
