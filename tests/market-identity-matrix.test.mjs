import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { Connection, Keypair } from '@solana/web3.js'
import { HF_MARKET_REF_MAX, HF_MARKET_REF_MIN, MarketIdentityError } from '../src/market-identity.mjs'
import { resolvePublicRepositoryById } from '../src/github.mjs'
import { createGitHubAppVerifier } from '../src/github-verification.mjs'
import { currentGithubAdminForRepository } from '../src/github-app-auth.mjs'
import { createReleaseReader } from '../src/github-release.mjs'
import { createDevPulseCollector } from '../src/dev-pulse.mjs'
import { createTrendSources } from '../src/trend-sources.mjs'
import { readRepositoryFacts } from '../src/verification-bonus-accrual.mjs'
import { rewardStamps } from '../src/launch-coordinator.mjs'
import { createClaim } from '../src/claim.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
import { repositoryById } from '../app/lib/server.mjs'
import { repositoryImageSuggestions } from '../app/lib/repo-images.mjs'
import { GET as repoLogo } from '../app/api/repo-logo/[repo]/route.js'

// Cross-source matrix: every GitHub-calling function given a Hugging Face market id throws before any request or
// database read, and payout authority from one source is refused for a market of the other before anything is touched.
const HF = HF_MARKET_REF_MIN, GITHUB = 1384142609n
const forms = id => [id, String(id), Number(id)]
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const identity = { clientId: 'Iv23test', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }

function recorder() {
  const calls = []
  const fetchImpl = async url => { calls.push(`fetch ${url}`); throw Error('network reached') }
  const pool = { async query(config) { calls.push(`query ${typeof config === 'string' ? config : config.text}`); throw Error('database reached') },
    async connect() { calls.push('connect'); throw Error('database reached') } }
  return { calls, fetchImpl, pool }
}
const verifier = ({ pool, fetchImpl }) => createGitHubAppVerifier({ pool, clientId: 'Iv23test', clientSecret: 'secret', redirectUri: 'https://repo.ing/api/github/callback', fetchImpl })

const githubCalls = {
  resolvePublicRepositoryById: (id, { fetchImpl }) => resolvePublicRepositoryById(id, fetchImpl),
  'release reader': (id, { fetchImpl }) => createReleaseReader({ fetchImpl }).latest({ repoId: id, owner: 'o', name: 'n' }),
  currentGithubAdminForRepository: (id, { fetchImpl }) => currentGithubAdminForRepository({ repoId: id, owner: 'o', name: 'n', githubUserId: '1', githubLogin: 'u', fetchImpl, identity }),
  readRepositoryFacts: (id, { fetchImpl }) => readRepositoryFacts(id, { fetchImpl, headers: async () => ({}) }),
  'trend observe': (id, { fetchImpl }) => createTrendSources({ fetchImpl, pause: async () => {} }).observe('https://github.com/o/n', id),
  authorizationUrl: async (id, recorded) => verifier(recorded).authorizationUrl({ githubRepoId: id }),
  verifyCallback: (id, recorded) => verifier(recorded).verifyCallback({ githubRepoId: id, expectedGithubRepoId: id, code: 'code', state: 's', expectedState: 's' }),
  verifyAccessToken: (id, recorded) => verifier(recorded).verifyAccessToken({ githubRepoId: id, accessToken: 'ghu_test' }),
  verifyRepositoryAdmin: (id, recorded) => verifier(recorded).verifyRepositoryAdmin({ githubRepoId: id, accessToken: 'ghu_test' }),
}

test('every GitHub-calling function refuses a Hugging Face id before any request or database read', async () => {
  for (const [name, call] of Object.entries(githubCalls)) {
    for (const id of [...forms(HF), HF_MARKET_REF_MAX]) {
      const recorded = recorder()
      await assert.rejects(call(id, recorded), MarketIdentityError, `${name} ${typeof id}`)
      assert.deepEqual(recorded.calls, [], name)
    }
  }
})

test('a GitHub id still goes through every guard to GitHub or the database', async () => {
  for (const [name, call] of Object.entries(githubCalls)) {
    if (name === 'authorizationUrl') { assert.equal(verifier(recorder()).authorizationUrl({ githubRepoId: GITHUB }).githubRepoId, GITHUB); continue }
    const recorded = recorder()
    try { await call(GITHUB, recorded) } catch (error) { assert.ok(!(error instanceof MarketIdentityError), `${name}: ${error.message}`) }
    assert.ok(recorded.calls.length > 0, `${name} reached GitHub or the database`)
  }
})

test('Dev Pulse records a Hugging Face row as an error and never reads GitHub for it', async () => {
  const failed = [], { calls, fetchImpl } = recorder()
  const store = { due: async () => [{ repoId: String(HF), fullName: 'o/n', etags: {}, stars: null }],
    save: async () => assert.fail('nothing to save'), fail: async (repoId, error) => { failed.push([repoId, error]) }, prune: async () => {} }
  const result = await createDevPulseCollector({ store, fetchImpl, headers: async () => ({}), now: () => 0 }).runOnce()
  assert.deepEqual(result, { checked: 0, events: 0, errors: 1 })
  assert.deepEqual(calls, [])
  assert.deepEqual(failed, [[String(HF), 'Not a GitHub repository ID']])
})

