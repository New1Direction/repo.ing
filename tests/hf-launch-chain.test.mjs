import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import sharp from 'sharp'
import { Connection, Keypair, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { startFakeHf, recorded } from './fixtures/hf-server.mjs'
import { createHfClient } from '../src/hf-api.mjs'
import { normalizeTokenImage } from '../src/token-image.mjs'
import { launchBuyPreset } from '../src/launch-buy.mjs'
import { DISCOVERY_VERSION } from '../src/discovery-rewards.mjs'
import { marketSource } from '../src/market-identity.mjs'
import { POST as resolveRoute } from '../app/api/resolve/route.js'
import { GET as launchStatus, POST as launchRoute } from '../app/api/launch/route.js'

// End to end on a local validator and a disposable database, through the same route handlers the browser calls:
// /api/resolve → /api/launch prepare → the wallet signs → /api/launch submit → verified, indexed market. Hugging Face is
// tests/fixtures/hf-server.mjs and GitHub a stub; nothing reaches the network. Discovery and the verification bonus are on,
// so the model market must come out with discovery and without the bonus. Once the config is declared to reserve the
// builder allocation, a second model launches on it and carries the allocation (never the bonus), and the repository
// launched in the same run carries the allocation and the bonus exactly as before.
const rpc = process.env.SOLANA_RPC_URL
assert.match(rpc ?? '', /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'Disposable local validator required')
const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/repoing_hf_launch_test'
const target = new URL(databaseUrl)
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname), 'Disposable local database required')
assert.equal(decodeURIComponent(target.pathname.slice(1)), 'repoing_hf_launch_test', 'Disposable model-launch test database required')
assert.notEqual(target.port, '55439', 'Never the production tunnel port')

const GGUF = recorded['model-llama-2-7b-gguf'].body, THEBLOKE = recorded['user-thebloke'].body
const REPOSITORY = { id: 1296269, name: 'Hello-World', full_name: 'octocat/Hello-World', description: 'My first repository on GitHub!',
  owner: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4' }, private: false, visibility: 'public',
  archived: false, updated_at: '2026-09-30T00:00:00Z', created_at: '2011-01-26T19:01:12Z', stargazers_count: 3000, forks_count: 900 }
const ENV = ['DATABASE_URL', 'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY', 'HF_MARKETS_ENABLED', 'DISCOVERY_REWARDS_ENABLED',
  'PLATFORM_PARTNER_SECRET_KEY', 'BUILDER_ALLOCATION_CONFIGS', 'VERIFICATION_BONUS_LAMPORTS', 'APP_ORIGIN']

async function call(handler, body) {
  const response = await handler(new Request('https://repo.ing/api/x', { method: 'POST', body: JSON.stringify(body) }))
  const result = await response.json()
  assert.equal(response.status, 200, `${body.action ?? 'resolve'}: ${JSON.stringify(result)}`)
  return result
}
// The wallet signs exactly the bytes it was shown, as the browser does.
function walletSigns(transaction, wallet) {
  const tx = Transaction.from(Buffer.from(transaction, 'base64'))
  tx.partialSign(wallet)
  return tx.serialize({ requireAllSignatures: false }).toString('base64')
}
const marketRow = async id => (await globalThis.__gitfunPool.query(`select status, mint, pool, launch_signature as "signature", launch_finality as "finality",
  indexed_at is not null as indexed, launcher_wallet as "launcher", creator_wallet as "creator", token_name as "tokenName", token_symbol as "tokenSymbol",
  token_image is not null as "hasImage", discovery_version as "discoveryVersion", builder_allocation_version as "allocationVersion",
  verification_bonus_lamports::text as "bonusLamports" from markets where github_repo_id = $1`, [String(id)])).rows

