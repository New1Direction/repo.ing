import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction,
  TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, deriveDammV2PoolAddress, deriveDbcEventAuthority, deriveDbcPoolAddress,
  deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { ACC_SCALE, BUNDLE_ERRORS, BUNDLE_VAULT_PROGRAM_ID as PROGRAM, STATUS, bundleAccounts, bundleAddress, bundleBuyQuote, bundleLaunchInstructions, backerAddress,
  cancelBundleInstruction, claimBackerFeesInstruction, createBundleInstruction, decodeBacker, decodeBundle, decodePlatform, depositInstruction,
  failRaiseInstruction, initPlatformInstruction, launchAmounts, openVaultInstruction, pendingBackerFees, platformAddress, programDataAddress, recordGraduationInstruction,
  refundInstruction, releaseInstruction, routeCurveFeesInstruction, routePoolFeesInstruction, routerAddress, setPausedInstruction, setPlatformInstruction,
  setPolicyInstruction, settleInstruction, splitClaim, tokenAccountOf, vaultAddress, vaultSwapCurveInstruction, vaultSwapPoolInstruction } from '../src/bundle-vault.mjs'

// Bundle launches (docs/BUNDLE_LAUNCH.md) on the programs mainnet runs (scripts/ci/start-bundle-validator.sh): the bundle vault
// program from tests/fixtures/validator/bundle_vault.so with Meteora DBC, DAMM v2 and Metaplex as deployed. Raises, refunds, the
// one-transaction launch, the vault's limits, fee routing with the vault's rebate, backer claims, graduation and DAMM v2.
// Nothing here touches mainnet beyond the validator script reading its programs once.
const RPC = process.env.BUNDLE_CHAIN_RPC ?? `http://127.0.0.1:${process.env.BUNDLE_VALIDATOR_RPC_PORT ?? 8939}`
const SOL = 1_000_000_000n
const DBC = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
const COOLDOWN = 180, GRACE = 60, GAP = 20
// The loosest policy a bundle may have, and bundle A's (tighter in every field).
const LIMITS = { maxTradeBps: 500, maxDailyBuyBps: 2_000, maxDailySellBps: 500, floorBps: 5_000, gapSecs: 10 }
const POLICY = { maxTradeBps: 200, maxDailyBuyBps: 1_000, maxDailySellBps: 300, floorBps: 10_000, gapSecs: GAP }

