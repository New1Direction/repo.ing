import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createHfClient } from '../src/hf-api.mjs'
import { createHfOAuth, createHfVerifier } from '../src/hf-verification.mjs'
import { HF_OPT_OUT_ERROR, hfLaunchGuard, registerModel } from '../src/hf-launch.mjs'
import { createWalletBinding, modelBeneficiary } from '../src/wallet-binding.mjs'
import { createClaim } from '../src/claim.mjs'
import { activateDuePayoutAddresses, createPayoutAddresses } from '../src/payout-address.mjs'
import { activeDecision, createMaintainerDecisions } from '../src/maintainer-opt-outs.mjs'
import { createPromotionExclusions } from '../app/lib/promotion-exclusions.mjs'
import { recorded, startFakeHf } from './fixtures/hf-server.mjs'

// Real PostgreSQL with every committed migration (0050_model_opt_outs, 0051_model_authority), and a local stand-in for
// huggingface.co (the recorded Hub responses, plus scripted OAuth): who may bind a model market's payout wallet, paste
// one, claim its fees and decline or opt it out; the database rules behind each; and the two HTTP routes. Nothing reaches
// the network or a chain: claims stop at a sentinel chain read once authorization has passed.
const url = process.env.HF_CLAIMS_TEST_DATABASE_URL
const OWNER = '6426d3f3a7723d62b53c259b' // TheBloke, owner of TheBloke/Llama-2-7B-GGUF
const NEW_OWNER = '5f17f0a0925b9863e28ad517', ORG_ADMIN = '60a551a34ecc5d054c8ad93e', STRANGER = '63972e77157559113eb8396d'
const ORG = '659ebc82b61dd9658802f398' // openai-community, owner of openai-community/gpt2
const GGUF = '64f5fd954d3b1dd311d30e28', GPT2 = '621ffdc036468d709f17434d'
const TOKENS = { owner: 'hf_oauth_owner_token_test_only', newOwner: 'hf_oauth_new_owner_token_test', orgAdmin: 'hf_oauth_org_admin_token_test', stranger: 'hf_oauth_stranger_token_tests' }
const USERINFO = new Map([
  [TOKENS.owner, { sub: OWNER, preferred_username: 'TheBloke', orgs: [] }],
  [TOKENS.newOwner, { sub: NEW_OWNER, preferred_username: 'new-owner', orgs: [] }],
  [TOKENS.orgAdmin, { sub: ORG_ADMIN, preferred_username: 'org-admin', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin' }] }],
  [TOKENS.stranger, { sub: STRANGER, preferred_username: 'stranger', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'read' }] }],
])
const OAUTH = { clientId: 'repoing-test-client', clientSecret: 'test-only-hf-client-secret', redirectUri: 'https://repo.ing/api/hf/callback' }
const code = expected => error => error?.code === expected
const last4 = address => address.slice(-4)
const wallet = () => {
  const pair = generateKeyPairSync('ed25519')
  const address = new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)).toBase58()
  return { address, signMessage: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey) }
}

function requireDisposableDatabase() {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_hf_claims_test', 'Disposable Hugging Face claims test database required')
}

async function prepare() {
  requireDisposableDatabase()
  const pool = new pg.Pool({ connectionString: url })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query(`truncate model_verifications, payout_address_events, payout_address_requests, wallet_binding_challenges, repo_claims,
    repo_beneficiaries, repo_verifications, maintainer_opt_outs, agent_request_limits, markets, repositories, hf_models restart identity cascade`)
  return pool
}

// A registered model; with a market (confirmed, indexed, finalized), unless market is false.
async function seedModel(pool, { hfId, path, ownerKind, ownerSubject, market = true, config = Keypair.generate().publicKey, creator = Keypair.generate().publicKey }) {
  const { rows: [{ marketId }] } = await pool.query(`insert into hf_models(hf_id, repo_path, owner_handle, owner_kind, owner_subject)
    values ($1, $2, $3, $4, $5) returning market_ref::text as "marketId"`, [hfId, path, path.split('/')[0], ownerKind, ownerSubject])
  if (!market) return { marketId }
  const [owner, name] = path.split('/'), mint = Keypair.generate().publicKey
  await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at, source, hf_model_ref)
    values ($1, $2, $3, $4, 0, 0, false, now(), 'huggingface', $1)`, [marketId, owner, name, path])
  await pool.query(`insert into markets(github_repo_id, status, mint, pool, launcher_wallet, creator_wallet, token_name, token_symbol,
      launch_signature, launch_slot, launch_finality, indexed_at, last_verified_at)
    values ($1, 'confirmed', $2, $3, $4, $5, 'Model', 'MODEL', $6, 1, 'finalized', now(), now())`,
  [marketId, mint.toBase58(), deriveDbcPoolAddress(NATIVE_MINT, mint, config).toBase58(), Keypair.generate().publicKey.toBase58(), creator.toBase58(), `Launch${marketId}`])
  return { marketId, mint: mint.toBase58() }
}
const seedGguf = (pool, extra = {}) => seedModel(pool, { hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', ownerKind: 'user', ownerSubject: OWNER, ...extra })
const seedGpt2 = (pool, extra = {}) => seedModel(pool, { hfId: GPT2, path: 'openai-community/gpt2', ownerKind: 'org', ownerSubject: ORG, ...extra })
async function seedRepository(pool, id) {
  await pool.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
    values ($1, 'octo', $2, $3, 1, 0, false, now())`, [id, `repo-${id}`, `octo/repo-${id}`])
}

// The recorded Hub plus OAuth for the four test accounts: the token endpoint issues the owner's token for the code
// 'owner-code' (and refuses anything else), userinfo answers per token.
async function hub() {
  const server = await startFakeHf()
  server.route('/oauth/token', async (_, request) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const form = new URLSearchParams(body)
    return form.get('code') === 'owner-code' && /^[A-Za-z0-9_-]{43}$/.test(form.get('code_verifier') ?? '')
      ? { status: 200, headers: {}, body: { access_token: TOKENS.owner, token_type: 'Bearer', expires_in: 28800, scope: 'openid profile read-memberships' } }
      : { status: 400, headers: {}, body: { error: 'invalid_grant' } }
  })
  server.route('/oauth/userinfo', (_, request) => {
    const info = USERINFO.get(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))
    return info ? { status: 200, headers: {}, body: info } : { status: 401, headers: {}, body: { error: 'invalid_token' } }
  })
  return server
}
// TheBloke/Llama-2-7B-GGUF moves to new-owner (the same repository and _id, as a Hub transfer redirects).
function transfer(server) {
  const body = { ...structuredClone(recorded['model-llama-2-7b-gguf'].body), id: 'new-owner/Llama-2-7B-GGUF', author: 'new-owner' }
  server.route('/api/models/TheBloke/Llama-2-7B-GGUF', { status: 307, headers: { location: '/api/models/new-owner/Llama-2-7B-GGUF' }, body: null })
  server.route('/api/models/new-owner/Llama-2-7B-GGUF', { status: 200, headers: {}, body })
  server.route('/api/users/new-owner/overview', { status: 200, headers: {}, body: { _id: NEW_OWNER, user: 'new-owner', type: 'user', fullname: 'New Owner', avatarUrl: null } })
}
const verifierFor = (pool, server) => createHfVerifier({ pool, hf: createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} }),
  oauth: createHfOAuth({ ...OAUTH, fetchImpl: server.fetchImpl }) })
