import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { MINT_SIZE, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BUILDER_ALLOCATION, FIXED_SUPPLY, assertModelAllocationAuthority, assertModelAllocationBinding, createBuilderAllocation } from '../src/builder-allocation.mjs'
import { HF_MARKET_REF_MIN, MarketIdentityError } from '../src/market-identity.mjs'
import { createHfClient } from '../src/hf-api.mjs'
import { createHfOAuth, createHfVerifier } from '../src/hf-verification.mjs'
import { startFakeHf } from './fixtures/hf-server.mjs'

// The Hugging Face branch of the 1% builder allocation (src/builder-allocation.mjs), with no database, chain or network:
// a scripted stand-in for PostgreSQL, a chain stand-in serving a not-yet-graduated canonical pool, and a local stand-in
// for huggingface.co. Every refusal here happens before anything is written; tests/hf-allocation-db.test.mjs and
// tests/hf-allocation-chain.test.mjs run the same rules on real PostgreSQL and a local validator.
const MARKET = String(HF_MARKET_REF_MIN)
const OWNER = '6426d3f3a7723d62b53c259b', GGUF = '64f5fd954d3b1dd311d30e28' // TheBloke and TheBloke/Llama-2-7B-GGUF
const ORG = '659ebc82b61dd9658802f398', GPT2 = '621ffdc036468d709f17434d' // openai-community and openai-community/gpt2
const ORG_ADMIN = '60a551a34ecc5d054c8ad93e', MEMBER = '63972e77157559113eb8396d', SSO_ADMIN = '5f17f0a0925b9863e28ad517', NEW_OWNER = '650c8bfb1ba1a2d6b5fe0b25'
const WALLET = Keypair.generate().publicKey.toBase58(), BOUND = new Date('2026-10-01T10:00:00.000Z')
const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')

const review = (extra = {}) => ({ purpose: 'model-allocation-review', repoId: MARKET, subject: OWNER, ownerSubject: OWNER, wallet: WALLET,
  boundAt: BOUND.toISOString(), amount: String(BUILDER_ALLOCATION), expiresAt: Date.now() + 600_000, ...extra })
const authority = (extra = {}) => ({ source: 'huggingface', verified: true, permission: 'admin', role: 'owner', githubRepoId: BigInt(MARKET), hfId: GGUF,
  subject: OWNER, ownerSubject: OWNER, ownerKind: 'user', ownerHandle: 'TheBloke', verifiedAt: new Date(), ...extra })
const orgAdmin = (extra = {}) => authority({ role: 'admin', hfId: GPT2, subject: ORG_ADMIN, ownerSubject: ORG, ownerKind: 'org', ownerHandle: 'openai-community', ...extra })
const binding = (extra = {}) => ({ wallet: WALLET, boundAt: BOUND, method: 'signature', subject: OWNER, ownerSubject: OWNER, ...extra })
const AUTHORITY_REQUIRED = /Current Hugging Face owner authority required/
const BINDING_CHANGED = /Payout wallet or authority changed; bind your wallet and review again/

test('wrong source: only a Hugging Face authority answers for a model market', () => {
  assert.throws(() => assertModelAllocationAuthority(authority({ source: undefined }), review()), MarketIdentityError, 'no source is GitHub’s')
  assert.throws(() => assertModelAllocationAuthority(authority({ source: 'github' }), review()), /A github authority cannot act for a huggingface market/)
  assert.throws(() => assertModelAllocationAuthority(null, review()), MarketIdentityError)
  const verifiedAt = new Date()
  assert.equal(assertModelAllocationAuthority(authority({ verifiedAt }), review()), verifiedAt.getTime(), 'a fresh Hugging Face check passes and dates the claim')
})

test('authority mismatch: another user, another market, a new owner since the review, or a stale check refuses the claim', () => {
  const now = Date.now()
  assert.equal(typeof assertModelAllocationAuthority(authority({ verifiedAt: new Date(now - 59_000) }), review(), now), 'number')
  for (const [why, changed] of [
    ['another signed-in user', authority({ subject: NEW_OWNER, ownerSubject: NEW_OWNER })],
    ['the model changed owner after the review', authority({ subject: OWNER, ownerSubject: NEW_OWNER, role: 'admin', ownerKind: 'org' })],
    ['another market', authority({ githubRepoId: BigInt(MARKET) + 1n })],
    ['not verified', authority({ verified: false })],
    ['not an admin permission', authority({ permission: 'write' })],
    ['checked more than 60 s ago', authority({ verifiedAt: new Date(now - 61_000) })],
    ['checked in the future', authority({ verifiedAt: new Date(now + 6_000) })],
    ['no check time', authority({ verifiedAt: 'never' })],
    ['a malformed subject', authority({ subject: 'TheBloke', ownerSubject: 'TheBloke' })],
  ]) assert.throws(() => assertModelAllocationAuthority(changed, review(), now), AUTHORITY_REQUIRED, why)
  // The review names the user and the model owner it was sealed for: a review for another user never passes either.
  assert.throws(() => assertModelAllocationAuthority(authority(), review({ subject: NEW_OWNER }), now), AUTHORITY_REQUIRED)
  assert.throws(() => assertModelAllocationAuthority(authority(), review({ ownerSubject: ORG }), now), AUTHORITY_REQUIRED)
})

