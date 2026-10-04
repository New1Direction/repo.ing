import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMint, createMintToInstruction,
  getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, MAX_SQRT_PRICE, MIN_SQRT_PRICE, SwapMode, derivePositionNftAccount, getBaseFeeParams, getCurrentPoint } from '@meteora-ag/cp-amm-sdk'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createMeteoraLauncher } from '../src/meteora-launch.mjs'
import { buildStockQuoteConfigTransaction } from '../src/stock-quote-config.mjs'
import { resolveQuoteAsset } from '../src/quote-assets.mjs'
import { loadFinalizedTransaction } from '../src/finalized-transaction.mjs'
import { POLICY_VERSION, splitCurveFee } from '../src/stock-fee-policy.mjs'
import { stockAccumulator } from '../src/stock-accumulator.mjs'
import { checkStockCollectionReceipt, createStockChainReader, createStockCollections, listStockMarkets } from '../src/stock-collections.mjs'
import { registerCanonicalPool, verifyCanonicalPool } from '../src/stock-canonical-pools.mjs'
import { previewStockSettlement, recordStockSettlementReceipt, verifyStockSettlementReceipt } from '../src/stock-settlement.mjs'
import { createFixedConfig } from './fixed-config.mjs'
import { dropTestDatabase } from './fixtures/drop-test-database.mjs'

// The accumulator's previews and receipt checks against real transactions on the programs mainnet runs
// (scripts/ci/start-stock-validator.sh: DBC, DAMM v2 and Token-2022 as deployed, Meteora's badges and the real METAx mint with
// a test mint authority). A DOCUSAURUS / METAx market accrues fees from a 10 METAx buy; the collection preview's exact
// instructions are then signed here with the test keys (on this validator only) and their finalized receipts checked; a test
// REPOING mint stands in for REPOING (the real mint is not on the validator), the owner seeds a REPOING/METAx DAMM v2 pool
// from the collected METAx, registers it, settles by the preview's instructions and records each receipt. Nothing here
// touches mainnet beyond the validator script's one read of those accounts.
const DB = 'repoing_stock_accumulator_chain_test'
const URL_ = `postgres://postgres:launchtest@127.0.0.1:55432/${DB}`
const RPC = process.env.STOCK_CHAIN_RPC ?? 'http://127.0.0.1:8919'
const META = resolveQuoteAsset('meta-xstock', { repoId: '94911145', ownerId: '69631', ownerType: 'Organization' }, { enabled: true })
const METAX = new PublicKey(META.mint)
const DOCS = '94911145'
const connections = []
const local = commitment => { const connection = new Connection(RPC, commitment); connections.push(connection); return connection }
const closeConnections = () => { for (const connection of connections) { try { connection._rpcWebSocket?.close() } catch {} } }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function healthy() {
  try { return (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })).json()).result === 'ok' } catch { return false }
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