const check = (verifier, marketId, token, subject, extra = {}) => verifier.verifyMarketAuthority({ marketId, accessToken: token, expectedSubject: subject, ...extra })
async function bindAs(pool, verifier, marketId, token, subject, signer = wallet()) {
  const authority = await check(verifier, marketId, token, subject)
  const binder = createWalletBinding({ pool })
  const challenge = await binder.requestChallenge({ githubRepoId: marketId, wallet: signer.address, authority })
  return binder.bindWallet({ githubRepoId: marketId, wallet: signer.address, nonce: challenge.nonce, signature: signer.signMessage(challenge.message), authority })
}
async function refused(pool, sql, constraint, params = []) {
  await assert.rejects(pool.query(sql, params), error => {
    assert.equal(error.constraint, constraint, `${error.message} (${sql.slice(0, 80)})`)
    return true
  })
}

test('real PostgreSQL: model rows name exactly one Hugging Face actor, and each id range keeps its own source', { skip: !url }, async () => {
  const pool = await prepare()
  try {
    const { marketId: hf } = await seedGguf(pool)
    await seedRepository(pool, 9601)
    const W = Keypair.generate().publicKey.toBase58()
    // Bindings: a GitHub authority never binds a model market, nor a Hugging Face one a repository.
    await refused(pool, 'insert into repo_beneficiaries(github_repo_id, github_user_id, wallet) values ($1, 7, $2)', 'repo_beneficiaries_source_range', [hf, W])
    await refused(pool, `insert into repo_beneficiaries(github_repo_id, wallet, authority_source, authority_subject, authority_owner_subject)
      values (9601, $1, 'huggingface', $2, $2)`, 'repo_beneficiaries_source_range', [W, OWNER])
    await refused(pool, `insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, authority_source, authority_subject, authority_owner_subject)
      values ($1, 7, $2, 'huggingface', $3, $3)`, 'repo_beneficiaries_authority_check', [hf, W, OWNER])
    await refused(pool, `insert into repo_beneficiaries(github_repo_id, wallet, authority_source, authority_subject) values ($1, $2, 'huggingface', $3)`,
      'repo_beneficiaries_authority_check', [hf, W, OWNER])
    await refused(pool, 'insert into repo_beneficiaries(github_repo_id, wallet) values (9601, $1)', 'repo_beneficiaries_authority_check', [W])
    // Challenges: a Hugging Face challenge names a model market.
    await refused(pool, `insert into wallet_binding_challenges(github_repo_id, wallet, nonce, expires_at, authority_source, authority_subject, authority_owner_subject)
      values (9601, $1, $2, now() + interval '5 minutes', 'huggingface', $3, $3)`, 'wallet_binding_challenges_hf_range', [W, 'c'.repeat(48), OWNER])
    await refused(pool, `insert into wallet_binding_challenges(github_repo_id, wallet, nonce, expires_at, authority_source, authority_subject)
      values ($1, $2, $3, now() + interval '5 minutes', 'huggingface', 'TheBloke')`, 'wallet_binding_challenges_authority_check', [hf, W, 'd'.repeat(48)])
    // A missing subject fails the check (a CHECK that evaluates to NULL would pass, so each one says IS NOT NULL).
    await refused(pool, `insert into wallet_binding_challenges(github_repo_id, wallet, nonce, expires_at, authority_source, authority_subject)
      values ($1, $2, $3, now() + interval '5 minutes', 'huggingface', $4)`, 'wallet_binding_challenges_authority_check', [hf, W, 'e'.repeat(48), OWNER])
    await refused(pool, `insert into payout_address_requests(github_repo_id, wallet, requested_by_login, active_at, authority_source, requested_by_subject)
      values ($1, $2, 'x', now(), 'huggingface', $3)`, 'payout_address_requests_authority_check', [hf, W, OWNER])
    // Verifications: model markets only; a user-owned model's owner is the user, an organization's admin is someone else.
    const verification = `insert into model_verifications(github_repo_id, hf_id, subject, username, owner_kind, owner_subject, role) values ($1, $2, $3, 'x', $4, $5, $6)`
    await refused(pool, verification, 'model_verifications_market_range', [9601, GGUF, OWNER, 'user', OWNER, 'owner'])
    await refused(pool, verification, 'model_verifications_role_check', [hf, GGUF, OWNER, 'user', NEW_OWNER, 'owner'])
    await refused(pool, verification, 'model_verifications_role_check', [hf, GGUF, ORG_ADMIN, 'org', ORG, 'owner'])
    await refused(pool, verification, 'model_verifications_subject_check', [hf, GGUF, 'TheBloke', 'user', 'TheBloke', 'owner'])
    // Pasted requests and their audit log.
    await refused(pool, `insert into payout_address_requests(github_repo_id, wallet, requested_by_github_user_id, requested_by_login, active_at)
      values ($1, $2, 7, 'x', now() + interval '48 hours')`, 'payout_address_requests_source_range', [hf, W])
    await refused(pool, `insert into payout_address_requests(github_repo_id, wallet, requested_by_github_user_id, requested_by_login, active_at, authority_source,
      requested_by_subject, requested_by_owner_subject) values ($1, $2, 7, 'x', now() + interval '48 hours', 'huggingface', $3, $3)`,
    'payout_address_requests_authority_check', [hf, W, OWNER])
    const { rows: [request] } = await pool.query(`insert into payout_address_requests(github_repo_id, wallet, requested_by_login, active_at, authority_source,
      requested_by_subject, requested_by_owner_subject) values ($1, $2, 'TheBloke', now(), 'huggingface', $3, $3) returning id`, [hf, W, OWNER])
    await assert.rejects(pool.query('update payout_address_requests set requested_by_owner_subject = $2 where id = $1', [request.id, NEW_OWNER]), /terms cannot change/)
    await assert.rejects(pool.query("update payout_address_requests set authority_source = 'github', requested_by_github_user_id = 7 where id = $1", [request.id]), /terms cannot change/)
    await refused(pool, `insert into payout_address_events(request_id, github_repo_id, event, github_user_id, wallet) values ($1, $2, 'cancelled', 7, $3)`,
      'payout_address_events_actor_check', [request.id, hf, W])
    await refused(pool, `insert into payout_address_events(request_id, github_repo_id, event, actor_subject, wallet) values ($1, $2, 'activated', $3, $4)`,
      'payout_address_events_actor_check', [request.id, hf, OWNER, W])
    await pool.query(`insert into payout_address_events(request_id, github_repo_id, event, actor_subject, wallet) values ($1, $2, 'cancelled', $3, $4)`, [request.id, hf, OWNER, W])
    // A pasted model binding must be its own activated request, with the same user and owner.
    await assert.rejects(pool.query(`insert into repo_beneficiaries(github_repo_id, wallet, method, payout_request_id, authority_source, authority_subject, authority_owner_subject)
      values ($1, $2, 'pasted', $3, 'huggingface', $4, $4)`, [hf, W, request.id, OWNER]), /Pasted payout address is not active/)
    // Decisions (0050): the actor and the id range follow the source; withdrawn by exactly one actor.
    const decision = (values, columns) => pool.query(`insert into maintainer_opt_outs (${columns}) values (${values})`)
    await assert.rejects(decision(`${hf}, 'opt_out', 7`, 'github_repo_id, kind, github_user_id'), /maintainer_opt_outs_source_range/)
    await assert.rejects(decision(`9601, 'opt_out', 'huggingface', '${OWNER}'`, 'github_repo_id, kind, authority_source, actor_subject'), /maintainer_opt_outs_source_range/)
    await assert.rejects(decision(`${hf}, 'opt_out', 7, 'huggingface', '${OWNER}'`, 'github_repo_id, kind, github_user_id, authority_source, actor_subject'), /maintainer_opt_outs_actor_check/)
    await assert.rejects(decision(`${hf}, 'opt_out', 'huggingface'`, 'github_repo_id, kind, authority_source'), /maintainer_opt_outs_actor_check/)
    await assert.rejects(decision(`${hf}, 'opt_out', 'huggingface', '${OWNER}', now()`, 'github_repo_id, kind, authority_source, actor_subject, withdrawn_at'),
      /maintainer_opt_outs_withdrawn_check/)
    await assert.rejects(decision(`${hf}, 'opt_out', 'huggingface', '${OWNER}', now(), 7`, 'github_repo_id, kind, authority_source, actor_subject, withdrawn_at, withdrawn_by_github_user_id'),
      /maintainer_opt_outs_(actor|withdrawn)_check/)
    await decision(`${hf}, 'opt_out', 'huggingface', '${OWNER}', now(), '${OWNER}'`, 'github_repo_id, kind, authority_source, actor_subject, withdrawn_at, withdrawn_by_subject')
    // GitHub rows keep their rules: a user id, never a subject.
    await assert.rejects(decision(`9601, 'opt_out', 7, '${OWNER}'`, 'github_repo_id, kind, github_user_id, actor_subject'), /maintainer_opt_outs_actor_check/)
    await decision(`9601, 'opt_out', 7`, 'github_repo_id, kind, github_user_id')
  } finally { await pool.end() }
})

