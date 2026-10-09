import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { BUNDLE_DEFAULTS } from '../src/bundle-launch.mjs'
import { STATUS, bundleAddress, createBundleInstruction, decodeBundle, depositInstruction, initPlatformInstruction, routerAddress,
  tokenAccountOf } from '../src/bundle-vault.mjs'
import { bundleLaunchLookupAddresses } from '../src/bundle-launcher.mjs'
import { createBundleJobs } from '../src/bundle-jobs.mjs'
import { BUNDLE_IN_PROGRESS, createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Bundle launches through the worker (docs/BUNDLE_LAUNCH.md) on PostgreSQL and the bundle validator (scripts/ci/start-bundle-validator.sh:
// the bundle program with Meteora DBC, DAMM v2 and Metaplex as deployed on mainnet). A full raise is launched server-signed through the
// launch coordinator into a bundle market (stamped, no discovery reward, no bonus) whose launch evidence the bundle verifier accepts;
// the vault opens, the curve's partner fees are routed, the vault agent decides (dry run); a raise past its deadline fails and its
// row follows; the curve graduates and the bundle is bound to its DAMM v2 pool. Nothing here touches mainnet.
const RPC = process.env.BUNDLE_CHAIN_RPC ?? `http://127.0.0.1:${process.env.BUNDLE_VALIDATOR_RPC_PORT ?? 8939}`
const DATABASE = 'repoing_bundle_launch_chain_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DATABASE}`
const SOL = 1_000_000_000n
const REPOSITORY = { id: 1296269, name: 'Hello-World', full_name: 'octocat/Hello-World', description: 'My first repository on GitHub!',
  owner: { login: 'octocat', avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4' }, private: false, visibility: 'public',
  archived: false, updated_at: '2026-09-30T00:00:00Z', created_at: '2011-01-26T19:01:12Z', stargazers_count: 3000, forks_count: 900 }
const github = async url => String(url).startsWith('https://api.github.com/repos/octocat/Hello-World') ? Response.json(REPOSITORY)
  : new Response('not found', { status: 404 })

async function healthy() {
  try { return (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })).json()).result === 'ok' } catch { return false }
}

