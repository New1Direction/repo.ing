import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import pg from 'pg'
import BN from 'bn.js'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { DynamicBondingCurveClient, SwapMode, deriveDbcPoolAuthority, DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFixedConfig } from './fixed-config.mjs'
import { startFakeHf } from './fixtures/hf-server.mjs'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { DISCOVERY_VERSION } from '../src/discovery-rewards.mjs'
import { createHfClient } from '../src/hf-api.mjs'
import { createHfOAuth, createHfVerifier } from '../src/hf-verification.mjs'
import { hfLaunchSource } from '../src/hf-launch.mjs'
import { marketSource } from '../src/market-identity.mjs'
import { createWalletBinding } from '../src/wallet-binding.mjs'
import { BUILDER_ALLOCATION, FIXED_SUPPLY, createBuilderAllocation } from '../src/builder-allocation.mjs'
import { createAllocationRecovery } from '../src/builder-allocation-settlement.mjs'

// solana-test-validator and PostgreSQL: two Hugging Face model markets launch on a config that reserves the 1% builder
// allocation (the builders curve, leftover to the protected creator signer), so each carries the allocation and never
// the verification bonus. Their payout wallets are bound through the Hugging Face path (a fresh owner check against a
// local stand-in for huggingface.co, then the model binding message signed by the wallet). Locked before graduation;
// after it, TheBloke's model is claimed through /api/allocation (review sealed for the owner's session, the real
// Hugging Face check), and openai-community's through src/builder-allocation.mjs with a stubbed Hugging Face verifier and
// a lost broadcast response that allocation recovery settles. Each bound wallet receives exactly 10,000,000 tokens, once.
const url = process.env.HF_ALLOCATION_CHAIN_TEST_DATABASE_URL
const rpc = process.env.SOLANA_RPC_URL
const OWNER = '6426d3f3a7723d62b53c259b', GGUF = '64f5fd954d3b1dd311d30e28' // TheBloke, TheBloke/Llama-2-7B-GGUF
const ORG = '659ebc82b61dd9658802f398', GPT2 = '621ffdc036468d709f17434d' // openai-community, openai-community/gpt2
const ORG_ADMIN = '60a551a34ecc5d054c8ad93e', NEW_OWNER = '5f17f0a0925b9863e28ad517'
const TOKENS = { owner: 'hf_oauth_owner_token_test_only', admin: 'hf_oauth_org_admin_token_test' }
const USERINFO = new Map([[TOKENS.owner, { sub: OWNER, preferred_username: 'TheBloke', orgs: [] }],
  [TOKENS.admin, { sub: ORG_ADMIN, preferred_username: 'org-admin', orgs: [{ sub: ORG, preferred_username: 'openai-community', roleInOrg: 'admin' }] }]])
const OAUTH = { clientId: 'repoing-test-client', clientSecret: 'test-only-hf-allocation-secret', redirectUri: 'https://repo.ing/api/hf/callback' }
const ENV = ['DATABASE_URL', 'APP_ORIGIN', 'HF_MARKETS_ENABLED', 'HF_OAUTH_CLIENT_ID', 'HF_OAUTH_CLIENT_SECRET', 'HF_OAUTH_REDIRECT_URI', 'SOLANA_RPC_URL',
  'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY', 'BUILDER_ALLOCATION_CONFIGS']
const edWallet = () => {
  const pair = generateKeyPairSync('ed25519')
  return { publicKey: new PublicKey(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)), signMessage: message => sign(null, Buffer.from(message, 'utf8'), pair.privateKey) }
}