test('web GitHub reads refuse a Hugging Face id (the logo route answers 404) and keep other ids unknown, before the database or GitHub', async () => {
  const saved = { url: process.env.DATABASE_URL, pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
  const { calls, fetchImpl, pool } = recorder()
  process.env.DATABASE_URL = 'postgres://matrix.invalid/db'; globalThis.__gitfunPool = pool; globalThis.fetch = fetchImpl
  const logo = repo => repoLogo(new Request(`https://repo.ing/api/repo-logo/${repo}`), { params: Promise.resolve({ repo }) })
  try {
    for (const id of forms(HF)) await assert.rejects(repositoryById(id), MarketIdentityError)
    for (const id of ['0', '4503599627370496', '7000000000000001', '99999999999999999999', 'abc']) assert.equal(await repositoryById(id), null, id)
    await assert.rejects(repositoryImageSuggestions(String(HF), { owner: 'o', name: 'n', avatar_url: null }), MarketIdentityError)
    for (const id of [String(HF), String(HF_MARKET_REF_MAX), '0', '4503599627370496', '99999999999999999999']) assert.equal((await logo(id)).status, 404, id)
    assert.deepEqual(calls, [])
  } finally {
    if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch
  }
})

test('createClaim refuses an authority from another source before touching the database or the chain', async () => {
  const { calls, pool } = recorder(), rpc = [], verified = []
  const connection = new Connection('http://127.0.0.1:9', 'confirmed')
  connection._rpcRequest = async method => { rpc.push(method); throw Error('chain reached') }
  const github = { verifyCurrentAuthority: async args => { verified.push(args); throw Error('verifier reached') } }
  const huggingface = { ...github, source: 'huggingface' }
  const claim = (githubVerifier, githubRepoId) => createClaim({ pool, connection, config: Keypair.generate().publicKey.toBase58(),
    creator: Keypair.generate(), githubVerifier }).claim({ githubRepoId, githubAuthorization: { session: true } })
  for (const id of forms(HF)) await assert.rejects(claim(github, id), /A github authority cannot act for a huggingface market/)
  await assert.rejects(claim(huggingface, GITHUB), /A huggingface authority cannot act for a github market/)
  await assert.rejects(claim({ ...github, source: 'gitlab' }, GITHUB), MarketIdentityError)
  assert.deepEqual([calls, rpc, verified], [[], [], []])
  // A verifier without a source is GitHub's: for a GitHub market the claim goes on to take the repository lock.
  await assert.rejects(claim(github, GITHUB), /database reached/)
  await assert.rejects(claim(huggingface, HF), /database reached/)
  assert.deepEqual(calls, ['connect', 'connect'])
})

test('wallet binding refuses a Hugging Face market before any database read or write', async () => {
  const { calls, pool } = recorder(), binder = createWalletBinding({ pool }), wallet = Keypair.generate().publicKey.toBase58()
  for (const id of forms(HF)) {
    await assert.rejects(binder.requestChallenge({ githubRepoId: id, githubUserId: 1n, wallet }), MarketIdentityError)
    await assert.rejects(binder.bindWallet({ githubRepoId: id, githubUserId: '1', wallet, nonce: 'a'.repeat(48), signature: Buffer.alloc(64) }), MarketIdentityError)
  }
  await assert.rejects(binder.requestBatchChallenge({ githubRepoIds: ['1001', String(HF)], githubUserId: '1', wallet }), MarketIdentityError)
  assert.deepEqual(calls, [])
  await assert.rejects(binder.requestChallenge({ githubRepoId: GITHUB, githubUserId: 1n, wallet }), error => !(error instanceof MarketIdentityError))
  assert.equal(calls.length, 1, 'a GitHub market goes on to the admin verification read')
})

test('a reservation stamps no verification bonus or builder allocation on a Hugging Face market, whatever is enabled', () => {
  const enabled = { builderAllocationEnabled: true, verificationBonusLamports: 250_000_000n }
  assert.deepEqual(rewardStamps(GITHUB, enabled), { builderAllocationVersion: 1, verificationBonusLamports: 250_000_000n })
  assert.deepEqual(rewardStamps(GITHUB, { builderAllocationEnabled: false, verificationBonusLamports: null }),
    { builderAllocationVersion: null, verificationBonusLamports: null })
  for (const id of [...forms(HF), HF_MARKET_REF_MAX]) {
    assert.deepEqual(rewardStamps(id, enabled), { builderAllocationVersion: null, verificationBonusLamports: null })
  }
  assert.throws(() => rewardStamps(2n ** 52n, enabled), MarketIdentityError)
})