test('org admin vs member: only the owner of a user-owned model or an admin of the owning organization passes', () => {
  const org = review({ subject: ORG_ADMIN, ownerSubject: ORG })
  assert.equal(typeof assertModelAllocationAuthority(orgAdmin(), org), 'number')
  for (const role of ['write', 'read', 'contributor', 'member', null, undefined]) {
    assert.throws(() => assertModelAllocationAuthority(orgAdmin({ role }), org), AUTHORITY_REQUIRED, `role ${role}`)
  }
  // A role must match the owner's kind: an "owner" of an organization's model, or an "admin" of a user's, is malformed.
  assert.throws(() => assertModelAllocationAuthority(orgAdmin({ role: 'owner' }), org), AUTHORITY_REQUIRED)
  assert.throws(() => assertModelAllocationAuthority(authority({ role: 'admin' }), review()), AUTHORITY_REQUIRED)
  assert.throws(() => assertModelAllocationAuthority(orgAdmin({ subject: ORG }), review({ subject: ORG, ownerSubject: ORG })), AUTHORITY_REQUIRED, 'the organization itself')
  assert.throws(() => assertModelAllocationAuthority(authority({ subject: OWNER, ownerSubject: NEW_OWNER }), review({ ownerSubject: NEW_OWNER })), AUTHORITY_REQUIRED)
})

test('binding changed: only the reviewed wallet and binding time, set by this user for the current owner, is paid', () => {
  const creatorWallet = Keypair.generate().publicKey.toBase58()
  const check = (bound, extra = {}) => assertModelAllocationBinding(bound, { review: review(), authority: authority(), creatorWallet, ...extra })
  assert.doesNotThrow(() => check(binding()))
  assert.throws(() => check(null), BINDING_CHANGED, 'no binding made by this user')
  assert.throws(() => check(binding({ wallet: Keypair.generate().publicKey.toBase58() })), BINDING_CHANGED, 'a different wallet')
  assert.throws(() => check(binding({ boundAt: new Date(BOUND.getTime() + 1) })), BINDING_CHANGED, 'rebound since the review')
  assert.throws(() => check(binding({ boundAt: undefined })), BINDING_CHANGED)
  assert.throws(() => check(binding({ subject: NEW_OWNER })), BINDING_CHANGED, 'made by another user')
  assert.throws(() => check(binding({ wallet: creatorWallet }), { review: review({ wallet: creatorWallet }) }), BINDING_CHANGED, 'never the protected creator signer')
  // Made for a previous owner: never paid, whoever claims (the counterpart of src/claim.mjs assertBindingAuthority).
  assert.throws(() => check(binding({ ownerSubject: NEW_OWNER })), /owner changed since this payout wallet was set/)
})

// PostgreSQL as src/builder-allocation.mjs, src/payout-address.mjs, src/wallet-binding.mjs and src/hf-verification.mjs see
// it for one model market. Every statement is recorded; a write to builder_allocation_claims fails the test.
const GGUF_REGISTRY = { marketId: MARKET, hfId: GGUF, path: 'TheBloke/Llama-2-7B-GGUF', ownerHandle: 'TheBloke', ownerKind: 'user', ownerSubject: OWNER }
const GPT2_REGISTRY = { marketId: MARKET, hfId: GPT2, path: 'openai-community/gpt2', ownerHandle: 'openai-community', ownerKind: 'org', ownerSubject: ORG }
function fakeDatabase({ market, latest = null, bound = null, registry = GGUF_REGISTRY }) {
  const sql = []
  const rows = (text, params) => {
    if (/^\s*(begin|commit|rollback)\s*$/.test(text) || /pg_advisory/.test(text)) return []
    if (/insert into builder_allocation_claims/.test(text)) assert.fail('a refused claim writes no payout intent')
    if (/from markets\s+where github_repo_id/.test(text)) return market ? [market] : []
    if (/from builder_allocation_claims/.test(text)) return latest ? [latest] : []
    if (/from payout_address_requests r/.test(text)) return []
    if (/from repo_beneficiaries/.test(text)) return bound && (params[1] == null || bound.subject === params[1]) ? [bound] : []
    if (/from hf_models where market_ref/.test(text)) return [registry]
    if (/^\s*update hf_models/.test(text)) return []
    if (/insert into model_verifications/.test(text)) return [{ verifiedAt: new Date() }]
    assert.fail(`unexpected statement: ${text}`)
  }
  const query = async (text, params = []) => { sql.push(text.replace(/\s+/g, ' ').trim()); return { rows: rows(text, params), rowCount: 0 } }
  return { sql, pool: { query, connect: async () => ({ query, release: () => {} }) } }
}