test('model markets carry the 1% allocation; after graduation each verified owner’s bound wallet receives exactly 10,000,000 tokens, once', { skip: !url || !rpc, timeout: 900_000 }, async t => {
  const target = new URL(url)
  assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.pathname === '/repoing_hf_allocation_chain_test', 'Disposable chain test database required')
  assert.notEqual(target.port, '55439', 'Never the production tunnel port')
  assert.match(rpc, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'local validator only')
  const pool = new pg.Pool({ connectionString: url }), connection = new Connection(rpc, 'confirmed'), server = await startFakeHf()
  const saved = { env: Object.fromEntries(ENV.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, fetch: globalThis.fetch, hf: globalThis.__repoingHfClient }
  t.after(async () => {
    for (const [key, value] of Object.entries(saved.env)) value === undefined ? delete process.env[key] : process.env[key] = value
    Object.assign(globalThis, { __gitfunPool: saved.pool, fetch: saved.fetch, __repoingHfClient: saved.hf })
    await server.close(); await pool.end()
  })
  server.route('/oauth/userinfo', (_, request) => {
    const info = USERINFO.get(String(request.headers.authorization ?? '').replace(/^Bearer /, ''))
    return info ? { status: 200, headers: {}, body: info } : { status: 401, headers: {}, body: {} }
  })
  await migrate(drizzle(pool), { migrationsFolder: new URL('../drizzle', import.meta.url).pathname })
  await pool.query(`truncate builder_allocation_claims, model_verifications, payout_address_events, payout_address_requests, wallet_binding_challenges, repo_claims,
    repo_beneficiaries, repo_verifications, fee_events, agent_request_limits, launch_sessions, markets, repositories, hf_models restart identity cascade`)

  const creator = Keypair.generate(), trader = Keypair.generate()
  for (const [wallet, sol] of [[creator, 5], [trader, 500]]) {
    const signature = await connection.requestAirdrop(wallet.publicKey, sol * 1e9)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  }
  const { config } = await createFixedConfig(connection, 'builders', { leftoverReceiver: creator.publicKey })
  process.env.BUILDER_ALLOCATION_CONFIGS = config.toBase58()
  const hf = createHfClient({ fetchImpl: server.fetchImpl, sleep: async () => {} })
  const dbc = new DynamicBondingCurveClient(connection, 'finalized')
  const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'finalized', preflightCommitment: 'confirmed' })

  // Launch: the model launch path (registry by _id), with the allocation config and the bonus enabled, as the web does.
  const coordinator = createLaunchCoordinator({ pool, launcher: createMeteoraLauncher({ connection, config, creator }), discoveryEnabled: true,
    builderAllocationEnabled: true, verificationBonusLamports: 5_000_000n, source: hfLaunchSource({ pool, hf, enabled: () => true }) })
  async function launch(path, symbol) {
    const market = await coordinator.launch({ repositoryUrl: `https://huggingface.co/${path}`, tokenName: symbol, tokenSymbol: symbol,
      launcherWallet: trader.publicKey.toBase58(), signTransaction: async tx => { tx.partialSign(trader); return tx } })
    await connection.confirmTransaction(market.launchSignature, 'finalized')
    assert.equal((await createLaunchIndexer({ pool, verify: createLaunchEvidenceVerifier({ connection, config }) }).processMarket(market.githubRepoId)).state, 'indexed')
    assert.equal(marketSource(market.githubRepoId), 'huggingface')
    assert.deepEqual([market.builderAllocationVersion, market.verificationBonusLamports, market.discoveryVersion], [1, null, DISCOVERY_VERSION])
    return { ...market, id: market.githubRepoId.toString() }
  }
  async function graduate(market) {
    const poolKey = new PublicKey(market.pool)
    await send(await dbc.pool.swap2({ owner: trader.publicKey, payer: trader.publicKey, pool: poolKey, amountIn: new BN(170e9), minimumAmountOut: new BN(1),
      swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null }), [trader])
    await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: trader.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1e9 })), [trader])
    const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.FixedBps100], payer: trader.publicKey })
    await send(migration.transaction, [trader, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
  }
  const gguf = await launch('TheBloke/Llama-2-7B-GGUF', 'GGUF'), gpt2 = await launch('openai-community/gpt2', 'GPT2')

  // Payout wallets, through the Hugging Face path: the user who owns one model, an admin of the organization that owns the other.
  const verifier = createHfVerifier({ pool, hf, oauth: createHfOAuth({ ...OAUTH, fetchImpl: server.fetchImpl }) })
  async function bind(marketId, token, subject) {
    const owner = edWallet(), binder = createWalletBinding({ pool })
    const authority = await verifier.verifyMarketAuthority({ marketId, accessToken: token, expectedSubject: subject })
    const challenge = await binder.requestChallenge({ githubRepoId: marketId, wallet: owner.publicKey.toBase58(), authority })
    return binder.bindWallet({ githubRepoId: marketId, wallet: owner.publicKey.toBase58(), nonce: challenge.nonce, signature: owner.signMessage(challenge.message), authority })
  }
  const ggufBound = await bind(gguf.id, TOKENS.owner, OWNER), gpt2Bound = await bind(gpt2.id, TOKENS.admin, ORG_ADMIN)
  const balance = async (market, wallet) => {
    try { return (await getAccount(connection, getAssociatedTokenAddressSync(new PublicKey(market.mint), new PublicKey(wallet)), 'finalized')).amount }
    catch { return 0n }
  }
  // The stubbed Hugging Face check: always fresh, for the market asked about.
  const stubbed = fields => ({ source: 'huggingface', verifyCurrentAuthority: async ({ githubRepoId }) => ({ source: 'huggingface', verified: true, permission: 'admin',
    githubRepoId, verifiedAt: new Date(), ...fields }) })
  const ownerOfGguf = stubbed({ role: 'owner', subject: OWNER, ownerSubject: OWNER, ownerKind: 'user', hfId: GGUF })
  const adminOfGpt2 = stubbed({ role: 'admin', subject: ORG_ADMIN, ownerSubject: ORG, ownerKind: 'org', hfId: GPT2 })
  const service = (githubVerifier, rpcConnection = connection) => createBuilderAllocation({ pool, connection: rpcConnection, config, creator, githubVerifier })
  const reviewOf = (market, bound, subject, ownerSubject) => ({ purpose: 'model-allocation-review', repoId: market.id, subject, ownerSubject, wallet: bound.wallet,
    boundAt: new Date(bound.boundAt).toISOString(), amount: String(BUILDER_ALLOCATION), expiresAt: Date.now() + 600_000 })

  // Locked until verified graduation, whoever asks.
  assert.equal((await service(ownerOfGguf).status(gguf.id)).state, 'locked')
  await assert.rejects(service(ownerOfGguf).claim({ review: reviewOf(gguf, ggufBound, OWNER, OWNER) }), /stays locked until verified graduation/)
  await graduate(gguf)
  await graduate(gpt2)
  assert.equal((await service(ownerOfGguf).status(gguf.id)).state, 'available')

  // On the graduated market: a GitHub authority, another user or a review of another wallet is still refused.
  await assert.rejects(service({ verifyCurrentAuthority: async () => assert.fail('GitHub is never asked') }).claim({ review: reviewOf(gguf, ggufBound, OWNER, OWNER) }),
    /A github authority cannot act for a huggingface market/)
  await assert.rejects(service(stubbed({ role: 'owner', subject: NEW_OWNER, ownerSubject: NEW_OWNER, ownerKind: 'user', hfId: GGUF }))
    .claim({ review: reviewOf(gguf, ggufBound, OWNER, OWNER) }), /Current Hugging Face owner authority required/)
  await assert.rejects(service(ownerOfGguf).claim({ review: { ...reviewOf(gguf, ggufBound, OWNER, OWNER), wallet: trader.publicKey.toBase58() } }), /Payout wallet or authority changed/)
  assert.equal((await pool.query('select count(*)::int as n from builder_allocation_claims')).rows[0].n, 0)

  // TheBloke's model through the web: /api/allocation seals a review for the owner's session (and only for it), and the
  // claim checks the owner again with Hugging Face (the local stand-in) before paying.
  Object.assign(process.env, { DATABASE_URL: url, APP_ORIGIN: 'https://repo.ing', HF_MARKETS_ENABLED: 'true', HF_OAUTH_CLIENT_ID: OAUTH.clientId,
    HF_OAUTH_CLIENT_SECRET: OAUTH.clientSecret, HF_OAUTH_REDIRECT_URI: OAUTH.redirectUri, SOLANA_RPC_URL: rpc, DBC_CONFIG: config.toBase58(),
    PLATFORM_CREATOR_SECRET_KEY: JSON.stringify([...creator.secretKey]) })
  globalThis.__gitfunPool = pool
  globalThis.__repoingHfClient = hf
  globalThis.fetch = (input, init) => String(input).startsWith('https://huggingface.co/') ? server.fetchImpl(String(input), init) : saved.fetch(input, init)
  const route = await import('../app/api/allocation/[repo]/route.js')
  const auth = await import('../app/lib/hf-auth.mjs')
  const call = async (handler, repo, { session = null, body = null } = {}) => {
    const response = await handler({ url: `https://repo.ing/api/allocation/${repo}`, headers: new Headers({ origin: 'https://repo.ing', 'sec-fetch-site': 'same-origin' }),
      cookies: { get: name => name === auth.hfSessionCookie && session ? { value: auth.encryptHfSession(session) } : undefined }, json: async () => body },
    { params: Promise.resolve({ repo }) })
    return { status: response.status, body: await response.json() }
  }
  const ownerSession = auth.newHfSession({ subject: OWNER, username: 'TheBloke', accessToken: TOKENS.owner, expiresAt: Date.now() + 600_000, mode: 'claim', marketId: gguf.id })
  const anonymous = await call(route.GET, gguf.id)
  assert.deepEqual([anonymous.status, anonymous.body.state, anonymous.body.wallet, anonymous.body.review, anonymous.body.boundBy], [200, 'available', ggufBound.wallet, null, null])
  const view = await call(route.GET, gguf.id, { session: ownerSession })
  assert.deepEqual([view.body.state, view.body.amount, view.body.boundBy, typeof view.body.review], ['available', '10000000000000', 'you', 'string'])
  const paid = await call(route.POST, gguf.id, { session: ownerSession, body: { review: view.body.review } })
  assert.equal(paid.status, 200, JSON.stringify(paid.body))
  assert.deepEqual([paid.body.status, paid.body.amount, paid.body.wallet, paid.body.mint], ['settled', '10000000000000', ggufBound.wallet, gguf.mint])
  assert.equal(await balance(gguf, ggufBound.wallet), BUILDER_ALLOCATION, 'exactly 10,000,000 tokens (six decimals) reach the bound wallet')
  assert.equal((await getMint(connection, new PublicKey(gguf.mint), 'finalized')).supply, FIXED_SUPPLY)
  assert.deepEqual((await pool.query(`select status, wallet, amount::text, github_user_id, authority_source as source, authority_subject as subject,
    authority_owner_subject as owner, signature from builder_allocation_claims where github_repo_id = $1`, [gguf.id])).rows,
  [{ status: 'settled', wallet: ggufBound.wallet, amount: '10000000000000', github_user_id: null, source: 'huggingface', subject: OWNER, owner: OWNER, signature: paid.body.signature }])
  // A second claim pays nothing: the route answers with the existing receipt, and the module refuses outright.
  const again = await call(route.POST, gguf.id, { session: ownerSession, body: { review: view.body.review } })
  assert.deepEqual([again.status, again.body.status, again.body.signature], [200, 'settled', paid.body.signature])
  await assert.rejects(service(ownerOfGguf).claim({ review: reviewOf(gguf, ggufBound, OWNER, OWNER) }), /Allocation already submitted or paid/)
  await assert.rejects(service(stubbed({ role: 'owner', subject: NEW_OWNER, ownerSubject: NEW_OWNER, ownerKind: 'user', hfId: GGUF }))
    .claim({ review: reviewOf(gguf, ggufBound, NEW_OWNER, NEW_OWNER) }), /Allocation already submitted or paid/, 'a later owner gets no second grant')
  const settled = await call(route.GET, gguf.id)
  assert.deepEqual([settled.body.state, settled.body.receipt.signature], ['settled', paid.body.signature])
  assert.equal(await balance(gguf, ggufBound.wallet), BUILDER_ALLOCATION)

  // openai-community's model with the stubbed Hugging Face verifier (an admin of the organization): someone else has already
  // withdrawn the leftover (permissionless, and always to the protected creator signer), and the broadcast response is lost.
  // The durable intent is settled by allocation recovery, by market id like any repository's.
  await send(await dbc.migration.withdrawLeftover({ pool: new PublicKey(gpt2.pool), payer: trader.publicKey }), [trader])
  const lost = new Proxy(connection, { get(target, key) {
    if (key === 'sendRawTransaction') return async (...args) => { await target.sendRawTransaction(...args); throw Error('Lost response') }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(service(adminOfGpt2, lost).claim({ review: reviewOf(gpt2, gpt2Bound, ORG_ADMIN, ORG) }), /Lost response/)
  const { rows: [intent] } = await pool.query(`select signature, status, authority_subject as subject, authority_owner_subject as owner from builder_allocation_claims
    where github_repo_id = $1`, [gpt2.id])
  assert.deepEqual([intent.status, intent.subject, intent.owner], ['pending', ORG_ADMIN, ORG])
  await connection.confirmTransaction(intent.signature, 'finalized')
  assert.deepEqual(await createAllocationRecovery({ pool, connection }).runOnce(), [{ githubRepoId: gpt2.id, status: 'settled', signature: intent.signature }])
  assert.deepEqual(await createAllocationRecovery({ pool, connection }).runOnce(), [])
  assert.equal(await balance(gpt2, gpt2Bound.wallet), BUILDER_ALLOCATION)
  await assert.rejects(service(adminOfGpt2).claim({ review: reviewOf(gpt2, gpt2Bound, ORG_ADMIN, ORG) }), /Allocation already submitted or paid/)
  assert.equal(await balance(gpt2, gpt2Bound.wallet), BUILDER_ALLOCATION, 'paid once')
  console.log(JSON.stringify({ modelAllocationProof: { config: config.toBase58(), grantTokens: '10000000', ownerReceipt: paid.body.signature,
    orgAdminRecoveryReceipt: intent.signature, markets: [gguf.id, gpt2.id] } }))
})
