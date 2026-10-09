import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { register } from 'node:module'

// The consent page of the repo.ing AI credits handoff (app/(site)/handoff/page.jsx) in each state, rendered offline: its cookies
// and the live admin check come from the test (next/headers and app/lib/github-session.mjs stubbed), the repository from a
// scripted database.
register(`data:text/javascript,${encodeURIComponent(`
const STUBS = {
  'next/headers': 'export const cookies = async () => ({ get: name => globalThis.__handoffCookies?.[name] === undefined ? undefined : { value: globalThis.__handoffCookies[name] } })',
  'github-session': 'export const sessionVerifier = () => ({ verifyRepositoryAdmin: async () => ({ admin: Boolean(globalThis.__handoffAdmin) }), verifyCurrentAuthority: async () => { throw new Error("the page never records a check") } })',
  'server': 'export const database = () => ({}); export const marketByRepo = async id => ({ market: globalThis.__handoffMarket === false ? null : { repoId: id } }); export const repositoryById = async () => ({ fullName: "octo/widget" })',
}
export async function resolve(specifier, context, next) {
  const name = specifier === 'next/headers' || specifier === 'next/headers.js' ? 'next/headers' : /\\/lib\\/github-session\\.mjs$/.test(specifier) ? 'github-session'
    : /^\\.\\.?\\/(\\.\\.\\/)*(lib\\/)?server\\.mjs$/.test(specifier) && context.parentURL?.includes('/app/') ? 'server' : null
  if (name) return { url: 'repoing-test:' + name, shortCircuit: true }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!url.startsWith('repoing-test:')) return next(url, context)
  return { format: 'module', shortCircuit: true, source: STUBS[url.slice('repoing-test:'.length)] }
}`)}`)
const { appModule, html } = await import('./fixtures/render-jsx.mjs')

const KEYS = ['DATABASE_URL', 'GITHUB_APP_CLIENT_SECRET', 'REPO_INFERENCE_HANDOFF_ENABLED', 'REPO_INFERENCE_HANDOFF_SECRET', 'HANDOFF_ASSERTION_SECRET', 'APP_ORIGIN']
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]))
Object.assign(process.env, { DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused', GITHUB_APP_CLIENT_SECRET: randomBytes(32).toString('hex'),
  REPO_INFERENCE_HANDOFF_ENABLED: 'true', REPO_INFERENCE_HANDOFF_SECRET: 'a'.repeat(32), HANDOFF_ASSERTION_SECRET: 'b'.repeat(32), APP_ORIGIN: 'https://repo.ing' })
globalThis.__gitfunPool = { query: async sql => /from repositories/.test(sql)
  ? { rows: [{ repoId: '77', owner: 'octo', name: 'widget', fullName: 'octo/widget', description: null, avatarUrl: null, stars: 5, forks: 0, updatedAt: new Date() }] } : { rows: [] } }
test.after(() => {
  delete globalThis.__gitfunPool; delete globalThis.__handoffCookies; delete globalThis.__handoffAdmin
  for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
})
const { encryptGithubSession, githubSessionCookie } = await appModule('app/lib/auth.mjs')
const { HANDOFF_COOKIE, sealHandoffRequest } = await appModule('app/lib/handoff.mjs')
const { default: HandoffPage } = await appModule('app/(site)/handoff/page.jsx')
const request = sealHandoffRequest({ audience: 'repo-inference', repoId: '77', challenge: 'c'.repeat(43), port: 54321, state: 's'.repeat(22) })
const session = encryptGithubSession({ scope: 'builders', repoId: null, permission: 'identity', githubUserId: '583231', githubLogin: 'octocat',
  accessToken: 'ghu_test_only', sessionId: randomBytes(24).toString('hex'), expiresAt: Date.now() + 60_000 })
const render = async (cookies, admin = false) => { globalThis.__handoffCookies = cookies; globalThis.__handoffAdmin = admin; return html(await HandoffPage(), { wallet: true }) }

test('the consent page: expired, sign in, not an admin, and the approval that names what is shared', async () => {
  assert.match(await render({}), /This sign-in request expired or was already used\. Run <code>repoing claim<\/code> again\./)
  const signIn = await render({ [HANDOFF_COOKIE]: request })
  assert.match(signIn, /asks repo\.ing to confirm that you are an admin of <strong>octo\/widget<\/strong>/)
  assert.match(signIn, /href="\/api\/github\/start\?mode=handoff"[^>]*>Sign in with GitHub/)
  assert.doesNotMatch(signIn, /Approve/)
  const notAdmin = await render({ [HANDOFF_COOKIE]: request, [githubSessionCookie]: session }, false)
  assert.match(notAdmin, /Not an admin of octo\/widget/)
  assert.match(notAdmin, /<strong>@octocat<\/strong> as an admin of octo\/widget/)
  assert.doesNotMatch(notAdmin, /value="approve"/)
  globalThis.__handoffMarket = false
  assert.match(await render({ [HANDOFF_COOKIE]: request, [githubSessionCookie]: session }, true), /Not an admin of octo\/widget/, 'no market: no approval')
  globalThis.__handoffMarket = true
  const consent = await render({ [HANDOFF_COOKIE]: request, [githubSessionCookie]: session }, true)
  assert.match(consent, /Signed in as @octocat/)
  assert.match(consent, /<li>your GitHub user ID and login<\/li><li>that you are an admin of octo\/widget<\/li><li class="handoff-not">not your GitHub token, and nothing that can move your funds<\/li>/)
  assert.match(consent, /Check code <strong>[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}<\/strong>: approve only if your terminal shows the same code/)
  const form = consent.match(/<form[^>]*>.*?<\/form>/s)[0]
  assert.match(form, /<input type="hidden" name="consent" value="[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"\/>/, 'the sealed copy of what the page showed')
  assert.match(form, /action="\/api\/handoff\/approve"/)
  assert.match(form, /method="post"/)
  assert.match(form, /<button class="button primary" type="submit" (?=[^>]*value="approve")(?=[^>]*name="decision")[^>]*>Approve<\/button>/)
  assert.match(form, /<button class="button" type="submit" (?=[^>]*value="deny")(?=[^>]*name="decision")[^>]*>Cancel<\/button>/)
  assert.match(consent, /returns to the CLI on this computer \(127\.0\.0\.1:(<!-- -->)?54321(<!-- -->)?\)/)
})

const notFound = error => /NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/.test(error.digest ?? error.message)

test('dark: not found without the handoff secrets', async () => {
  delete process.env.HANDOFF_ASSERTION_SECRET
  await assert.rejects(render({ [HANDOFF_COOKIE]: request }), notFound)
  process.env.HANDOFF_ASSERTION_SECRET = 'b'.repeat(32)
})

test('dark: not found with every secret set while the switch is off (hidden until AI credits start)', async () => {
  for (const enabled of [undefined, 'false', 'TRUE', '1']) {
    if (enabled === undefined) delete process.env.REPO_INFERENCE_HANDOFF_ENABLED
    else process.env.REPO_INFERENCE_HANDOFF_ENABLED = enabled
    await assert.rejects(render({}), notFound, String(enabled))
    await assert.rejects(render({ [HANDOFF_COOKIE]: request, [githubSessionCookie]: session }, true), notFound, String(enabled))
  }
  process.env.REPO_INFERENCE_HANDOFF_ENABLED = 'true'
  assert.match(await render({}), /Run <code>repoing claim<\/code> again/)
})