// The chain as the grant's checks read it: a fixed-supply canonical pool on an allocation config whose leftover goes to
// the protected creator signer, not yet graduated. Anything beyond account reads would be a payout attempt.
const coder = new DynamicBondingCurveClient(new Connection('http://127.0.0.1:9'), 'finalized').state.program.coder.accounts
function encodeAccount(name, patch) {
  const discriminator = Buffer.from(coder.accountDiscriminator(name)), size = coder.size(name)
  const blank = coder.decode(name, Buffer.concat([discriminator, Buffer.alloc(size - 8)]))
  const body = Buffer.alloc(size - 8)
  return Buffer.concat([discriminator, body.subarray(0, coder.accountLayouts.get(name).layout.encode(patch(blank), body))])
}
function fakeChain(creator) {
  const config = Keypair.generate().publicKey, mint = Keypair.generate().publicKey, poolKey = deriveDbcPoolAddress(NATIVE_MINT, mint, config)
  const virtualPool = encodeAccount('virtualPool', blank => ({ ...blank, poolState: { ...blank.poolState, config, creator, baseMint: mint, isMigrated: 0 } }))
  const poolConfig = encodeAccount('poolConfig', blank => ({ ...blank, quoteMint: NATIVE_MINT, leftoverReceiver: creator, tokenType: 0,
    preMigrationTokenSupply: new BN(FIXED_SUPPLY.toString()) }))
  const mintData = Buffer.alloc(MINT_SIZE)
  MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: FIXED_SUPPLY, decimals: 6, isInitialized: true,
    freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, mintData)
  const accounts = new Map([[poolKey.toBase58(), [virtualPool, DBC_PROGRAM]], [config.toBase58(), [poolConfig, DBC_PROGRAM]], [mint.toBase58(), [mintData, TOKEN_PROGRAM_ID]]])
  const calls = []
  const info = key => { const found = accounts.get(new PublicKey(key).toBase58()); return found ? { data: found[0], owner: found[1], lamports: 1_000_000, executable: false, rentEpoch: 0 } : null }
  const connection = { rpcEndpoint: 'http://chain-stand-in.invalid', commitment: 'finalized',
    getAccountInfo: async key => { calls.push('getAccountInfo'); return info(key) },
    getAccountInfoAndContext: async key => { calls.push('getAccountInfoAndContext'); return { context: { slot: 1 }, value: info(key) } } }
  for (const method of ['getLatestBlockhash', 'simulateTransaction', 'sendRawTransaction', 'sendTransaction', 'confirmTransaction', 'getMultipleAccountsInfoAndContext']) {
    connection[method] = async () => assert.fail(`${method}: nothing may be paid before graduation`)
  }
  return { connection, calls, config, market: { githubRepoId: MARKET, mint: mint.toBase58(), pool: poolKey.toBase58(), creatorWallet: creator.toBase58(), version: 1 } }
}

async function withAllocationConfig(config, work) {
  const saved = process.env.BUILDER_ALLOCATION_CONFIGS
  process.env.BUILDER_ALLOCATION_CONFIGS = config.toBase58()
  try { return await work() } finally { if (saved === undefined) delete process.env.BUILDER_ALLOCATION_CONFIGS; else process.env.BUILDER_ALLOCATION_CONFIGS = saved }
}
const stub = answer => { const calls = []; return { calls, verifier: { source: 'huggingface', verifyCurrentAuthority: async input => { calls.push(input); return typeof answer === 'function' ? answer(input) : answer } } } }

