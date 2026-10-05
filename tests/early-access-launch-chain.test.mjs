import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferHook } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher, isVersionedLaunch, unsignedLaunchBase64 } from '../src/meteora-launch.mjs'
import { createEarlyAccessLauncher } from '../src/early-access-launch.mjs'
import { createLaunchSessionStore, launchSessionKey } from '../src/launch-sessions.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { estimateLaunchCosts } from '../src/launch-costs.mjs'
import { assertEarlyAccessConfig, buildEarlyAccessConfigTransaction, earlyAccessLookupAddresses, reviewEarlyAccessConfig,
  verifyCreatedEarlyAccessConfig } from '../src/early-access-config.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, decodeAllowList, decodeMintConfig, earlyAccessAddresses, initPlatformInstruction } from '../src/early-access-hook.mjs'
import { contributorSnapshot } from '../src/github-contributors.mjs'
import { contributorSnapshotStep, earlyAccessGuard } from '../app/lib/early-access-launch.mjs'
import { composeGuards } from '../app/lib/stock-launch.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// Contributor early access launched end to end (docs/EARLY_ACCESS.md, step 4) on the programs mainnet runs
// (scripts/ci/start-early-access-validator.sh): the early access config built and reviewed as scripts/create-early-access-config.mjs
// does, the hook's platform, the shared lookup table, then launches through the coordinator, the persisted review and the
// evidence verifier and indexer, with GitHub's contributor list stubbed and a contributor's wallet linked in PostgreSQL. A SOL
// launch on the same programs is unchanged. Nothing here touches mainnet beyond the validator script reading its programs once.
const DATABASE = 'repoing_early_access_launch_chain_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DATABASE}`
const RPC = process.env.EARLY_ACCESS_CHAIN_RPC ?? `http://127.0.0.1:${process.env.EARLY_ACCESS_VALIDATOR_RPC_PORT ?? 8929}`
const WINDOW_SECONDS = 15 * 60
const repository = (id, fullName, ownerId) => ({ id, name: fullName.split('/')[1], full_name: fullName, owner: { login: fullName.split('/')[0], id: ownerId,
  type: 'User', avatar_url: null }, description: null, stargazers_count: 5, forks_count: 1, archived: false, private: false, visibility: 'public',
  updated_at: '2026-10-01T00:00:00Z' })
const REPOS = { first: repository(700001, 'octo/first', 91), second: repository(700002, 'octo/second', 91), third: repository(700003, 'octo/third', 91),
  legacy: repository(700004, 'octo/legacy', 91) }
