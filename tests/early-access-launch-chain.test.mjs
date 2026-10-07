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
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, getMint,
  getTransferHook, unpackMint } from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, deriveDammV2PoolAddress, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID, CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { createGraduationMonitor } from '../src/graduation-readiness.mjs'
import { assertRevokedHookMint } from '../src/canonical-damm-trade.mjs'
import { readGraduationState } from '../src/graduation-state.mjs'
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
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, MAX_EARLY_ACCESS_SECONDS, addWalletsInstruction, decodeAllowList, decodeMintConfig, earlyAccessAddresses,
  initPlatformInstruction } from '../src/early-access-hook.mjs'
import { EARLY_ACCESS_NOT_CLAIMABLE, EARLY_ACCESS_NOT_TRADABLE } from '../src/early-access.mjs'
import { contributorsOnly, hookRefusal } from '../src/early-access-trade.mjs'
import { createEarlyAccessOracle } from '../src/early-access-oracle.mjs'
import { createReconciler } from '../src/reconcile.mjs'
import { createClaim } from '../src/claim.mjs'
import { createDiscoveryClaims } from '../src/discovery-claims.mjs'
import { discoverySummary } from '../src/discovery-rewards.mjs'
import { DBC_MAX_NETWORK_FEE_LAMPORTS, createDbcPlatformFees } from '../src/platform-dbc-fees.mjs'
import { createPlatformFees } from '../src/platform-fees.mjs'
import { sign as signBytes } from 'node:crypto'
import { CLAIM_CREATOR_TRADING_FEE2_DISCRIMINATOR } from '../src/dbc-hook-claims.mjs'
import { associatedAccountLength } from '../src/trade-costs.mjs'
import { POST as tradeRoute } from '../app/api/trade/route.js'
import { GET as balanceRoute } from '../app/api/market/[mint]/balance/route.js'
import { GET as claimPreviewRoute } from '../app/api/claim/[repo]/preview/route.js'
import { feeStatus } from '../app/lib/server.mjs'
import { handleBuyGet, handleBuyPost, handleSellPost, loadActionMarket } from '../app/lib/solana-actions.mjs'
import { prepareActionTrade, walletTokenBalance } from '../app/lib/action-trades.mjs'
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