test('wrong source, through the claim: refused before the database is touched, in either direction', async () => {
  const creator = Keypair.generate(), { connection, config, market } = fakeChain(creator.publicKey)
  const { pool, sql } = fakeDatabase({ market })
  const github = { verifyCurrentAuthority: async () => assert.fail('GitHub is never asked about a model market') }
  await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: github }).claim({ review: review() }),
    /A github authority cannot act for a huggingface market/)
  const { verifier, calls } = stub(authority())
  await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: verifier })
    .claim({ review: { repoId: '1296269', githubUserId: '42', wallet: WALLET, boundAt: BOUND.toISOString(), amount: String(BUILDER_ALLOCATION), expiresAt: Date.now() + 600_000 } }),
  /A huggingface authority cannot act for a github market/)
  assert.deepEqual([sql, calls], [[], []])
  // A GitHub verifier still takes a repository's review on the GitHub path, unchanged (here: not enrolled).
  await assert.rejects(createBuilderAllocation({ pool: fakeDatabase({ market: null }).pool, connection, config, creator, githubVerifier: github })
    .claim({ review: { repoId: '1296269', githubUserId: '42', wallet: WALLET, boundAt: BOUND.toISOString(), amount: String(BUILDER_ALLOCATION), expiresAt: Date.now() + 600_000 } }),
  /Market is not enrolled for an allocation/)
})

test('already settled: one grant per market, ever; a later owner never reaches the Hugging Face check', async () => {
  const creator = Keypair.generate(), { connection, config, market } = fakeChain(creator.publicKey)
  for (const status of ['settled', 'pending']) {
    const { pool, sql } = fakeDatabase({ market, latest: { status, signature: 'Grant', wallet: WALLET, amount: String(BUILDER_ALLOCATION) }, bound: binding() })
    const { verifier, calls } = stub(authority({ subject: NEW_OWNER, ownerSubject: NEW_OWNER }))
    await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: verifier })
      .claim({ review: review({ subject: NEW_OWNER, ownerSubject: NEW_OWNER }) }), /Allocation already submitted or paid/)
    assert.deepEqual(calls, [], status)
    assert.ok(!sql.some(text => /repo_beneficiaries/.test(text)), status)
  }
  const { pool } = fakeDatabase({ market: null })
  await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: stub(authority()).verifier }).claim({ review: review() }),
    /Market is not enrolled for an allocation/)
})

test('authority mismatch, through the claim: refused after the fresh check, before the binding is read', async () => {
  const creator = Keypair.generate(), { connection, config, market, calls: chain } = fakeChain(creator.publicKey)
  for (const answer of [authority({ subject: NEW_OWNER, ownerSubject: NEW_OWNER }), authority({ source: 'github' }), authority({ verifiedAt: new Date(Date.now() - 120_000) })]) {
    const { pool, sql } = fakeDatabase({ market, bound: binding() })
    const { verifier, calls } = stub(answer)
    await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: verifier }).claim({ review: review() }),
      /Current Hugging Face owner authority required|A github authority cannot act/)
    assert.deepEqual(calls.map(call => call.githubRepoId), [BigInt(MARKET)])
    assert.ok(!sql.some(text => /repo_beneficiaries/.test(text)))
  }
  // An expired review, or one for another amount, is refused before anything is read.
  const { pool, sql } = fakeDatabase({ market, bound: binding() })
  for (const stale of [review({ expiresAt: Date.now() - 1 }), review({ expiresAt: undefined }), review({ amount: '1' }), review({ subject: 'nobody' })]) {
    await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: stub(authority()).verifier }).claim({ review: stale }),
      /Allocation review expired/)
  }
  assert.deepEqual([sql, chain], [[], []])
})

test('binding changed or made for a previous owner, through the claim: refused before any chain read', async () => {
  const creator = Keypair.generate(), { connection, config, market, calls: chain } = fakeChain(creator.publicKey)
  for (const [bound, expected] of [[binding({ wallet: Keypair.generate().publicKey.toBase58() }), BINDING_CHANGED],
    [binding({ boundAt: new Date() }), BINDING_CHANGED], [binding({ subject: ORG_ADMIN }), BINDING_CHANGED], [null, BINDING_CHANGED],
    [binding({ ownerSubject: NEW_OWNER }), /owner changed since this payout wallet was set/]]) {
    const { pool, sql } = fakeDatabase({ market, bound })
    await assert.rejects(createBuilderAllocation({ pool, connection, config, creator, githubVerifier: stub(authority()).verifier }).claim({ review: review() }), expected)
    // A pasted address whose hold has passed would have been activated first, under the market's lock.
    const activation = sql.findIndex(text => /from payout_address_requests r/.test(text)), read = sql.findIndex(text => /from repo_beneficiaries where/.test(text))
    assert.ok(activation > sql.indexOf('begin') && sql.indexOf('begin') >= 0 && read > activation, sql.join('\n'))
  }
  assert.deepEqual(chain, [])
})