test('real PostgreSQL: a model wallet is bound only after a fresh recorded owner check, with its own message, and never by GitHub authority', { skip: !url }, async () => {
  const pool = await prepare(), server = await hub()
  try {
    const { marketId } = await seedGguf(pool), { marketId: orgMarket } = await seedGpt2(pool)
    const verifier = verifierFor(pool, server), binder = createWalletBinding({ pool }), signer = wallet()
    const claimed = { source: 'huggingface', subject: OWNER, ownerSubject: OWNER, hfId: GGUF }
    await assert.rejects(binder.requestChallenge({ githubRepoId: marketId, wallet: signer.address, authority: claimed }), /Recent Hugging Face owner verification required/,
      'an authority object without a recorded check is not enough')
    await assert.rejects(check(verifier, marketId, TOKENS.stranger, STRANGER), code('HF_NOT_AUTHORIZED'))
    assert.equal((await pool.query('select count(*)::int as n from model_verifications')).rows[0].n, 0, 'a refused check records nothing')

    const authority = await check(verifier, marketId, TOKENS.owner, OWNER)
    assert.deepEqual([authority.role, authority.ownerSubject, authority.hfId], ['owner', OWNER, GGUF])
    const challenge = await binder.requestChallenge({ githubRepoId: marketId, wallet: signer.address, authority })
    assert.ok(challenge.message.startsWith('repo.ing model beneficiary v1\n'))
    assert.ok(challenge.message.includes(`\nMarket ID: ${marketId}\nModel ID: ${GGUF}\nHugging Face user ID: ${OWNER}\n`))
    const { rows: [stored] } = await pool.query('select github_user_id, authority_source, authority_subject, authority_owner_subject from wallet_binding_challenges where nonce = $1', [challenge.nonce])
    assert.deepEqual(stored, { github_user_id: null, authority_source: 'huggingface', authority_subject: OWNER, authority_owner_subject: OWNER })

    // GitHub's paths cannot use it: the single bind, the batch bind, or a GitHub-domain signature over the same nonce.
    const signature = signer.signMessage(challenge.message)
    await assert.rejects(binder.bindWallet({ githubRepoId: marketId, githubUserId: '42', wallet: signer.address, nonce: challenge.nonce, signature }),
      /A github authority cannot act for a huggingface market/)
    await assert.rejects(binder.bindBatch({ nonces: [challenge.nonce], githubUserId: '42', wallet: signer.address, signature }), /A github authority cannot act for a huggingface market/)
    const githubBytes = ['repo.ing repository beneficiary v1', 'I bind this Solana wallet as beneficiary for the repository.', 'Chain: Solana',
      `Repository ID: ${marketId}`, `Wallet: ${signer.address}`, `Nonce: ${challenge.nonce}`, `Expires: ${challenge.expiresAt.toISOString()}`].join('\n')
    await assert.rejects(binder.bindWallet({ githubRepoId: marketId, wallet: signer.address, nonce: challenge.nonce, signature: signer.signMessage(githubBytes), authority }),
      /Invalid Solana wallet signature/)
    // Another user's fresh check cannot spend this user's challenge.
    const orgAuthority = await check(verifier, orgMarket, TOKENS.orgAdmin, ORG_ADMIN)
    await assert.rejects(binder.bindWallet({ githubRepoId: marketId, wallet: signer.address, nonce: challenge.nonce, signature, authority: orgAuthority }),
      /Model verification mismatch|Recent Hugging Face owner verification required/)
    assert.equal((await pool.query('select count(*)::int as n from repo_beneficiaries')).rows[0].n, 0)

    const bound = await binder.bindWallet({ githubRepoId: marketId, wallet: signer.address, nonce: challenge.nonce, signature, authority })
    assert.deepEqual([bound.wallet, bound.githubUserId, bound.method, bound.authoritySource, bound.authoritySubject, bound.authorityOwnerSubject],
      [signer.address, null, 'signature', 'huggingface', OWNER, OWNER])
    await assert.rejects(binder.bindWallet({ githubRepoId: marketId, wallet: signer.address, nonce: challenge.nonce, signature, authority }), /missing, mismatched, expired, or used/)

    // An organization's model: one of its admins binds; the binding names the organization as owner.
    const orgBound = await bindAs(pool, verifier, orgMarket, TOKENS.orgAdmin, ORG_ADMIN)
    assert.deepEqual([orgBound.authoritySubject, orgBound.authorityOwnerSubject], [ORG_ADMIN, ORG])
    assert.deepEqual((await pool.query('select role, owner_kind, owner_subject from model_verifications where github_repo_id = $1', [orgMarket])).rows,
      [{ role: 'admin', owner_kind: 'org', owner_subject: ORG }, { role: 'admin', owner_kind: 'org', owner_subject: ORG }])
    // The lookup by market id (and Hugging Face user) that pays these bindings, the counterpart of repo_beneficiaries.github_user_id.
    assert.deepEqual(await modelBeneficiary(pool, orgMarket, { subject: ORG_ADMIN }),
      { wallet: orgBound.wallet, boundAt: orgBound.boundAt, method: 'signature', subject: ORG_ADMIN, ownerSubject: ORG })
    assert.deepEqual((await modelBeneficiary(pool, marketId)).ownerSubject, OWNER)
    assert.equal(await modelBeneficiary(pool, orgMarket, { subject: STRANGER }), null, 'another user’s binding is not theirs')
    await assert.rejects(modelBeneficiary(pool, '9701'), /Not a Hugging Face market ID/)
    await assert.rejects(modelBeneficiary(pool, orgMarket, { subject: 'ORG' }), /Invalid Hugging Face user ID/)
    // Checks expire after five minutes.
    await pool.query("update model_verifications set verified_at = now() - interval '6 minutes'")
    await assert.rejects(binder.requestChallenge({ githubRepoId: marketId, wallet: signer.address, authority }), /Recent Hugging Face owner verification required/)
  } finally { await server.close(); await pool.end() }
})