test('stock collections and settlements verified from real transactions on mainnet\'s programs', { timeout: 900_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.STOCK_CHAIN_WORK_DIR, started = false
  const admin = new pg.Pool({ connectionString: URL_.replace(new RegExp(`${DB}$`), 'postgres') })
  let pool, created = false
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-stock-accumulator-'))
      started = true
      assert.equal(spawnSync('scripts/ci/start-stock-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 }).status, 0, 'stock-pair validator started')
    }
    assert.ok(work && existsSync(join(work, 'metax-authority.json')), 'the validator work dir with the METAx test authority')
    const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'metax-authority.json'), 'utf8'))))
    const connection = local('confirmed'), finalizedConnection = local('finalized')
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed'), amm = new CpAmm(connection)
    await admin.query(`drop database if exists ${DB} with (force)`)
    await admin.query(`create database ${DB}`); created = true
    pool = new pg.Pool({ connectionString: URL_, max: 4 })
    await migrate(drizzle(pool), { migrationsFolder: 'drizzle' })

    const funded = async (lamports = 5_000_000_000) => {
      const keypair = Keypair.generate()
      const signature = await connection.requestAirdrop(keypair.publicKey, lamports)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
      return keypair
    }
    const finalized = async signature => {
      for (let i = 0; i < 240; i++) {
        if ((await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]?.confirmationStatus === 'finalized') return signature
        await sleep(250)
      }
      throw Error(`${signature} did not finalize`)
    }
    const send = async (instructions, signers) => {
      const tx = new Transaction().add(...instructions)
      tx.feePayer = signers[0].publicKey
      return finalized(await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' }))
    }
    const toInstruction = described => new TransactionInstruction({ programId: new PublicKey(described.program), data: Buffer.from(described.data, 'base64'),
      keys: described.accounts.map(a => ({ pubkey: new PublicKey(a.address), isSigner: a.signer, isWritable: a.writable })) })
    const holdMetax = async (wallet, raw) => {
      const account = getAssociatedTokenAddressSync(METAX, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID)
      await send([createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, account, wallet.publicKey, METAX, TOKEN_2022_PROGRAM_ID),
        createMintToInstruction(METAX, account, authority.publicKey, raw, [], TOKEN_2022_PROGRAM_ID)], [wallet, authority])
      return account
    }

    // The SOL launch-fee config and the METAx config built from it, as scripts/create-stock-quote-config.mjs builds it.
    const { config: solConfig, partner } = await createFixedConfig(connection, 'launch-fee')
    const stockConfig = Keypair.generate()
    const built = await buildStockQuoteConfigTransaction({ connection, config: stockConfig.publicKey.toBase58(), asset: META, graduation: 14,
      partner: partner.publicKey.toBase58(), leftoverReceiver: partner.publicKey.toBase58() })
    built.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
    await sendAndConfirmTransaction(connection, built.tx, [partner, stockConfig], { commitment: 'confirmed' })
    const stockConfigs = new Map([['meta-xstock', stockConfig.publicKey]])

    // DOCUSAURUS / METAx launched by the launcher, recorded as the launch indexer leaves a finalized market.
    const creator = await funded(), launcherWallet = await funded()
    const prepared = await createMeteoraLauncher({ connection, config: stockConfig.publicKey, creator, quote: META })
      .prepare({ launcherWallet: launcherWallet.publicKey.toBase58(), tokenName: 'Docusaurus', tokenSymbol: 'DOCUSAURUS' })
    const launch = await prepared.sign(async tx => { tx.partialSign(launcherWallet); return tx })
    await connection.sendRawTransaction(launch.raw)
    await finalized(launch.signature)
    await pool.query(`insert into repositories(github_repo_id,owner,name,full_name,stars,forks,archived,github_updated_at)
      values (${DOCS},'facebook','docusaurus','facebook/docusaurus',60000,9000,false,now())`)
    await pool.query(`insert into markets(github_repo_id,status,mint,pool,launcher_wallet,creator_wallet,token_name,token_symbol,launch_signature,blockhash,
        last_valid_block_height,launch_slot,launch_finality,indexed_at,last_verified_at,quote_asset_id,quote_mint,quote_registry_version)
      values ($1,'confirmed',$2,$3,$4,$5,'Docusaurus','DOCUSAURUS',$6,$7,$8,1,'finalized',now(),now(),'meta-xstock',$9,1)`,
    [DOCS, prepared.mint, prepared.pool, launcherWallet.publicKey.toBase58(), creator.publicKey.toBase58(), launch.signature, prepared.blockhash,
      String(prepared.lastValidBlockHeight), META.mint])

    // A trader buys with 10 METAx; the curve's creator and partner fees accrue in METAx and the curve indexer records the swap.
    const trader = await funded()
    await holdMetax(trader, 1_000_000_000n)
    const swap = await dbc.pool.swap({ owner: trader.publicKey, pool: new PublicKey(prepared.pool), amountIn: new BN(1_000_000_000),
      minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null })
    swap.feePayer = trader.publicKey
    const swapSignature = await finalized(await sendAndConfirmTransaction(connection, swap, [trader], { commitment: 'confirmed' }))
    const curve = (await new DynamicBondingCurveClient(finalizedConnection, 'finalized').state.getPool(new PublicKey(prepared.pool))).poolState
    const creatorFee = BigInt(curve.creatorQuoteFee.toString()), partnerFee = BigInt(curve.partnerQuoteFee.toString())
    assert.ok(creatorFee > 0n && partnerFee > 0n)
    const split = splitCurveFee({ creatorAmount: creatorFee, partnerAmount: partnerFee })
    await pool.query(`insert into stock_fee_events(github_repo_id,asset_id,quote_mint,pool,signature,event_index,slot,creator_amount,partner_amount,
      launcher_amount,accumulator_amount,policy_version) values ($1,'meta-xstock',$2,$3,$4,0,1,$5,$6,$7,$8,$9)`, [DOCS, META.mint, prepared.pool,
      swapSignature, creatorFee, partnerFee, split.launcherAmount, split.accumulatorAmount, POLICY_VERSION])

    // The owner holds custody of the collected fees here, and is the canonical pool's owner (both protocol wallets on mainnet).
    const custody = await funded(), owners = [custody.publicKey.toBase58()]
    const reader = createStockChainReader({ connection: finalizedConnection, config: solConfig.toBase58(), legacyConfigs: '', stockConfigs,
      partner: partner.publicKey.toBase58() })
    const collections = createStockCollections({ pool, reader, custody: custody.publicKey.toBase58() })
    const [market] = await listStockMarkets(pool)
    let collected = 0n

    await t.test('the collection preview matches the pool, and its exact instructions settle with exact Token-2022 receipts', async () => {
      const preview = await collections.previewMarket(market)
      const by = Object.fromEntries(preview.sources.map(s => [s.source, s]))
      assert.equal(preview.status, 'COLLECTABLE')
      assert.deepEqual([by.dbc_creator.status, by.dbc_creator.amount, by.dbc_creator.launcherAmount], ['MATCH', String(creatorFee), String(split.launcherAmount)])
      assert.deepEqual([by.dbc_partner.status, by.dbc_partner.amount, by.dbc_partner.launcherAmount], ['MATCH', String(partnerFee), '0'])
      // Executed here with the test keys exactly as previewed; execution on mainnet comes later, behind an operator flag.
      const signed = { dbc_creator: await send(by.dbc_creator.instructions.map(toInstruction), [creator]),
        dbc_partner: await send(by.dbc_partner.instructions.map(toInstruction), [partner]) }
      for (const source of ['dbc_creator', 'dbc_partner']) {
        const transaction = await loadFinalizedTransaction(connection, signed[source])
        const receipt = checkStockCollectionReceipt({ transaction, terms: by[source].terms, signature: signed[source] })
        assert.deepEqual([receipt.amount, receipt.excess, receipt.receiverTokenAccount], [by[source].amount, '0', by[source].receiverTokenAccount])
        assert.throws(() => checkStockCollectionReceipt({ transaction, terms: { ...by[source].terms, amount: String(BigInt(by[source].amount) + 1n) } }), /differs from the reviewed amount/)
        // As execution will: the settled collection with its receipt.
        await pool.query(`insert into stock_fee_collections(github_repo_id,asset_id,quote_mint,source,reviewed_amount,actual_amount,launcher_amount,
          accumulator_amount,terms_hash,status,signature,receipt,settled_at) values ($1,'meta-xstock',$2,$3,$4,$5,$6,$7,$8,'settled',$9,$10,now())`,
        [DOCS, META.mint, source, by[source].amount, receipt.amount, by[source].launcherAmount, by[source].accumulatorAmount, by[source].termsHash,
          signed[source], JSON.stringify(receipt)])
        collected += BigInt(by[source].accumulatorAmount)
      }
      assert.throws(() => checkStockCollectionReceipt({ transaction: null, terms: by.dbc_creator.terms }), /not available yet/)
      const custodyAccount = await connection.getTokenAccountBalance(new PublicKey(by.dbc_creator.receiverTokenAccount))
      assert.equal(custodyAccount.value.amount, String(creatorFee + partnerFee), 'custody holds both claims')
      const after = await collections.previewMarket(market)
      assert.deepEqual(after.sources.map(s => [s.source, s.status]), [['dbc_creator', 'EMPTY'], ['dbc_partner', 'EMPTY']])
      const summary = await stockAccumulator(pool, 'meta-xstock', { onchain: new Map([[DOCS, { uncollected: after.uncollected }]]) })
      assert.equal(summary.status, 'MATCH', summary.problems.join('; '))
      assert.deepEqual([summary.totals.collected, summary.totals.available, summary.totals.inPools], [String(collected), String(collected), '0'])
    })

    // A test REPOING (SPL Token, 6 decimals); the owner seeds REPOING/METAx with half the collected METAx, all permanently locked.
    const repoing = await createMint(connection, custody, custody.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' })
    const ownerRepoing = getAssociatedTokenAddressSync(repoing, custody.publicKey)
    const repoingFunding = await send([createAssociatedTokenAccountIdempotentInstruction(custody.publicKey, ownerRepoing, custody.publicKey, repoing),
      createMintToInstruction(repoing, ownerRepoing, custody.publicKey, 10n ** 15n)], [custody])
    let canonical, seedSpent = 0n
    // A customizable REPOING/METAx pool, created and funded by `payer`, naming `creator` (who gets the position NFT). Locking
    // the position in the same transaction needs the creator's signature, so only an owner's own creation can lock it.
    const createPool = async ({ payer, creator, mint, stockSeed, repoingSeed, lock = true }) => {
      const prep = amm.preparePoolCreationParams({ tokenAAmount: new BN(String(repoingSeed)), tokenBAmount: new BN(String(stockSeed)),
        minSqrtPrice: MIN_SQRT_PRICE, maxSqrtPrice: MAX_SQRT_PRICE, collectFeeMode: 1 })
      const nft = Keypair.generate()
      const created = await amm.createCustomPool({ payer: payer.publicKey, creator, positionNft: nft.publicKey, tokenAMint: mint,
        tokenBMint: METAX, tokenAAmount: new BN(String(repoingSeed)), tokenBAmount: new BN(String(stockSeed)), sqrtMinPrice: MIN_SQRT_PRICE,
        sqrtMaxPrice: MAX_SQRT_PRICE, liquidityDelta: prep.liquidityDelta, initSqrtPrice: prep.initSqrtPrice,
        poolFees: { baseFee: getBaseFeeParams({ baseFeeMode: 0, feeTimeSchedulerParam: { startingFeeBps: 25, endingFeeBps: 25, numberOfPeriod: 0, totalDuration: 0 } }),
          compoundingFeeBps: 0, padding: 0, dynamicFee: null },
        hasAlphaVault: false, activationType: 0, collectFeeMode: 1, activationPoint: null, tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_2022_PROGRAM_ID, isLockLiquidity: lock })
      created.tx.feePayer = payer.publicKey
      const signature = await finalized(await sendAndConfirmTransaction(connection, created.tx, [payer, nft], { commitment: 'confirmed' }))
      return { ...created, signature }
    }

    await t.test('the owner\'s pool is verified and registered, and its seeding is a receipt within the collected accumulator', async () => {
      const stockSeed = collected / 2n, repoingSeed = stockSeed * 10n
      const created = await createPool({ payer: custody, creator: custody.publicKey, mint: repoing, stockSeed, repoingSeed })
      const seedSignature = created.signature
      const check = over => verifyCanonicalPool({ connection: finalizedConnection, assetId: 'meta-xstock', pool: created.pool.toBase58(), owners,
        repoingMint: repoing.toBase58(), creationSignature: seedSignature, ...over })
      // Only a pool of exactly REPOING and METAx, created and paid for by an owner wallet, passes.
      await assert.rejects(check({ repoingMint: Keypair.generate().publicKey.toBase58() }), /REPOING mint is not an SPL Token mint|not exactly REPOING/)
      await assert.rejects(check({ owners: [Keypair.generate().publicKey.toBase58()] }), /not an owner wallet/)
      await assert.rejects(check({ assetId: 'msft-xstock' }), /MSFTx mint is not a Token-2022 mint|not exactly REPOING/)
      await assert.rejects(check({ creationSignature: swapSignature }), /paid for by .*, not an owner wallet/)
      await assert.rejects(check({ creationSignature: repoingFunding }), /exactly one pool creation/)
      await assert.rejects(check({ creationSignature: undefined }), /creation transaction signature is required/)
      // The pool's creator is not a signature: an outsider can create a pool naming an owner wallet, which then holds its position.
      // Its creation, paid for by the outsider, is what refuses it.
      const outsider = await funded(), forgedMint = await createMint(connection, outsider, outsider.publicKey, null, 6, Keypair.generate(), { commitment: 'confirmed' })
      const outsiderRepoing = getAssociatedTokenAddressSync(forgedMint, outsider.publicKey)
      await send([createAssociatedTokenAccountIdempotentInstruction(outsider.publicKey, outsiderRepoing, outsider.publicKey, forgedMint),
        createMintToInstruction(forgedMint, outsiderRepoing, outsider.publicKey, 10n ** 12n)], [outsider])
      await holdMetax(outsider, 100_000_000n)
      const forged = await createPool({ payer: outsider, creator: custody.publicKey, mint: forgedMint, stockSeed: 1_000_000n, repoingSeed: 1_000_000_000n, lock: false })
      await assert.rejects(verifyCanonicalPool({ connection: finalizedConnection, assetId: 'meta-xstock', pool: forged.pool.toBase58(), owners,
        repoingMint: forgedMint.toBase58(), creationSignature: forged.signature }), /paid for by .*, not an owner wallet/)
      const verified = await check({ verification: local('finalized') })
      assert.equal(verified.evidence.verifiedBy, 2)
      assert.deepEqual([verified.evidence.creation.signature, verified.evidence.creation.payer], [seedSignature, custody.publicKey.toBase58()])
      assert.deepEqual([verified.position, verified.owner, verified.fullyLocked, verified.evidence.pool.sides], [created.position.toBase58(),
        custody.publicKey.toBase58(), true, { repoing: 'A', stock: 'B' }])
      assert.equal((await registerCanonicalPool(pool, verified)).status, 'registered')
      canonical = verified
      const receipt = await verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'seed', signature: seedSignature, owners })
      assert.ok(BigInt(receipt.quoteSpent) > 0n && BigInt(receipt.quoteSpent) <= stockSeed)
      assert.ok(BigInt(receipt.repoingSpent) > 0n && BigInt(receipt.repoingSpent) <= repoingSeed)
      assert.equal(receipt.repoingReceived, '0')
      assert.deepEqual(receipt.evidence.positions.map(p => [p.address, p.fullyLocked]), [[created.position.toBase58(), true]])
      assert.deepEqual(Object.keys(receipt.evidence.liquidity), [created.position.toBase58()])
      await assert.rejects(verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'swap', signature: seedSignature, owners }), /exactly one swap/)
      const recorded = await recordStockSettlementReceipt(pool, receipt)
      assert.deepEqual([recorded.status, recorded.availableBefore], ['recorded', String(collected)])
      seedSpent = BigInt(receipt.quoteSpent)
    })

    await t.test('the settlement preview\'s instructions settle the rest as permanently locked liquidity, recorded as a receipt', async () => {
      const preview = await previewStockSettlement({ pool, connection: finalizedConnection, assetId: 'meta-xstock', owners, repoingMint: repoing.toBase58() })
      assert.equal(preview.status, 'PLANNED', preview.reason)
      assert.equal(preview.available, String(collected - seedSpent))
      assert.ok(BigInt(preview.amount) > 1n && BigInt(preview.amount) <= collected - seedSpent)
      assert.ok(BigInt(preview.swap.priceImpactBps) <= 300n)
      assert.equal(preview.swap.minimumOut, String(BigInt(preview.swap.expectedOut) * 9_900n / 10_000n), 'the default 100 bps slippage, in basis points')
      assert.deepEqual(preview.instructions.map(ix => ix.name.split(' ')[0]), ['createIdempotent', 'swap2', 'add_liquidity', 'permanent_lock_position'])
      const signature = await send(preview.instructions.map(toInstruction), [custody])
      const receipt = await verifyStockSettlementReceipt({ pool, connection: finalizedConnection, verification: local('finalized'), assetId: 'meta-xstock',
        kind: 'add_liquidity', signature, owners })
      assert.equal(receipt.evidence.verifiedBy, 2)
      assert.equal(receipt.evidence.liquidity[canonical.position], preview.lock.liquidity, 'exactly the liquidity the plan locks')
      // The swap spends exactly the planned half; the deposit at most the planned rest (its thresholds).
      assert.equal(receipt.evidence.swap.amountIn, preview.swap.amountIn)
      assert.ok(BigInt(receipt.evidence.deposit.stock) <= BigInt(preview.deposit.stock))
      assert.ok(BigInt(receipt.quoteSpent) <= BigInt(preview.amount))
      assert.ok(BigInt(receipt.repoingReceived) >= BigInt(preview.swap.minimumOut))
      assert.deepEqual(receipt.evidence.positions.map(p => [p.address, p.fullyLocked]), [[canonical.position, true]])
      assert.equal((await recordStockSettlementReceipt(pool, receipt)).status, 'recorded')
      assert.equal((await recordStockSettlementReceipt(pool, receipt)).status, 'already-recorded')
      const summary = await stockAccumulator(pool, 'meta-xstock')
      assert.deepEqual([summary.totals.spent, summary.receipts.seed.count, summary.receipts.add_liquidity.count],
        [String(seedSpent + BigInt(receipt.quoteSpent)), 1, 1])
      assert.equal(summary.status, 'MATCH', summary.problems.join('; '))
      assert.equal(summary.canonicalPool.pool, canonical.pool)
    })

    await t.test('a REPOING sale, an unlocked deposit, a deposit withdrawn before its lock and a spend beyond the accumulator are refused', async () => {
      const poolState = await amm.fetchPoolState(new PublicKey(canonical.pool))
      const swapIn = (input, output, amountIn) => amm.swap2({ payer: custody.publicKey, pool: new PublicKey(canonical.pool), inputTokenMint: input, outputTokenMint: output,
        tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID, referralTokenAccount: null, swapMode: SwapMode.ExactIn,
        amountIn: new BN(amountIn), minimumAmountOut: new BN(0), poolState })
      const sell = await swapIn(repoing, METAX, 1000)
      sell.feePayer = custody.publicKey
      const sellSignature = await finalized(await sendAndConfirmTransaction(connection, sell, [custody], { commitment: 'confirmed' }))
      await assert.rejects(verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'swap', signature: sellSignature, owners }), /sells REPOING/)
      // A deposit into a fresh position that stays unlocked is not permanent liquidity.
      const nft = Keypair.generate()
      const deposit = await amm.createPositionAndAddLiquidity({ owner: custody.publicKey, pool: new PublicKey(canonical.pool), positionNft: nft.publicKey,
        liquidityDelta: new BN(1_000_000), maxAmountTokenA: new BN(10n ** 12n), maxAmountTokenB: new BN(10n ** 9n), tokenAAmountThreshold: new BN(10n ** 12n),
        tokenBAmountThreshold: new BN(10n ** 9n), tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID })
      deposit.feePayer = custody.publicKey
      await holdMetax(custody, 10n ** 9n)
      const depositSignature = await finalized(await sendAndConfirmTransaction(connection, deposit, [custody, nft], { commitment: 'confirmed' }))
      await assert.rejects(verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'add_liquidity', signature: depositSignature, owners }),
        /still holds .* unlocked/)
      // A deposit into the canonical position withdrawn again before any lock: the position is fully locked afterwards, but its
      // permanent liquidity does not cover this deposit on top of the recorded ones, so it never counts.
      const canonicalPosition = await amm.fetchPositionState(new PublicKey(canonical.position))
      const positionNftAccount = derivePositionNftAccount(canonicalPosition.nftMint)
      // Sized from real token amounts: a withdrawal that rounds to zero tokens is refused by the program.
      const added = amm.getLiquidityDelta({ maxAmountTokenA: new BN(10n ** 9n), maxAmountTokenB: new BN(10n ** 7n), sqrtPrice: poolState.sqrtPrice,
        sqrtMinPrice: poolState.sqrtMinPrice, sqrtMaxPrice: poolState.sqrtMaxPrice, collectFeeMode: poolState.collectFeeMode })
      const add = await amm.addLiquidity({ owner: custody.publicKey, position: new PublicKey(canonical.position), pool: new PublicKey(canonical.pool),
        positionNftAccount, liquidityDelta: added, maxAmountTokenA: new BN(10n ** 12n), maxAmountTokenB: new BN(10n ** 9n), tokenAAmountThreshold: new BN(10n ** 12n),
        tokenBAmountThreshold: new BN(10n ** 9n), tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_2022_PROGRAM_ID })
      add.feePayer = custody.publicKey
      const addSignature = await finalized(await sendAndConfirmTransaction(connection, add, [custody], { commitment: 'confirmed' }))
      const remove = await amm.removeLiquidity({ owner: custody.publicKey, position: new PublicKey(canonical.position), pool: new PublicKey(canonical.pool),
        positionNftAccount, liquidityDelta: added, tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_2022_PROGRAM_ID, vestings: [], currentPoint: await getCurrentPoint(connection, poolState.activationType) })
      remove.feePayer = custody.publicKey
      await finalized(await sendAndConfirmTransaction(connection, remove, [custody], { commitment: 'confirmed' }))
      await assert.rejects(verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'add_liquidity', signature: addSignature, owners }),
        /permanently locked liquidity, less than the .* recorded/)
      // A genuine swap paid from the owner's own METAx, larger than what the accumulator has left, verifies but is never recorded.
      const left = BigInt((await stockAccumulator(pool, 'meta-xstock')).totals.available)
      const big = await swapIn(METAX, repoing, String(left + 1n))
      big.feePayer = custody.publicKey
      const bigSignature = await finalized(await sendAndConfirmTransaction(connection, big, [custody], { commitment: 'confirmed' }))
      const receipt = await verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'swap', signature: bigSignature, owners })
      assert.equal(receipt.quoteSpent, String(left + 1n))
      await assert.rejects(recordStockSettlementReceipt(pool, receipt), /collect first/)
      await assert.rejects(verifyStockSettlementReceipt({ pool, connection: finalizedConnection, assetId: 'meta-xstock', kind: 'swap', signature: bigSignature,
        owners: [Keypair.generate().publicKey.toBase58()] }), /not an owner wallet/)
    })
  } finally {
    await pool?.end()
    if (created) await dropTestDatabase(admin, DB)
    await admin.end()
    closeConnections()
    if (started) await stopValidator(work)
  }
})