async function healthy() {
  try { return (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) })).json()).result === 'ok' } catch { return false }
}
async function stopValidator(work) {
  let pid
  try { pid = Number(await readFile(join(work, 'validator.pid'), 'utf8')) } catch {}
  if (pid) {
    try { process.kill(pid) } catch {}
    for (let i = 0; i < 40; i++) { try { process.kill(pid, 0) } catch { break } await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

test('bundle launches on mainnet\'s programs: raises, refunds, launch, vault limits, fee routing, claims, graduation', { timeout: 1_200_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.BUNDLE_CHAIN_WORK_DIR, started = false
  const connection = new Connection(RPC, 'confirmed')
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-bundle-'))
      started = true
      const run = spawnSync('scripts/ci/start-bundle-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'bundle validator started')
    }
    assert.ok(work, 'the validator work dir with the program upgrade authority')
    const workKey = async name => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, name), 'utf8'))))
    const upgradeAuthority = await workKey('bundle-authority.json')
    // A second copy of the program, upgradeable by another key (start-bundle-validator.sh): its ProgramData passes every check but the address.
    const decoyAuthority = await workKey('decoy-authority.json'), decoyProgram = (await workKey('decoy-program.json')).publicKey
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed'), amm = new CpAmm(connection)
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
    const sendIx = (instructions, signers) => send(new Transaction().add(...[instructions].flat()), signers)
    const airdrop = async (to, lamports) => {
      const signature = await connection.requestAirdrop(to, Number(lamports))
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    }
    const funded = async sol => { const keypair = Keypair.generate(); await airdrop(keypair.publicKey, BigInt(sol) * SOL); return keypair }
    // "landed", or the first Anchor error code in the refused transaction's logs. A transaction that passed simulation and
    // failed on chain has no logs here, only its custom error number (this program's, in these tests).
    const outcome = promise => promise.then(() => 'landed', async error => {
      const logs = error?.logs ?? await error?.getLogs?.(connection).catch(() => []) ?? []
      const message = String(error?.message ?? error)
      const custom = message.match(/"Custom":(\d+)/)?.[1]
      return logs.join('\n').match(/Error Code: (\w+)/)?.[1] ?? (custom ? BUNDLE_ERRORS[Number(custom)] ?? `Custom ${custom}` : message.slice(0, 200))
    })
    const refusal = run => outcome(Promise.resolve().then(run))
    const chainTime = async () => {
      for (let i = 0; ; i++) {
        try { const time = await connection.getBlockTime(await connection.getSlot('confirmed')); if (time) return time } catch (error) { if (i >= 20) throw error }
        await sleep(250)
      }
    }
    const waitUntil = async unix => { while ((await chainTime()) < unix) await sleep(1_000) }
    const tokens = async account => BigInt((await connection.getTokenAccountBalance(account).catch(() => ({ value: { amount: '0' } }))).value.amount)
    const bundleState = async id => decodeBundle((await connection.getAccountInfo(bundleAddress(id))).data)
    const backerState = async (id, wallet) => decodeBacker((await connection.getAccountInfo(backerAddress(bundleAddress(id), wallet.publicKey))).data)
    const ata = (owner, mint) => createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, tokenAccountOf(owner, mint), owner, mint)
    const price = n => ComputeBudgetProgram.setComputeUnitPrice({ microLamports: n })

    await airdrop(upgradeAuthority.publicKey, 5n * SOL)
    const admin = await funded(20), launchSigner = await funded(2), agent = await funded(2), agent2 = await funded(2), outsider = await funded(10)
    const launcher = await funded(5), opsWallet = await funded(1), treasuryOwner = await funded(1), trader = await funded(60), whale = await funded(400)
    const [backerA, backerB, backerC] = [await funded(12), await funded(9), await funded(4)]
    const [backer4, backer5, backer6, backer7] = [await funded(3), await funded(3), await funded(3), await funded(3)]
    const router = routerAddress(), treasury = tokenAccountOf(treasuryOwner.publicKey, NATIVE_MINT)
    await sendIx([ata(router, NATIVE_MINT), ata(treasuryOwner.publicKey, NATIVE_MINT)], [admin])

    // The bundle config: today's launch-fee curve; its fee claimer is the router PDA (an address, no signature at creation).
    const config = Keypair.generate()
    await send(await dbc.partner.createConfig({ config: config.publicKey, feeClaimer: router, leftoverReceiver: admin.publicKey, payer: admin.publicKey,
      quoteMint: NATIVE_MINT, ...buildLaunchCurve('launch-fee') }), [admin, config])
    const fixed = await dbc.state.getPoolConfig(config.publicKey)
    const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[fixed.migrationFeeOption]
    const platformArgs = { admin: admin.publicKey, launchSigner: launchSigner.publicKey, operators: [agent.publicKey, agent2.publicKey],
      opsWallet: opsWallet.publicKey, curveConfig: config.publicKey, dammConfig, backerBps: 8_000, opsBps: 500, launchCooldownSecs: COOLDOWN,
      launchGraceSecs: GRACE, limits: LIMITS, treasury }

    await t.test('the platform: set once by the upgrade authority, changed only by the admin, its settings checked', async () => {
      assert.equal(await refusal(async () => sendIx(initPlatformInstruction({ ...platformArgs, upgradeAuthority: outsider.publicKey }), [outsider])), 'NotUpgradeAuthority')
      const decoyData = await connection.getAccountInfo(programDataAddress(decoyProgram))
      assert.ok(new PublicKey(decoyData.data.subarray(13, 45)).equals(decoyAuthority.publicKey), 'the decoy copy is the signer\'s to upgrade')
      await airdrop(decoyAuthority.publicKey, SOL)
      const init = initPlatformInstruction({ ...platformArgs, upgradeAuthority: decoyAuthority.publicKey })
      const decoy = { ...init, keys: init.keys.map((meta, index) => index === 3 ? { ...meta, pubkey: programDataAddress(decoyProgram) } : meta) }
      assert.equal(await refusal(async () => sendIx(decoy, [decoyAuthority])), 'NotUpgradeAuthority', 'another program\'s ProgramData, even one the signer controls')
      assert.equal(await refusal(async () => sendIx(initPlatformInstruction({ ...platformArgs, upgradeAuthority: upgradeAuthority.publicKey, launchCooldownSecs: 60 }),
        [upgradeAuthority])), 'BadSettings', 'no cooldown shorter than the launch fee')
      assert.equal(await refusal(async () => sendIx(initPlatformInstruction({ ...platformArgs, upgradeAuthority: upgradeAuthority.publicKey, treasury: outsider.publicKey }),
        [upgradeAuthority])), 'NotTokenAccount')
      await sendIx(initPlatformInstruction({ ...platformArgs, upgradeAuthority: upgradeAuthority.publicKey }), [upgradeAuthority])
      const platform = decodePlatform((await connection.getAccountInfo(platformAddress())).data)
      assert.deepEqual([platform.admin, platform.launchSigner, platform.curveConfig, platform.treasury, platform.routerSol].map(String),
        [admin.publicKey, launchSigner.publicKey, config.publicKey, treasury, tokenAccountOf(router, NATIVE_MINT)].map(String))
      assert.deepEqual([platform.operators.length, platform.backerBps, platform.opsBps, platform.launchCooldownSecs, platform.limits], [2, 8_000, 500, COOLDOWN, LIMITS])
      assert.notEqual(await refusal(async () => sendIx([price(1), initPlatformInstruction({ ...platformArgs, upgradeAuthority: upgradeAuthority.publicKey })],
        [upgradeAuthority])), 'landed', 'once only')
      assert.equal(await refusal(async () => sendIx(setPlatformInstruction({ ...platformArgs, admin: outsider.publicKey }), [outsider])), 'NotAdmin')
      // A DBC config whose fee claimer is not the router cannot become the bundle config.
      const other = Keypair.generate()
      await send(await dbc.partner.createConfig({ config: other.publicKey, feeClaimer: admin.publicKey, leftoverReceiver: admin.publicKey,
        payer: admin.publicKey, quoteMint: NATIVE_MINT, ...buildLaunchCurve('launch-fee') }), [admin, other])
      assert.equal(await refusal(async () => sendIx(setPlatformInstruction({ ...platformArgs, curveConfig: other.publicKey }), [admin])), 'BadSettings')
      await sendIx(setPlatformInstruction({ ...platformArgs }), [admin])
    })

    // A: launched. B: misses its target. C: cancelled by the admin. D: full but never launched (stale after the grace period).
    const create = (id, target, deadline, overrides = {}, signer = admin) => sendIx(createBundleInstruction({ creator: launcher.publicKey,
      admin: signer.publicKey, id, repoId: 9_000 + id, target, minDeposit: SOL / 2n, deadline, policy: POLICY, ...overrides }), [launcher, signer])
    const deposit = (wallet, id, lamports) => sendIx(depositInstruction({ wallet: wallet.publicKey, id, lamports }), [wallet])
    const SHARES = { A: 9_999_999_999n, B: 7_000_000_003n, C: 2_999_999_998n }
    let deadlineB, deadlineD

    await t.test('raises: repo.ing co-signs, policies within the limits, deposits to the target, one share per lamport', async () => {
      const now = await chainTime()
      assert.equal(await refusal(async () => create(1, 20n * SOL, now + 900, {}, outsider)), 'NotAdmin')
      assert.equal(await refusal(async () => create(1, 20n * SOL, now + 900, { policy: { ...POLICY, maxTradeBps: 600 } })), 'PolicyTooLoose')
      assert.equal(await refusal(async () => create(1, 20n * SOL, now + 900, { policy: { ...POLICY, floorBps: 4_000 } })), 'PolicyTooLoose')
      assert.equal(await refusal(async () => create(1, SOL / 2n, now + 900)), 'BadRaise', 'below the minimum target')
      assert.equal(await refusal(async () => create(1, 20n * SOL, now - 1)), 'BadRaise', 'a deadline in the past')
      deadlineB = now + 50
      deadlineD = now + 45
      await create(1, 20n * SOL, now + 900)
      await create(2, 5n * SOL, deadlineB)
      await create(3, 3n * SOL, now + 900)
      await create(4, SOL, deadlineD)
      assert.notEqual(await refusal(async () => sendIx([price(1), createBundleInstruction({ creator: launcher.publicKey, admin: admin.publicKey, id: 1, repoId: 1,
        target: SOL, minDeposit: SOL / 2n, deadline: now + 900, policy: POLICY })], [launcher, admin])), 'landed', 'one bundle per id')

      await deposit(backerA, 1, SHARES.A)
      await deposit(backerB, 1, 3_000_000_003n)
      await deposit(backerB, 1, 4_000_000_000n)
      assert.equal(await refusal(async () => deposit(backerC, 1, SOL / 10n)), 'BelowMinimum')
      assert.equal(await refusal(async () => deposit(backerC, 1, 3n * SOL)), 'OverTarget')
      await deposit(backerC, 1, SHARES.C)
      const a = await bundleState(1)
      assert.deepEqual([a.raised, a.status], [20n * SOL, STATUS.RAISING])
      for (const [wallet, shares] of [[backerA, SHARES.A], [backerB, SHARES.B], [backerC, SHARES.C]]) assert.equal((await backerState(1, wallet)).shares, shares)
      assert.equal(await refusal(async () => deposit(outsider, 1, SOL)), 'OverTarget', 'a full raise takes no more')

      await deposit(backer4, 2, 1_500_000_000n)
      await deposit(backer5, 2, SOL)
      await deposit(backer6, 3, 2n * SOL)
      await deposit(backer7, 4, SOL)
      assert.equal(await refusal(async () => sendIx(failRaiseInstruction({ id: 2 }), [outsider])), 'RaiseOpen', 'before its deadline a raise can still fill')
      // A raise that is not full cannot launch.
      assert.equal(await refusal(async () => sendIx([releaseInstruction({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: 2 }),
        settleInstruction({ launchSigner: launchSigner.publicKey, id: 2, pool: config.publicKey, mint: NATIVE_MINT, minTokens: 1 })], [launchSigner])), 'RaiseNotFull')
    })

    // ---- the launch of A
    const ID = 1, mint = Keypair.generate(), pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey)
    const accounts = bundleAccounts({ id: ID, mint: mint.publicKey })
    const { ops, buy } = launchAmounts(20n * SOL, 500)
    const minimumTokens = bundleBuyQuote(dbc, fixed, buy)
    let lookup, launchedAt

    await t.test('the launch: one transaction, release only with settle, the vault holds exactly the minimum-fee quote', async () => {
      const [createTable, table] = AddressLookupTableProgram.createLookupTable({ authority: admin.publicKey, payer: admin.publicKey,
        recentSlot: await connection.getSlot('finalized') })
      await send(new Transaction().add(createTable, AddressLookupTableProgram.extendLookupTable({ payer: admin.publicKey, authority: admin.publicKey,
        lookupTable: table, addresses: [deriveDbcPoolAuthority(), deriveDbcEventAuthority(), DBC, TOKEN_PROGRAM_ID, SystemProgram.programId,
          SYSVAR_INSTRUCTIONS_PUBKEY, NATIVE_MINT, PROGRAM, config.publicKey, ASSOCIATED_TOKEN_PROGRAM_ID, METAPLEX, ComputeBudgetProgram.programId,
          platformAddress(), opsWallet.publicKey] })), [admin])
      for (let i = 0; i < 40 && !(lookup?.state.addresses.length); i++) { await sleep(250); lookup = (await connection.getAddressLookupTable(table)).value }
      for (let i = 0; i < 40 && await connection.getSlot('confirmed') <= lookup.state.lastExtendedSlot; i++) await sleep(250)
      const sendV0 = async (instructions, signers) => {
        const message = new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions })
          .compileToV0Message([lookup])
        const tx = new VersionedTransaction(message)
        tx.sign(signers)
        const signature = await connection.sendTransaction(tx)
        const result = await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
        assert.equal(result.value.err, null)
        return { signature, bytes: tx.serialize() }
      }
      const created = await dbc.creator.createPoolWithFirstBuy({
        createPoolParam: { baseMint: mint.publicKey, config: config.publicKey, name: 'Bundle Chain', symbol: 'BNDL', uri: 'https://repo.ing/bundle.json',
          payer: launcher.publicKey, poolCreator: admin.publicKey },
        firstBuyParam: { buyer: launchSigner.publicKey, receiver: accounts.vault, buyAmount: new BN(buy.toString()),
          minimumAmountOut: new BN(minimumTokens.toString()), referralTokenAccount: null } })
      const instructions = bundleLaunchInstructions({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: ID, pool,
        mint: mint.publicKey, minimumTokens, created })
      const signers = [launcher, admin, launchSigner, mint]

      assert.equal(await refusal(async () => sendIx(releaseInstruction({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: ID }),
        [launchSigner])), 'NoSettle', 'no SOL leaves without a settle later in the transaction')
      assert.equal(await refusal(async () => sendIx([releaseInstruction({ launchSigner: outsider.publicKey, opsWallet: opsWallet.publicKey, id: ID }),
        settleInstruction({ launchSigner: outsider.publicKey, id: ID, pool, mint: mint.publicKey, minTokens: 1 })], [outsider])), 'NotLaunchSigner')
      assert.equal(await refusal(async () => sendIx([releaseInstruction({ launchSigner: launchSigner.publicKey, opsWallet: outsider.publicKey, id: ID }),
        settleInstruction({ launchSigner: launchSigner.publicKey, id: ID, pool, mint: mint.publicKey, minTokens: 1 })], [launchSigner])), 'BadSettings',
      'the operations share goes to the platform\'s wallet only')
      // Settle into a token account that is not the vault's: the whole launch fails, so there is no pool.
      const settleData = settleInstruction({ launchSigner: launchSigner.publicKey, id: ID, pool, mint: mint.publicKey, minTokens: minimumTokens }).data
      const wrong = instructions.map(ix => ix.programId.equals(PROGRAM) && ix.data.equals(settleData)
        ? { programId: ix.programId, data: ix.data, keys: ix.keys.map((meta, index) => index === 5 ? { ...meta, pubkey: treasury } : meta) }
        : ix)
      assert.equal(await refusal(async () => sendV0(wrong, signers)), 'BadVaultAccount')
      assert.equal(await connection.getAccountInfo(pool), null, 'no pool after the refused launch')
      // A launch signer that buys with half the raise and keeps the rest: settle refuses, so nothing happens.
      const half = buy / 2n, halfTokens = bundleBuyQuote(dbc, fixed, half)
      const createdHalf = await dbc.creator.createPoolWithFirstBuy({
        createPoolParam: { baseMint: mint.publicKey, config: config.publicKey, name: 'Bundle Chain', symbol: 'BNDL', uri: 'https://repo.ing/bundle.json',
          payer: launcher.publicKey, poolCreator: admin.publicKey },
        firstBuyParam: { buyer: launchSigner.publicKey, receiver: accounts.vault, buyAmount: new BN(half.toString()),
          minimumAmountOut: new BN(halfTokens.toString()), referralTokenAccount: null } })
      assert.equal(await refusal(async () => sendV0(bundleLaunchInstructions({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: ID,
        pool, mint: mint.publicKey, minimumTokens: halfTokens, created: createdHalf }), signers)), 'NotSpent')
      assert.equal(await refusal(async () => sendV0(bundleLaunchInstructions({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: ID,
        pool, mint: mint.publicKey, minimumTokens: minimumTokens + 1n, created }), signers)), 'TooFewTokens')

      const opsBefore = BigInt(await connection.getBalance(opsWallet.publicKey))
      const launched = await sendV0(instructions, signers)
      const a = await bundleState(ID), curve = await dbc.state.getPool(pool), curveState = curve.poolState ?? curve
      assert.equal(await tokens(accounts.vaultTokens), minimumTokens, 'the vault received exactly the quote at the 1.75% minimum fee')
      assert.deepEqual([a.status, a.released, a.opsPaid, a.costLamports, a.costTokens], [STATUS.LAUNCHED, buy, ops, buy, minimumTokens])
      assert.equal(BigInt(await connection.getBalance(opsWallet.publicKey)) - opsBefore, ops, '5% of the raise to operations')
      assert.equal(a.vaultFeeOwed, BigInt(curveState.partnerQuoteFee.toString()), 'the launch buy\'s partner fee is the vault\'s, not backer income')
      assert.equal(a.tradingOpensAt - a.launchedAt, COOLDOWN)
      assert.equal(await tokens(tokenAccountOf(launchSigner.publicKey, mint.publicKey)), 0n, 'nothing stays with the launch signer')
      launchedAt = a.launchedAt
      console.log(JSON.stringify({ bundleLaunch: { bytes: launched.bytes.length, vaultShareOfSupply: Number(minimumTokens) / 1e15 } }))

      // Replays: the same signed bytes again, a second launch of the same bundle, and deposits after the launch.
      const replay = await connection.sendRawTransaction(launched.bytes).then(() => 'sent', error => String(error?.message ?? error))
      await sleep(1_500)
      assert.deepEqual(await bundleState(ID), a, `the replayed launch changed nothing (${replay.slice(0, 80)})`)
      assert.equal(await refusal(async () => sendIx([releaseInstruction({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: ID }),
        settleInstruction({ launchSigner: launchSigner.publicKey, id: ID, pool, mint: mint.publicKey, minTokens: 1 })], [launchSigner])), 'NotRaising')
      assert.equal(await refusal(async () => sendIx([price(2), settleInstruction({ launchSigner: launchSigner.publicKey, id: ID, pool, mint: mint.publicKey,
        minTokens: 1 })], [launchSigner])), 'NotReleased')
      assert.equal(await refusal(async () => deposit(outsider, ID, SOL)), 'NotRaising')
    })

    await t.test('failed raises: each backer takes back exactly its deposit, once; no launch, no deposit after', async () => {
      const refundExact = async (wallet, id) => {
        const backer = backerAddress(bundleAddress(id), wallet.publicKey)
        const rent = BigInt((await connection.getAccountInfo(backer)).lamports), shares = (await backerState(id, wallet)).shares
        const before = BigInt(await connection.getBalance(wallet.publicKey))
        const tx = new Transaction().add(refundInstruction({ wallet: wallet.publicKey, id }))
        tx.feePayer = admin.publicKey
        await send(tx, [admin, wallet])
        assert.equal(BigInt(await connection.getBalance(wallet.publicKey)) - before, shares + rent, 'the deposit and the backer account\'s rent')
        assert.equal(await connection.getAccountInfo(backer), null, 'the backer account is closed')
        return shares
      }
      // D: full, so after its deadline it can still launch until the grace period ends; then it fails.
      await waitUntil(deadlineD + 1)
      assert.equal(await refusal(async () => sendIx([price(4), failRaiseInstruction({ id: 4 })], [outsider])), 'RaiseOpen', 'a full raise can launch until the grace ends')
      // C: the admin cancels it.
      assert.equal(await refusal(async () => sendIx(cancelBundleInstruction({ admin: outsider.publicKey, id: 3 }), [outsider])), 'NotAdmin')
      assert.equal(await refusal(async () => sendIx(refundInstruction({ wallet: backer6.publicKey, id: 3 }), [backer6])), 'NotFailed')
      await sendIx(cancelBundleInstruction({ admin: admin.publicKey, id: 3 }), [admin])
      await refundExact(backer6, 3)
      assert.equal(await refusal(async () => sendIx([price(3), refundInstruction({ wallet: backer6.publicKey, id: 3 })], [backer6])), 'AccountNotInitialized',
        'a refund cannot be repeated')
      // B: misses its target by the deadline.
      await waitUntil(deadlineB + 1)
      assert.equal(await refusal(async () => deposit(backer4, 2, SOL)), 'RaiseClosed')
      await sendIx(failRaiseInstruction({ id: 2 }), [outsider])
      assert.equal(await refusal(async () => deposit(backer4, 2, SOL)), 'NotRaising')
      assert.equal(await refusal(async () => sendIx([releaseInstruction({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: 2 }),
        settleInstruction({ launchSigner: launchSigner.publicKey, id: 2, pool, mint: mint.publicKey, minTokens: 1 })], [launchSigner])), 'NotRaising')
      assert.equal(await refusal(async () => sendIx(refundInstruction({ wallet: outsider.publicKey, id: 2 }), [outsider])), 'AccountNotInitialized')
      const refunded = await refundExact(backer4, 2) + await refundExact(backer5, 2)
      const b = await bundleState(2)
      assert.deepEqual([b.status, b.refunded], [STATUS.FAILED, refunded])
      assert.equal(b.refunded, b.raised, 'every lamport of the raise went back')
      // D, not launched within the grace period.
      await waitUntil(deadlineD + GRACE + 1)
      await sendIx([price(5), failRaiseInstruction({ id: 4 })], [outsider])
      await refundExact(backer7, 4)
    })

    // ---- the vault of A
    const curveAccounts = async () => {
      const curve = await dbc.state.getPool(pool), state = curve.poolState ?? curve
      return { pool, config: config.publicKey, baseVault: state.baseVault, quoteVault: state.quoteVault, partnerQuoteFee: BigInt(state.partnerQuoteFee.toString()) }
    }
    const vaultCurve = async (buy, amountIn, operator = agent, extra = []) => {
      const { partnerQuoteFee, ...curve } = await curveAccounts()
      return sendIx([...extra, ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), vaultSwapCurveInstruction({ operator: operator.publicKey, id: ID,
        mint: mint.publicKey, ...curve, buy, amountIn, minimumOut: 1 })], [operator])
    }
    const traderCurve = async (buy, amount) => send(await dbc.pool.swap({ owner: trader.publicKey, payer: trader.publicKey, pool,
      amountIn: new BN(String(amount)), minimumAmountOut: new BN(0), swapBaseForQuote: !buy, referralTokenAccount: null }), [trader])

    await t.test('the vault: operators only, nothing during the launch fee, then per-trade, daily and gap limits; pause; its own accounts only', async () => {
      const { partnerQuoteFee: _, ...early } = await curveAccounts()
      assert.notEqual(await refusal(async () => sendIx(routeCurveFeesInstruction({ id: ID, mint: mint.publicKey, ...early, treasury }), [outsider])), 'landed',
        'no routing before the vault and the pot exist')
      await sendIx(openVaultInstruction({ payer: outsider.publicKey, id: ID }), [outsider])
      assert.equal(await refusal(async () => sendIx([price(6), openVaultInstruction({ payer: outsider.publicKey, id: ID })], [outsider])), 'AlreadyOpen')
      const held = await tokens(accounts.vaultTokens)
      assert.equal(await refusal(async () => vaultCurve(false, held / 100n, outsider)), 'NotOperator')
      assert.equal(await refusal(async () => vaultCurve(false, held / 100n)), 'LaunchCooldown', 'no vault trade while the launch fee lasts')
      // A public trade during the launch fee (its partner fee is backer income, not the vault's).
      await traderCurve(true, SOL)
      await waitUntil(launchedAt + COOLDOWN)

      assert.equal(await refusal(async () => vaultCurve(false, held * 201n / 10_000n)), 'TradeTooLarge')
      const fee0 = (await curveAccounts()).partnerQuoteFee, owed0 = (await bundleState(ID)).vaultFeeOwed
      await vaultCurve(false, held * 200n / 10_000n)
      const fee1 = (await curveAccounts()).partnerQuoteFee, a = await bundleState(ID)
      assert.equal(a.vaultFeeOwed - owed0, fee1 - fee0, 'the vault\'s partner fee is measured exactly on the pool\'s counter')
      assert.ok(await tokens(accounts.vaultSol) > 0n, 'the sell landed in the vault\'s wrapped SOL')
      assert.equal(await refusal(async () => vaultCurve(false, (await tokens(accounts.vaultTokens)) * 150n / 10_000n)), 'DailyLimit', '3% of the tokens a day')
      assert.equal(await refusal(async () => vaultCurve(true, 1_000_000n)), 'TooSoon', 'a gap between a sell and a buy')
      // A public swap and a vault trade in one transaction (a sandwich) are refused.
      const sandwich = (await dbc.pool.swap({ owner: trader.publicKey, payer: trader.publicKey, pool, amountIn: new BN(String(SOL / 10n)),
        minimumAmountOut: new BN(0), swapBaseForQuote: false, referralTokenAccount: null })).instructions
      const { partnerQuoteFee: __, ...now } = await curveAccounts()
      assert.equal(await refusal(async () => sendIx([...sandwich, ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        vaultSwapCurveInstruction({ operator: agent.publicKey, id: ID, mint: mint.publicKey, ...now, buy: false, amountIn: 1_000n, minimumOut: 1 })],
      [trader, agent])), 'NotAlone')
      // Only the bundle's own pool and accounts.
      const { partnerQuoteFee, ...curve } = await curveAccounts()
      const withKey = (index, pubkey) => {
        const swap = vaultSwapCurveInstruction({ operator: agent.publicKey, id: ID, mint: mint.publicKey, ...curve, buy: false, amountIn: 1_000n, minimumOut: 1 })
        return Object.assign(swap, { keys: swap.keys.map((meta, i) => i === index ? { ...meta, pubkey } : meta) })
      }
      assert.equal(await refusal(async () => sendIx(withKey(4, config.publicKey), [agent])), 'BadPool')
      assert.equal(await refusal(async () => sendIx(withKey(12, tokenAccountOf(router, NATIVE_MINT)), [agent])), 'BadVaultAccount')

      await waitUntil(a.lastSellAt + GAP)
      const sol = await tokens(accounts.vaultSol)
      assert.equal(await refusal(async () => vaultCurve(true, sol * 201n / 10_000n)), 'TradeTooLarge')
      await vaultCurve(true, sol * 150n / 10_000n)
      assert.ok((await bundleState(ID)).costTokens > a.costTokens, 'the buy added to the cost basis')
      // Pause and policy: admin only; tighten only.
      assert.equal(await refusal(async () => sendIx(setPausedInstruction({ admin: outsider.publicKey, id: ID, paused: true }), [outsider])), 'NotAdmin')
      await sendIx(setPausedInstruction({ admin: admin.publicKey, id: ID, paused: true }), [admin])
      assert.equal(await refusal(async () => vaultCurve(true, 1_000n, agent2)), 'Paused')
      await sendIx(setPausedInstruction({ admin: admin.publicKey, id: ID, paused: false }), [admin])
      assert.equal(await refusal(async () => sendIx(setPolicyInstruction({ admin: admin.publicKey, id: ID, policy: { ...POLICY, maxDailySellBps: 400 } }), [admin])),
        'PolicyTooLoose', 'a policy is never loosened')
      assert.equal(await refusal(async () => sendIx(setPolicyInstruction({ admin: outsider.publicKey, id: ID, policy: POLICY }), [outsider])), 'NotAdmin')
      // Tighter: a longer gap and a sell floor at 3× the vault's average cost, which the curve's price is below.
      await sendIx(setPolicyInstruction({ admin: admin.publicKey, id: ID, policy: { ...POLICY, gapSecs: GAP + 5, floorBps: 30_000 } }), [admin])
      assert.deepEqual([(await bundleState(ID)).policy.gapSecs, (await bundleState(ID)).policy.floorBps], [GAP + 5, 30_000])
      await waitUntil((await bundleState(ID)).lastBuyAt + GAP + 5)
      assert.equal(await refusal(async () => vaultCurve(false, (await tokens(accounts.vaultTokens)) / 200n)), 'BelowFloor', 'no sell below the floor')
    })

    // ---- fee routing and backer claims
    let routedTotal = 0n
    const routeCurve = async (extra = []) => {
      const { partnerQuoteFee, ...curve } = await curveAccounts()
      return sendIx([...extra, routeCurveFeesInstruction({ id: ID, mint: mint.publicKey, ...curve, treasury })], [outsider])
    }
    const balances = async () => ({ vault: await tokens(accounts.vaultSol), pot: await tokens(accounts.pot), treasury: await tokens(treasury) })

    await t.test('fee routing: the vault\'s own partner fees go back to the vault, then 80% of the rest to the backers, 20% to repo.ing', async () => {
      await sendIx(ata(router, mint.publicKey), [admin])
      // The bundle keeps the terms it was created with: a later platform change (here 50% to backers) does not touch it.
      await sendIx(setPlatformInstruction({ ...platformArgs, backerBps: 5_000 }), [admin])
      assert.deepEqual([(await bundleState(ID)).backerBps, decodePlatform((await connection.getAccountInfo(platformAddress())).data).backerBps], [8_000, 5_000])
      const wrongTreasury = routeCurveFeesInstruction({ id: ID, mint: mint.publicKey, ...await curveAccounts(), treasury: tokenAccountOf(router, NATIVE_MINT) })
      assert.equal(await refusal(async () => sendIx(wrongTreasury, [outsider])), 'BadSettings', 'repo.ing\'s share goes to its treasury only')
      const claimable = (await curveAccounts()).partnerQuoteFee, a = await bundleState(ID), before = await balances()
      const expected = splitClaim(claimable, a.vaultFeeOwed, 8_000, a.raised)
      assert.ok(claimable > a.vaultFeeOwed, 'public trades paid partner fees too')
      await routeCurve()
      routedTotal += claimable
      const after = await balances(), b = await bundleState(ID)
      assert.deepEqual([after.vault - before.vault, after.pot - before.pot, after.treasury - before.treasury],
        [expected.rebate, expected.toBackers, expected.toTreasury])
      assert.equal(expected.rebate, a.vaultFeeOwed, 'every lamport the vault generated went back to it')
      assert.deepEqual([b.vaultFeeOwed, b.vaultRebated, b.backerIncome, b.accPerShare], [0n, expected.rebate, expected.toBackers, expected.accIncrement])
      assert.equal(expected.toBackers + expected.toTreasury, claimable - a.vaultFeeOwed, 'backers and repo.ing split only the public trades\' fees')
      assert.equal(await refusal(async () => routeCurve([price(7)])), 'NothingToClaim')
      // Two cranks at once: one routes, the other finds nothing; the fees are routed once.
      await traderCurve(true, 2n * SOL)
      const second = (await curveAccounts()).partnerQuoteFee
      const results = await Promise.all([routeCurve([price(8)]), routeCurve([price(9)])].map(outcome))
      assert.deepEqual(results.sort(), ['NothingToClaim', 'landed'])
      routedTotal += second
      const c = await bundleState(ID)
      assert.equal(c.vaultRebated + c.backerIncome + c.treasuryIncome, routedTotal, 'every routed lamport is booked once')
      await sendIx(setPlatformInstruction({ ...platformArgs }), [admin])
    })

    await t.test('backer claims: pro rata to shares, rounding never overpays, concurrent and replayed claims pay once, backers only', async () => {
      const backers = [backerA, backerB, backerC]
      await sendIx(backers.map(wallet => ata(wallet.publicKey, NATIVE_MINT)), [admin])
      const claim = (wallet, extra = [], options = {}) => sendIx([...extra, claimBackerFeesInstruction({ wallet: wallet.publicKey, id: ID, ...options })], [wallet])
      // Someone else's backer account, a wallet with none, and a destination that is not wrapped SOL.
      const other = claimBackerFeesInstruction({ wallet: outsider.publicKey, id: ID })
      other.keys[2] = { ...other.keys[2], pubkey: backerAddress(accounts.bundle, backerA.publicKey) }
      assert.ok(['ConstraintSeeds', 'NotBacker'].includes(await refusal(async () => sendIx(other, [outsider]))), 'not someone else\'s backer account')
      assert.equal(await refusal(async () => claim(outsider)), 'AccountNotInitialized')
      await sendIx(ata(backerA.publicKey, mint.publicKey), [admin])
      assert.equal(await refusal(async () => claim(backerA, [], { destination: tokenAccountOf(backerA.publicKey, mint.publicKey) })), 'BadDestination')

      const a = await bundleState(ID)
      const owed = await Promise.all(backers.map(async wallet => pendingBackerFees(a, await backerState(ID, wallet))))
      // backerA: three claims at once; one pays, the others find nothing.
      const before = await tokens(tokenAccountOf(backerA.publicKey, NATIVE_MINT))
      const results = await Promise.all([1, 2, 3].map(n => outcome(claim(backerA, [price(10 + n)]))))
      assert.deepEqual(results.sort(), ['NothingToClaim', 'NothingToClaim', 'landed'])
      assert.equal(await tokens(tokenAccountOf(backerA.publicKey, NATIVE_MINT)) - before, owed[0])
      // backerB: its signed claim sent twice pays once.
      const tx = new Transaction().add(claimBackerFeesInstruction({ wallet: backerB.publicKey, id: ID }))
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash
      tx.feePayer = backerB.publicKey
      tx.sign(backerB)
      const bytes = tx.serialize(), beforeB = await tokens(tokenAccountOf(backerB.publicKey, NATIVE_MINT))
      const signature = await connection.sendRawTransaction(bytes)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
      await connection.sendRawTransaction(bytes).catch(() => {})
      await sleep(1_500)
      assert.equal(await tokens(tokenAccountOf(backerB.publicKey, NATIVE_MINT)) - beforeB, owed[1], 'the replay paid nothing')
      await claim(backerC)
      assert.equal(await refusal(async () => claim(backerC, [price(20)])), 'NothingToClaim')

      const b = await bundleState(ID), paid = await Promise.all(backers.map(async wallet => (await backerState(ID, wallet)).paid))
      assert.deepEqual(paid, owed)
      const shares = [SHARES.A, SHARES.B, SHARES.C]
      for (let i = 0; i < 3; i++) assert.equal(paid[i], shares[i] * b.accPerShare / ACC_SCALE, 'floor(shares × income per share)')
      const total = paid.reduce((sum, value) => sum + value, 0n), dust = b.backerIncome - total
      assert.equal(b.backerPaid, total)
      assert.ok(dust >= 0n && dust <= 3n, `rounding leaves at most one lamport per backer in the pot (${dust})`)
      assert.equal(await tokens(accounts.pot), b.backerIncome - b.backerPaid, 'the pot holds exactly what is unclaimed')
      console.log(JSON.stringify({ backerClaims: { paid: paid.map(String), dust: String(dust) } }))
    })

    await t.test('graduation: the curve migrates with the vault inside; the router\'s LP position; DAMM v2 trades, rebates and claims', async () => {
      await send(await dbc.pool.swap2({ owner: whale.publicKey, payer: whale.publicKey, pool, amountIn: new BN(String(300n * SOL)),
        minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode: SwapMode.PartialFill, referralTokenAccount: null }), [whale])
      const final = (await curveAccounts()).partnerQuoteFee
      await routeCurve([price(21)])
      routedTotal += final
      assert.equal(await refusal(async () => sendIx(recordGraduationInstruction({ admin: admin.publicKey, id: ID, pool, dammPool: config.publicKey,
        position: config.publicKey, positionNftAccount: config.publicKey }), [admin])), 'NotMigrated')
      await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: SOL })), [whale])
      const migration = await dbc.migration.migrateToDammV2({ pool, dammConfig, payer: whale.publicKey })
      await send(migration.transaction, [whale, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
      const dammPool = deriveDammV2PoolAddress(dammConfig, mint.publicKey, NATIVE_MINT)
      const [position] = await amm.getPositionsByUser(router), [creatorPosition] = await amm.getPositionsByUser(admin.publicKey)
      assert.ok(position, 'the partner LP position belongs to the router')
      const record = (overrides, signer = admin) => sendIx(recordGraduationInstruction({ admin: signer.publicKey, id: ID, pool, dammPool,
        position: position.position, positionNftAccount: position.positionNftAccount, ...overrides }), [signer])
      assert.equal(await refusal(async () => record({}, outsider)), 'NotAdmin')
      assert.equal(await refusal(async () => record({ dammPool: pool })), 'BadPool')
      // Anyone can open a position owned by the router: an empty one is never the bundle's.
      const junkNft = Keypair.generate()
      const built = amm.createPosition({ owner: router, payer: whale.publicKey, pool: dammPool, positionNft: junkNft.publicKey })
      await send(typeof built.transaction === 'function' ? await built.transaction() : await built, [whale, junkNft])
      const junk = (await amm.getPositionsByUser(router)).find(p => !p.position.equals(position.position))
      assert.ok(junk, 'a second router position exists')
      assert.equal(await refusal(async () => record({ position: junk.position, positionNftAccount: junk.positionNftAccount })), 'BadPosition')
      assert.equal(await refusal(async () => record({ position: creatorPosition.position, positionNftAccount: creatorPosition.positionNftAccount })), 'BadPosition',
        'not the creator\'s position')
      await record()
      assert.equal(await refusal(async () => sendIx([price(22), recordGraduationInstruction({ admin: admin.publicKey, id: ID, pool, dammPool,
        position: position.position, positionNftAccount: position.positionNftAccount })], [admin])), 'NotLaunched', 'once')
      assert.equal(await refusal(async () => vaultCurve(true, 1_000n)), 'Graduated')

      const poolState = await amm.fetchPoolState(dammPool)
      const pools = { dammPool, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, position: position.position }
      const vaultPool = (buy, amountIn, extra = []) => sendIx([...extra, ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        vaultSwapPoolInstruction({ operator: agent.publicKey, id: ID, mint: mint.publicKey, ...pools, buy, amountIn, minimumOut: 1 })], [agent])
      const routePool = (extra = []) => sendIx([...extra, routePoolFeesInstruction({ id: ID, mint: mint.publicKey, ...pools,
        positionNftAccount: position.positionNftAccount, treasury })], [outsider])
      assert.equal(await refusal(async () => routePool()), 'NothingToClaim', 'no DAMM v2 trade yet')

      // Only the vault trades: the fee its trade generated for the router's position is measured within one lamport.
      const owed0 = (await bundleState(ID)).vaultFeeOwed
      await vaultPool(true, (await tokens(accounts.vaultSol)) * 100n / 10_000n)
      const owed1 = (await bundleState(ID)).vaultFeeOwed, before = await balances()
      assert.ok(owed1 > owed0, 'the vault\'s DAMM v2 trade generated partner fees')
      await routePool()
      const after = await balances(), claimed = (after.vault - before.vault) + (after.pot - before.pot) + (after.treasury - before.treasury)
      routedTotal += claimed
      assert.equal(after.vault - before.vault, owed1 - owed0, 'all of it went back to the vault')
      assert.ok(claimed - (owed1 - owed0) <= 1n, `measured within rounding (${claimed} claimed, ${owed1 - owed0} measured)`)

      // Public DAMM v2 trades are backer income; the vault's next sell waits for the gap and stays within its limits.
      const traderPool = async (buy, amount) => send(await amm.swap2({ payer: trader.publicKey, pool: dammPool, poolState, swapMode: AmmSwapMode.ExactIn,
        inputTokenMint: buy ? NATIVE_MINT : mint.publicKey, outputTokenMint: buy ? mint.publicKey : NATIVE_MINT, tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, amountIn: new BN(String(amount)), minimumAmountOut: new BN(1) }), [trader])
      await traderPool(true, 5n * SOL)
      const held = await tokens(accounts.vaultTokens)
      assert.equal(await refusal(async () => vaultPool(false, held / 200n)), 'TooSoon')
      await waitUntil((await bundleState(ID)).lastBuyAt + GAP + 5)
      assert.equal(await refusal(async () => vaultPool(false, held * 201n / 10_000n)), 'TradeTooLarge')
      await vaultPool(false, held / 200n)
      const c = await bundleState(ID), owedNow = c.vaultFeeOwed, beforePublic = await balances()
      await routePool([price(23)])
      const afterPublic = await balances()
      const claimedPublic = (afterPublic.vault - beforePublic.vault) + (afterPublic.pot - beforePublic.pot) + (afterPublic.treasury - beforePublic.treasury)
      routedTotal += claimedPublic
      const expected = splitClaim(claimedPublic, owedNow, 8_000, c.raised)
      assert.deepEqual([afterPublic.vault - beforePublic.vault, afterPublic.pot - beforePublic.pot, afterPublic.treasury - beforePublic.treasury],
        [expected.rebate, expected.toBackers, expected.toTreasury])
      assert.ok(expected.toBackers > 0n, 'the public trade\'s fees reached the backers')
      const d = await bundleState(ID)
      assert.equal(d.vaultRebated + d.backerIncome + d.treasuryIncome, routedTotal, 'every routed lamport is booked once')
      // Backers claim what graduation added.
      const backerAPaid = (await backerState(ID, backerA)).paid, more = pendingBackerFees(d, await backerState(ID, backerA))
      assert.ok(more > 0n)
      await sendIx(claimBackerFeesInstruction({ wallet: backerA.publicKey, id: ID }), [backerA])
      assert.equal((await backerState(ID, backerA)).paid - backerAPaid, more)
      console.log(JSON.stringify({ bundleGraduated: { vaultShareOfSupply: Number(await tokens(accounts.vaultTokens)) / 1e15, routedLamports: String(routedTotal),
        vaultRebated: String(d.vaultRebated), backerIncome: String(d.backerIncome), treasuryIncome: String(d.treasuryIncome) } }))
    })
  } finally {
    try { connection._rpcWebSocket?.close() } catch {}
    if (started) await stopValidator(work)
  }
})