test('real PostgreSQL: a model claim pays only a binding made by the current owner; after a transfer the new owner must bind again', { skip: !url }, async () => {
  const pool = await prepare(), server = await hub()
  try {
    const config = Keypair.generate().publicKey, creator = Keypair.generate()
    const { marketId } = await seedGguf(pool, { config, creator: creator.publicKey })
    const verifier = verifierFor(pool, server)
    const sentinel = 'CHAIN_READ_REACHED', rpc = []
    const connection = new Connection('http://127.0.0.1:9', 'confirmed')
    connection.getBalance = async () => 1_000_000_000
    connection._rpcRequest = async method => { rpc.push(method); throw new Error(sentinel) }
    const claimAs = (token, subject) => createClaim({ pool, connection, config, creator, githubVerifier: { source: 'huggingface',
      verifyCurrentAuthority: ({ githubRepoId }) => check(verifier, githubRepoId, token, subject) } })
    const request = { githubRepoId: marketId, githubAuthorization: { session: true } }

    await assert.rejects(claimAs(TOKENS.owner, OWNER).claim(request), /no bound beneficiary/)
    const first = await bindAs(pool, verifier, marketId, TOKENS.owner, OWNER)
    await assert.rejects(claimAs(TOKENS.owner, OWNER).claim(request), new RegExp(sentinel), 'the owner of a current binding goes on to the chain')
    assert.ok(rpc.length > 0); rpc.length = 0
    // Not the owner, or a GitHub authority: refused before any chain read.
    await assert.rejects(claimAs(TOKENS.stranger, STRANGER).claim(request), code('HF_NOT_AUTHORIZED'))
    await assert.rejects(createClaim({ pool, connection, config, creator, githubVerifier: { verifyCurrentAuthority: async () =>
      ({ verified: true, permission: 'admin', githubRepoId: BigInt(marketId), githubUserId: 42n, verifiedAt: new Date() }) } }).claim(request),
    /A github authority cannot act for a huggingface market/)
    // A verifier answering for another source is refused too.
    await assert.rejects(createClaim({ pool, connection, config, creator, githubVerifier: { source: 'huggingface', verifyCurrentAuthority: async () =>
      ({ verified: true, permission: 'admin', githubRepoId: BigInt(marketId), githubUserId: 42n, verifiedAt: new Date() }) } }).claim(request),
    /Current Hugging Face owner authority required/)

    // The model is transferred: the previous owner can no longer claim, and the new owner cannot claim the old binding.
    transfer(server)
    await assert.rejects(claimAs(TOKENS.owner, OWNER).claim(request), error => error.code === 'HF_NOT_AUTHORIZED' && error.reason === 'not-owner')
    await assert.rejects(claimAs(TOKENS.newOwner, NEW_OWNER).claim(request), /owner changed since this payout wallet was set/)
    assert.deepEqual(rpc, [], 'no chain read in any refusal')
    const { rows: [registry] } = await pool.query('select repo_path, owner_subject from hf_models where market_ref = $1', [marketId])
    assert.deepEqual(registry, { repo_path: 'new-owner/Llama-2-7B-GGUF', owner_subject: NEW_OWNER }, 'the registry follows the same _id to its new path')

    // The previous owner's binding does not count as the new owner's: the new owner may paste that same address under
    // their own authority (it starts its own hold), and only then does a repeat count as already waiting.
    const addresses = createPayoutAddresses({ pool, connection: { getAccountInfo: async () => null } })
    const newOwner = Object.assign(input => check(verifier, input.githubRepoId, TOKENS.newOwner, NEW_OWNER), { source: 'huggingface' })
    const repasted = await addresses.request({ githubRepoId: marketId, address: first.wallet, confirm: last4(first.wallet), verifyAuthority: newOwner })
    assert.equal(repasted.previousWallet, first.wallet)
    assert.deepEqual((await pool.query('select requested_by_subject as s, requested_by_owner_subject as o from payout_address_requests where id = $1', [repasted.id])).rows[0],
      { s: NEW_OWNER, o: NEW_OWNER })
    await assert.rejects(addresses.request({ githubRepoId: marketId, address: first.wallet, confirm: last4(first.wallet), verifyAuthority: newOwner }), code('ALREADY_PENDING'))

    const rebound = await bindAs(pool, verifier, marketId, TOKENS.newOwner, NEW_OWNER)
    assert.deepEqual([rebound.authoritySubject, rebound.authorityOwnerSubject], [NEW_OWNER, NEW_OWNER])
    await assert.rejects(claimAs(TOKENS.newOwner, NEW_OWNER).claim(request), new RegExp(sentinel))
    assert.equal((await pool.query('select count(*)::int as n from repo_claims')).rows[0].n, 0, 'no payout intent was created in any case')
  } finally { await server.close(); await pool.end() }
})

test('real PostgreSQL: a pasted model address records its Hugging Face actor, waits out the hold, and its binding inherits the owner', { skip: !url }, async () => {
  const pool = await prepare(), server = await hub()
  try {
    const { marketId } = await seedGguf(pool)
    const verifier = verifierFor(pool, server)
    const as = (token, subject) => Object.assign(input => check(verifier, input.githubRepoId, token, subject), { source: 'huggingface' })
    const service = createPayoutAddresses({ pool, connection: { getAccountInfo: async () => null } })
    const first = wallet().address, second = wallet().address

    await assert.rejects(service.request({ githubRepoId: marketId, address: first, confirm: last4(first), verifyAuthority: as(TOKENS.stranger, STRANGER) }), code('HF_NOT_AUTHORIZED'))
    await assert.rejects(service.request({ githubRepoId: marketId, address: first, confirm: last4(first), verifyAuthority: async () => assert.fail('GitHub is never asked') }),
      /A github authority cannot act for a huggingface market/)
    await assert.rejects(service.requestBatch({ githubRepoIds: [marketId], address: first, confirm: last4(first), verifyAuthority: as(TOKENS.owner, OWNER) }),
      code('INVALID_REPOSITORIES'))
    const pending = await service.request({ githubRepoId: marketId, address: first, confirm: last4(first), verifyAuthority: as(TOKENS.owner, OWNER) })
    assert.deepEqual([pending.requestedByLogin, pending.notify], ['TheBloke', []])
    const replaced = await service.request({ githubRepoId: marketId, address: second, confirm: last4(second), verifyAuthority: as(TOKENS.owner, OWNER) })
    const rows = async () => (await pool.query(`select status, authority_source as source, requested_by_github_user_id as "githubUser", requested_by_subject as subject,
      requested_by_owner_subject as owner, resolved_by_subject as "resolvedBy" from payout_address_requests where github_repo_id = $1 order by id`, [marketId])).rows
    assert.deepEqual(await rows(), [
      { status: 'superseded', source: 'huggingface', githubUser: null, subject: OWNER, owner: OWNER, resolvedBy: OWNER },
      { status: 'pending', source: 'huggingface', githubUser: null, subject: OWNER, owner: OWNER, resolvedBy: null }])
    await service.cancel({ githubRepoId: marketId, requestId: replaced.id, verifyAuthority: as(TOKENS.owner, OWNER) })
    const again = await service.request({ githubRepoId: marketId, address: first, confirm: last4(first), verifyAuthority: as(TOKENS.owner, OWNER) })
    assert.deepEqual((await pool.query(`select event, github_user_id as "githubUser", actor_subject as actor from payout_address_events
      where github_repo_id = $1 order by id`, [marketId])).rows.map(Object.values),
    [['requested', null, OWNER], ['superseded', null, OWNER], ['requested', null, OWNER], ['cancelled', null, OWNER], ['requested', null, OWNER]])

    // The hold passes: the activated binding names the same user and owner, so it pays only while that owner owns the model.
    const client = await pool.connect()
    try {
      await client.query('begin'); await client.query('set local session_replication_role = replica')
      await client.query(`update payout_address_requests set requested_at = requested_at - interval '49 hours', active_at = active_at - interval '49 hours' where id = $1`, [again.id])
      await client.query('commit')
    } finally { client.release() }
    const [activation] = await activateDuePayoutAddresses(pool, { repoIds: [marketId] })
    assert.equal(activation.status, 'activated')
    const { rows: [binding] } = await pool.query(`select wallet, method, github_user_id, authority_source, authority_subject, authority_owner_subject
      from repo_beneficiaries where github_repo_id = $1`, [marketId])
    assert.deepEqual(binding, { wallet: first, method: 'pasted', github_user_id: null, authority_source: 'huggingface', authority_subject: OWNER, authority_owner_subject: OWNER })
    // A wallet signature by the current owner replaces a waiting pasted address, recorded under the Hugging Face user.
    const waiting = await service.request({ githubRepoId: marketId, address: second, confirm: last4(second), verifyAuthority: as(TOKENS.owner, OWNER) })
    await bindAs(pool, verifier, marketId, TOKENS.owner, OWNER)
    assert.deepEqual((await pool.query('select status, resolved_by_subject as "by" from payout_address_requests where id = $1', [waiting.id])).rows[0],
      { status: 'superseded', by: OWNER })
  } finally { await server.close(); await pool.end() }
})