test('contributor early access launches end to end on mainnet\'s programs; SOL launches are unchanged', { timeout: 900_000 }, async t => {
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

    let firstMarket, firstEnd, firstLauncher, secondMarket
    await t.test('prepared on one replica, signed as v0 by the wallet, submitted from another; the launcher is taken off the list', async () => {
      const launcher = firstLauncher = await funded(connection)
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

    // Step 5d: the site's curve trader through /api/trade, as the trade panel calls it. Each transaction is swap2WithTransferHook,
    // checked before the wallet signs and verified after it lands. During the window a listed contributor buys and sells, a wallet the
    // oracle adds buys (its Token-2022 account's rent is in the costs), a holder who is not listed sells, and anyone else's buy is
    // refused before anything is built. Without EARLY_ACCESS_DBC_CONFIG the market is refused by name.
    await t.test('the site and its Blinks trade the curve during the window: listed wallets buy, holders sell, anyone else is refused', async () => {
      const ENV = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'BUNDLE_DBC_CONFIG', 'EARLY_ACCESS_DBC_CONFIG']
      const GLOBALS = ['__gitfunPool', '__gitfunTrader', '__gitfunTraderConfig', '__gitfunTradeSessions', '__gitfunTradeSessionsRouter']
      const saved = { env: Object.fromEntries(ENV.map(name => [name, process.env[name]])), globals: Object.fromEntries(GLOBALS.map(name => [name, globalThis[name]])) }
      const fresh = () => { for (const name of GLOBALS) delete globalThis[name]; globalThis.__gitfunPool = pool }
      try {
        for (const name of ENV) delete process.env[name]
        Object.assign(process.env, { DATABASE_URL: URL_, SOLANA_RPC_URL: RPC, DBC_CONFIG: solConfig.toBase58(), EARLY_ACCESS_DBC_CONFIG: eaConfig })
        fresh()
        const market = secondMarket, mint = new PublicKey(market.mint), repoId = String(market.githubRepoId)
        const post = async body => {
          const response = await tradeRoute(new Request('https://repo.ing/api/trade', { method: 'POST', body: JSON.stringify(body) }))
          return { status: response.status, body: await response.json() }
        }
        const prepare = (forMarket, wallet, direction, amount) => post({ action: 'prepare', githubRepoId: String(forMarket.githubRepoId),
          wallet: wallet.publicKey.toBase58(), direction, amountBaseUnits: String(amount) })
        const held = async (forMint, wallet) => BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(forMint),
          wallet.publicKey, false, TOKEN_2022_PROGRAM_ID), 'confirmed')).value.amount)
        const trade = async (forMarket, wallet, direction, amount) => {
          const prepared = await prepare(forMarket, wallet, direction, amount)
          assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
          const tx = Transaction.from(Buffer.from(prepared.body.transaction, 'base64'))
          const swap = tx.instructions.filter(ix => ix.programId.toBase58() === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
          assert.equal(swap.length, 1)
          assert.deepEqual([...swap[0].data.subarray(0, 8)], [183, 93, 153, 40, 24, 230, 194, 151], 'swap2WithTransferHook')
          const before = await held(forMarket.mint, wallet).catch(() => 0n)
          tx.sign(wallet)
          const submitted = await post({ action: 'submit', id: prepared.body.id, transaction: tx.serialize().toString('base64') })
          assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
          assert.equal(submitted.body.state, 'confirmed', JSON.stringify(submitted.body))
          assert.equal(BigInt(submitted.body.tokenDelta), await held(forMarket.mint, wallet) - before, 'the verified delta is the wallet\'s Token-2022 account')
          return { costs: prepared.body.costs, result: submitted.body }
        }

        const quote = await post({ action: 'quote', githubRepoId: repoId, direction: 'buy', amountBaseUnits: '10000000' })
        assert.equal(quote.status, 200, JSON.stringify(quote.body))
        assert.ok(BigInt(quote.body.outputAmount) > 0n)

        // The listed contributor buys, then sells half of what it bought; the trade panel's balance reads its Token-2022 account.
        const bought = await trade(market, contributor, 'buy', 30_000_000)
        assert.ok(BigInt(bought.result.tokenDelta) > 0n && BigInt(bought.result.solDelta) < -30_000_000n, JSON.stringify(bought.result))
        const sold = await trade(market, contributor, 'sell', BigInt(bought.result.tokenDelta) / 2n)
        assert.equal(BigInt(sold.result.tokenDelta), -(BigInt(bought.result.tokenDelta) / 2n))
        const shown = await balanceRoute(new Request(`https://repo.ing/api/market/${market.mint}/balance?wallet=${contributor.publicKey.toBase58()}`),
          { params: Promise.resolve({ mint: market.mint }) })
        assert.equal((await shown.json()).balanceBaseUnits, String(await held(market.mint, contributor)))

        // A wallet that is not on the list: refused before anything is built, with the window's end. The hook's own refusal of the same
        // buy (what a trade that got past this check would meet in its simulation) is named the same way.
        const outsider = await funded(connection)
        const refused = await prepare(market, outsider, 'buy', 10_000_000)
        assert.deepEqual([refused.status, refused.body.error], [400, contributorsOnly(market.earlyAccessEnd.getTime())])
        assert.match(refused.body.error, /until \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/)
        const direct = await dbc.pool.swap2WithTransferHook({ owner: outsider.publicKey, payer: outsider.publicKey, pool: new PublicKey(market.pool),
          amountIn: new BN(10_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.ExactIn, referralTokenAccount: null })
        direct.feePayer = outsider.publicKey
        direct.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
        const simulated = await connection.simulateTransaction(direct)
        assert.ok(simulated.value.err, 'the hook refuses it')
        assert.equal(hookRefusal(simulated.value.logs), contributorsOnly())

        // The oracle adds that wallet during the window (owner decision: linked contributors are added while it is open); it buys,
        // creating its Token-2022 account, whose rent (the hook's account extension included) is in the costs it was shown.
        const funding = await connection.requestAirdrop(oracle.publicKey, 1_000_000_000)
        await connection.confirmTransaction({ signature: funding, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
        await sendAndConfirmTransaction(connection, new Transaction().add(addWalletsInstruction({ oracle: oracle.publicKey, mint, wallets: [outsider.publicKey] })),
          [oracle], { commitment: 'confirmed' })
        const added = await trade(market, outsider, 'buy', 10_000_000)
        const mintInfo = await connection.getAccountInfo(mint, 'confirmed')
        const tokenAccountRent = await connection.getMinimumBalanceForRentExemption(associatedAccountLength(unpackMint(mint, mintInfo, TOKEN_2022_PROGRAM_ID)))
        assert.ok(tokenAccountRent > await connection.getMinimumBalanceForRentExemption(165), 'larger than an SPL Token account')
        assert.equal(BigInt(added.costs.accountDeposits), BigInt(tokenAccountRent), JSON.stringify(added.costs))
        assert.ok(BigInt(added.result.tokenDelta) > 0n)

        // The first market's launcher is not listed but holds its first buy: it sells into the curve during the window.
        const launcherHeld = await held(firstMarket.mint, firstLauncher)
        const launcherSold = await trade(firstMarket, firstLauncher, 'sell', launcherHeld / 2n)
        assert.equal(BigInt(launcherSold.result.tokenDelta), -(launcherHeld / 2n))
        assert.ok(BigInt(launcherSold.result.solDelta) > 0n)

        // Step 5e: the same market as a Blink. The card leads with the window; a buy and a sell are built by the same trader and
        // checks, and the wallet signs and sends them itself; a sell is a share of the wallet's Token-2022 balance; a wallet off the
        // list is refused with the window's end.
        const actions = { loadMarket: forMint => loadActionMarket(pool, forMint), prepareBuy: request => prepareActionTrade('buy', request),
          prepareSell: request => prepareActionTrade('sell', request), tokenBalance: (owner, forMint, options) => walletTokenBalance(owner, forMint, connection, options) }
        const card = await handleBuyGet(market.mint, actions)
        assert.equal(card.status, 200)
        assert.match((await card.json()).description, /^Contributor early access until [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d UTC: only this repository's linked contributors can buy\./)
        const blink = async (handler, path, signer) => {
          const response = await handler(new Request(`https://repo.ing${path}`, { method: 'POST', body: JSON.stringify({ account: signer.publicKey.toBase58() }) }),
            market.mint, actions)
          return { status: response.status, body: await response.json() }
        }
        const sendBlink = async (answer, signer) => {
          assert.equal(answer.status, 200, JSON.stringify(answer.body))
          const tx = Transaction.from(Buffer.from(answer.body.transaction, 'base64'))
          assert.equal(tx.instructions.filter(ix => ix.programId.toBase58() === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN' &&
            ix.data.subarray(0, 8).equals(Buffer.from([183, 93, 153, 40, 24, 230, 194, 151]))).length, 1)
          tx.sign(signer)
          const signature = await connection.sendRawTransaction(tx.serialize())
          const confirmed = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash,
            lastValidBlockHeight: (await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight }, 'confirmed')
          assert.equal(confirmed.value.err, null)
        }
        const beforeBlink = await held(market.mint, contributor)
        await sendBlink(await blink(handleBuyPost, `/api/actions/buy/${market.mint}?amount=0.01`, contributor), contributor)
        const afterBuy = await held(market.mint, contributor)
        assert.ok(afterBuy > beforeBlink, 'the Blink buy landed')
        await sendBlink(await blink(handleSellPost, `/api/actions/sell/${market.mint}?percent=25`, contributor), contributor)
        assert.equal(await held(market.mint, contributor), afterBuy - afterBuy * 25n / 100n, 'a quarter of the Token-2022 balance sold')
        const stranger = await funded(connection)
        const blinkRefused = await blink(handleBuyPost, `/api/actions/buy/${market.mint}?amount=0.01`, stranger)
        assert.deepEqual([blinkRefused.status, blinkRefused.body.message], [400, contributorsOnly(market.earlyAccessEnd.getTime())])

        // The route recorded each curve trade's fees once its swap finalized; recording them again credits nothing.
        const signatures = [bought, sold, added].map(done => done.result.signature)
        const accrual = createFeeAccrual({ pool, connection, config: solConfig.toBase58(), earlyAccess: eaConfig })
        const again = await until(async () => { try { return await accrual.recordTradeFees({ githubRepoId: BigInt(repoId), signatures }) } catch (error) {
          if (/finalized/i.test(error.message)) return null; throw error } }, 240)
        assert.ok(again, 'finalized')
        const recorded = (await pool.query('select distinct signature from fee_events where signature = any($1)', [signatures])).rows.map(row => row.signature).sort()
        assert.deepEqual(recorded, [...signatures].sort())
        for (const done of [bought, sold, added]) assert.equal(done.result.feeIndexing === 'recorded' || done.result.feeIndexing === 'pending', true)

        // Without the setting the router and the Blink refuse the market by name, before any chain read.
        delete process.env.EARLY_ACCESS_DBC_CONFIG
        fresh()
        const off = await post({ action: 'quote', githubRepoId: repoId, direction: 'buy', amountBaseUnits: '10000000' })
        assert.deepEqual([off.status, off.body.error], [400, EARLY_ACCESS_NOT_TRADABLE])
        const offCard = await handleBuyGet(market.mint, actions)
        assert.deepEqual([offCard.status, (await offCard.json()).message], [404, EARLY_ACCESS_NOT_TRADABLE])
      } finally {
        for (const [name, value] of Object.entries(saved.env)) value === undefined ? delete process.env[name] : process.env[name] = value
        for (const name of GLOBALS) delete globalThis[name]
        Object.assign(globalThis, Object.fromEntries(Object.entries(saved.globals).filter(([, value]) => value !== undefined)))
      }
    })

    // Step 5f: the oracle's upkeep. While a window is open each list holds the linked wallets of the repository's contributors:
    // alice's wallet joins the first market's empty list at once, and the wallet the oracle added by hand above leaves the second's on the
    // next run (a removal waits for two runs in a row to agree). When alice links another wallet, the new one joins and the old one
    // leaves a run later. A key that is not the platform's oracle sends nothing.
    await t.test('the oracle keeps open windows\' lists equal to the contributors\' linked wallets', async () => {
      const funding = await connection.requestAirdrop(oracle.publicKey, 1_000_000_000)
      await connection.confirmTransaction({ signature: funding, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
      const upkeep = createEarlyAccessOracle({ pool, connection, oracle, log: () => {} })
      assert.deepEqual(await createEarlyAccessOracle({ pool, connection, oracle: Keypair.generate(), log: () => {} }).runOnce(), { status: 'ORACLE_MISMATCH' })
      const alice = contributor.publicKey.toBase58()
      assert.deepEqual(await allowList(firstMarket.mint), [])
      const second = await allowList(secondMarket.mint)
      assert.ok(second.length === 2 && second.includes(alice), 'the contributor launcher and the wallet the oracle added by hand')
      const counts = async () => Object.fromEntries((await upkeep.runOnce()).results.map(entry => {
        assert.equal(entry.error, undefined, JSON.stringify(entry))
        return [entry.mint === firstMarket.mint ? 'first' : 'second', [entry.added, entry.removed]]
      }))
      const lists = async () => [await allowList(firstMarket.mint), await allowList(secondMarket.mint)]
      assert.deepEqual(await counts(), { first: [1, 0], second: [0, 0] })
      assert.deepEqual(await counts(), { first: [0, 0], second: [0, 1] })
      assert.deepEqual(await lists(), [[alice], [alice]])
      assert.deepEqual(await counts(), { first: [0, 0], second: [0, 0] })
      // alice links another wallet: it joins both lists, and the old one leaves a run later.
      const relinked = Keypair.generate().publicKey.toBase58()
      await pool.query('update github_wallet_links set wallet = $1 where github_user_id = 501', [relinked])
      try {
        assert.deepEqual(await counts(), { first: [1, 0], second: [1, 0] })
        assert.deepEqual(await counts(), { first: [0, 1], second: [0, 1] })
        assert.deepEqual(await lists(), [[relinked], [relinked]])
      } finally {
        await pool.query('update github_wallet_links set wallet = $1 where github_user_id = 501', [alice])
        await upkeep.runOnce()
        await upkeep.runOnce()
      }
      assert.deepEqual(await lists(), [[alice], [alice]])
    })

    // Step 6a: once the worker's indexer has caught up with every trade (the Blink trades above are recorded by it alone), each early
    // access market's builder fee ledger equals its pool's creator fee and the discovery ledger its partner fee. Without the setting
    // the reconciler refuses them by name. (The graduation monitor watches them from step 7a on.)
    await t.test('their fee ledgers reconcile with their pools', async () => {
      const config = solConfig.toBase58(), markets = [firstMarket, secondMarket]
      const indexer = createExternalFeeIndexer({ pool, connection, config, earlyAccess: eaConfig })
      const reconciler = createReconciler({ pool, connection, config, earlyAccess: eaConfig })
      // The ledgers hold finalized trades only, and the reconciler reads the pool at finalized: wait until the pools' confirmed and
      // finalized fees agree (every trade above is final), then until the ledgers match.
      const finalized = new DynamicBondingCurveClient(connection, 'finalized')
      const fees = async (client, market) => (await client.state.getPool(new PublicKey(market.pool))).poolState
      const matched = await until(async () => {
        for (const market of markets) {
          const [now, final] = await Promise.all([fees(dbc, market), fees(finalized, market)])
          if (!now.creatorQuoteFee.eq(final.creatorQuoteFee) || !now.partnerQuoteFee.eq(final.partnerQuoteFee)) return null
        }
        await indexer.runOnce()
        const results = await Promise.all(markets.map(market => reconciler.reconcile(market.githubRepoId)))
        return results.every(result => result.status === 'MATCH') ? results : null
      }, 240)
      assert.ok(matched, 'both ledgers match their pools')
      for (const [index, market] of markets.entries()) {
        assert.ok(matched[index].recordedEarned > 0n, `${market.mint}: builder fees recorded`)
        assert.equal(matched[index].onchainCreatorFee, matched[index].recordedEarned, 'nothing claimed yet: all of it is still in the pool')
        const state = { poolState: await fees(finalized, market) }
        const { rows: [partner] } = await pool.query('select coalesce(sum(partner_amount), 0)::text as total from discovery_fee_events where pool = $1', [market.pool])
        assert.equal(BigInt(partner.total), BigInt(state.poolState.partnerQuoteFee.toString()), 'the partner fee equals the discovery ledger')
      }
      await assert.rejects(createReconciler({ pool, connection, config, earlyAccess: null }).reconcile(secondMarket.githubRepoId), /transfer-hook-aware path/)
    })

    // Step 6c: the builder claims an early access market's curve fees. The payout is claim_creator_trading_fee2 with a one-time WSOL
    // account, checked before it is signed; the bound wallet receives the whole ledger; the pool's creator fee falls to zero and the
    // ledgers still reconcile; nothing is left to claim. Without the setting the claim is refused by name.
    await t.test('the builder claims its curve fees with claim_creator_trading_fee2', async () => {
      const config = solConfig.toBase58(), market = secondMarket, repoId = String(market.githubRepoId)
      const builder = Keypair.generate(), creatorKey = Keypair.fromSecretKey(creatorSecret)
      await pool.query('insert into repo_beneficiaries (github_repo_id, github_user_id, wallet) values ($1, 91, $2)', [repoId, builder.publicKey.toBase58()])
      const githubVerifier = { verifyCurrentAuthority: async ({ githubRepoId }) => ({ verified: true, permission: 'admin', githubRepoId, githubUserId: 91n, verifiedAt: new Date() }) }
      const request = { githubRepoId: repoId, githubAuthorization: {} }
      await assert.rejects(createClaim({ pool, connection, config, creator: creatorKey, githubVerifier, earlyAccess: null }).claim(request), { message: EARLY_ACCESS_NOT_CLAIMABLE })
      const reconciler = createReconciler({ pool, connection, config, earlyAccess: eaConfig })
      const before = await reconciler.reconcile(repoId)
      assert.equal(before.status, 'MATCH')
      const claimant = createClaim({ pool, connection, config, creator: creatorKey, githubVerifier, earlyAccess: eaConfig })
      const paid = await claimant.claim(request)
      assert.equal(paid.status, 'settled')
      assert.equal(paid.amountBaseUnits, before.recordedEarned, 'the whole builder ledger')
      assert.ok(paid.receiverDeltaLamports >= paid.amountBaseUnits, 'the bound wallet received it')
      assert.equal(await connection.getBalance(builder.publicKey, 'finalized'), Number(paid.receiverDeltaLamports))
      const landed = await connection.getTransaction(paid.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      const claims = landed.transaction.message.instructions.filter(ix => landed.transaction.message.accountKeys[ix.programIdIndex].toBase58() ===
        'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
      assert.equal(claims.length, 1)
      assert.ok(Buffer.from(bs58.decode(claims[0].data)).subarray(0, 8).equals(CLAIM_CREATOR_TRADING_FEE2_DISCRIMINATOR))
      console.log(JSON.stringify({ earlyAccessClaim: { bytes: landed.transaction.message.serialize().length + 64 * landed.transaction.signatures.length,
        computeUnits: landed.meta.computeUnitsConsumed } }))
      const { rows: [row] } = await pool.query("select status, amount_base_units::text as amount from repo_claims where github_repo_id = $1", [repoId])
      assert.deepEqual(row, { status: 'settled', amount: String(paid.amountBaseUnits) })
      const pool_ = await new DynamicBondingCurveClient(connection, 'finalized').state.getPool(new PublicKey(market.pool))
      assert.equal(pool_.poolState.creatorQuoteFee.toString(), '0')
      const after = await reconciler.reconcile(repoId)
      assert.deepEqual([after.status, after.recordedClaimed, after.expectedRemaining], ['MATCH', paid.amountBaseUnits, 0n])
      await assert.rejects(claimant.claim(request), /No accrued creator fees remain to claim/, 'nothing left to claim')
    })

    // Step 6d: the fee status the token page, the claim page, the builder dashboard and the reminders read takes an early access
    // market where the setting is set, so its earnings and claim show; without it the market reads as unavailable, as before.
    await t.test('the token page\'s fee status and the claim preview read it only with the setting', async () => {
      const ENV = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'BUNDLE_DBC_CONFIG', 'EARLY_ACCESS_DBC_CONFIG']
      const saved = { env: Object.fromEntries(ENV.map(name => [name, process.env[name]])), pool: globalThis.__gitfunPool }
      try {
        for (const name of ENV) delete process.env[name]
        Object.assign(process.env, { DATABASE_URL: URL_, SOLANA_RPC_URL: RPC, DBC_CONFIG: solConfig.toBase58(), EARLY_ACCESS_DBC_CONFIG: eaConfig })
        globalThis.__gitfunPool = pool
        const repoId = String(firstMarket.githubRepoId)
        const fees = await feeStatus(repoId)
        assert.equal(fees.status, 'MATCH')
        assert.ok(fees.onchainCreatorFee > 0n, 'the first market\'s builder fees are unclaimed')
        const preview = await claimPreviewRoute(new Request(`https://repo.ing/api/claim/${repoId}/preview`), { params: Promise.resolve({ repo: repoId }) })
        assert.deepEqual(await preview.json(), { available: String(fees.onchainCreatorFee) })
        delete process.env.EARLY_ACCESS_DBC_CONFIG
        assert.deepEqual(await feeStatus(repoId), { status: 'UNAVAILABLE', onchainCreatorFee: null })
      } finally {
        for (const [name, value] of Object.entries(saved.env)) value === undefined ? delete process.env[name] : process.env[name] = value
        globalThis.__gitfunPool = saved.pool
      }
    })

    // Step 6e: the launcher of an early access market claims its discovery reward. The payout is claim_trading_fee2 from the hook
    // pool to a one-time authority, checked before signing; the launcher receives exactly the reward and the partner spends only
    // the network fee (both temporary accounts are closed back to it). Without the setting the market is not enrolled.
    await t.test('its launcher claims the discovery reward with claim_trading_fee2', async () => {
      const config = solConfig.toBase58(), repoId = String(secondMarket.githubRepoId), wallet = contributor.publicKey.toBase58()
      const signMessage = (keypair, message) => bs58.encode(signBytes(null, Buffer.from(message, 'utf8'), { format: 'der', type: 'pkcs8',
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(keypair.secretKey.subarray(0, 32))]) }))
      await assert.rejects(createDiscoveryClaims({ pool, connection, config, partner, minClaimLamports: 1n }).prepare({ repoId, wallet }), /not enrolled/)
      // A larger buy, so the reward (half the eligible partner fees) passes the claim minimum and is worth its payout's network fee.
      const buy = await dbc.pool.swap2WithTransferHook({ owner: contributor.publicKey, payer: contributor.publicKey, pool: new PublicKey(secondMarket.pool),
        amountIn: new BN(3_000_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.ExactIn, referralTokenAccount: null })
      await sendAndConfirmTransaction(connection, buy, [contributor], { commitment: 'confirmed' })
      const indexer = createExternalFeeIndexer({ pool, connection, config, earlyAccess: eaConfig })
      assert.ok(await until(async () => { await indexer.runOnce()
        return BigInt((await discoverySummary(pool, repoId, { includeEarlyAccess: true })).remaining) > 3_000_000n }, 240), 'the reward accrued')
      const claims = createDiscoveryClaims({ pool, connection, config, partner, earlyAccess: eaConfig })
      const offer = await claims.prepare({ repoId, wallet })
      assert.equal(offer.status, 'prepared')
      assert.ok(BigInt(offer.amount) > 0n, 'a reward accrued from the trades above')
      const submitted = await claims.submit({ repoId, id: offer.id, signature: signMessage(contributor, offer.message) })
      assert.equal(submitted.status, 'pending')
      // A payout already signed settles from its own receipt even where the setting is gone (the worker without it).
      const unset = createDiscoveryClaims({ pool, connection, config, partner })
      const settled = await until(async () => { const result = await unset.recover(repoId); return result?.status === 'settled' ? result : null }, 240)
      assert.ok(settled, 'settled once final')
      const landed = await connection.getTransaction(submitted.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      const keys = landed.transaction.message.accountKeys, delta = key => BigInt(landed.meta.postBalances[keys.findIndex(k => k.equals(key))]) -
        BigInt(landed.meta.preBalances[keys.findIndex(k => k.equals(key))])
      assert.equal(delta(contributor.publicKey), BigInt(offer.amount), 'the launcher receives exactly the reward')
      assert.equal(delta(partner.publicKey), -BigInt(landed.meta.fee), 'the partner spends only the network fee')
      const dbcClaims = landed.transaction.message.instructions.filter(ix => keys[ix.programIdIndex].toBase58() === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
      assert.equal(dbcClaims.length, 1)
      assert.equal(Buffer.from(bs58.decode(dbcClaims[0].data)).subarray(0, 8).toString('hex'), '54bf473209a237c1', 'claim_trading_fee2')
      console.log(JSON.stringify({ earlyAccessDiscoveryClaim: { bytes: landed.transaction.message.serialize().length + 64 * landed.transaction.signatures.length,
        computeUnits: landed.meta.computeUnitsConsumed } }))
    })

    // Step 6f: the platform collects the rest of the market's partner fees (all but the launcher's discovery reward) with
    // claim_trading_fee2, behind PLATFORM_DBC_COLLECTION_ENABLED and an exact review: the treasury receives exactly that amount,
    // the temporary accounts open and close inside the transaction, and nothing is left to collect. Without the setting the market
    // is not listed.
    await t.test('the platform collects its share of the partner fees with claim_trading_fee2', async () => {
      const config = solConfig.toBase58(), repoId = String(secondMarket.githubRepoId), treasury = Keypair.generate().publicKey
      const env = { PLATFORM_DBC_COLLECTION_ENABLED: 'true', PLATFORM_FEE_TREASURY_WALLET: treasury.toBase58() }
      await assert.rejects(createDbcPlatformFees({ pool, connection, config, partner, env }).status(repoId), /not finalized and indexed/)
      const fees = createDbcPlatformFees({ pool, connection, config, partner, env, earlyAccess: eaConfig })
      const status = await fees.status(repoId)
      assert.equal(status.hook, true)
      assert.equal(status.receiver, treasury.toBase58())
      assert.ok(BigInt(status.available) > 0n, JSON.stringify(status))
      const review = { purpose: 'platform-fee-review', phase: 'DBC', repoId, receiver: status.receiver, amount: status.available,
        termsHash: status.termsHash, maxNetworkFeeLamports: String(DBC_MAX_NETWORK_FEE_LAMPORTS), expiresAt: Date.now() + 120_000 }
      const receipt = await fees.claim({ review })
      assert.deepEqual([receipt.status, receipt.amount], ['settled', status.available])
      assert.equal(await connection.getBalance(treasury, 'finalized'), Number(status.available), 'the treasury received exactly the collected fees')
      const landed = await connection.getTransaction(receipt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      const keys = landed.transaction.message.accountKeys
      const dbcClaims = landed.transaction.message.instructions.filter(ix => keys[ix.programIdIndex].toBase58() === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
      assert.equal(Buffer.from(bs58.decode(dbcClaims[0].data)).subarray(0, 8).toString('hex'), '54bf473209a237c1', 'claim_trading_fee2')
      console.log(JSON.stringify({ earlyAccessPlatformClaim: { bytes: landed.transaction.message.serialize().length + 64 * landed.transaction.signatures.length,
        computeUnits: landed.meta.computeUnitsConsumed } }))
      assert.equal((await fees.status(repoId)).available, '0', 'nothing left to collect')
    })

    // Step 7a: the curve fills and migrates (Meteora's keeper does this on mainnet; on this validator the pool authority needs SOL for
    // the migration's accounts). The graduation monitor then verifies the graduated market from its migration proof and its DAMM v2
    // pool, whose token A is the Token-2022 market token; liquidity deployment is refused for it; a DAMM v2 trade's builder fee is
    // indexed, so the builder ledger matches again. Paths that do not handle the graduated phase yet (claims) still refuse it.
    await t.test('the curve graduates: the monitor verifies it and its DAMM v2 fees are indexed', async () => {
      const config = solConfig.toBase58(), market = secondMarket, repoId = String(market.githubRepoId)
      const poolKey = new PublicKey(market.pool), mint = new PublicKey(market.mint)
      const funding = await connection.requestAirdrop(contributor.publicKey, 120_000_000_000)
      await connection.confirmTransaction({ signature: funding, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
      const fill = await dbc.pool.swap2WithTransferHook({ owner: contributor.publicKey, payer: contributor.publicKey, pool: poolKey,
        amountIn: new BN(110_000_000_000), minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null })
      await sendAndConfirmTransaction(connection, fill, [contributor], { commitment: 'confirmed' })
      assert.equal(getTransferHook(await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID)).programId.toBase58(), PublicKey.default.toBase58(),
        'the filling swap revoked the hook')
      await sendAndConfirmTransaction(connection, new Transaction().add(SystemProgram.transfer({ fromPubkey: contributor.publicKey,
        toPubkey: deriveDbcPoolAuthority(), lamports: 1_000_000_000 })), [contributor], { commitment: 'confirmed' })
      const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[(await dbc.state.getPoolConfig(new PublicKey(eaConfig))).migrationFeeOption]
      const migration = await dbc.migration.migrateToDammV2({ pool: poolKey, dammConfig, payer: contributor.publicKey })
      await sendAndConfirmTransaction(connection, migration.transaction, [contributor, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair],
        { commitment: 'confirmed' })
      const dammPool = deriveDammV2PoolAddress(dammConfig, mint, NATIVE_MINT), amm = new CpAmm(connection)
      const poolState = await amm.fetchPoolState(dammPool)
      assert.deepEqual([poolState.tokenAFlag, poolState.tokenBFlag], [1, 0], 'Token-2022 market token, SPL wrapped SOL')

      // The state the monitor reads: without the setting the market is refused; with it, graduated, from its migration proof.
      const verification = local()
      const marketRow = { githubRepoId: repoId, mint: market.mint, pool: market.pool, creatorWallet: market.creatorWallet, fullName: REPOS.second.full_name,
        earlyAccessEnd: market.earlyAccessEnd, transferHookProgram: market.transferHookProgram }
      await assert.rejects(readGraduationState({ connection, verification, config, market: marketRow, env: {} }), /transfer-hook-aware path/)
      const state = await until(async () => { try { const read = await readGraduationState({ connection, verification, config, market: marketRow, env: {},
        earlyAccess: eaConfig }); return read.phase === 'GRADUATED' ? read : null } catch (error) { if (/STALE|finalized|MIGRATION|DISAGREEMENT/i.test(error.message)) return null; throw error } }, 240)
      assert.ok(state, 'graduated, from finalized evidence')
      assert.deepEqual([state.migration.pool, state.migration.mint, state.migration.curve], [dammPool.toBase58(), market.mint, market.pool])

      // The monitor's pass: the market verified as graduated, its proof recorded, never eligible for liquidity deployment.
      const monitor = createGraduationMonitor({ pool, connection, verification, config, earlyAccess: eaConfig, pauseMs: 0, env: {} })
      const entry = (await monitor.runOnce()).find(result => result.repoId === repoId)
      assert.deepEqual([entry?.status, entry?.phase], ['VERIFIED', 'GRADUATED'], JSON.stringify(entry))
      const { rows: [event] } = await pool.query('select pool from graduation_events where github_repo_id = $1', [repoId])
      assert.equal(event.pool, dammPool.toBase58())
      const observation = JSON.parse((await pool.query('select observation from graduation_observations where github_repo_id = $1', [repoId])).rows[0].observation)
      // Nothing for the platform to claim yet: the DAMM v2 pool has had no trade (its claim is offered from step 7d on, below).
      assert.deepEqual([observation.p3.eligible, observation.p3.reason, observation.platformClaimAvailable],
        [false, 'Early access markets are not eligible for liquidity deployment', false])

      // A DAMM v2 trade on the graduated pool (Token-2022 token A, no hook any more); the indexer records the builder's position fee and
      // the ledger matches the chain, curve and DAMM v2 together.
      const tokens = { tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
        tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID }
      await sendAndConfirmTransaction(connection, await amm.swap2({ payer: contributor.publicKey, pool: dammPool, poolState, swapMode: AmmSwapMode.ExactIn,
        inputTokenMint: NATIVE_MINT, outputTokenMint: mint, ...tokens, referralTokenAccount: null, amountIn: new BN(2_000_000_000), minimumAmountOut: new BN(1) }),
      [contributor], { commitment: 'confirmed' })
      const indexer = createExternalFeeIndexer({ pool, connection, config, earlyAccess: eaConfig })
      const reconciler = createReconciler({ pool, connection, config, earlyAccess: eaConfig, earlyAccessGraduated: true })
      // The ledgers hold finalized evidence only: wait until the trade's position fee is recorded, then for the match.
      const dammFees = async () => BigInt((await pool.query('select coalesce(sum(amount_base_units), 0)::text as total from damm_fee_events where github_repo_id = $1',
        [repoId])).rows[0].total)
      const matched = await until(async () => {
        await indexer.runOnce()
        if (await dammFees() === 0n) return null
        const result = await reconciler.reconcile(repoId)
        return result.status === 'MATCH' && result.graduated ? result : null
      }, 240)
      assert.ok(matched, 'the DAMM v2 position fee is in the builder ledger, which matches the curve and DAMM v2 fees')
      // A reconciler that does not handle the graduated phase still refuses it by name.
      await assert.rejects(createReconciler({ pool, connection, config, earlyAccess: eaConfig }).reconcile(repoId), /EARLY_ACCESS_GRADUATION_PENDING/)
    })

    // Step 7b: the graduated pool trades through the site and its Blinks. The router sends the market to the DAMM v2 trader, which builds
    // swap2 with token A on Token-2022 and no hook accounts (the filling swap revoked the hook), checks it before the wallet signs and
    // verifies the receipt after it lands. Inside the window too, anyone can buy now, and the window's note is gone. A referral is paid
    // in SOL as on any graduated market. Without EARLY_ACCESS_DBC_CONFIG the market is refused by name.
    await t.test('the graduated pool trades through the site and its Blinks: anyone buys and sells, a referral is paid in SOL', async () => {
      const ENV = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'BUNDLE_DBC_CONFIG', 'EARLY_ACCESS_DBC_CONFIG']
      const GLOBALS = ['__gitfunPool', '__gitfunTrader', '__gitfunTraderConfig', '__gitfunTradeSessions', '__gitfunTradeSessionsRouter']
      const saved = { env: Object.fromEntries(ENV.map(name => [name, process.env[name]])), globals: Object.fromEntries(GLOBALS.map(name => [name, globalThis[name]])) }
      const fresh = () => { for (const name of GLOBALS) delete globalThis[name]; globalThis.__gitfunPool = pool }
      try {
        for (const name of ENV) delete process.env[name]
        Object.assign(process.env, { DATABASE_URL: URL_, SOLANA_RPC_URL: RPC, DBC_CONFIG: solConfig.toBase58(), EARLY_ACCESS_DBC_CONFIG: eaConfig })
        fresh()
        const market = secondMarket, mint = new PublicKey(market.mint), repoId = String(market.githubRepoId)
        assert.ok(market.earlyAccessEnd.getTime() > Date.now() + 60_000, 'still inside the window')
        const post = async body => {
          const response = await tradeRoute(new Request('https://repo.ing/api/trade', { method: 'POST', body: JSON.stringify(body) }))
          return { status: response.status, body: await response.json() }
        }
        const held = async wallet => BigInt((await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(mint, wallet.publicKey, false,
          TOKEN_2022_PROGRAM_ID), 'confirmed')).value.amount)
        // The one DAMM v2 swap2: token A on Token-2022, token B (wrapped SOL) on SPL Token, and no account of the hook anywhere.
        const graduatedSwap = tx => {
          const swaps = tx.instructions.filter(ix => ix.programId.equals(CP_AMM_PROGRAM_ID))
          assert.equal(swaps.length, 1)
          assert.equal(swaps[0].data.subarray(0, 8).toString('hex'), '414b3f4ceb5b5b88', 'swap2')
          assert.deepEqual([swaps[0].keys[6].pubkey, swaps[0].keys[9].pubkey, swaps[0].keys[10].pubkey].map(String),
            [market.mint, TOKEN_2022_PROGRAM_ID.toBase58(), TOKEN_PROGRAM_ID.toBase58()])
          assert.ok(tx.instructions.every(ix => !ix.programId.equals(HOOK) && ix.keys.every(key => !key.pubkey.equals(HOOK))), 'no hook account')
          assert.ok(!tx.instructions.some(ix => ix.programId.toBase58() === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'), 'not the curve')
        }
        const trade = async (wallet, direction, amount, referrer = null) => {
          const prepared = await post({ action: 'prepare', githubRepoId: repoId, wallet: wallet.publicKey.toBase58(), direction, amountBaseUnits: String(amount),
            ...referrer ? { referrer } : {} })
          assert.equal(prepared.status, 200, JSON.stringify(prepared.body))
          const tx = Transaction.from(Buffer.from(prepared.body.transaction, 'base64'))
          graduatedSwap(tx)
          const before = await held(wallet).catch(() => 0n)
          tx.sign(wallet)
          const submitted = await post({ action: 'submit', id: prepared.body.id, transaction: tx.serialize().toString('base64') })
          assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
          assert.equal(submitted.body.state, 'confirmed', JSON.stringify(submitted.body))
          assert.equal(BigInt(submitted.body.tokenDelta), await held(wallet) - before, 'the verified delta is the wallet\'s Token-2022 account')
          return { costs: prepared.body.costs, result: submitted.body, tx }
        }

        // The token as the filling swap left it: hook program and hook authority revoked, no mint or freeze authority, only DBC's
        // extensions (the trader checks this before its first quote). The first market's token, whose curve has not filled, is refused.
        assertRevokedHookMint(await connection.getAccountInfo(mint, 'confirmed'), mint)
        const live = await connection.getAccountInfo(new PublicKey(firstMarket.mint), 'confirmed')
        assert.throws(() => assertRevokedHookMint(live, new PublicKey(firstMarket.mint)), /not tradable/)
        const quote = await post({ action: 'quote', githubRepoId: repoId, direction: 'buy', amountBaseUnits: '10000000' })
        assert.equal(quote.status, 200, JSON.stringify(quote.body))
        assert.equal(quote.body.venue, 'damm')
        assert.ok(BigInt(quote.body.outputAmount) > 0n)

        // A wallet that was never on the list buys inside the window, creating its Token-2022 account (its rent, the hook's account
        // extension included, is in the costs it was shown). The referrer's wrapped SOL account receives the referral share.
        const stranger = await funded(connection), referrer = await funded(connection)
        const referral = getAssociatedTokenAddressSync(NATIVE_MINT, referrer.publicKey)
        await sendAndConfirmTransaction(connection, new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(referrer.publicKey, referral,
          referrer.publicKey, NATIVE_MINT)), [referrer], { commitment: 'confirmed' })
        const referralBefore = BigInt((await connection.getTokenAccountBalance(referral, 'confirmed')).value.amount)
        const bought = await trade(stranger, 'buy', 100_000_000, referrer.publicKey.toBase58())
        assert.ok(BigInt(bought.result.tokenDelta) > 0n && BigInt(bought.result.solDelta) < -100_000_000n, JSON.stringify(bought.result))
        const tokenAccountRent = await connection.getMinimumBalanceForRentExemption(associatedAccountLength(unpackMint(mint,
          await connection.getAccountInfo(mint, 'confirmed'), TOKEN_2022_PROGRAM_ID)))
        assert.equal(BigInt(bought.costs.accountDeposits), BigInt(tokenAccountRent), JSON.stringify(bought.costs))
        assert.ok(bought.tx.instructions.find(ix => ix.programId.equals(CP_AMM_PROGRAM_ID)).keys[11].pubkey.equals(referral), 'the referral slot')
        const referralPaid = BigInt((await connection.getTokenAccountBalance(referral, 'confirmed')).value.amount) - referralBefore
        assert.ok(referralPaid > 0n, 'the referrer was paid in SOL')
        if (bought.result.referralFee !== undefined) assert.equal(BigInt(bought.result.referralFee), referralPaid)

        // It sells half of what it bought, from its Token-2022 account.
        const half = BigInt(bought.result.tokenDelta) / 2n
        const sold = await trade(stranger, 'sell', half)
        assert.equal(BigInt(sold.result.tokenDelta), -half)
        assert.ok(BigInt(sold.result.solDelta) > 0n)

        // The Blink: the card no longer leads with the window (the monitor recorded the graduation above); a buy and a sell are built by
        // the same graduated trader and checks, and a sell is a share of the wallet's Token-2022 balance.
        const actions = { loadMarket: forMint => loadActionMarket(pool, forMint), prepareBuy: request => prepareActionTrade('buy', request),
          prepareSell: request => prepareActionTrade('sell', request), tokenBalance: (owner, forMint, options) => walletTokenBalance(owner, forMint, connection, options) }
        const card = await handleBuyGet(market.mint, actions)
        assert.equal(card.status, 200)
        assert.doesNotMatch((await card.json()).description, /Contributor early access/)
        const blink = async (handler, path, signer) => {
          const response = await handler(new Request(`https://repo.ing${path}`, { method: 'POST', body: JSON.stringify({ account: signer.publicKey.toBase58() }) }),
            market.mint, actions)
          const answer = { status: response.status, body: await response.json() }
          assert.equal(answer.status, 200, JSON.stringify(answer.body))
          const tx = Transaction.from(Buffer.from(answer.body.transaction, 'base64'))
          graduatedSwap(tx)
          tx.sign(signer)
          const signature = await connection.sendRawTransaction(tx.serialize())
          const confirmed = await connection.confirmTransaction({ signature, blockhash: tx.recentBlockhash,
            lastValidBlockHeight: (await connection.getLatestBlockhash('confirmed')).lastValidBlockHeight }, 'confirmed')
          assert.equal(confirmed.value.err, null)
        }
        const other = await funded(connection)
        await blink(handleBuyPost, `/api/actions/buy/${market.mint}?amount=0.01`, other)
        const afterBuy = await held(other)
        assert.ok(afterBuy > 0n, 'the Blink buy landed')
        await blink(handleSellPost, `/api/actions/sell/${market.mint}?percent=25`, other)
        assert.equal(await held(other), afterBuy - afterBuy * 25n / 100n, 'a quarter of the Token-2022 balance sold')

        // Without the setting the router and the Blink refuse the market by name.
        delete process.env.EARLY_ACCESS_DBC_CONFIG
        fresh()
        const off = await post({ action: 'quote', githubRepoId: repoId, direction: 'buy', amountBaseUnits: '10000000' })
        assert.deepEqual([off.status, off.body.error], [400, EARLY_ACCESS_NOT_TRADABLE])
        const offCard = await handleBuyGet(market.mint, actions)
        assert.deepEqual([offCard.status, (await offCard.json()).message], [404, EARLY_ACCESS_NOT_TRADABLE])
      } finally {
        for (const [name, value] of Object.entries(saved.env)) value === undefined ? delete process.env[name] : process.env[name] = value
        for (const name of GLOBALS) delete globalThis[name]
        Object.assign(globalThis, Object.fromEntries(Object.entries(saved.globals).filter(([, value]) => value !== undefined)))
      }
    })

    // Step 7c: the builder claims after the graduation. The curve's creator fee left from before the migration and the DAMM v2
    // position's fees need more than one transaction's bytes together, so the first claim pays the curve part
    // (claim_creator_trading_fee2) and the next the DAMM v2 part (claim_position_fee, token A on Token-2022), each checked exactly
    // before it is signed. The token page and the claim preview read both; the ledgers match after each claim.
    await t.test('the builder claims after the graduation: the curve part first, then the DAMM v2 part', async () => {
      const config = solConfig.toBase58(), market = secondMarket, repoId = String(market.githubRepoId)
      const creatorKey = Keypair.fromSecretKey(creatorSecret)
      const githubVerifier = { verifyCurrentAuthority: async ({ githubRepoId }) => ({ verified: true, permission: 'admin', githubRepoId, githubUserId: 91n, verifiedAt: new Date() }) }
      const request = { githubRepoId: repoId, githubAuthorization: {} }
      const indexer = createExternalFeeIndexer({ pool, connection, config, earlyAccess: eaConfig })
      const reconciler = createReconciler({ pool, connection, config, earlyAccess: eaConfig, earlyAccessGraduated: true })
      const matched = () => until(async () => { await indexer.runOnce(); const result = await reconciler.reconcile(repoId)
        return result.status === 'MATCH' ? result : null }, 240)
      // Every earlier trade (the Blink's last sell above) final first: the ledgers and the claims read finalized state.
      const confirmedSlot = await connection.getSlot('confirmed')
      assert.ok(await until(async () => await connection.getSlot('finalized') >= confirmedSlot, 240), 'earlier trades finalized')
      const before = await matched()
      assert.ok(before?.graduated, 'the ledgers match the curve and the DAMM v2 pool')
      const curveFee = BigInt((await new DynamicBondingCurveClient(connection, 'finalized').state.getPool(new PublicKey(market.pool))).poolState.creatorQuoteFee.toString())
      const dammFee = before.onchainCreatorFee - curveFee
      assert.ok(curveFee > 0n && dammFee > 0n, JSON.stringify({ curveFee: String(curveFee), dammFee: String(dammFee) }))

      // The fee status reads both parts; the claim preview offers what the next claim pays: the curve part.
      const ENV = ['DATABASE_URL', 'SOLANA_RPC_URL', 'DBC_CONFIG', 'DBC_LEGACY_CONFIGS', 'BUNDLE_DBC_CONFIG', 'EARLY_ACCESS_DBC_CONFIG']
      const saved = { env: Object.fromEntries(ENV.map(name => [name, process.env[name]])), pool: globalThis.__gitfunPool }
      try {
        for (const name of ENV) delete process.env[name]
        Object.assign(process.env, { DATABASE_URL: URL_, SOLANA_RPC_URL: RPC, DBC_CONFIG: config, EARLY_ACCESS_DBC_CONFIG: eaConfig })
        globalThis.__gitfunPool = pool
        const fees = await feeStatus(repoId)
        assert.deepEqual([fees.status, fees.graduated, fees.onchainCreatorFee, fees.earlyAccess, fees.graduatedCreatorFee],
          ['MATCH', true, curveFee + dammFee, true, dammFee])
        const preview = await claimPreviewRoute(new Request(`https://repo.ing/api/claim/${repoId}/preview`), { params: Promise.resolve({ repo: repoId }) })
        assert.deepEqual(await preview.json(), { available: String(curveFee) })
      } finally {
        for (const [name, value] of Object.entries(saved.env)) value === undefined ? delete process.env[name] : process.env[name] = value
        globalThis.__gitfunPool = saved.pool
      }

      const claimant = createClaim({ pool, connection, config, creator: creatorKey, githubVerifier, earlyAccess: eaConfig })
      const landed = async signature => {
        const tx = await connection.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
        const keys = tx.transaction.message.accountKeys
        return { bytes: tx.transaction.message.serialize().length + 64 * tx.transaction.signatures.length, computeUnits: tx.meta.computeUnitsConsumed,
          calls: tx.transaction.message.instructions.map(ix => ({ program: keys[ix.programIdIndex].toBase58(), data: Buffer.from(bs58.decode(ix.data)),
            accounts: ix.accounts.map(index => keys[index].toBase58()) })) }
      }
      // Each claim carries the review the claim page seals for it (src/claim-review.mjs): the amount the next claim pays.
      const { rows: [binding] } = await pool.query('select wallet, bound_at from repo_beneficiaries where github_repo_id = $1', [repoId])
      const reviewFor = (amount, paid) => ({ repoId, wallet: binding.wallet, boundAt: new Date(binding.bound_at).toISOString(), amount: String(amount),
        includeGraduatedFees: true, paid: String(paid), expiresAt: Date.now() + 600_000 })
      // The curve part alone.
      const curveReview = reviewFor(curveFee, before.recordedClaimed)
      const first = await claimant.claim({ ...request, review: curveReview })
      assert.equal(first.status, 'settled')
      assert.deepEqual([first.amountBaseUnits, first.dammAmountBaseUnits], [curveFee, 0n])
      assert.ok(first.receiverDeltaLamports >= first.amountBaseUnits, 'the bound wallet received it')
      const curveClaim = await landed(first.signature)
      assert.deepEqual(curveClaim.calls.filter(call => call.program === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN').map(call => call.data.subarray(0, 8).toString('hex')),
        [CLAIM_CREATOR_TRADING_FEE2_DISCRIMINATOR.toString('hex')])
      assert.equal(curveClaim.calls.filter(call => call.program === CP_AMM_PROGRAM_ID.toBase58()).length, 0)
      const between = await matched()
      assert.deepEqual([between.expectedRemaining, between.onchainCreatorFee], [dammFee, dammFee], 'the DAMM v2 fees wait for the next claim')
      // The curve part's review cannot pay again (paid changed); a fresh review pays the DAMM v2 part: claim_position_fee, token A on
      // Token-2022.
      await assert.rejects(claimant.claim({ ...request, review: curveReview }), /already used/)
      const second = await claimant.claim({ ...request, review: reviewFor(dammFee, between.recordedClaimed) })
      assert.equal(second.status, 'settled')
      assert.deepEqual([second.amountBaseUnits, second.dammAmountBaseUnits], [dammFee, dammFee])
      assert.ok(second.receiverDeltaLamports >= second.amountBaseUnits, 'the bound wallet received it')
      const dammClaim = await landed(second.signature)
      const positionClaims = dammClaim.calls.filter(call => call.program === CP_AMM_PROGRAM_ID.toBase58())
      assert.equal(positionClaims.length, 1)
      assert.equal(positionClaims[0].data.toString('hex'), 'b4269a118521a2d3', 'claim_position_fee')
      assert.deepEqual([positionClaims[0].accounts[7], positionClaims[0].accounts[11]], [market.mint, TOKEN_2022_PROGRAM_ID.toBase58()])
      assert.equal(dammClaim.calls.filter(call => call.program === 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN').length, 0)
      console.log(JSON.stringify({ earlyAccessGraduatedClaims: { curve: { bytes: curveClaim.bytes, computeUnits: curveClaim.computeUnits },
        damm: { bytes: dammClaim.bytes, computeUnits: dammClaim.computeUnits } } }))
      const after = await matched()
      assert.deepEqual([after.expectedRemaining, after.onchainCreatorFee, after.recordedClaimed - before.recordedClaimed], [0n, 0n, curveFee + dammFee])
      await assert.rejects(claimant.claim(request), /No accrued creator fees remain to claim/, 'nothing left to claim')
    })

    // Step 7d: the platform collects its share of the graduated pool's fees (the partner position) with claim_position_fee, token A
    // on Token-2022, through a one-time WSOL account, checked exactly before signing. The ledger records exactly the claim event's
    // amount (the rent of the partner's new Token-2022 account for the token counts as paid, not lost), the platform ledger matches
    // the position again, and nothing is left. Without the setting the market is not enrolled.
    await t.test('the platform collects its share of the graduated pool\'s fees with claim_position_fee', async () => {
      const config = solConfig.toBase58(), repoId = String(secondMarket.githubRepoId)
      assert.deepEqual(await createPlatformFees({ pool, connection, config, partner }).status(repoId), { enrolled: false })
      const fees = createPlatformFees({ pool, connection, config, partner, earlyAccess: eaConfig })
      const indexer = createExternalFeeIndexer({ pool, connection, config, earlyAccess: eaConfig })
      // The platform ledger holds finalized evidence: wait until it equals the partner position's fee.
      const status = await until(async () => { await indexer.runOnce(); const read = await fees.status(repoId)
        return read.enrolled && BigInt(read.available) > 0n && read.available === read.onchainAvailable ? read : null }, 240)
      assert.ok(status, 'the platform ledger equals the partner position')
      const review = { purpose: 'platform-fee-review', phase: 'DAMM', repoId, receiver: partner.publicKey.toBase58(), amount: status.available,
        expiresAt: Date.now() + 120_000 }
      const receipt = await fees.claim({ review })
      assert.deepEqual([receipt.status, receipt.amount], ['settled', status.available])
      const landed = await connection.getTransaction(receipt.signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 })
      const keys = landed.transaction.message.accountKeys
      const { rows: [proof] } = await pool.query('select partner_position from graduated_migration_proofs where github_repo_id = $1', [repoId])
      const positionClaims = landed.transaction.message.instructions.filter(ix => keys[ix.programIdIndex].equals(CP_AMM_PROGRAM_ID))
      assert.equal(positionClaims.length, 1)
      assert.equal(Buffer.from(bs58.decode(positionClaims[0].data)).toString('hex'), 'b4269a118521a2d3', 'claim_position_fee')
      assert.deepEqual([2, 7, 11].map(i => keys[positionClaims[0].accounts[i]].toBase58()), [proof.partner_position, secondMarket.mint, TOKEN_2022_PROGRAM_ID.toBase58()])
      // The claim event's amount is what was recorded: the partner's balance change, its network fee and the rent of the account it opened.
      const amm = new CpAmm(connection), events = []
      for (const group of landed.meta.innerInstructions ?? []) for (const ix of group.instructions) {
        const bytes = Buffer.from(bs58.decode(ix.data))
        if (keys[ix.programIdIndex].equals(CP_AMM_PROGRAM_ID) && bytes.subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d') {
          const event = amm._program.coder.events.decode(bytes.subarray(8).toString('base64'))
          if (event?.name === 'evtClaimPositionFee') events.push(BigInt(event.data.feeBClaimed.toString()))
        }
      }
      const at = keys.findIndex(key => key.equals(partner.publicKey))
      const opened = keys.reduce((sum, _key, i) => i !== at && landed.meta.preBalances[i] === 0 && landed.meta.postBalances[i] > 0 ? sum + landed.meta.postBalances[i] : sum, 0)
      assert.ok(opened > 0, 'the partner\'s Token-2022 account for the token was opened by this first claim')
      assert.deepEqual(events, [BigInt(receipt.amount)])
      assert.equal(BigInt(landed.meta.postBalances[at] - landed.meta.preBalances[at] + landed.meta.fee + opened), BigInt(receipt.amount))
      console.log(JSON.stringify({ earlyAccessPlatformDammClaim: { bytes: landed.transaction.message.serialize().length + 64 * landed.transaction.signatures.length,
        computeUnits: landed.meta.computeUnitsConsumed } }))
      assert.equal((await fees.status(repoId)).available, '0', 'nothing left to collect')
      const reconciled = await until(async () => { const result = await createReconciler({ pool, connection, config, earlyAccess: eaConfig, earlyAccessGraduated: true })
        .reconcile(repoId); return result.status === 'MATCH' ? result : null }, 240)
      assert.ok(reconciled, 'the ledgers match')
      assert.equal(reconciled.platform.claimed, reconciled.platform.onchainClaimed, 'the platform ledger equals the position\'s claimed fees')
      await assert.rejects(fees.claim({ review: { ...review, expiresAt: Date.now() + 120_000 } }), /No platform fees remain to claim/)
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
