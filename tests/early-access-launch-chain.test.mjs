import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressLookupTableProgram, Connection, Keypair, PACKET_DATA_SIZE, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
  sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, getMint, getTransferHook } from '@solana/spl-token'
import BN from 'bn.js'
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { createFeeAccrual } from '../src/fee-accrual.mjs'
import { createTradeRecorder } from '../src/trade-evidence.mjs'
import { createExternalFeeIndexer } from '../src/external-fee-indexer.mjs'
import { watchedMarkets } from '../src/live-trades.mjs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createLaunchCoordinator } from '../src/launch-coordinator.mjs'
import { createMeteoraLauncher, isVersionedLaunch, unsignedLaunchBase64 } from '../src/meteora-launch.mjs'
import { UNREADABLE_SIGNED_LAUNCH, createEarlyAccessLauncher, lookupTableLoader } from '../src/early-access-launch.mjs'
import { LIGHTHOUSE_PROGRAM, MAX_VERSIONED_LAUNCH_ASSERTIONS, matchesReviewedVersionedLaunch } from '../src/launch-wallet-assertions.mjs'
import { createLaunchSessionStore, launchSessionKey } from '../src/launch-sessions.mjs'
import { createLaunchEvidenceVerifier } from '../src/launch-evidence.mjs'
import { createLaunchIndexer } from '../src/launch-indexer.mjs'
import { estimateLaunchCosts } from '../src/launch-costs.mjs'
import { assertEarlyAccessConfig, buildEarlyAccessConfigTransaction, earlyAccessLookupAddresses, reviewEarlyAccessConfig,
  verifyCreatedEarlyAccessConfig } from '../src/early-access-config.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, MAX_EARLY_ACCESS_SECONDS, decodeAllowList, decodeMintConfig, earlyAccessAddresses, initPlatformInstruction } from '../src/early-access-hook.mjs'
