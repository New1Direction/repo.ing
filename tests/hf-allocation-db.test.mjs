import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BUILDER_ALLOCATION, createBuilderAllocation } from '../src/builder-allocation.mjs'
import { createHfClient } from '../src/hf-api.mjs'
import { createHfOAuth, createHfVerifier } from '../src/hf-verification.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
import { createPayoutAddresses } from '../src/payout-address.mjs'
import { recorded, startFakeHf } from './fixtures/hf-server.mjs'

// The Hugging Face branch of the 1% builder allocation on real PostgreSQL with every committed migration (0052 included)
// and a local stand-in for huggingface.co (the recorded Hub, plus scripted OAuth): the 0052 rules, who may claim a model
// market's grant and to which binding, and /api/allocation/<model id>. Nothing reaches the network or a chain: a claim
// stops at a sentinel chain read once every database and Hugging Face check has passed
// (tests/hf-allocation-chain.test.mjs pays one on a local validator).
const url = process.env.HF_ALLOCATION_TEST_DATABASE_URL
const OWNER = '6426d3f3a7723d62b53c259b', GGUF = '64f5fd954d3b1dd311d30e28' // TheBloke, TheBloke/Llama-2-7B-GGUF
const ORG = '659ebc82b61dd9658802f398', GPT2 = '621ffdc036468d709f17434d' // openai-community, openai-community/gpt2
const NEW_OWNER = '5f17f0a0925b9863e28ad517', ORG_ADMIN = '60a551a34ecc5d054c8ad93e', ORG_ADMIN_2 = '650c8bfb1ba1a2d6b5fe0b25', MEMBER = '63972e77157559113eb8396d'
const STRANGER = '64a1b2c3d4e5f60718293a4b'
const TOKENS = { owner: 'hf_oauth_owner_token_test_only', newOwner: 'hf_oauth_new_owner_token_test', admin: 'hf_oauth_org_admin_token_test',
  admin2: 'hf_oauth_org_admin_2_token_tst', member: 'hf_oauth_org_member_token_tst', stranger: 'hf_oauth_stranger_token_tests' }
const USERINFO = new Map([
  [TOKENS.owner, { sub: OWNER, preferred_username: 'TheBloke', orgs: [] }],
  [TOKENS.newOwner, { sub: NEW_OWNER, preferred_username: 'new-owner', orgs: [] }],
  [TOKENS.admin, { sub: ORG_ADMIN, preferred_username: 'org-admin', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin' }] }],
  [TOKENS.admin2, { sub: ORG_ADMIN_2, preferred_username: 'org-admin-2', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin' }] }],
  [TOKENS.member, { sub: MEMBER, preferred_username: 'org-member', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'write' }] }],
  [TOKENS.stranger, { sub: STRANGER, preferred_username: 'stranger', orgs: [] }],
])
const OAUTH = { clientId: 'repoing-test-client', clientSecret: 'test-only-hf-client-secret', redirectUri: 'https://repo.ing/api/hf/callback' }
const SENTINEL = 'CHAIN_READ_REACHED'
const code = expected => error => error?.code === expected
const wallet = () => {
  const pair = generateKeyPairSync('ed25519')
  return { address: new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58(),
    signMessage: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey) }
}

function requireDisposableDatabase() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_hf_allocation_test', 'Disposable allocation test database required')
  assert.notEqual(target.port, '55439', 'Never the production tunnel port')
}
async function prepare() {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query(`truncate builder_allocation_claims, model_verifications, payout_address_events, payout_address_requests, wallet_binding_challenges,
    repo_claims, repo_beneficiaries, repo_verifications, maintainer_opt_outs, agent_request_limits, markets, repositories, hf_models restart identity cascade`)
  return pool
}
async function refused(pool, sql, constraint, params = []) {
  await assert.rejects(pool.query(sql, params), error => {
    assert.equal(error.constraint, constraint, `${error.message} (${sql.slice(0, 90)})`)
    return true
  })
}