test('real PostgreSQL: model owners and org admins decline or opt out by registry id; launches and promotion read it', { skip: !url }, async () => {
  const pool = await prepare(), server = await hub()
  const warn = console.warn
  console.warn = () => {}
  try {
    const { marketId: live } = await seedGguf(pool)
    await seedRepository(pool, 9701)
    const verifier = verifierFor(pool, server)
    const decisionsAs = (token, subject) => createMaintainerDecisions({ pool, source: 'huggingface', verifyAdmin: ({ githubRepoId, live: hasMarket }) =>
      check(verifier, githubRepoId, token, subject, { record: hasMarket }) })

    // A model without a market: registered by its _id, then opted out by an admin of the organization that owns it.
    const found = await verifier.lookupModel('https://huggingface.co/openai-community/gpt2')
    assert.deepEqual([found.hfId, found.owner.id, found.owner.kind], [GPT2, ORG, 'org'])
    const unlaunched = String(await registerModel(pool, found, found.owner))
    assert.equal(String(await registerModel(pool, found, found.owner)), unlaunched, 'one registry id per model _id')
    await assert.rejects(decisionsAs(TOKENS.stranger, STRANGER).create({ repoId: unlaunched, kind: 'opt_out' }), error => error.status === 403)
    await assert.rejects(decisionsAs(TOKENS.orgAdmin, ORG_ADMIN).create({ repoId: unlaunched, kind: 'decline' }), error => error.status === 409 && /no market/.test(error.message))
    const optedOut = await decisionsAs(TOKENS.orgAdmin, ORG_ADMIN).create({ repoId: unlaunched, kind: 'opt_out', note: 'Please do not launch our model.' })
    assert.deepEqual([optedOut.repoId, optedOut.kind, optedOut.note], [unlaunched, 'opt_out', 'Please do not launch our model.'])
    // Model launches read it like a repository's decision: the launch guard (src/hf-launch.mjs) refuses the model.
    const launchGuard = hfLaunchGuard({ pool, hf: createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} }), enabled: () => true })
    await assert.rejects(launchGuard({ market: { githubRepoId: unlaunched } }), error => error.message === HF_OPT_OUT_ERROR && error.code === 'MAINTAINER_OPTED_OUT')
    assert.equal((await pool.query('select count(*)::int as n from model_verifications where github_repo_id = $1', [unlaunched])).rows[0].n, 0, 'no market, nothing recorded')

    // A launched model: its owner declines the market, then withdraws.
    const declined = await decisionsAs(TOKENS.owner, OWNER).create({ repoId: live, kind: 'decline' })
    assert.equal(declined.kind, 'decline')
    assert.deepEqual(await activeDecision(pool, live), declined, 'read like a repository decision')
    assert.deepEqual((await pool.query(`select authority_source as source, github_user_id as "githubUser", actor_subject as actor
      from maintainer_opt_outs where github_repo_id = $1`, [live])).rows, [{ source: 'huggingface', githubUser: null, actor: OWNER }])

    // Sources never cross: a GitHub decision for a model id, or a model decision for a repository id, is refused before anything is read.
    const github = createMaintainerDecisions({ pool, verifyAdmin: async () => assert.fail('never asked') })
    await assert.rejects(github.create({ repoId: live, kind: 'decline' }), error => error.status === 400 && /Invalid repository/.test(error.message))
    await assert.rejects(decisionsAs(TOKENS.owner, OWNER).create({ repoId: '9701', kind: 'opt_out' }), error => error.status === 400 && /Invalid model/.test(error.message))

    // The do-not-promote set: both decisions, plus env entries resolved to registry ids (by _id or by path).
    assert.deepEqual([...await createPromotionExclusions({ pool, env: { PROMOTION_EXCLUDED_REPO_IDS: '7' } })()].sort(), ['7', live, unlaunched].sort())
    await decisionsAs(TOKENS.owner, OWNER).withdraw({ repoId: live })
    assert.equal(await activeDecision(pool, live), null)
    assert.deepEqual((await pool.query('select withdrawn_by_subject as by from maintainer_opt_outs where github_repo_id = $1', [live])).rows, [{ by: OWNER }])
    assert.deepEqual([...await createPromotionExclusions({ pool, env: { PROMOTION_EXCLUDED_REPO_IDS: `7, hf:${GGUF}` } })()].sort(), ['7', live, unlaunched].sort())
    assert.deepEqual([...await createPromotionExclusions({ pool, env: { PROMOTION_EXCLUDED_REPO_IDS: 'hf:THEBLOKE/llama-2-7b-gguf, hf:nobody/unregistered' } })()].sort(),
      [live, unlaunched].sort())
    assert.deepEqual([...await createPromotionExclusions({ pool, env: {} })()], [unlaunched])
  } finally { console.warn = warn; await server.close(); await pool.end() }
})

// The web routes' environment: this database behind database(), the Hugging Face OAuth settings, and a fetch that sends
// huggingface.co to the local stand-in and answers the Solana RPC (an unused fresh account). Restored after the test.
async function routeEnvironment(t, pool, server) {
  const saved = { env: { ...process.env }, pool: globalThis.__gitfunPool, fetch: globalThis.fetch, hf: globalThis.__repoingHfClient }
  const KEYS = ['DATABASE_URL', 'APP_ORIGIN', 'HF_MARKETS_ENABLED', 'HF_OAUTH_CLIENT_ID', 'HF_OAUTH_CLIENT_SECRET', 'HF_OAUTH_REDIRECT_URI', 'SOLANA_RPC_URL']
  t.after(async () => {
    for (const key of KEYS) { if (saved.env[key] === undefined) delete process.env[key]; else process.env[key] = saved.env[key] }
    globalThis.__gitfunPool = saved.pool; globalThis.fetch = saved.fetch; globalThis.__repoingHfClient = saved.hf
    await server.close(); await pool.end()
  })
  const rpc = 'http://127.0.0.1:8998'
  Object.assign(process.env, { DATABASE_URL: url, APP_ORIGIN: 'https://repo.ing', HF_OAUTH_CLIENT_ID: OAUTH.clientId, HF_OAUTH_CLIENT_SECRET: OAUTH.clientSecret,
    HF_OAUTH_REDIRECT_URI: OAUTH.redirectUri, SOLANA_RPC_URL: rpc })
  delete process.env.HF_MARKETS_ENABLED
  globalThis.__gitfunPool = pool
  delete globalThis.__repoingHfClient
  const calls = []
  globalThis.fetch = async (input, init) => {
    const target = String(input)
    if (target.startsWith(rpc)) {
      const body = JSON.parse(init.body)
      calls.push(`rpc:${body.method}`)
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: null } })
    }
    if (target.startsWith('https://huggingface.co/')) {
      calls.push(new URL(target).pathname)
      return server.fetchImpl(target, init)
    }
    return saved.fetch(input, init) // the local stand-in for huggingface.co itself
  }
  return { calls }
}