test('not graduated: the grant stays locked, and status says so, with nothing signed or written', () => {
  const creator = Keypair.generate(), { connection, config, market, calls } = fakeChain(creator.publicKey)
  return withAllocationConfig(config, async () => {
    const { pool, sql } = fakeDatabase({ market, bound: binding() })
    const allocation = createBuilderAllocation({ pool, connection, config, creator, githubVerifier: stub(authority()).verifier })
    assert.deepEqual(await allocation.status(MARKET), { enrolled: true, amount: String(BUILDER_ALLOCATION), state: 'locked' })
    await assert.rejects(allocation.claim({ review: review() }), /Builder allocation stays locked until verified graduation/)
    assert.ok(calls.length > 0 && calls.every(call => /^getAccountInfo/.test(call)), 'account reads only')
    assert.ok(!sql.some(text => /insert/.test(text)))
    // A config that is not an approved allocation config is refused outright.
    process.env.BUILDER_ALLOCATION_CONFIGS = Keypair.generate().publicKey.toBase58()
    await assert.rejects(allocation.claim({ review: review() }), /Allocation configuration is not approved/)
  })
})

// The real Hugging Face verifier against the recorded Hub: the user who owns TheBloke/Llama-2-7B-GGUF, and for
// openai-community/gpt2 an admin, a member and an admin whose organization requires SSO.
const TOKENS = { owner: 'hf_oauth_owner_token_test_only', admin: 'hf_oauth_org_admin_token_test', member: 'hf_oauth_org_member_token_tst', sso: 'hf_oauth_org_sso_admin_token_t' }
const USERINFO = new Map([
  [TOKENS.owner, { sub: OWNER, preferred_username: 'TheBloke', orgs: [] }],
  [TOKENS.admin, { sub: ORG_ADMIN, preferred_username: 'org-admin', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin' }] }],
  [TOKENS.member, { sub: MEMBER, preferred_username: 'org-member', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'write' }] }],
  [TOKENS.sso, { sub: SSO_ADMIN, preferred_username: 'sso-admin', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin', pendingSSO: true }] }],
])

test('org admin vs member, through the real Hugging Face verifier: the owner and an org admin reach the graduation check; a member or an SSO-pending admin does not', async () => {
  const server = await startFakeHf()
  server.route('/oauth/userinfo', (_, request) => {
    const info = USERINFO.get(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))
    return info ? { status: 200, headers: {}, body: info } : { status: 401, headers: {}, body: {} }
  })
  const creator = Keypair.generate(), { connection, config, market } = fakeChain(creator.publicKey)
  try {
    await withAllocationConfig(config, async () => {
      const run = async ({ registry, token, subject, ownerSubject }) => {
        const { pool, sql } = fakeDatabase({ market, registry, bound: binding({ subject, ownerSubject }) })
        const hf = createHfVerifier({ pool, hf: createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} }),
          oauth: createHfOAuth({ clientId: 'repoing-test', clientSecret: 'test-only-hf-secret', redirectUri: 'https://repo.ing/api/hf/callback', fetchImpl: server.fetchImpl }) })
        const githubVerifier = { source: 'huggingface', verifyCurrentAuthority: ({ githubRepoId }) => hf.verifyMarketAuthority({ marketId: githubRepoId, accessToken: token, expectedSubject: subject }) }
        const outcome = await createBuilderAllocation({ pool, connection, config, creator, githubVerifier }).claim({ review: review({ subject, ownerSubject }) }).catch(error => error)
        return { outcome, read: sql.some(text => /from repo_beneficiaries where/.test(text)) }
      }
      // Past the authority and binding checks, the stand-in pool has not graduated: "locked" proves every check passed.
      for (const passing of [{ registry: GGUF_REGISTRY, token: TOKENS.owner, subject: OWNER, ownerSubject: OWNER },
        { registry: GPT2_REGISTRY, token: TOKENS.admin, subject: ORG_ADMIN, ownerSubject: ORG }]) {
        const { outcome, read } = await run(passing)
        assert.match(outcome.message, /stays locked until verified graduation/, passing.subject)
        assert.equal(read, true)
      }
      for (const [refused, reason] of [[{ token: TOKENS.member, subject: MEMBER }, 'not-admin'], [{ token: TOKENS.sso, subject: SSO_ADMIN }, 'security-restrictions'],
        [{ token: TOKENS.owner, subject: OWNER }, 'not-member']]) {
        const { outcome, read } = await run({ registry: GPT2_REGISTRY, ownerSubject: ORG, ...refused })
        assert.deepEqual([outcome.code, outcome.reason, read], ['HF_NOT_AUTHORIZED', reason, false], refused.subject)
      }
    })
  } finally { await server.close() }
})