// A registered model with a confirmed, indexed market stamped with the allocation (0052), on an allocation config.
async function seedModel(pool, { hfId, path, ownerKind, ownerSubject, config, creator, allocation = 1 }) {
  const { rows: [{ marketId }] } = await pool.query(`insert into hf_models(hf_id, repo_path, owner_handle, owner_kind, owner_subject)
    values ($1, $2, $3, $4, $5) returning market_ref::text as "marketId"`, [hfId, path, path.split('/')[0], ownerKind, ownerSubject])
  const [owner, name] = path.split('/'), mint = Keypair.generate().publicKey
  await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at, source, hf_model_ref)
    values ($1, $2, $3, $4, 0, 0, false, now(), 'huggingface', $1)`, [marketId, owner, name, path])
  await pool.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol,
      launch_signature, launch_slot, launch_finality, indexed_at, last_verified_at, builder_allocation_version)
    values ($1, 'confirmed', $2, $3, $4, $5, 'Model', 'MODEL', $6, 1, 'finalized', now(), now(), $7)`,
  [marketId, mint.toBase58(), deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58(), Keypair.generate().publicKey.toBase58(), creator.toBase58(),
    `Launch${marketId}`, allocation])
  return { marketId, mint: mint.toBase58() }
}

async function hub() {
  const server = await startFakeHf()
  server.route('/oauth/userinfo', (_, request) => {
    const info = USERINFO.get(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))
    return info ? { status: 200, headers: {}, body: info } : { status: 401, headers: {}, body: { error: 'invalid_token' } }
  })
  return server
}
// TheBloke/Llama-2-7B-GGUF moves to new-owner: the same repository and _id, as a Hub transfer redirects.
function transfer(server) {
  const body = { ...structuredClone(recorded['model-llama-2-7b-gguf'].body), id: 'new-owner/Llama-2-7B-GGUF', author: 'new-owner' }
  server.route('/api/models/TheBloke/Llama-2-7B-GGUF', { status: 307, headers: { location: '/api/models/new-owner/Llama-2-7B-GGUF' }, body: null })
  server.route('/api/models/new-owner/Llama-2-7B-GGUF', { status: 200, headers: {}, body })
  server.route('/api/users/new-owner/overview', { status: 200, headers: {}, body: { _id: NEW_OWNER, user: 'new-owner', type: 'user', fullname: 'New Owner', avatarUrl: null } })
}
const verifierFor = (pool, server) => createHfVerifier({ pool, hf: createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} }),
  oauth: createHfOAuth({ ...OAUTH, fetchImpl: server.fetchImpl }) })
const hfAuthority = (verifier, token, subject) => ({ source: 'huggingface',
  verifyCurrentAuthority: ({ githubRepoId }) => verifier.verifyMarketAuthority({ marketId: githubRepoId, accessToken: token, expectedSubject: subject }) })
async function bindAs(pool, verifier, marketId, token, subject, signer = wallet()) {
  const authority = await verifier.verifyMarketAuthority({ marketId, accessToken: token, expectedSubject: subject })
  const binder = createWalletBinding({ pool })
  const challenge = await binder.requestChallenge({ githubRepoId: marketId, wallet: signer.address, authority })
  return binder.bindWallet({ githubRepoId: marketId, wallet: signer.address, nonce: challenge.nonce, signature: signer.signMessage(challenge.message), authority })
}
// What app/lib/allocation.mjs seals for the binding's own user (here unsealed: the route test below covers the seal).
const reviewOf = (marketId, bound, subject, ownerSubject) => ({ purpose: 'model-allocation-review', repoId: marketId, subject, ownerSubject, wallet: bound.wallet,
  boundAt: new Date(bound.boundAt).toISOString(), amount: String(BUILDER_ALLOCATION), expiresAt: Date.now() + 600_000 })
function sentinelChain() {
  const rpc = [], connection = new Connection('http://127.0.0.1:9', 'confirmed')
  connection._rpcRequest = async method => { rpc.push(method); throw new Error(SENTINEL) }
  return { connection, rpc }
}
const grants = async pool => (await pool.query('select count(*)::int as n from builder_allocation_claims')).rows[0].n