test('bundle launches through the worker: launch, evidence, vault, routing, failure and graduation', { timeout: 900_000 }, async t => {
  assert.equal(process.env.DATABASE_URL, URL_)
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DATABASE}$`), 'postgres') })
  let created = false, pool, work = process.env.BUNDLE_CHAIN_WORK_DIR, started = false
  const connection = new Connection(RPC, 'confirmed')
  try {
    await admin.query(`drop database if exists ${DATABASE}`)
    await admin.query(`create database ${DATABASE}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 8 })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,description,avatar_url,stars,forks,archived,github_updated_at) values
      (1296269,'octocat','Hello-World','octocat/Hello-World',null,null,3000,900,false,'2026-10-01T00:00:00Z'),
      (10270250,'facebook','react','facebook/react',null,null,240000,49000,false,'2026-10-01T00:00:00Z')`)
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-bundle-launch-'))
      started = true
      const run = spawnSync('scripts/ci/start-bundle-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'bundle validator started')
    }
    const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'bundle-authority.json'), 'utf8'))))
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
    const airdrop = async (to, lamports) => {
      const signature = await connection.requestAirdrop(to, Number(lamports))
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    }
    const funded = async sol => { const keypair = Keypair.generate(); await airdrop(keypair.publicKey, BigInt(sol) * SOL); return keypair }
    const chainTime = async () => { for (;;) { try { const time = await connection.getBlockTime(await connection.getSlot('confirmed')); if (time) return time } catch {} await sleep(250) } }
    await airdrop(upgradeAuthority.publicKey, 5n * SOL)
    const creator = await funded(10), launchSigner = await funded(10), operator = await funded(2), opsWallet = await funded(1)
    const treasuryOwner = await funded(1), launcherWallet = await funded(5), backer = await funded(10), whale = await funded(400)
    const router = routerAddress(), treasury = tokenAccountOf(treasuryOwner.publicKey, NATIVE_MINT)
    await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, tokenAccountOf(router, NATIVE_MINT), router, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(creator.publicKey, treasury, treasuryOwner.publicKey, NATIVE_MINT)), [creator])
    const config = Keypair.generate()
    await send(await dbc.partner.createConfig({ config: config.publicKey, feeClaimer: router, leftoverReceiver: creator.publicKey, payer: creator.publicKey,
      quoteMint: NATIVE_MINT, ...buildLaunchCurve('launch-fee') }), [creator, config])
    const fixed = await dbc.state.getPoolConfig(config.publicKey)
    const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
    await send(new Transaction().add(initPlatformInstruction({ upgradeAuthority: upgradeAuthority.publicKey, treasury, curveConfig: config.publicKey,
      admin: creator.publicKey, launchSigner: launchSigner.publicKey, operators: [operator.publicKey], opsWallet: opsWallet.publicKey, dammConfig,
      backerBps: BUNDLE_DEFAULTS.backerBps, opsBps: BUNDLE_DEFAULTS.opsBps, launchCooldownSecs: BUNDLE_DEFAULTS.launchCooldownSecs, launchGraceSecs: 60,
      limits: BUNDLE_DEFAULTS.limits })), [upgradeAuthority])
    const [createTable, table] = AddressLookupTableProgram.createLookupTable({ authority: creator.publicKey, payer: creator.publicKey,
      recentSlot: await connection.getSlot('finalized') })
    await send(new Transaction().add(createTable, AddressLookupTableProgram.extendLookupTable({ payer: creator.publicKey, authority: creator.publicKey,
      lookupTable: table, addresses: bundleLaunchLookupAddresses(config.publicKey, opsWallet.publicKey) })), [creator])
    for (let i = 0; i < 80; i++) { const value = (await connection.getAddressLookupTable(table)).value; if (value?.state.addresses.length && await connection.getSlot('confirmed') > value.state.lastExtendedSlot) break; await sleep(250) }

    // Two raises, opened as the raise pages open them (the create transaction, then the row): one fills, one misses its target.
    const now = await chainTime()
    const open = async (id, repo, target, deadline) => {
      await send(new Transaction().add(createBundleInstruction({ creator: launcherWallet.publicKey, admin: creator.publicKey, id, repoId: repo, target,
        minDeposit: SOL / 10n, deadline, policy: BUNDLE_DEFAULTS.policy })), [launcherWallet, creator])
      await pool.query(`insert into bundles(bundle_id,github_repo_id,address,creator_wallet,token_name,token_symbol,target_lamports,min_deposit_lamports,deadline,status)
        values ($1,$2,$3,$4,'Hello','HELLO',$5,$6,to_timestamp($7),'opening')`, [String(id), String(repo), bundleAddress(id).toBase58(),
        launcherWallet.publicKey.toBase58(), String(target), String(SOL / 10n), deadline])
    }
    await open(1, 1296269, 5n * SOL, now + 3_600)
    await open(2, 10270250, 2n * SOL, now + 30)
    await send(new Transaction().add(depositInstruction({ wallet: backer.publicKey, id: 1, lamports: 5n * SOL })), [backer])
    await send(new Transaction().add(depositInstruction({ wallet: backer.publicKey, id: 2, lamports: SOL })), [backer])

    const settings = { config: config.publicKey, lookupTable: table.toBase58(), launchSigner, creator, operator, agentsLive: false, metadataOrigin: null }
    const jobs = createBundleJobs({ pool, connection, settings, log: () => {},
      coordinatorFor: (id, launcher) => createLaunchCoordinator({ pool, launcher, fetchImpl: github, discoveryEnabled: true,
        verificationBonusLamports: 10_000_000n, bundle: { id: String(id) } }) })
    // Every pass's results are kept: the second raise's deadline may pass during any earlier step.
    const history = []
    const pass = async () => { const results = await jobs.runOnce(); history.push(...results); return Object.fromEntries(results.map(result => [result.bundleId, result])) }
    const status = async id => (await pool.query('select status from bundles where bundle_id=$1', [String(id)])).rows[0].status
    const chainBundle = async id => decodeBundle((await connection.getAccountInfo(bundleAddress(id))).data)

    await t.test('a live bundle keeps its repository: any other launch path is refused before anything is reserved', async () => {
      const standard = createLaunchCoordinator({ pool, fetchImpl: github, launcher: { creatorWallet: creator.publicKey.toBase58(),
        prepare: async () => { throw Error('never reached') }, inspect: async () => false } })
      await assert.rejects(standard.launch({ repositoryUrl: 'https://github.com/octocat/Hello-World', tokenName: 'Hello', tokenSymbol: 'HELLO',
        launcherWallet: Keypair.generate().publicKey.toBase58(), signTransaction: async tx => tx }), error => error.message === BUNDLE_IN_PROGRESS)
      assert.equal((await pool.query('select count(*)::int as n from markets')).rows[0].n, 0)
    })

    await t.test('the rows follow the chain, and a full raise launches server-signed into a stamped bundle market', async () => {
      const first = await pass()
      assert.deepEqual([first['1'].action, await status(1), await status(2)], ['activate', 'raising', 'raising'])
      const second = await pass()
      assert.equal(second['1'].action, 'launch')
      assert.ok(second['1'].launched, JSON.stringify(second['1']))
      assert.equal(await status(1), 'launched')
      const { rows: [market] } = await pool.query(`select status, bundle_id::text as "bundleId", launcher_wallet as "launcherWallet", creator_wallet as "creatorWallet",
        discovery_version as "discoveryVersion", verification_bonus_lamports as bonus, mint, pool, launch_signature as "launchSignature" from markets where github_repo_id = 1296269`)
      assert.deepEqual([market.status, market.bundleId, market.launcherWallet, market.creatorWallet, market.discoveryVersion, market.bonus],
        ['confirmed', '1', launchSigner.publicKey.toBase58(), creator.publicKey.toBase58(), null, null], 'no discovery reward and no bonus on a bundle market')
      const chain = await chainBundle(1)
      assert.deepEqual([chain.status, chain.pool.toBase58(), chain.mint.toBase58()], [STATUS.LAUNCHED, market.pool, market.mint])
      // The launch evidence the indexer checks (finalized): the bundle verifier accepts it.
      const verify = createLaunchEvidenceVerifier({ connection, config: Keypair.generate().publicKey.toBase58(), bundleConfig: config.publicKey })
      let evidence
      for (let i = 0; i < 120; i++) { evidence = await verify({ ...market, githubRepoId: 1296269n }); if (evidence.state === 'match') break; await sleep(500) }
      assert.equal(evidence.state, 'match', evidence.reason)
      const forged = await verify({ ...market, githubRepoId: 1296269n, bundleId: '2' })
      assert.equal(forged.state, 'mismatch', 'the launch is not another bundle\'s')
    })

    await t.test('after the launch: the vault opens, the curve\'s partner fees are routed, the agent decides (dry run)', async () => {
      assert.equal((await pass())['1'].action, 'open_vault')
      assert.notEqual((await chainBundle(1)).vaultSol.toBase58(), PublicKey.default.toBase58())
      const routed = await pass()
      assert.ok(routed['1'].routeCurve?.sent, JSON.stringify(routed['1']))
      const chain = await chainBundle(1)
      assert.ok(chain.vaultRebated > 0n, 'the launch buy\'s partner fee went back to the vault')
      assert.equal((await pass())['1'].agent, 'hold', 'nothing to do yet (and nothing during the launch fee)')
    })

    await t.test('a raise past its deadline fails through the crank and its row follows', async () => {
      while ((await chainTime()) <= now + 31) await sleep(1_000)
      for (let i = 0; i < 3 && await status(2) !== 'failed'; i++) await pass()
      // The worker decides by the server's clock and the program by the chain's: with the validator's clock behind (CI), an earlier
      // pass tries too soon and the program refuses it in simulation (nothing is sent). A later pass sends it.
      const cranks = history.filter(result => result.bundleId === '2' && result.action === 'fail_raise')
      assert.ok(cranks.some(result => result.sent), JSON.stringify(cranks))
      assert.ok(cranks.every(result => result.sent || result.reason === 'RaiseOpen'), JSON.stringify(cranks))
      assert.equal(await status(2), 'failed')
      assert.equal((await chainBundle(2)).status, STATUS.FAILED)
    })

    await t.test('the live vault agent sells above its target with a quoted minimum within 1% of what the vault receives', async () => {
      // After the launch fee window, a large buy lifts the price well above 1.5x the vault's average cost.
      while ((await chainTime()) < Number((await chainBundle(1)).tradingOpensAt) + 2) await sleep(1_000)
      const before = await chainBundle(1)
      await send(await dbc.pool.swap2({ owner: whale.publicKey, payer: whale.publicKey, pool: before.pool, amountIn: new BN(String(30n * SOL)),
        minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.ExactIn, referralTokenAccount: null }), [whale])
      const vaultSol = async () => BigInt((await connection.getTokenAccountBalance(before.vaultSol, 'confirmed')).value.amount)
      const solBefore = await vaultSol()
      const live = createBundleJobs({ pool, connection, settings: { ...settings, agentsLive: true }, log: () => {} })
      let traded
      // One action per bundle per pass: the buy's partner fee is routed first, then the agent trades.
      for (let i = 0; i < 4 && !traded; i++) { const [result] = (await live.runOnce()).filter(r => r.bundleId === '1'); if (result?.trade) traded = result }
      assert.ok(traded?.trade?.sent, JSON.stringify(traded))
      assert.equal(traded.agent, 'price above the sell target')
      const after = await chainBundle(1), received = await vaultSol() - solBefore
      assert.ok(after.daySold > 0n, 'the program recorded the sell')
      const minimum = BigInt(traded.minimumOut)
      // A real bound: within 1% (the agent's tolerance) plus rounding of what the vault actually received, never 1.
      assert.ok(received >= minimum && minimum * 10_000n >= received * 9_890n, JSON.stringify({ minimum: String(minimum), received: String(received) }))
    })

    await t.test('the curve graduates and the worker binds the bundle to its DAMM v2 pool and the router\'s position', async () => {
      const chain = await chainBundle(1)
      await send(await dbc.pool.swap2({ owner: whale.publicKey, payer: whale.publicKey, pool: chain.pool, amountIn: new BN(String(300n * SOL)),
        minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null }), [whale])
      await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: SOL })), [whale])
      const migration = await dbc.migration.migrateToDammV2({ pool: chain.pool, dammConfig, payer: whale.publicKey })
      await send(migration.transaction, [whale, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
      const graduation = await pass()
      assert.ok(graduation['1'].recordGraduation?.sent, JSON.stringify(graduation['1']))
      const after = await chainBundle(1)
      assert.equal(after.graduated, true)
      const pooled = await pass()
      assert.ok('routePool' in pooled['1'], JSON.stringify(pooled['1']))
    })
  } finally {
    try { connection._rpcWebSocket?.close() } catch {}
    await pool?.end()
    if (created) await dropTestDatabase(admin, DATABASE)
    await admin.end()
    if (started) {
      let pid
      try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
      if (pid) { try { process.kill(pid) } catch {} for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(r => setTimeout(r, 250)) } }
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }
})