import { contributorSnapshot } from '../src/github-contributors.mjs'
import { EARLY_ACCESS_REFUSALS, contributorSnapshotStep, earlyAccessGuard } from '../app/lib/early-access-launch.mjs'
import { POST as launchRoute } from '../app/api/launch/route.js'
import { normalizeTokenImage } from '../src/token-image.mjs'
import sharp from 'sharp'
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
      const launcher = early ? createEarlyAccessLauncher({ connection: local(), config: eaConfig, creator: creatorKey, lookupTable: lookupTable.toBase58(),
        feeClaimer: partner.publicKey })
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

    let firstMarket, firstEnd, secondMarket
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
      secondMarket = market
    })

    // Step 5 (docs/EARLY_ACCESS.md): an early access market's curve trades are indexed like any other once a path opts in with
    // EARLY_ACCESS_DBC_CONFIG: the launch's first buy and a contributor's swap2 with the transfer hook, into trade_events and
    // fee_events, by the fee accrual, the trade recorder, the external fee indexer and the live-trades watch list.
    await t.test('its curve trades are indexed: the first buy and a contributor\'s hook swap; paths that do not opt in refuse it', async () => {
      const market = secondMarket, config = solConfig.toBase58(), poolKey = new PublicKey(market.pool)
      assert.equal((await createLaunchIndexer({ pool, verify }).processMarket(market.githubRepoId)).state, 'indexed')
      const buy = await dbc.pool.swap2WithTransferHook({ owner: contributor.publicKey, payer: contributor.publicKey, pool: poolKey,
        amountIn: new BN(20_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.ExactIn, referralTokenAccount: null })
      const swapSignature = await sendAndConfirmTransaction(connection, buy, [contributor], { commitment: 'confirmed' })
      const signatures = [market.launchSignature, swapSignature]
      // Without the opt-in every path still refuses the market.
      await assert.rejects(createTradeRecorder({ pool, connection, config, earlyAccess: null })(market, swapSignature), /transfer-hook-aware path/)
      const skipped = (await createExternalFeeIndexer({ pool, connection, config, earlyAccess: null }).runOnce()).find(r => r.githubRepoId === String(market.githubRepoId))
      assert.equal(skipped.status, 'SKIPPED')
      // With it: both trades recorded once, their fees accrued once (finalized evidence).
      const record = createTradeRecorder({ pool, connection, config, earlyAccess: eaConfig })
      const accrual = createFeeAccrual({ pool, connection, config, earlyAccess: eaConfig })
      await until(async () => { try { for (const signature of signatures) await record(market, signature); return true } catch (error) {
        if (/finalized/i.test(error.message)) return null; throw error } }, 240)
      const fees = await accrual.recordTradeFees({ githubRepoId: BigInt(market.githubRepoId), signatures })
      assert.ok(fees.creditedBaseUnits > 0n, 'the builder fee of both buys')
      const again = await accrual.recordTradeFees({ githubRepoId: BigInt(market.githubRepoId), signatures })
      assert.equal(again.creditedBaseUnits, 0n, 'credited once')
      const trades = (await pool.query('select signature, direction, trader from trade_events where pool = $1 order by slot', [market.pool])).rows
      assert.deepEqual(trades.map(t => [t.signature, t.direction, t.trader]),
        [[market.launchSignature, 'buy', contributor.publicKey.toBase58()], [swapSignature, 'buy', contributor.publicKey.toBase58()]])
      const feeRows = (await pool.query('select distinct signature from fee_events where pool = $1', [market.pool])).rows.map(r => r.signature).sort()
      assert.deepEqual(feeRows, [...signatures].sort())
      // The external fee indexer passes over it with nothing new and no error; its graduated (DAMM) read waits for step 7.
      const indexed = (await createExternalFeeIndexer({ pool, connection, config, earlyAccess: eaConfig }).runOnce()).find(r => r.githubRepoId === String(market.githubRepoId))
      assert.equal(indexed.status, 'OK', indexed.error)
      assert.equal(indexed.creditedBaseUnits, 0n)
      // The live-trades watch list has its curve; the opt-in resolver maps it to the early access config.
      const watched = await watchedMarkets(pool)
      assert.ok(watched.curves.has(market.pool))
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

    // The largest realistic launch: a first buy by a wallet with neither token account yet, taken off the list after it, with the
    // longest ASCII name and ticker the form allows and the production metadata link. How many trailing Lighthouse assertions (the
    // smallest a wallet adds: one 12-byte account-info or token-account check on an account already in the transaction; the first
    // also adds the Lighthouse program's key) still fit under Solana's 1,232 bytes. Measured: none with a first buy, so a wallet
    // that insists on adding one cannot sign such a launch; at least MAX_VERSIONED_LAUNCH_ASSERTIONS without a buy.
    await t.test('sizes: the largest realistic launch fits; the Lighthouse assertions that still fit', async () => {
      const launcher = await funded(connection)
      const sized = createEarlyAccessLauncher({ connection, config: eaConfig, creator: Keypair.fromSecretKey(creatorSecret), lookupTable: lookupTable.toBase58(),
        metadataOrigin: 'https://repo.ing', feeClaimer: partner.publicKey })
      const shape = (tokenName, tokenSymbol, initialBuyLamports = '100000000') => sized.prepare({ launcherWallet: launcher.publicKey.toBase58(), tokenName, tokenSymbol,
        initialBuyLamports, earlyAccess: { windowSeconds: MAX_EARLY_ACCESS_SECONDS, repoId: '4503599627370495', keepLauncher: false } })
      const largest = await shape('N'.repeat(32), 'S'.repeat(10))
      const bytes = largest.transaction.serialize().length
      const tables = await lookupTableLoader(connection)(largest.transaction.message)
      const assertion = account => new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [{ pubkey: account, isSigner: false, isWritable: false }],
        data: Buffer.from([5, 0, 2, ...Buffer.alloc(8, 1), 0]) })
      // Bytes with `count` assertions appended, or Infinity when web3.js cannot even encode it (over 1,232 bytes).
      const sizeWith = (prepared, count) => {
        const message = TransactionMessage.decompile(prepared.transaction.message, { addressLookupTableAccounts: tables })
        try {
          return new VersionedTransaction(new TransactionMessage({ ...message, instructions: [...message.instructions,
            ...Array.from({ length: count }, () => assertion(launcher.publicKey))] }).compileToV0Message(tables)).serialize().length
        } catch { return Infinity }
      }
      const fitting = prepared => { let fits = 0; while (sizeWith(prepared, fits + 1) <= PACKET_DATA_SIZE) fits++; return fits }
      const small = await shape('First', 'FIRST'), noBuy = await shape('N'.repeat(32), 'S'.repeat(10), '0')
      const sizes = { largestFirstBuy: bytes, shortNameFirstBuy: small.transaction.serialize().length, noBuy: noBuy.transaction.serialize().length,
        assertionsThatFit: { largestFirstBuy: fitting(largest), shortNameFirstBuy: fitting(small), noBuy: fitting(noBuy) },
        perAssertion: { first: sizeWith(noBuy, 1) - sizeWith(noBuy, 0), next: sizeWith(noBuy, 2) - sizeWith(noBuy, 1) }, limit: PACKET_DATA_SIZE }
      console.log(JSON.stringify({ launchSizes: sizes }))
      assert.ok(bytes <= PACKET_DATA_SIZE, `${bytes} bytes`)
      assert.deepEqual([sizes.assertionsThatFit.largestFirstBuy, sizes.assertionsThatFit.shortNameFirstBuy], [0, 0], 'no room for one with a first buy')
      assert.ok(sizes.assertionsThatFit.noBuy >= MAX_VERSIONED_LAUNCH_ASSERTIONS, 'the cap is reachable without a buy')
      // The matcher refuses a first-buy launch with an assertion (it could not be sent) and accepts a no-buy launch with the cap.
      const asserted = (prepared, count) => new VersionedTransaction(new TransactionMessage({ ...TransactionMessage.decompile(prepared.transaction.message,
        { addressLookupTableAccounts: tables }), instructions: [...TransactionMessage.decompile(prepared.transaction.message, { addressLookupTableAccounts: tables }).instructions,
        ...Array.from({ length: count }, () => assertion(launcher.publicKey))] }).compileToV0Message(tables))
      const load = lookupTableLoader(connection)
      assert.equal(await matchesReviewedVersionedLaunch(Buffer.from(largest.transaction.message.serialize()), asserted(largest, 1), load), false)
      assert.equal(await matchesReviewedVersionedLaunch(Buffer.from(noBuy.transaction.message.serialize()), asserted(noBuy, MAX_VERSIONED_LAUNCH_ASSERTIONS), load), true)
      // A name of multi-byte characters can pass the length check and still not fit: refused with a message, never sent.
      await assert.rejects(shape('名'.repeat(32), 'S'.repeat(10)), /does not fit in one Solana transaction/)
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

    // Through the route the browser calls (app/api/launch/route.js): a stored v0 review is told apart from a legacy one
    // (isVersionedLaunch) and restored by the early access launcher; its guards (marketPairGuard, then the early access guard) run
    // after the wallet signed. While the code gate is closed, as in step 4, a signed early access launch is refused there and nothing
    // is sent; a legacy body posted for it is refused with a message the page can show. A SOL launch goes through the same route and
    // the same composed guards unchanged.
    await t.test('the launch API: v0 reviews are told apart and refused while the gate is closed; a SOL launch through it is unchanged', async () => {
      const ENV = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'PLATFORM_CREATOR_SECRET_KEY', 'EARLY_ACCESS_ENABLED', 'EARLY_ACCESS_DBC_CONFIG',
        'EARLY_ACCESS_LOOKUP_TABLE', 'APP_ORIGIN', 'DISCOVERY_REWARDS_ENABLED', 'PLATFORM_PARTNER_SECRET_KEY', 'BUILDER_ALLOCATION_CONFIGS', 'VERIFICATION_BONUS_LAMPORTS']
      const saved = { env: Object.fromEntries(ENV.map(key => [key, process.env[key]])), pool: globalThis.__gitfunPool, fetch: globalThis.fetch }
      const ROUTE_REPO = repository(700008, 'octo/route', 91)
      try {
        for (const key of ENV) delete process.env[key]
        Object.assign(process.env, { DATABASE_URL: URL_, SOLANA_RPC_URL: RPC, DBC_CONFIG: solConfig.toBase58(), PLATFORM_CREATOR_SECRET_KEY: JSON.stringify([...creatorSecret]),
          EARLY_ACCESS_ENABLED: 'true', EARLY_ACCESS_DBC_CONFIG: eaConfig, EARLY_ACCESS_LOOKUP_TABLE: lookupTable.toBase58() })
        globalThis.__gitfunPool = pool
        globalThis.fetch = async (url, init) => {
          const href = String(url)
          if (href.startsWith('https://api.github.com/')) return Response.json(/\/commits\?per_page=1$/.test(href) ? [{ sha: 'b2'.repeat(20) }] : ROUTE_REPO)
          if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(href)) throw Error(`test fetch outside the local services: ${href}`)
          return saved.fetch(url, init)
        }
        const post = async body => {
          const response = await launchRoute(new Request('https://repo.ing/api/launch', { method: 'POST', body: JSON.stringify(body) }))
          return { status: response.status, body: await response.json() }
        }
        // Two early access reviews, prepared and stored as the prepare step stores them.
        const review = async repo => {
          const launcher = await funded(connection), { coordinator, store } = replica({ repo }), id = crypto.randomUUID()
          let transaction, marketId
          await coordinator.prepareLaunch({ repositoryUrl: `https://github.com/${repo.full_name}`, tokenName: 'Route', tokenSymbol: 'ROUTE',
            launcherWallet: launcher.publicKey.toBase58(), initialBuyLamports: '10000000', onPrepared: async ({ market, prepared, repo: resolved }) => {
              transaction = unsignedLaunchBase64(prepared.transaction); marketId = market.id
              await store.create({ id, market, repoFullName: resolved.fullName, config: eaConfig, transaction, mintSecretKey: prepared.mintSecretKey,
                blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight, initialBuyLamports: '10000000' })
            } })
          const signed = VersionedTransaction.deserialize(Buffer.from(transaction, 'base64'))
          signed.sign([launcher])
          return { id, marketId, launcher, signed: Buffer.from(signed.serialize()).toString('base64') }
        }
        const state = async marketId => (await pool.query('select status, launch_signature from markets where id = $1', [marketId])).rows[0]
        const gated = await review(repository(700006, 'octo/gated', 91))
        const refused = await post({ action: 'submit', id: gated.id, transaction: gated.signed })
        assert.deepEqual([refused.status, refused.body.error], [400, EARLY_ACCESS_REFUSALS.unavailable], 'the code gate is closed in step 4')
        assert.deepEqual(await state(gated.marketId), { status: 'failed', launch_signature: null }, 'nothing was sent')
        assert.equal((await post({ action: 'submit', id: gated.id, transaction: gated.signed })).body.error, 'Prepared launch expired; reload before trying again')
        const legacyBody = await review(repository(700007, 'octo/legacy-body', 91))
        const wrong = new Transaction({ feePayer: legacyBody.launcher.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash })
          .add(SystemProgram.transfer({ fromPubkey: legacyBody.launcher.publicKey, toPubkey: creator.publicKey, lamports: 1 }))
        wrong.sign(legacyBody.launcher)
        for (const [label, transaction] of [['a legacy transaction', wrong.serialize().toString('base64')]]) {
          const answer = await post({ action: 'submit', id: legacyBody.id, transaction })
          assert.deepEqual([answer.status, answer.body.error, answer.body.canRetry], [400, UNREADABLE_SIGNED_LAUNCH, true], label)
        }
        assert.deepEqual(await state(legacyBody.marketId), { status: 'failed', launch_signature: null })

        // A SOL launch through the same route: prepared, signed as a legacy transaction, submitted, verified and indexed.
        const wallet = await funded(connection)
        const image = (await normalizeTokenImage(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#4d9fff' } }).png().toBuffer())).image
        const prepared = await post({ action: 'prepare', repoId: String(ROUTE_REPO.id), repositoryUrl: `https://github.com/${ROUTE_REPO.full_name}`,
          tokenName: 'Route', tokenSymbol: 'ROUTE', tokenImage: image, launcherWallet: wallet.publicKey.toBase58(), initialBuyLamports: '0' })
        assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
        assert.equal(prepared.body.earlyAccess, undefined)
        assert.equal(isVersionedLaunch(prepared.body.transaction), false)
        const tx = Transaction.from(Buffer.from(prepared.body.transaction, 'base64'))
        tx.partialSign(wallet)
        const launched = await post({ action: 'submit', id: prepared.body.id, transaction: tx.serialize({ requireAllSignatures: false }).toString('base64') })
        assert.equal(launched.status, 200, JSON.stringify(launched.body))
        const { rows: [market] } = await pool.query('select status, indexed_at is not null as indexed, early_access_end, transfer_hook_program from markets where github_repo_id = $1', [ROUTE_REPO.id])
        assert.deepEqual(market, { status: 'confirmed', indexed: true, early_access_end: null, transfer_hook_program: null })
      } finally {
        for (const [key, value] of Object.entries(saved.env)) value === undefined ? delete process.env[key] : process.env[key] = value
        Object.assign(globalThis, { __gitfunPool: saved.pool, fetch: saved.fetch })
      }
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