test('real PostgreSQL: 0052 lets a model market carry the allocation but never the bonus, and a model grant names exactly one Hugging Face authority', { skip: !url }, async () => {
  const pool = await prepare()
  try {
    const config = Keypair.generate().publicKey, creator = Keypair.generate().publicKey
    const { marketId: hf, mint } = await seedModel(pool, { hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', ownerKind: 'user', ownerSubject: OWNER, config, creator })
    assert.equal((await pool.query('select builder_allocation_version as v from markets where github_repo_id = $1', [hf])).rows[0].v, 1)
    const { rows: [{ ref }] } = await pool.query(`insert into hf_models(hf_id, repo_path, owner_handle, owner_kind, owner_subject)
      values ($1, 'openai-community/gpt2', 'openai-community', 'org', $2) returning market_ref::text as ref`, [GPT2, ORG])
    await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at, source, hf_model_ref)
      values ($1, 'openai-community', 'gpt2', 'openai-community/gpt2', 0, 0, false, now(), 'huggingface', $1)`, [ref])
    const reservation = `insert into markets(github_repo_id, status, launcher_wallet, creator_wallet, token_name, token_symbol, builder_allocation_version,
      verification_bonus_lamports) values ($1, 'reserved', 'L', 'C', 'M', 'M', $2, $3)`
    await refused(pool, reservation, 'markets_hf_no_bonus', [ref, 1, 5_000_000])
    await refused(pool, reservation, 'markets_hf_no_bonus', [ref, null, 5_000_000])
    await pool.query(reservation, [ref, 1, null])
    // A repository's market keeps both stamps.
    await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at) values (9601, 'octo', 'r', 'octo/r', 1, 0, false, now())`)
    await pool.query(`insert into markets(github_repo_id, status, launcher_wallet, creator_wallet, token_name, token_symbol, builder_allocation_version, verification_bonus_lamports)
      values (9601, 'reserved', 'L', 'C', 'R', 'R', 1, 5000000)`)

    const W = Keypair.generate().publicKey.toBase58()
    const grant = (columns, values, params) => `insert into builder_allocation_claims(github_repo_id, mint, wallet, amount, status, signature, signed_transaction,
      last_valid_block_height${columns}) values (${params.id}, '${mint}', '${W}', ${params.amount ?? '10000000000000'}, '${params.status ?? 'pending'}', '${params.signature}', 'tx', 1${values})`
    const hfColumns = ', authority_source, authority_subject, authority_owner_subject'
    // A model id needs a Hugging Face authority: never a GitHub user, never a missing or malformed subject.
    await refused(pool, grant(', github_user_id', ', 7', { id: hf, signature: 'S1' }), 'builder_allocation_claims_source_range')
    await refused(pool, grant(`${hfColumns}, github_user_id`, `, 'huggingface', '${OWNER}', '${OWNER}', 7`, { id: hf, signature: 'S2' }), 'builder_allocation_claims_authority_check')
    await refused(pool, grant(', authority_source', ", 'huggingface'", { id: hf, signature: 'S3' }), 'builder_allocation_claims_authority_check')
    await refused(pool, grant(hfColumns, `, 'huggingface', 'TheBloke', 'TheBloke'`, { id: hf, signature: 'S4' }), 'builder_allocation_claims_authority_check')
    await refused(pool, grant(hfColumns, `, 'huggingface', '${OWNER}', null`, { id: hf, signature: 'S5' }), 'builder_allocation_claims_authority_check')
    // And a repository id needs a GitHub user: never Hugging Face subjects.
    await refused(pool, grant(hfColumns, `, 'huggingface', '${OWNER}', '${OWNER}'`, { id: 9601, signature: 'S6' }), 'builder_allocation_claims_source_range')
    await refused(pool, grant(`${hfColumns}, github_user_id`, `, 'github', '${OWNER}', null, 7`, { id: 9601, signature: 'S7' }), 'builder_allocation_claims_authority_check')
    await refused(pool, grant(hfColumns, `, 'huggingface', '${OWNER}', '${OWNER}'`, { id: hf, signature: 'S8', amount: '1' }), 'builder_allocation_amount_check')
    // One grant per market, ever: an aborted attempt leaves room for one more, a pending or settled one never does.
    await pool.query(grant(hfColumns, `, 'huggingface', '${OWNER}', '${OWNER}'`, { id: hf, signature: 'A1', status: 'aborted' }))
    await pool.query(grant(hfColumns, `, 'huggingface', '${OWNER}', '${OWNER}'`, { id: hf, signature: 'P1' }))
    await refused(pool, grant(hfColumns, `, 'huggingface', '${NEW_OWNER}', '${NEW_OWNER}'`, { id: hf, signature: 'P2' }), 'builder_allocation_one_payout')
    await pool.query(`update builder_allocation_claims set status = 'settled', settled_at = now() where signature = 'P1'`)
    await refused(pool, grant(hfColumns, `, 'huggingface', '${OWNER}', '${OWNER}'`, { id: hf, signature: 'P3' }), 'builder_allocation_one_payout')
    await pool.query(grant(', github_user_id', ', 7', { id: 9601, signature: 'G1' }))
    assert.deepEqual((await pool.query(`select github_repo_id::text as id, authority_source as source, github_user_id::text as "user", authority_subject as subject,
      authority_owner_subject as owner, status from builder_allocation_claims order by id`)).rows,
    [{ id: hf, source: 'huggingface', user: null, subject: OWNER, owner: OWNER, status: 'aborted' }, { id: hf, source: 'huggingface', user: null, subject: OWNER, owner: OWNER, status: 'settled' },
      { id: '9601', source: 'github', user: '7', subject: null, owner: null, status: 'pending' }])
  } finally { await pool.end() }
})