const github = repo => async () => ({ ok: true, status: 200, json: async () => repo })
const connections = []
const local = () => { const connection = new Connection(RPC, 'confirmed'); connections.push(connection); return connection }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function healthy() {
  try { return (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })).json()).result === 'ok' } catch { return false }
}
async function funded(connection, lamports = 10_000_000_000) {
  const keypair = Keypair.generate()
  const signature = await connection.requestAirdrop(keypair.publicKey, lamports)
  await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
  return keypair
}
async function until(read, attempts = 200) {
  for (let i = 0; i < attempts; i++) { const value = await read(); if (value) return value; await sleep(250) }
  return null
}
async function stopValidator(work) {
  let pid
  try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
  if (pid) {
    try { process.kill(pid) } catch {}
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await sleep(250) }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('contributor early access launches end to end on mainnet\'s programs; SOL launches are unchanged', { timeout: 600_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.EARLY_ACCESS_CHAIN_WORK_DIR, started = false
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DATABASE}$`), 'postgres') })
  let pool, created = false
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-early-access-launch-'))
      started = true
      const run = spawnSync('scripts/ci/start-early-access-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'early access validator started')
    }
    assert.ok(work && existsSync(join(work, 'hook-authority.json')), 'the validator work dir with the hook upgrade authority')
    const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'hook-authority.json'), 'utf8'))))
    const connection = local()
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    await admin.query(`drop database if exists ${DATABASE}`)
    await admin.query(`create database ${DATABASE}`); created = true
    pool = new pg.Pool({ connectionString: URL_ })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })

    const creatorSecret = (await funded(connection)).secretKey // the launch co-signer and the hook's admin
    const creator = Keypair.fromSecretKey(creatorSecret)
    const oracle = Keypair.generate()
    const signature = await connection.requestAirdrop(upgradeAuthority.publicKey, 2_000_000_000)
    await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')

    // The live SOL launch-fee config, then the early access config built and reviewed against it exactly as the mainnet script does.
    const { config: solConfig, partner } = await createFixedConfig(connection, 'launch-fee', { leftoverReceiver: creator.publicKey })
    const eaConfigKey = Keypair.generate(), eaConfig = eaConfigKey.publicKey.toBase58()
    await t.test('the early access config is built, reviewed against the SOL config and created', async () => {
      const built = await buildEarlyAccessConfigTransaction({ connection, config: eaConfig, partner: partner.publicKey.toBase58(),
        leftoverReceiver: creator.publicKey.toBase58() })
      const review = await reviewEarlyAccessConfig({ connection, tx: built.tx, config: eaConfig, payer: partner.publicKey.toBase58(),
        feeClaimer: partner.publicKey.toBase58(), leftoverReceiver: creator.publicKey.toBase58(), reference: solConfig.toBase58(), curve: built.curve })
      built.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
      await sendAndConfirmTransaction(connection, built.tx, [partner, eaConfigKey], { commitment: 'confirmed' })
      const decoded = await verifyCreatedEarlyAccessConfig({ connection, config: eaConfig, accountDataSha256: review.accountDataSha256, commitment: 'confirmed' })
      assert.ok(decoded.transferHookProgram.equals(HOOK))
      const coder = dbc.state.getProgram().coder.accounts
      const reference = coder.decode('poolConfig', (await connection.getAccountInfo(solConfig)).data)
      const expected = { feeClaimer: partner.publicKey, leftoverReceiver: creator.publicKey, reference }
      assert.ok(assertEarlyAccessConfig(decoded, expected))
      // Each tampered field is refused.
      const other = Keypair.generate().publicKey
      const tampered = (field, value) => ({ ...decoded, config: { ...decoded.config, [field]: value } })
      assert.throws(() => assertEarlyAccessConfig({ ...decoded, transferHookProgram: other }, expected), /another transfer hook program/)
      assert.throws(() => assertEarlyAccessConfig(tampered('feeClaimer', other), expected), /another fee claimer/)
      assert.throws(() => assertEarlyAccessConfig(tampered('leftoverReceiver', other), expected), /another leftover receiver/)
      assert.throws(() => assertEarlyAccessConfig(tampered('quoteMint', other), expected), /does not quote wrapped SOL/)
      assert.throws(() => assertEarlyAccessConfig(tampered('tokenType', 0), expected), /Token-2022/)
      assert.throws(() => assertEarlyAccessConfig(tampered('sqrtStartPrice', decoded.config.sqrtStartPrice.addn(1)), expected), /sqrtStartPrice/)
      assert.throws(() => assertEarlyAccessConfig(tampered('migrationQuoteThreshold', decoded.config.migrationQuoteThreshold.addn(1)), expected), /migrationQuoteThreshold/)
      assert.throws(() => assertEarlyAccessConfig(decoded, { ...expected, reference: { ...reference, partnerLiquidityPercentage: 1 } }),
        /beyond the fee and token type: partnerLiquidityPercentage/)
      // The SOL launch-fee config itself is not an early access config.
      assert.throws(() => assertEarlyAccessConfig({ config: reference, transferHookProgram: HOOK }, expected), /Token-2022|flat 1.75%/)
    })

    // The hook's platform (admin: the launch co-signer), then the lookup table every early access launch uses.
    await sendAndConfirmTransaction(connection, new Transaction().add(initPlatformInstruction({ upgradeAuthority: upgradeAuthority.publicKey,
      admin: creator.publicKey, oracle: oracle.publicKey })), [upgradeAuthority], { commitment: 'confirmed' })
    const [createTable, lookupTable] = AddressLookupTableProgram.createLookupTable({ authority: partner.publicKey, payer: partner.publicKey,
      recentSlot: await connection.getSlot('finalized') })
    await sendAndConfirmTransaction(connection, new Transaction().add(createTable, AddressLookupTableProgram.extendLookupTable({ payer: partner.publicKey,
      authority: partner.publicKey, lookupTable, addresses: earlyAccessLookupAddresses(eaConfig) })), [partner], { commitment: 'confirmed' })
    const table = await until(async () => (await connection.getAddressLookupTable(lookupTable)).value)
    assert.equal(table.state.addresses.length, 12)
    await until(async () => await connection.getSlot('confirmed') > table.state.lastExtendedSlot)

    // GitHub's contributor list for every repository: one linked contributor, one unlinked, a bot, an organization, an anonymous entry.
    const contributor = await funded(connection), unlinked = Keypair.generate()
    await pool.query(`insert into github_wallet_links (github_user_id, wallet, github_login) values (501, $1, 'alice')`, [contributor.publicKey.toBase58()])
    const contributorPages = []
    const contributorsFetch = async url => {
      contributorPages.push(String(url))
      return new Response(JSON.stringify([{ login: 'alice', id: 501, type: 'User', contributions: 40 }, { login: 'bob', id: 502, type: 'User', contributions: 2 },
        { login: 'renovate[bot]', id: 503, type: 'Bot', contributions: 9 }, { login: 'octo-org', id: 504, type: 'Organization', contributions: 1 },
        { email: 'x@example.com', name: 'X', type: 'Anonymous', contributions: 3 }]), { status: 200, headers: { 'x-ratelimit-remaining': '4000' } })
    }
    const launchable = () => true, configured = () => eaConfig
    const replica = ({ repo, windowSeconds = WINDOW_SECONDS, early = true }) => {
      const creatorKey = Keypair.fromSecretKey(creatorSecret)
      const launcher = early ? createEarlyAccessLauncher({ connection: local(), config: eaConfig, creator: creatorKey, lookupTable: lookupTable.toBase58() })
        : createMeteoraLauncher({ connection: local(), config: solConfig, creator: creatorKey })
      const store = createLaunchSessionStore({ pool, key: launchSessionKey(creatorKey.secretKey) })
      const coordinator = createLaunchCoordinator({ pool, launcher, fetchImpl: github(repo), discoveryEnabled: true, builderAllocationEnabled: true,
        verificationBonusLamports: 250_000_000n, pendingReview: market => store.pending(market.id),
        earlyAccess: early ? { windowSeconds, snapshot: contributorSnapshotStep({ pool, fetchImpl: contributorsFetch }) } : null })
      return { launcher, store, coordinator }
    }
    const guard = versioned => composeGuards(earlyAccessGuard(eaConfig, { versioned, launchable, configured }))
    const verify = createLaunchEvidenceVerifier({ connection, config: solConfig.toBase58(), earlyAccessConfig: eaConfig })
    const evidence = async market => until(async () => { const result = await verify(market); return result.state === 'match' ? result : null })
    const allowList = async mint => decodeAllowList((await connection.getAccountInfo(earlyAccessAddresses(mint).allowList)).data).wallets.map(String)
    const row = async id => (await pool.query(`select status, early_access_end, transfer_hook_program, discovery_version, builder_allocation_version,
      verification_bonus_lamports::text, quote_asset_id from markets where id = $1`, [id])).rows[0]

    let firstMarket, firstEnd
    await t.test('prepared on one replica, signed as v0 by the wallet, submitted from another; the launcher is taken off the list', async () => {
      const launcher = await funded(connection)
      const a = replica({ repo: REPOS.first }), b = replica({ repo: REPOS.first }), id = crypto.randomUUID()
      let transaction, costs, prepared
      const before = Math.floor(Date.now() / 1000)
      await a.coordinator.prepareLaunch({ repositoryUrl: `https://github.com/${REPOS.first.full_name}`, tokenName: 'First', tokenSymbol: 'FIRST',
        launcherWallet: launcher.publicKey.toBase58(), initialBuyLamports: '100000000', launchGuard: guard(true),
        onPrepared: async ({ market, prepared: ready, repo }) => {
          prepared = ready
          costs = await estimateLaunchCosts(connection, ready.transaction, '100000000')
          transaction = unsignedLaunchBase64(ready.transaction)
          await a.store.create({ id, market, repoFullName: repo.fullName, config: eaConfig, transaction, mintSecretKey: ready.mintSecretKey,
            blockhash: ready.blockhash, lastValidBlockHeight: ready.lastValidBlockHeight, initialBuyLamports: '100000000' })
        } })
      // The review: a v0 transaction through the lookup table, within the packet limit, its costs read from the same bytes.
      const unsigned = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
      assert.equal(unsigned.version, 0)
      assert.deepEqual(unsigned.message.addressTableLookups.map(lookup => lookup.accountKey.toBase58()), [lookupTable.toBase58()])
      const bytes = unsigned.serialize().length
      assert.ok(bytes <= 1232, `${bytes} bytes`)
      assert.ok(BigInt(costs.initialBuy) === 100_000_000n && BigInt(costs.accountDeposits) > 0n && BigInt(costs.networkFee) >= 15_000n, JSON.stringify(costs))
      assert.equal(prepared.earlyAccess.contributors, 2, 'alice and bob; the bot, the organization and the anonymous entry are skipped')
      assert.equal(prepared.earlyAccess.linkedWallets, 1)
      assert.equal(prepared.earlyAccess.launcherListed, false)
      firstEnd = prepared.earlyAccess.end
      assert.ok(firstEnd >= before + WINDOW_SECONDS - 5 && firstEnd <= Math.floor(Date.now() / 1000) + WINDOW_SECONDS, `${firstEnd}`)
      assert.deepEqual((await contributorSnapshot(pool, REPOS.first.id)).map(c => [c.githubUserId, c.githubLogin, c.contributions]),
        [['501', 'alice', 40], ['502', 'bob', 2]])
      assert.match(contributorPages.at(-1), /\/repos\/octo\/first\/contributors\?per_page=100&page=1$/)
      // The stamp is on the prepared reservation.
      const { rows: [reserved] } = await pool.query('select id, status, early_access_end, transfer_hook_program from markets where github_repo_id = $1', [REPOS.first.id])
      assert.deepEqual([reserved.status, reserved.early_access_end.getTime(), reserved.transfer_hook_program], ['prepared', firstEnd * 1000, HOOK.toBase58()])

      // The wallet signs the v0 transaction; the page posts it; another replica submits it.
      const signed = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
      signed.sign([launcher])
      const posted = Buffer.from(signed.serialize()).toString('base64')
      const session = await b.store.consume(id)
      assert.equal(isVersionedLaunch(session.transaction), true)
      const restorer = createEarlyAccessLauncher({ connection: local(), config: session.config, creator: Keypair.fromSecretKey(creatorSecret) })
      firstMarket = await b.coordinator.submitPrepared({ marketId: session.marketId, githubRepoId: session.githubRepoId, mint: session.mint,
        repo: { githubRepoId: BigInt(session.githubRepoId), fullName: session.repoFullName }, prepared: restorer.restore(session), launchGuard: guard(true),
        signTransaction: async () => VersionedTransaction.deserialize(Buffer.from(posted, 'base64')) })
      assert.equal(firstMarket.status, 'confirmed')
      assert.equal(firstMarket.earlyAccessEnd.getTime(), firstEnd * 1000)
      assert.equal(firstMarket.transferHookProgram, HOOK.toBase58())

      // On chain: a Token-2022 mint with our hook, the hook's window equal to the stamp, the launcher's buy, the launcher off the list.
      const mint = new PublicKey(firstMarket.mint)
      const minted = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)
      assert.equal(getTransferHook(minted).programId.toBase58(), HOOK.toBase58())
      const window = decodeMintConfig((await connection.getAccountInfo(earlyAccessAddresses(mint).config)).data)
      assert.deepEqual([window.earlyAccessEnd, window.repoId, window.rentReceiver.toBase58()], [firstEnd, String(REPOS.first.id), launcher.publicKey.toBase58()])
      const balance = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, launcher.publicKey, false, TOKEN_2022_PROGRAM_ID))
      assert.ok(BigInt(balance.value.amount) > 0n, 'the launcher\'s first buy landed')
      assert.deepEqual(await allowList(mint), [], 'the launcher (not a contributor) is off the list')
      const landed = await connection.getTransaction(firstMarket.launchSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      assert.equal(landed.version, 0)
      console.log(JSON.stringify({ earlyAccessLaunch: { bytes, computeUnits: landed.meta.computeUnitsConsumed, priorityFee: prepared.priorityFee } }))
      // The SPL-era rewards are stamped as on a SOL launch (claims for hook pools come with step 6); never a stock stamp.
      assert.deepEqual(await row(firstMarket.id), { status: 'confirmed', early_access_end: new Date(firstEnd * 1000), transfer_hook_program: HOOK.toBase58(),
        discovery_version: 2, builder_allocation_version: 1, verification_bonus_lamports: '250000000', quote_asset_id: null })
    })

    await t.test('launch evidence and the indexer accept it; a different window or a missing stamp is refused', async () => {
      const result = await evidence(firstMarket)
      assert.ok(result, 'finalized evidence matches')
      const indexed = await createLaunchIndexer({ pool, verify }).processMarket(firstMarket.githubRepoId)
      assert.equal(indexed.state, 'indexed')
      assert.equal((await verify({ ...firstMarket, earlyAccessEnd: new Date((firstEnd + 1) * 1000) })).state, 'mismatch')
      assert.equal((await verify({ ...firstMarket, githubRepoId: 1n })).state, 'mismatch')
      assert.equal((await verify({ ...firstMarket, transferHookProgram: Keypair.generate().publicKey.toBase58() })).state, 'mismatch')
      // Without its stamp the market is read as a SOL market, whose path refuses this pool.
      assert.equal((await verify({ ...firstMarket, earlyAccessEnd: null, transferHookProgram: null })).state, 'mismatch')
      // The stamp is immutable once the launch was sent.
      await assert.rejects(pool.query('update markets set early_access_end = early_access_end + interval \'1 second\' where id = $1', [firstMarket.id]), /immutable/)
    })

    await t.test('a contributor launcher stays on the list after its first buy', async () => {
      const { coordinator } = replica({ repo: REPOS.second, windowSeconds: 3600 })
      const market = await coordinator.launch({ repositoryUrl: `https://github.com/${REPOS.second.full_name}`, tokenName: 'Second', tokenSymbol: 'SECOND',
        launcherWallet: contributor.publicKey.toBase58(), initialBuyLamports: '50000000', launchGuard: guard(true),
        signTransaction: async tx => { tx.sign([contributor]); return tx } })
      assert.equal(market.status, 'confirmed')
      assert.deepEqual(await allowList(market.mint), [contributor.publicKey.toBase58()])
      assert.ok(await evidence(market))
    })

    await t.test('without a first buy nobody is listed and nothing is removed', async () => {
      const launcher = await funded(connection)
      const { coordinator } = replica({ repo: REPOS.third })
      const market = await coordinator.launch({ repositoryUrl: `https://github.com/${REPOS.third.full_name}`, tokenName: 'Third', tokenSymbol: 'THIRD',
        launcherWallet: launcher.publicKey.toBase58(), launchGuard: guard(true), signTransaction: async tx => { tx.sign([launcher]); return tx } })
      assert.equal(market.status, 'confirmed')
      assert.deepEqual(await allowList(market.mint), [])
      const landed = await connection.getTransaction(market.launchSignature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
      const hookCalls = landed.transaction.message.compiledInstructions.filter(ix => landed.transaction.message.staticAccountKeys[ix.programIdIndex]?.equals(HOOK))
      assert.equal(hookCalls.length, 1, 'init_mint only')
    })

    await t.test('a wallet that changes the v0 transaction is refused and nothing is sent', async () => {
      const launcher = await funded(connection)
      const { coordinator } = replica({ repo: repository(700005, 'octo/fifth', 91) })
      await assert.rejects(coordinator.launch({ repositoryUrl: 'https://github.com/octo/fifth', tokenName: 'Fifth', tokenSymbol: 'FIFTH',
        launcherWallet: launcher.publicKey.toBase58(), launchGuard: guard(true), signTransaction: async tx => {
          // A higher priority fee: the unit price instruction (the second) re-priced.
          const changed = VersionedTransaction.deserialize(tx.serialize())
          const price = changed.message.compiledInstructions[1]
          price.data = Uint8Array.from(price.data); price.data[1] ^= 1
          changed.sign([launcher])
          return changed
        } }), /Your wallet changed the launch transaction/)
      const { rows: [market] } = await pool.query('select status, launch_signature from markets where github_repo_id = 700005')
      assert.deepEqual(market, { status: 'failed', launch_signature: null })
    })

    await t.test('a failed early access reservation reused by a SOL launch clears its stamp; the SOL launch is unchanged', async () => {
      const launcher = await funded(connection)
      const early = replica({ repo: REPOS.legacy }), id = crypto.randomUUID()
      await early.coordinator.prepareLaunch({ repositoryUrl: `https://github.com/${REPOS.legacy.full_name}`, tokenName: 'Legacy', tokenSymbol: 'LEGACY',
        launcherWallet: launcher.publicKey.toBase58(), launchGuard: guard(true), onPrepared: async ({ market, prepared, repo }) => {
          await early.store.create({ id, market, repoFullName: repo.fullName, config: eaConfig, transaction: unsignedLaunchBase64(prepared.transaction),
            mintSecretKey: prepared.mintSecretKey, blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight })
        } })
      assert.equal(await early.store.cancel(id), true)
      const { rows: [failed] } = await pool.query('select status, early_access_end is not null as stamped from markets where github_repo_id = $1', [REPOS.legacy.id])
      assert.deepEqual(failed, { status: 'failed', stamped: true })
      const sol = replica({ repo: REPOS.legacy, early: false })
      let reviewed
      const market = await sol.coordinator.launch({ repositoryUrl: `https://github.com/${REPOS.legacy.full_name}`, tokenName: 'Legacy', tokenSymbol: 'LEGACY',
        launcherWallet: launcher.publicKey.toBase58(), initialBuyLamports: '10000000', launchGuard: guard(false),
        signTransaction: async tx => { reviewed = tx; tx.partialSign(launcher); return tx } })
      assert.ok(reviewed instanceof Transaction, 'a legacy transaction, as before')
      assert.equal(market.status, 'confirmed')
      assert.deepEqual(await row(market.id), { status: 'confirmed', early_access_end: null, transfer_hook_program: null, discovery_version: 2,
        builder_allocation_version: 1, verification_bonus_lamports: '250000000', quote_asset_id: null })
      assert.ok(await until(async () => (await verify(market)).state === 'match'), 'the SPL evidence path is unchanged')
      const mintInfo = await connection.getAccountInfo(new PublicKey(market.mint))
      assert.notEqual(mintInfo.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58())
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, DATABASE)
    await admin.end()
    for (const connection of connections) { try { connection._rpcWebSocket?.close() } catch {} }
    if (started) await stopValidator(work)
  }
})