test('real PostgreSQL routes: /api/hf/bind and /api/opt-out/hf need the flag, the same origin, a Hugging Face session and the current owner', { skip: !url }, async t => {
  const pool = await prepare(), server = await hub()
  const { calls } = await routeEnvironment(t, pool, server)
  const { marketId, mint } = await seedGguf(pool)
  const { POST: bind } = await import('../app/api/hf/bind/route.js')
  const optOut = await import('../app/api/opt-out/hf/route.js')
  const { encryptHfSession, newHfSession, hfSessionCookie } = await import('../app/lib/hf-auth.mjs')
  const session = (token, subject, username, extra = {}) => encryptHfSession(newHfSession({ subject, username, accessToken: token,
    expiresAt: Date.now() + 600_000, mode: 'claim', marketId, ...extra }))
  const owner = session(TOKENS.owner, OWNER, 'TheBloke')
  const requestFor = (path, cookie, body, origin = 'https://repo.ing') => ({ url: `https://repo.ing${path}`, nextUrl: new URL(`https://repo.ing${path}`),
    headers: new Headers({ origin, 'sec-fetch-site': 'same-origin' }), cookies: { get: name => name === hfSessionCookie && cookie ? { value: cookie } : undefined },
    json: async () => body })
  const send = async (handler, path, cookie, body, origin) => {
    const response = await handler(requestFor(path, cookie, body, origin))
    assert.equal(response.headers.get('cache-control')?.startsWith('private, no-store') ?? response.status === 404, true)
    return { status: response.status, body: response.status === 404 ? null : await response.json() }
  }
  const signer = wallet()

  assert.equal((await send(bind, '/api/hf/bind', owner, { action: 'challenge', marketId, wallet: signer.address })).status, 404, 'dormant while HF_MARKETS_ENABLED is off')
  assert.equal((await send(optOut.GET, '/api/opt-out/hf?model=openai-community/gpt2', owner)).status, 404)
  process.env.HF_MARKETS_ENABLED = 'true'
  let result = await send(bind, '/api/hf/bind', owner, { action: 'challenge', marketId, wallet: signer.address }, 'https://evil.example')
  assert.equal(result.status, 403)
  result = await send(bind, '/api/hf/bind', null, { action: 'challenge', marketId, wallet: signer.address })
  assert.equal(result.status, 401)
  result = await send(bind, '/api/hf/bind', session(TOKENS.owner, OWNER, 'TheBloke', { marketId: String(BigInt(marketId) + 1n) }), { action: 'challenge', marketId, wallet: signer.address })
  assert.equal(result.status, 403)
  assert.deepEqual(calls, [], 'refused requests never reach Hugging Face or Solana')
  result = await send(bind, '/api/hf/bind', session(TOKENS.stranger, STRANGER, 'stranger'), { action: 'challenge', marketId, wallet: signer.address })
  assert.equal(result.status, 403, JSON.stringify(result.body)); assert.equal(result.body.code, "HF_NOT_AUTHORIZED")

  const challenge = await send(bind, '/api/hf/bind', owner, { action: 'challenge', marketId, wallet: signer.address })
  assert.equal(challenge.status, 200); assert.match(challenge.body.message, /^repo\.ing model beneficiary v1\n/)
  const signature = signer.signMessage(challenge.body.message).toString('base64')
  result = await send(bind, '/api/hf/bind', owner, { action: 'bind', marketId, wallet: signer.address, nonce: challenge.body.nonce, signature })
  assert.equal(result.status, 200); assert.equal(result.body.wallet, signer.address)
  assert.equal(calls.filter(call => call.startsWith('rpc:')).length, 0, 'binding needs no chain read')

  const pasted = wallet().address
  result = await send(bind, '/api/hf/bind', owner, { action: 'paste', repoId: marketId, address: pasted, confirm: last4(pasted) })
  assert.equal(result.status, 200); assert.equal(result.body.pending.wallet, pasted); assert.equal(result.body.previousWallet, signer.address)
  assert.ok(calls.includes('rpc:getAccountInfo'))
  result = await send(bind, '/api/hf/bind', owner, { action: 'cancel', repoId: marketId, requestId: result.body.pending.id })
  assert.equal(result.status, 200); assert.equal(result.body.cancelled, true)
  result = await send(bind, '/api/hf/bind', owner, { action: 'repoint', marketId, url: 'https://huggingface.co/openai-community/gpt2' })
  assert.equal(result.status, 409); assert.equal(result.body.code, 'HF_REPOINT_MISMATCH')
  // Re-pointing is open to any session for the market (no owner can be checked while the registry path is stale) and only
  // ever accepts the same _id: a non-owner can confirm the model's true address, never change which model it is.
  result = await send(bind, '/api/hf/bind', session(TOKENS.stranger, STRANGER, 'stranger'), { action: 'repoint', marketId, url: 'huggingface.co/TheBloke/Llama-2-7B-GGUF' })
  assert.equal(result.status, 200); assert.equal(result.body.path, 'TheBloke/Llama-2-7B-GGUF')

  // /opt-out: any Hugging Face session may look a model up; changes need the current owner and the reviewed _id.
  const models = encryptHfSession(newHfSession({ subject: OWNER, username: 'TheBloke', accessToken: TOKENS.owner, expiresAt: Date.now() + 600_000, mode: 'models' }))
  result = await send(optOut.GET, `/api/opt-out/hf?model=${encodeURIComponent('https://huggingface.co/TheBloke/Llama-2-7B-GGUF')}`, models)
  assert.equal(result.status, 200)
  assert.deepEqual([result.body.model.hfId, result.body.marketId, result.body.mint, result.body.live, result.body.decision, result.body.authority.authorized, result.body.authority.role],
    [GGUF, marketId, mint, true, null, true, 'owner'])
  result = await send(optOut.GET, '/api/opt-out/hf?model=openai-community/gpt2', models)
  assert.deepEqual([result.body.marketId, result.body.authority.authorized], [null, false])
  result = await send(optOut.POST, '/api/opt-out/hf', models, { action: 'decline', model: 'TheBloke/Llama-2-7B-GGUF', hfId: GPT2 })
  assert.equal(result.status, 409, 'a URL that now names another model changes nothing')
  result = await send(optOut.POST, '/api/opt-out/hf', models, { action: 'opt_out', model: 'openai-community/gpt2', hfId: GPT2 })
  assert.equal(result.status, 403)
  assert.equal((await pool.query('select count(*)::int as n from hf_models where hf_id = $1', [GPT2])).rows[0].n, 0, 'a non-owner registers nothing')
  result = await send(optOut.POST, '/api/opt-out/hf', models, { action: 'decline', model: 'TheBloke/Llama-2-7B-GGUF', hfId: GGUF, note: 'Not ours to sell.' })
  assert.equal(result.status, 200); assert.deepEqual([result.body.decision.kind, result.body.decision.note, result.body.marketId], ['decline', 'Not ours to sell.', marketId])
  result = await send(optOut.POST, '/api/opt-out/hf', models, { action: 'withdraw', model: 'TheBloke/Llama-2-7B-GGUF', hfId: GGUF }, 'https://evil.example')
  assert.equal(result.status, 403)
  result = await send(optOut.POST, '/api/opt-out/hf', models, { action: 'withdraw', model: 'TheBloke/Llama-2-7B-GGUF', hfId: GGUF })
  assert.equal(result.status, 200); assert.equal(result.body.decision, null)
})