test('a model market launches end to end; a repository launch in the same run is unchanged', { timeout: 900_000 }, async t => {
  const saved = { env: Object.fromEntries(ENV.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, hf: globalThis.__repoingHfClient, fetch: globalThis.fetch }
  const pool = new pg.Pool({ connectionString: databaseUrl }), hfServer = await startFakeHf(), connection = new Connection(rpc, 'confirmed')
  t.after(async () => {
    for (const [key, value] of Object.entries(saved.env)) value === undefined ? delete process.env[key] : process.env[key] = value
    Object.assign(globalThis, { __gitfunPool: saved.pool, __repoingHfClient: saved.hf, fetch: saved.fetch })
    await hfServer.close()
    await pool.end()
  })
  await pool.query('truncate markets, repositories, hf_models, maintainer_opt_outs, launch_sessions, agent_request_limits restart identity cascade')
  const { config, partner } = await createFixedConfig(connection)
  const creator = Keypair.generate(), wallet = Keypair.generate()
  const airdrop = await connection.requestAirdrop(wallet.publicKey, 5_000_000_000)
  await connection.confirmTransaction({ signature: airdrop, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  delete process.env.APP_ORIGIN
  delete process.env.BUILDER_ALLOCATION_CONFIGS
  Object.assign(process.env, { DATABASE_URL: databaseUrl, DBC_CONFIG: config.toBase58(), PLATFORM_CREATOR_SECRET_KEY: JSON.stringify([...creator.secretKey]),
    HF_MARKETS_ENABLED: 'true', DISCOVERY_REWARDS_ENABLED: 'true', PLATFORM_PARTNER_SECRET_KEY: JSON.stringify([...partner.secretKey]),
    VERIFICATION_BONUS_LAMPORTS: '5000000' })
  globalThis.__gitfunPool = pool
  globalThis.__repoingHfClient = createHfClient({ fetchImpl: hfServer.fetchImpl })
  const github = []
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    if (href.startsWith('https://api.github.com/')) { github.push(href); return Response.json(REPOSITORY) }
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(href)) throw Error(`test fetch outside the local services: ${href}`)
    return saved.fetch(url, init)
  }
  const image = (await normalizeTokenImage(await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffcc4d' } }).png().toBuffer())).image
  const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
  const initialBuyLamports = launchBuyPreset(dbc, await dbc.state.getPoolConfig(config), 100)

  // The model: resolved by its _id, registered, reviewed, signed, submitted and indexed.
  const resolved = await call(resolveRoute, { url: 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF' })
  assert.equal(resolved.source, 'huggingface')
  assert.equal(resolved.mint, null)
  assert.equal(marketSource(resolved.repoId), 'huggingface')
  const review = await call(launchRoute, { action: 'prepare', repoId: resolved.repoId, hfId: GGUF._id, tokenName: 'Llama-2-7B-GGUF', tokenSymbol: 'LLAMA27BGG',
    tokenImage: image, launcherWallet: wallet.publicKey.toBase58(), initialBuyLamports })
  assert.equal(review.costs.initialBuy, initialBuyLamports)
  const beforeSubmit = hfServer.requests.length
  const launched = await call(launchRoute, { action: 'submit', id: review.id, transaction: walletSigns(review.transaction, wallet) })
  // hfLaunchGuard read the model again after the wallet signed, before the transaction went out.
  assert.deepEqual(hfServer.requests.slice(beforeSubmit).map(request => request.path), ['/api/models/TheBloke/Llama-2-7B-GGUF'])
  assert.equal(launched.verified, false)
  assert.deepEqual(github, [], 'a model launch never asks GitHub')

  assert.deepEqual(await marketRow(resolved.repoId), [{ status: 'confirmed', mint: launched.mint, pool: launched.pool, signature: launched.signature,
    finality: 'finalized', indexed: true, launcher: wallet.publicKey.toBase58(), creator: creator.publicKey.toBase58(), tokenName: 'Llama-2-7B-GGUF',
    tokenSymbol: 'LLAMA27BGG', hasImage: true, discoveryVersion: DISCOVERY_VERSION, allocationVersion: null, bonusLamports: null }])
  const { rows: [registry] } = await pool.query(`select market_ref::text as "marketRef", repo_path as "path", owner_handle as "owner", owner_kind as "kind",
    owner_subject as "subject", gated, base_models as "baseModels" from hf_models where hf_id = $1`, [GGUF._id])
  assert.deepEqual(registry, { marketRef: resolved.repoId, path: 'TheBloke/Llama-2-7B-GGUF', owner: 'TheBloke', kind: 'user', subject: THEBLOKE._id,
    gated: false, baseModels: [{ hfId: '64b0234d53bd91402e6ad49c', path: 'meta-llama/Llama-2-7b-hf', relation: 'quantized' }] })
  const { rows: [model] } = await pool.query(`select source, hf_model_ref::text as "ref", full_name as "fullName", owner, name, avatar_url as "avatarUrl",
    stars, forks from repositories where github_repo_id = $1`, [resolved.repoId])
  assert.deepEqual(model, { source: 'huggingface', ref: resolved.repoId, fullName: 'TheBloke/Llama-2-7B-GGUF', owner: 'TheBloke', name: 'Llama-2-7B-GGUF',
    avatarUrl: THEBLOKE.avatarUrl, stars: 0, forks: 0 })
  // The first buy is indexed like any market's: a chart trade and a creator fee for the model's market.
  assert.equal((await pool.query('select count(*)::int as n from trade_events where pool = $1', [launched.pool])).rows[0].n, 1)
  assert.ok((await pool.query('select count(*)::int as n from fee_events where github_repo_id = $1', [resolved.repoId])).rows[0].n >= 1)
  const status = await (await launchStatus(new Request(`https://repo.ing/api/launch?repo=${resolved.repoId}`))).json()
  assert.deepEqual(status, { state: 'live', mint: launched.mint })
  assert.deepEqual(await call(resolveRoute, { url: 'hf.co/TheBloke/Llama-2-7B-GGUF' }), { repoId: resolved.repoId, mint: launched.mint, source: 'huggingface' })

  // The config now reserves the builder allocation: a model launches on it too, and its market carries the allocation for
  // the model's verified owner (src/builder-allocation.mjs), never the verification bonus.
  process.env.BUILDER_ALLOCATION_CONFIGS = config.toBase58()
  const gpt2 = await call(resolveRoute, { url: 'https://huggingface.co/openai-community/gpt2' })
  const gpt2Review = await call(launchRoute, { action: 'prepare', repoId: gpt2.repoId, hfId: recorded['model-gpt2'].body._id, tokenName: 'gpt2',
    tokenSymbol: 'GPT2', tokenImage: image, launcherWallet: wallet.publicKey.toBase58(), initialBuyLamports: '0' })
  const gpt2Launched = await call(launchRoute, { action: 'submit', id: gpt2Review.id, transaction: walletSigns(gpt2Review.transaction, wallet) })
  assert.deepEqual(await marketRow(gpt2.repoId), [{ status: 'confirmed', mint: gpt2Launched.mint, pool: gpt2Launched.pool, signature: gpt2Launched.signature,
    finality: 'finalized', indexed: true, launcher: wallet.publicKey.toBase58(), creator: creator.publicKey.toBase58(), tokenName: 'gpt2',
    tokenSymbol: 'GPT2', hasImage: true, discoveryVersion: DISCOVERY_VERSION, allocationVersion: 1, bonusLamports: null }])

  // The repository, through the same routes and environment: unchanged, rewards stamped.
  const modelRequests = hfServer.requests.length
  const repository = await call(resolveRoute, { url: 'github.com/octocat/Hello-World' })
  assert.deepEqual(repository, { repoId: '1296269', mint: null })
  const repoReview = await call(launchRoute, { action: 'prepare', repoId: '1296269', repositoryUrl: 'https://github.com/octocat/Hello-World',
    tokenName: 'Hello Repo', tokenSymbol: 'HELLO', tokenImage: image, launcherWallet: wallet.publicKey.toBase58(), initialBuyLamports: '0' })
  const repoLaunched = await call(launchRoute, { action: 'submit', id: repoReview.id, transaction: walletSigns(repoReview.transaction, wallet) })
  assert.equal(repoLaunched.verified, false)
  assert.deepEqual(await marketRow('1296269'), [{ status: 'confirmed', mint: repoLaunched.mint, pool: repoLaunched.pool, signature: repoLaunched.signature,
    finality: 'finalized', indexed: true, launcher: wallet.publicKey.toBase58(), creator: creator.publicKey.toBase58(), tokenName: 'Hello Repo',
    tokenSymbol: 'HELLO', hasImage: true, discoveryVersion: DISCOVERY_VERSION, allocationVersion: 1, bonusLamports: '5000000' }])
  const { rows: [repo] } = await pool.query(`select source, hf_model_ref, full_name as "fullName", stars, forks from repositories where github_repo_id = 1296269`)
  assert.deepEqual(repo, { source: 'github', hf_model_ref: null, fullName: 'octocat/Hello-World', stars: 3000, forks: 900 })
  assert.deepEqual([...new Set(github)], ['https://api.github.com/repos/octocat/Hello-World'])
  assert.equal(hfServer.requests.length, modelRequests, 'a repository launch never asks Hugging Face')
  assert.equal((await pool.query('select count(*)::int as n from markets')).rows[0].n, 3)
})