test('real PostgreSQL: a model grant needs the current owner or an org admin, their own binding for that owner, and no earlier grant, all before any chain read', { skip: !url }, async t => {
  const pool = await prepare(), server = await hub()
  const savedConfigs = process.env.BUILDER_ALLOCATION_CONFIGS
  t.after(async () => {
    if (savedConfigs === undefined) delete process.env.BUILDER_ALLOCATION_CONFIGS; else process.env.BUILDER_ALLOCATION_CONFIGS = savedConfigs
    await server.close(); await pool.end()
  })
  const config = Keypair.generate().publicKey, creator = Keypair.generate()
  process.env.BUILDER_ALLOCATION_CONFIGS = config.toBase58()
  const { marketId } = await seedModel(pool, { hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', ownerKind: 'user', ownerSubject: OWNER, config, creator: creator.publicKey })
  const { marketId: orgMarket } = await seedModel(pool, { hfId: GPT2, path: 'openai-community/gpt2', ownerKind: 'org', ownerSubject: ORG, config, creator: creator.publicKey })
  const verifier = verifierFor(pool, server), { connection, rpc } = sentinelChain()
  const claim = (githubVerifier, review) => createBuilderAllocation({ pool, connection, config, creator, githubVerifier }).claim({ review })
  const asUser = (token, subject) => hfAuthority(verifier, token, subject)

  // The owner, with their own binding: every check passes and the claim goes on to the chain.
  const bound = await bindAs(pool, verifier, marketId, TOKENS.owner, OWNER)
  const review = reviewOf(marketId, bound, OWNER, OWNER)
  await assert.rejects(claim(asUser(TOKENS.owner, OWNER), review), new RegExp(SENTINEL))
  assert.ok(rpc.length > 0); rpc.length = 0
  // Not the owner, a GitHub authority, or a review of another wallet: refused before the chain.
  await assert.rejects(claim(asUser(TOKENS.stranger, STRANGER), reviewOf(marketId, bound, STRANGER, OWNER)), code('HF_NOT_AUTHORIZED'))
  await assert.rejects(claim({ verifyCurrentAuthority: async () => assert.fail('GitHub is never asked') }, review), /A github authority cannot act for a huggingface market/)
  await assert.rejects(claim(asUser(TOKENS.owner, OWNER), { ...review, wallet: wallet().address }), /Payout wallet or authority changed/)
  assert.deepEqual(rpc, [])

  // A pasted address whose hold has passed becomes the binding under the claim's lock: the review of the old one is refused.
  const pasted = wallet().address
  const owner = Object.assign(input => verifier.verifyMarketAuthority({ marketId: input.githubRepoId, accessToken: TOKENS.owner, expectedSubject: OWNER }), { source: 'huggingface' })
  const request = await createPayoutAddresses({ pool, connection: { getAccountInfo: async () => null } })
    .request({ githubRepoId: marketId, address: pasted, confirm: pasted.slice(-4), verifyAuthority: owner })
  const client = await pool.connect()
  try {
    await client.query('begin'); await client.query('set local session_replication_role = replica')
    await client.query(`update payout_address_requests set requested_at = requested_at - interval '49 hours', active_at = active_at - interval '49 hours' where id = $1`, [request.id])
    await client.query('commit')
  } finally { client.release() }
  await assert.rejects(claim(asUser(TOKENS.owner, OWNER), review), /Payout wallet or authority changed/)
  const { rows: [active] } = await pool.query('select wallet, bound_at as "boundAt", method, authority_subject as subject from repo_beneficiaries where github_repo_id = $1', [marketId])
  assert.deepEqual([active.wallet, active.method, active.subject], [pasted, 'pasted', OWNER])
  await assert.rejects(claim(asUser(TOKENS.owner, OWNER), reviewOf(marketId, active, OWNER, OWNER)), new RegExp(SENTINEL), 'the new binding’s review goes on')
  rpc.length = 0

  // The model is transferred: the previous owner is refused, and the new owner has no binding of their own until they bind.
  transfer(server)
  await assert.rejects(claim(asUser(TOKENS.owner, OWNER), reviewOf(marketId, active, OWNER, OWNER)), error => error.code === 'HF_NOT_AUTHORIZED' && error.reason === 'not-owner')
  await assert.rejects(claim(asUser(TOKENS.newOwner, NEW_OWNER), reviewOf(marketId, active, NEW_OWNER, NEW_OWNER)), /Payout wallet or authority changed/)
  await assert.rejects(claim(asUser(TOKENS.newOwner, NEW_OWNER), reviewOf(marketId, active, NEW_OWNER, OWNER)), /Current Hugging Face owner authority required/,
    'a review made under the previous owner')
  assert.deepEqual(rpc, [])
  const rebound = await bindAs(pool, verifier, marketId, TOKENS.newOwner, NEW_OWNER)
  await assert.rejects(claim(asUser(TOKENS.newOwner, NEW_OWNER), reviewOf(marketId, rebound, NEW_OWNER, NEW_OWNER)), new RegExp(SENTINEL))
  rpc.length = 0

  // An organization's model: an admin with their own binding goes on; a member, or another admin without their own binding, does not.
  const orgBound = await bindAs(pool, verifier, orgMarket, TOKENS.admin, ORG_ADMIN)
  await assert.rejects(claim(asUser(TOKENS.admin, ORG_ADMIN), reviewOf(orgMarket, orgBound, ORG_ADMIN, ORG)), new RegExp(SENTINEL))
  rpc.length = 0
  await assert.rejects(claim(asUser(TOKENS.member, MEMBER), reviewOf(orgMarket, orgBound, MEMBER, ORG)), error => error.code === 'HF_NOT_AUTHORIZED' && error.reason === 'not-admin')
  await assert.rejects(claim(asUser(TOKENS.admin2, ORG_ADMIN_2), reviewOf(orgMarket, orgBound, ORG_ADMIN_2, ORG)), /Payout wallet or authority changed/)
  assert.deepEqual(rpc, [])

  // One grant per market, ever: once a grant is settled, nobody reaches Hugging Face or the chain for that market again.
  await pool.query(`insert into builder_allocation_claims(github_repo_id, mint, wallet, amount, status, signature, signed_transaction, last_valid_block_height,
    settled_at, authority_source, authority_subject, authority_owner_subject) select github_repo_id, mint, $2, 10000000000000, 'settled', 'SettledGrant', 'tx', 1, now(),
    'huggingface', $3, $4 from markets where github_repo_id = $1`, [orgMarket, orgBound.wallet, ORG_ADMIN, ORG])
  const asked = server.requests.length
  await assert.rejects(claim(asUser(TOKENS.admin, ORG_ADMIN), reviewOf(orgMarket, orgBound, ORG_ADMIN, ORG)), /Allocation already submitted or paid/)
  await assert.rejects(claim(asUser(TOKENS.admin2, ORG_ADMIN_2), reviewOf(orgMarket, orgBound, ORG_ADMIN_2, ORG)), /Allocation already submitted or paid/)
  assert.deepEqual([server.requests.length, rpc], [asked, []])
  // A market without the allocation stamp has nothing to claim.
  await pool.query('update markets set builder_allocation_version = null where github_repo_id = $1', [marketId])
  await assert.rejects(claim(asUser(TOKENS.newOwner, NEW_OWNER), reviewOf(marketId, rebound, NEW_OWNER, NEW_OWNER)), /not enrolled/)
  assert.equal(await grants(pool), 1, 'no refusal wrote a grant')
})

// The web routes' environment: this database behind database(), the Hugging Face OAuth settings, a payout signer and an
// allocation config, and a fetch that sends huggingface.co to the local stand-in and refuses every Solana RPC call.
async function routeEnvironment(t, pool, server, { config, creator }) {
  const KEYS = ['DATABASE_URL', 'APP_ORIGIN', 'HF_MARKETS_ENABLED', 'HF_OAUTH_CLIENT_ID', 'HF_OAUTH_CLIENT_SECRET', 'HF_OAUTH_REDIRECT_URI', 'SOLANA_RPC_URL',
    'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY', 'BUILDER_ALLOCATION_CONFIGS']
  const saved = { env: Object.fromEntries(KEYS.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, fetch: globalThis.fetch, hf: globalThis.__repoingHfClient }
  t.after(async () => {
    for (const [key, value] of Object.entries(saved.env)) value === undefined ? delete process.env[key] : process.env[key] = value
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch; globalThis.__repoingHfClient = saved.hf
    await server.close(); await pool.end()
  })
  const rpcUrl = 'http://127.0.0.1:8997'
  Object.assign(process.env, { DATABASE_URL: url, APP_ORIGIN: 'https://repo.ing', HF_OAUTH_CLIENT_ID: OAUTH.clientId, HF_OAUTH_CLIENT_SECRET: OAUTH.clientSecret,
    HF_OAUTH_REDIRECT_URI: OAUTH.redirectUri, SOLANA_RPC_URL: rpcUrl, DBC_CONFIG: config.toBase58(), BUILDER_ALLOCATION_CONFIGS: config.toBase58(),
    PLATFORM_CREATOR_SECRET_KEY: JSON.stringify([...creator.secretKey]) })
  delete process.env.HF_MARKETS_ENABLED
  globalThis.__gitfunPool = pool
  globalThis.__repoingHfClient = createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} })
  const calls = []
  globalThis.fetch = async (input, init) => {
    const target = String(input)
    if (target.startsWith(rpcUrl)) { calls.push(`rpc:${JSON.parse(init.body).method}`); return new Response('unavailable', { status: 503 }) }
    if (target.startsWith('https://huggingface.co/')) { calls.push(new URL(target).pathname); return server.fetchImpl(target, init) }
    return saved.fetch(input, init) // the local stand-in for huggingface.co itself
  }
  return { calls }
}