test('real PostgreSQL routes: sign-in start and callback, and the claim form', { skip: !url }, async t => {
  const pool = await prepare(), server = await hub()
  const { calls } = await routeEnvironment(t, pool, server)
  const { marketId } = await seedGguf(pool), { marketId: orgMarket } = await seedGpt2(pool)
  const start = (await import('../app/api/hf/start/route.js')).GET
  const callback = (await import('../app/api/hf/callback/route.js')).GET
  const claim = (await import('../app/api/hf/claim/route.js')).POST
  const auth = await import('../app/lib/hf-auth.mjs')
  const request = (path, { jar = {}, origin = 'https://repo.ing', form = {} } = {}) => ({ url: `https://repo.ing${path}`,
    headers: new Headers({ origin, 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.7' }),
    cookies: { get: name => jar[name] === undefined ? undefined : { value: jar[name] } },
    formData: async () => { const data = new FormData(); for (const [key, value] of Object.entries(form)) data.append(key, value); return data } })
  const setCookies = response => Object.fromEntries(response.headers.getSetCookie().map(line => {
    const [pair, ...attributes] = line.split('; ')
    return [pair.slice(0, pair.indexOf('=')), { value: pair.slice(pair.indexOf('=') + 1), attributes }]
  }))
  const location = response => new URL(response.headers.get('location'))

  for (const response of [await start(request(`/api/hf/start?mode=claim&market=${marketId}`)), await callback(request('/api/hf/callback?code=owner-code&state=x')),
    await claim(request('/api/hf/claim', { form: { repoId: marketId } }))]) assert.equal(response.status, 404, 'dormant while HF_MARKETS_ENABLED is off')
  process.env.HF_MARKETS_ENABLED = 'true'

  // Start: PKCE S256 with the three scopes; the owning organization's _id from the registry (no Hugging Face call), or from ?org=.
  let response = await start(request(`/api/hf/start?mode=claim&market=${marketId}`))
  assert.equal(response.status, 307)
  let authorize = location(response)
  assert.equal(`${authorize.origin}${authorize.pathname}`, 'https://huggingface.co/oauth/authorize')
  assert.deepEqual([authorize.searchParams.get('scope'), authorize.searchParams.get('code_challenge_method'), authorize.searchParams.get('orgIds'),
    authorize.searchParams.get('redirect_uri')], ['openid profile read-memberships', 'S256', null, OAUTH.redirectUri])
  const stateCookie = setCookies(response)[auth.hfStateCookie]
  assert.deepEqual(stateCookie.attributes, ['Path=/', 'Max-Age=600', 'HttpOnly', 'SameSite=Lax'])
  const state = authorize.searchParams.get('state')
  assert.equal(auth.readHfState(stateCookie.value).state, state)
  authorize = location(await start(request(`/api/hf/start?mode=claim&market=${orgMarket}`)))
  assert.equal(authorize.searchParams.get('orgIds'), ORG, 'an organization-owned model asks for that organization')
  authorize = location(await start(request(`/api/hf/start?mode=models&model=openai-community/gpt2&org=${ORG}`)))
  assert.equal(authorize.searchParams.get('orgIds'), ORG)
  assert.equal(location(await start(request('/api/hf/start?mode=models&org=openai-community'))).searchParams.get('orgIds'), null)
  for (const market of ['1384142609', String(BigInt(marketId) + 7n), 'abc']) {
    assert.equal(location(await start(request(`/api/hf/start?mode=claim&market=${market}`))).pathname, '/explore', market)
  }
  assert.deepEqual(calls, [], 'starting a sign-in never calls Hugging Face')

  // Callback: nothing is honoured without the matching state, not even an error, and no cookie changes then.
  const jar = { [auth.hfStateCookie]: stateCookie.value, [auth.hfSessionCookie]: 'an-earlier-session' }
  response = await callback(request(`/api/hf/callback?code=owner-code&state=${'f'.repeat(64)}`, { jar }))
  assert.deepEqual([location(response).searchParams.get('error'), response.headers.getSetCookie()], ['hf-sign-in-failed', []])
  response = await callback(request(`/api/hf/callback?error=access_denied&state=${state}`, { jar }))
  assert.equal(location(response).searchParams.get('error'), 'hf-denied')
  assert.deepEqual(Object.keys(setCookies(response)), [auth.hfStateCookie], 'the state is spent; an earlier session is left alone')
  assert.equal(setCookies(response)[auth.hfStateCookie].attributes[1], 'Max-Age=0')
  response = await callback(request(`/api/hf/callback?code=wrong-code&state=${state}`, { jar }))
  assert.deepEqual([location(response).searchParams.get('error'), Object.keys(setCookies(response))], ['hf-sign-in-failed', [auth.hfStateCookie]])
  response = await callback(request(`/api/hf/callback?code=owner-code&state=${state}`, { jar }))
  assert.deepEqual([location(response).pathname, location(response).searchParams.get('hf')], [`/claim/${marketId}`, 'signed-in'])
  const sessionCookie = setCookies(response)[auth.hfSessionCookie]
  const maxAge = Number(sessionCookie.attributes.find(a => a.startsWith('Max-Age=')).slice(8))
  assert.ok(maxAge > 3500 && maxAge <= 3600, `at most an hour, whatever the token allows (${maxAge})`)
  const signedIn = auth.readHfSession(sessionCookie.value)
  assert.deepEqual([signedIn.subject, signedIn.username, signedIn.mode, signedIn.marketId], [OWNER, 'TheBloke', 'claim', marketId])
  assert.ok(!sessionCookie.value.includes(TOKENS.owner), 'the token is sealed')

  // The claim form: same origin, this market's session, and a review sealed for that session and market.
  const claimJar = { [auth.hfSessionCookie]: sessionCookie.value }
  response = await claim(request('/api/hf/claim', { jar: claimJar, origin: 'https://evil.example', form: { repoId: marketId } }))
  assert.equal(response.status, 403)
  response = await claim(request('/api/hf/claim', { form: { repoId: marketId, review: 'x' } }))
  assert.deepEqual([response.status, location(response).searchParams.get('error')], [303, 'verification-failed'])
  response = await claim(request('/api/hf/claim', { jar: claimJar, form: { repoId: marketId, review: 'forged' } }))
  assert.deepEqual([response.status, location(response).searchParams.get('error')], [303, 'review-changed'])
  const review = auth.sealHfClaimReview(signedIn, { repoId: marketId, wallet: Keypair.generate().publicKey.toBase58(), boundAt: new Date(), amount: '1', paid: '0' })
  response = await claim(request('/api/hf/claim', { jar: { [auth.hfSessionCookie]: auth.encryptHfSession({ ...signedIn, marketId: orgMarket }) },
    form: { repoId: orgMarket, review } }))
  assert.equal(location(response).searchParams.get('error'), 'review-changed', 'a review is good only for its own market and session')
  response = await claim(request('/api/hf/claim', { jar: claimJar, form: { repoId: marketId, review } }))
  assert.equal(response.status, 200)
  const page = await response.text()
  assert.ok(page.includes('Checking Hugging Face ownership and the current claim state'))
  assert.ok(page.includes(`location.replace("https://repo.ing/claim/${marketId}?error=payout-unavailable")`), 'it reaches the claim (no payout signer here)')
})

// The tables 0050/0051 change, with the columns they had before; rows are compared on exactly those columns.
const UPGRADED = ['maintainer_opt_outs', 'payout_address_events', 'payout_address_requests', 'repo_beneficiaries', 'wallet_binding_challenges']
async function rowChecksums(pool, columns) {
  const sums = {}
  for (const [name, list] of Object.entries(columns)) {
    const { rows: [row] } = await pool.query(`select count(*)::int as n, md5(coalesce(string_agg(r, E'\\n' order by r), '')) as sum
      from (select row(${list.map(column => `"${column}"`).join(', ')})::text as r from "${name}") rows`)
    sums[name] = `${row.n}:${row.sum}`
  }
  return sums
}

test('real PostgreSQL: 0050 and 0051 upgrade GitHub history unchanged, re-apply as a no-op, and GitHub activation runs on either schema', { skip: !url }, async () => {
  requireDisposableDatabase()
  const adminUrl = new URL(url), targetUrl = new URL(url)
  adminUrl.pathname = '/postgres'; targetUrl.pathname = '/repoing_hf_upgrade_test'
  const admin = new pg.Pool({ connectionString: adminUrl.toString() })
  const folder = await mkdtemp(join(tmpdir(), 'repoing-0051-'))
  let pool
  try {
    await admin.query('drop database if exists repoing_hf_upgrade_test with (force)')
    await admin.query('create database repoing_hf_upgrade_test')
    pool = new pg.Pool({ connectionString: targetUrl.toString() })
    // The database as main has it: every migration before 0050.
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'))
    const at = journal.entries.findIndex(entry => entry.tag === '0050_model_opt_outs')
    assert.ok(at > 0 && journal.entries[at + 1]?.tag === '0051_model_authority', '0051 follows 0050 (later migrations, such as 0052, come after both)')
    await mkdir(join(folder, 'meta'))
    const baseline = { ...journal, entries: journal.entries.slice(0, at) }
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(baseline))
    for (const entry of baseline.entries) await copyFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), join(folder, `${entry.tag}.sql`))
    await migrate(drizzle(pool), { migrationsFolder: folder })

    // GitHub history of every shape these tables hold, stored as it was written (triggers off for the backdated rows).
    const W = () => Keypair.generate().publicKey.toBase58()
    const client = await pool.connect()
    try {
      await client.query('begin'); await client.query('set local session_replication_role = replica')
      for (const id of [9801, 9802, 9803]) {
        await client.query(`insert into repositories(github_repo_id, owner, name, full_name, stars, forks, archived, github_updated_at)
          values ($1, 'octo', $2, $3, 1, 0, false, now())`, [id, `repo-${id}`, `octo/repo-${id}`])
      }
      const request = async (repo, status, extra = {}) => (await client.query(`insert into payout_address_requests(github_repo_id, wallet,
          requested_by_github_user_id, requested_by_login, requested_at, active_at, status, resolved_at, resolved_by_github_user_id, resolution_reason)
        values ($1, $2, 501, 'maintainer', now() - interval '49 hours', now() - interval '1 hour', $3, $4, $5, $6) returning id::text as id, wallet`,
      [repo, extra.wallet ?? W(), status, status === 'pending' ? null : new Date(), extra.by ?? null, extra.reason ?? null])).rows[0]
      const activated = await request(9803, 'activated'), cancelled = await request(9801, 'cancelled', { by: 502, reason: 'Cancelled by co-admin' })
      const superseded = await request(9801, 'superseded', { by: 502, reason: 'Replaced by a newer pasted address' })
      await request(9802, 'pending')
      await client.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, bound_at) values (9801, 501, $1, now() - interval '3 days')`, [W()])
      await client.query(`insert into repo_beneficiaries(github_repo_id, github_user_id, wallet, bound_at, method, payout_request_id)
        values (9803, 501, $1, now() - interval '1 hour', 'pasted', $2)`, [activated.wallet, activated.id])
      const event = (requestId, repo, kind, user, wallet) => client.query(`insert into payout_address_events(request_id, github_repo_id, event, github_user_id, wallet)
        values ($1, $2, $3, $4, $5)`, [requestId, repo, kind, user, wallet])
      await event(activated.id, 9803, 'requested', 501, activated.wallet); await event(activated.id, 9803, 'activated', null, activated.wallet)
      await event(cancelled.id, 9801, 'requested', 501, cancelled.wallet); await event(cancelled.id, 9801, 'cancelled', 502, cancelled.wallet)
      await event(superseded.id, 9801, 'requested', 501, superseded.wallet); await event(superseded.id, 9801, 'superseded', 502, superseded.wallet)
      await client.query(`insert into wallet_binding_challenges(github_repo_id, github_user_id, wallet, nonce, expires_at, consumed_at)
        values (9801, 501, $1, repeat('a', 48), now(), now())`, [W()])
      await client.query(`insert into maintainer_opt_outs(github_repo_id, kind, github_user_id, note) values (9801, 'decline', 501, 'Not ours')`)
      await client.query(`insert into maintainer_opt_outs(github_repo_id, kind, github_user_id, created_at, withdrawn_at, withdrawn_by_github_user_id)
        values (9803, 'opt_out', 501, now() - interval '2 days', now() - interval '1 day', 502)`)
      await client.query('commit')
    } finally { client.release() }

    // This code on a database 0050/0051 have not reached (the worker deploys without migrating): GitHub activation and
    // decision reads work, through exactly the 0048 statements.
    assert.deepEqual((await activateDuePayoutAddresses(pool, { repoIds: ['9802'] })).map(result => result.status), ['activated'])
    const decision = await activeDecision(pool, '9801')
    assert.deepEqual({ ...decision, createdAt: typeof decision.createdAt }, { repoId: '9801', kind: 'decline', note: 'Not ours', createdAt: 'string' },
      'a GitHub decision reads exactly as before (no source field)')

    const { rows } = await pool.query(`select table_name as name, array_agg(column_name::text order by ordinal_position) as columns
      from information_schema.columns where table_schema = 'public' and table_name = any($1) group by table_name`, [UPGRADED])
    const columns = Object.fromEntries(rows.map(row => [row.name, row.columns]))
    const before = await rowChecksums(pool, columns)
    await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
    for (const tag of ['0050_model_opt_outs', '0051_model_authority']) {
      for (const statement of (await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8')).split('--> statement-breakpoint')) await pool.query(statement)
    }
    assert.deepEqual(await rowChecksums(pool, columns), before, 'every existing row reads back identically')
    assert.equal((await pool.query('select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, journal.entries.length)
    const { rows: constraints } = await pool.query(`select conname as name, convalidated as valid, pg_get_constraintdef(oid) as def from pg_constraint
      where conname = any($1) order by 1`, [['maintainer_opt_outs_actor_check', 'maintainer_opt_outs_source_range', 'maintainer_opt_outs_withdrawn_check',
      'payout_address_events_actor_check', 'payout_address_requests_authority_check', 'payout_address_requests_source_range', 'repo_beneficiaries_authority_check',
      'repo_beneficiaries_source_range', 'wallet_binding_challenges_authority_check', 'wallet_binding_challenges_hf_range']])
    assert.equal(constraints.length, 10)
    assert.ok(constraints.every(constraint => constraint.valid), 'validated against the existing rows')
    assert.match(constraints.find(c => c.name === 'maintainer_opt_outs_withdrawn_check').def, /withdrawn_by_subject/)
    assert.match(constraints.find(c => c.name === 'payout_address_events_actor_check').def, /actor_subject/)
    const { rows: [sources] } = await pool.query(`select (select array_agg(distinct authority_source) from repo_beneficiaries) as beneficiaries,
      (select array_agg(distinct authority_source) from payout_address_requests) as requests, (select array_agg(distinct authority_source) from maintainer_opt_outs) as decisions`)
    assert.deepEqual(sources, { beneficiaries: ['github'], requests: ['github'], decisions: ['github'] })
  } finally {
    await pool?.end()
    await admin.query('drop database if exists repoing_hf_upgrade_test with (force)')
    await admin.end(); await rm(folder, { recursive: true, force: true })
  }
})
