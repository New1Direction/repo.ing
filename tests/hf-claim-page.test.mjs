import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { register } from 'node:module'
import { Keypair } from '@solana/web3.js'
import { appModule, html, offlineFetch, resolveServer } from './fixtures/render-jsx.mjs'
import { HF_DISCLAIMER } from '../src/hf-copy.mjs'

// /claim/<id> for a Hugging Face model market id returns the model claim page (Hugging Face sign-in) before anything
// GitHub-specific runs. The GitHub claim page asks GitHub about the repository's owner/name (its App installation, and a
// metadata refresh scheduled with after()), so neither may happen for a model. Rendered against a fake read-only pool,
// outside a Next request: cookies() is a signed-out visitor's empty jar, after() records its task, and every fetch is
// offline. The control shows the same render does reach GitHub for a GitHub market.
register(`data:text/javascript,${encodeURIComponent(`
const STUBS = {
  'next/headers': 'export const cookies = async () => ({ get: () => undefined, getAll: () => [], has: () => false })',
  'next/server': 'export const after = task => { (globalThis.__repoingTestAfter ??= []).push(task) }',
}
export async function resolve(specifier, context, next) {
  const name = specifier.replace(/\\.js$/, '')
  if (STUBS[name]) return { url: 'repoing-test:' + name, shortCircuit: true }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (!url.startsWith('repoing-test:')) return next(url, context)
  return { format: 'module', shortCircuit: true, source: STUBS[url.slice('repoing-test:'.length)] }
}`)}`)

const MODEL_ID = '4503599627370497', GITHUB_ID = '1384142611'
const row = (repoId, source, owner, name) => ({ repoId, mint: Keypair.generate().publicKey.toBase58(), pool: Keypair.generate().publicKey.toBase58(),
  tokenName: name, symbol: 'TOKEN', indexedAt: new Date(), allocationVersion: null, discoveryVersion: null, launcherWallet: Keypair.generate().publicKey.toBase58(),
  verificationBonusLamports: null, owner, name, fullName: `${owner}/${name}`, description: null, avatarUrl: null, source, stars: 0, forks: 0, updatedAt: null,
  githubCreatedAt: null, beneficiaryWallet: null, beneficiaryBoundAt: null, beneficiaryMethod: null, earned: '0', claimed: '0', volume24hLamports: '0',
  wasVerified: false, lastSqrtPrice: null, graduationStatus: null, observation: null, graduationError: null, migrationEvidenceHash: null })
const MARKETS = { [MODEL_ID]: row(MODEL_ID, 'huggingface', 'openai-community', 'gpt2'), [GITHUB_ID]: row(GITHUB_ID, 'github', 'octo', 'repo') }

const saved = { ...process.env }
const KEYS = ['DATABASE_URL', 'SOLANA_RPC_URL', 'HF_MARKETS_ENABLED', 'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_INSTALLATION_ID', 'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY']
for (const key of KEYS) delete process.env[key]
process.env.DATABASE_URL = 'postgres://unused@127.0.0.1:1/unused'
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1'
// A configured GitHub App (a throwaway key), so the GitHub claim content really would call api.github.com.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
process.env.GITHUB_APP_PRIVATE_KEY_BASE64 = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')
process.env.GITHUB_APP_CLIENT_ID = 'Iv1.test-only'
process.env.GITHUB_APP_INSTALLATION_ID = '1'
globalThis.__gitfunPool = { query: async (sql, params = []) => {
  if (/where m\.github_repo_id = \$1/.test(sql)) return { rows: MARKETS[params[0]] ? [MARKETS[params[0]]] : [] }
  if (/from hf_models where market_ref/.test(sql)) return { rows: [{ path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org' }] }
  return { rows: [] }
} }
const net = offlineFetch()
test.after(() => {
  net.restore()
  delete globalThis.__gitfunPool
  for (const key of KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key] }
})

const page = await appModule('app/(site)/claim/[repo]/page.jsx')
const { ModelClaimPage } = await appModule('app/components/hf/claim-page.jsx')
const open = repo => page.default({ params: Promise.resolve({ repo }), searchParams: Promise.resolve({}) })
const decoded = markup => markup.replaceAll('&#x27;', "'").replaceAll('&amp;', '&').replaceAll('&quot;', '"')
const askedGithub = () => net.requested.filter(url => /(^|\.)github\.com$/.test(new URL(url).hostname))
const scheduled = () => globalThis.__repoingTestAfter ??= []
function find(node, match) {
  if (!node || typeof node !== 'object') return null
  if (Array.isArray(node)) { for (const item of node) { const found = find(item, match); if (found) return found } return null }
  if (match(node)) return node
  return find(node.props?.children, match)
}

test('a model market id reaches the model claim page, flag off or on, and GitHub is never asked about the model', async () => {
  for (const flag of [undefined, 'true']) {
    if (flag) process.env.HF_MARKETS_ENABLED = flag; else delete process.env.HF_MARKETS_ENABLED
    net.requested.length = 0; scheduled().length = 0
    const element = await open(MODEL_ID)
    assert.equal(element.type, ModelClaimPage, 'the early return, before the GitHub claim content')
    const markup = decoded(html(await resolveServer(ModelClaimPage(element.props)), { wallet: true }))
    assert.ok(markup.includes('Claim model fees') && markup.includes(HF_DISCLAIMER))
    assert.ok(flag ? markup.includes('Sign in with Hugging Face') : markup.includes('Model claims are not open yet'), `flag ${flag ?? 'off'}`)
    assert.doesNotMatch(markup, /GitHub access|Claim builder fees|Connect GitHub/)
    assert.deepEqual(askedGithub(), [], `no GitHub request with the flag ${flag ?? 'off'}`)
    assert.equal(scheduled().length, 0, 'no GitHub metadata refresh scheduled')
  }
  delete process.env.HF_MARKETS_ENABLED
})

test('control: a GitHub market gets the GitHub claim page, whose content asks GitHub about the repository', async () => {
  net.requested.length = 0; scheduled().length = 0
  const element = await open(GITHUB_ID)
  assert.notEqual(element.type, ModelClaimPage)
  assert.equal(scheduled().length, 1, 'the repository metadata refresh')
  await scheduled()[0]()
  assert.ok(askedGithub().length > 0, 'the refresh reads the repository from GitHub')
  const content = find(element, node => node.type?.name === 'ClaimContent')
  assert.ok(content, 'the GitHub claim content')
  net.requested.length = 0
  await content.type(content.props).catch(() => {})
  assert.ok(askedGithub().includes('https://api.github.com/repos/octo/repo/installation'), 'the request the model gate prevents')
})