test('real PostgreSQL routes: /api/allocation/<model id> is dormant without the flag and claims only with this market’s Hugging Face session and review', { skip: !url }, async t => {
  const pool = await prepare(), server = await hub()
  const config = Keypair.generate().publicKey, creator = Keypair.generate()
  const { calls } = await routeEnvironment(t, pool, server, { config, creator })
  const { marketId, mint } = await seedModel(pool, { hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', ownerKind: 'user', ownerSubject: OWNER, config, creator: creator.publicKey })
  const { marketId: plain } = await seedModel(pool, { hfId: GPT2, path: 'openai-community/gpt2', ownerKind: 'org', ownerSubject: ORG, config, creator: creator.publicKey, allocation: null })
  const route = await import('../app/api/allocation/[repo]/route.js')
  const auth = await import('../app/lib/hf-auth.mjs')
  const session = (token, subject, username, market = marketId) => auth.newHfSession({ subject, username, accessToken: token, expiresAt: Date.now() + 600_000, mode: 'claim', marketId: market })
  const requestFor = (repo, { cookie = null, body = null, origin = 'https://repo.ing' } = {}) => [{ url: `https://repo.ing/api/allocation/${repo}`,
    headers: new Headers({ origin, 'sec-fetch-site': 'same-origin' }), cookies: { get: name => name === auth.hfSessionCookie && cookie ? { value: cookie } : undefined },
    json: async () => body }, { params: Promise.resolve({ repo }) }]
  const send = async (handler, repo, options) => {
    const response = await handler(...requestFor(repo, options))
    return { status: response.status, body: response.status === 404 ? null : await response.json() }
  }
  const verifier = verifierFor(pool, server)
  const bound = await bindAs(pool, verifier, marketId, TOKENS.owner, OWNER)
  const owner = session(TOKENS.owner, OWNER, 'TheBloke')
  const sealed = (who = owner, extra = {}) => auth.sealHfAllocationReview(who, { repoId: marketId, wallet: bound.wallet, boundAt: bound.boundAt, ownerSubject: OWNER,
    amount: String(BUILDER_ALLOCATION), ...extra })

  assert.equal((await send(route.GET, marketId)).status, 404, 'dormant while HF_MARKETS_ENABLED is off')
  assert.equal((await send(route.POST, marketId, { cookie: auth.encryptHfSession(owner), body: { review: sealed() } })).status, 404)
  process.env.HF_MARKETS_ENABLED = 'true'
  assert.deepEqual(await send(route.GET, plain), { status: 200, body: { enrolled: false } }, 'a model market without the stamp')

  // Refused before anything is read: another origin, no session, a session for another market, a forged or foreign review.
  const before = calls.length
  for (const [options, status, message] of [
    [{ cookie: auth.encryptHfSession(owner), body: { review: sealed() }, origin: 'https://evil.example' }, 403, /Open this page on repo\.ing/],
    [{ body: { review: sealed() } }, 401, /Sign in with Hugging Face again/],
    [{ cookie: auth.encryptHfSession(session(TOKENS.owner, OWNER, 'TheBloke', plain)), body: { review: sealed() } }, 401, /Sign in with Hugging Face again/],
    [{ cookie: auth.encryptHfSession(owner), body: { review: 'forged' } }, 409, /Refresh this page to review the allocation/],
    [{ cookie: auth.encryptHfSession(owner), body: { review: sealed(session(TOKENS.owner, OWNER, 'TheBloke')) } }, 409, /Refresh this page to review the allocation/],
    [{ cookie: auth.encryptHfSession(owner), body: { review: auth.sealHfClaimReview(owner, { repoId: marketId, wallet: bound.wallet, boundAt: bound.boundAt, amount: '1', paid: '0' }) } },
      409, /Refresh this page to review the allocation/],
  ]) {
    const result = await send(route.POST, marketId, options)
    assert.deepEqual([result.status, result.body.status], [status, 'failed'], JSON.stringify(result.body))
    assert.match(result.body.error, message)
  }
  assert.deepEqual(calls.slice(before), [], 'no refusal reaches Hugging Face or Solana')

  // A stranger's own session and a review sealed for it: Hugging Face refuses them, in its own words.
  const stranger = session(TOKENS.stranger, STRANGER, 'stranger')
  let result = await send(route.POST, marketId, { cookie: auth.encryptHfSession(stranger), body: { review: sealed(stranger) } })
  assert.deepEqual([result.status, result.body.code], [409, 'HF_NOT_AUTHORIZED'])
  assert.match(result.body.error, /Only the model’s owner can do this/)
  // The owner's review passes every database and Hugging Face check, then meets the (unavailable) chain: nothing is paid.
  result = await send(route.POST, marketId, { cookie: auth.encryptHfSession(owner), body: { review: sealed() } })
  assert.deepEqual([result.status, result.body.status], [409, 'failed'])
  assert.ok(calls.includes('/oauth/userinfo') && calls.some(call => call.startsWith('rpc:')), calls.join(', '))
  assert.equal(await grants(pool), 0)

  // Once the grant is settled, a status read and a repeated claim both answer with the receipt, without asking anyone.
  await pool.query(`insert into builder_allocation_claims(github_repo_id, mint, wallet, amount, status, signature, signed_transaction, last_valid_block_height,
    settled_at, authority_source, authority_subject, authority_owner_subject) values ($1, $2, $3, 10000000000000, 'settled', 'GrantSignature', 'tx', 1, now(),
    'huggingface', $4, $4)`, [marketId, mint, bound.wallet, OWNER])
  const asked = calls.length
  result = await send(route.GET, marketId, { cookie: auth.encryptHfSession(owner) })
  assert.deepEqual([result.status, result.body.state, result.body.receipt.signature, result.body.wallet, result.body.boundBy, result.body.review],
    [200, 'settled', 'GrantSignature', bound.wallet, 'you', null])
  result = await send(route.POST, marketId, { cookie: auth.encryptHfSession(owner), body: { review: sealed() } })
  assert.deepEqual([result.status, result.body.status, result.body.signature, result.body.wallet], [200, 'settled', 'GrantSignature', bound.wallet])
  assert.deepEqual(calls.slice(asked), [])
})

// The columns builder_allocation_claims and markets had before 0052; rows are compared on exactly those.
async function rowChecksums(pool, tables) {
  const sums = {}
  for (const table of tables) {
    const { rows: [{ columns }] } = await pool.query(`select array_agg(column_name::text order by ordinal_position) as columns from information_schema.columns
      where table_schema = 'public' and table_name = $1`, [table])
    const { rows: [row] } = await pool.query(`select count(*)::int as n, md5(coalesce(string_agg(r, E'\\n' order by r), '')) as sum
      from (select row(${columns.map(column => `"${column}"`).join(', ')})::text as r from "${table}") rows`)
    sums[table] = { columns, value: `${row.n}:${row.sum}` }
  }
  return sums
}

test('real PostgreSQL: 0052 upgrades GitHub allocation history unchanged and re-applies as a no-op', { skip: !url }, async () => {
  requireDisposableDatabase()
  const adminUrl = new URL(url), targetUrl = new URL(url)
  adminUrl.pathname = '/postgres'; targetUrl.pathname = '/repoing_hf_allocation_upgrade_test'
  const admin = new pg.Pool({ connectionString: adminUrl.toString() })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0052-'))
  let pool
  try {
    await admin.query('drop database if exists repoing_hf_allocation_upgrade_test with (force)')
    await admin.query('create database repoing_hf_allocation_upgrade_test')
    pool = new pg.Pool({ connectionString: targetUrl.toString() })
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
    const at = journal.entries.findIndex(entry => entry.tag === '0052_model_builder_allocation')
    assert.ok(at > 0 && journal.entries[at - 1].tag === '0051_model_authority' && journal.entries[at].when > journal.entries[at - 1].when)
    await mkdir(join(folder, 'meta'))
    const baseline = { ...journal, entries: journal.entries.slice(0, at) }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(baseline))
    for (const entry of baseline.entries) await copyFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), join(folder, `${entry.tag}.sql`))
    await migrate(drizzle(pool), { migrationsFolder: folder })

    // GitHub history as 0011 stored it: a settled grant, an aborted attempt and a pending one, on stamped markets.
    for (const id of [9801, 9802]) {
      await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at) values ($1, 'octo', $2, $3, 1, 0, false, now())`,
        [id, `repo-${id}`, `octo/repo-${id}`])
      await pool.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol, launch_signature,
          builder_allocation_version, verification_bonus_lamports) values ($1, 'confirmed', $2, $3, 'L', 'C', 'R', 'R', $4, 1, 5000000)`, [id, `Mint${id}`, `Pool${id}`, `Launch${id}`])
    }
    const grant = (id, status, signature) => pool.query(`insert into builder_allocation_claims(github_repo_id, github_user_id, mint, wallet, amount, status, signature,
      signed_transaction, last_valid_block_height, settled_at, resolution_reason) values ($1, 501, $2, 'Wallet', 10000000000000, $3, $4, 'tx', 7, $5, $6)`,
    [id, `Mint${id}`, status, signature, status === 'settled' ? new Date('2026-09-30T00:00:00Z') : null, status === 'aborted' ? 'Finalized transaction failed' : null])
    await grant(9801, 'aborted', 'Aborted9801'); await grant(9801, 'settled', 'Settled9801'); await grant(9802, 'pending', 'Pending9802')
    const before = await rowChecksums(pool, ['builder_allocation_claims', 'markets'])

    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    for (const statement of (await readFile(new URL('../drizzle/0052_model_builder_allocation.sql', import.meta.url), 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
    const after = await rowChecksums(pool, ['builder_allocation_claims', 'markets'])
    for (const table of ['builder_allocation_claims', 'markets']) {
      const { rows: [row] } = await pool.query(`select count(*)::int as n, md5(coalesce(string_agg(r, E'\\n' order by r), '')) as sum
        from (select row(${before[table].columns.map(column => `"${column}"`).join(', ')})::text as r from "${table}") rows`)
      assert.equal(`${row.n}:${row.sum}`, before[table].value, `${table}: every existing row reads back identically`)
    }
    assert.deepEqual(after.builder_allocation_claims.columns.slice(-3), ['authority_source', 'authority_subject', 'authority_owner_subject'])
    assert.equal((await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, journal.entries.length)
    assert.deepEqual((await pool.query(`select distinct authority_source as source from builder_allocation_claims`)).rows, [{ source: 'github' }])
    const { rows: constraints } = await pool.query(`select conname as name, convalidated as valid from pg_constraint
      where conname = any($1) order by 1`, [['builder_allocation_claims_authority_check', 'builder_allocation_claims_github_only', 'builder_allocation_claims_source_range',
      'markets_hf_no_bonus', 'markets_hf_no_rewards']])
    assert.deepEqual(constraints, [{ name: 'builder_allocation_claims_authority_check', valid: true }, { name: 'builder_allocation_claims_source_range', valid: true },
      { name: 'markets_hf_no_bonus', valid: true }], 'the relaxed checks are gone and their replacements validated')
    // The worker deploys without migrating: allocation recovery reads only columns every schema has.
    const { rows: pending } = await pool.query(`select signature, signed_transaction as "signedTransaction", mint, wallet, amount::text, last_valid_block_height::text as expiry
      from builder_allocation_claims where github_repo_id = $1 and status = 'pending'`, ['9802'])
    assert.deepEqual(pending.map(row => row.signature), ['Pending9802'])
  } finally {
    await pool?.end()
    await admin.query('drop database if exists repoing_hf_allocation_upgrade_test with (force)')
    await admin.end(); await rm(folder, { recursive: true, force: true })
  }
})
