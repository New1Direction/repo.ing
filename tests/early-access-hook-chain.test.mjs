import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, Transaction,
  TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, ExtensionType, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createInitializeAccount3Instruction, createTransferCheckedInstruction, createTransferCheckedWithTransferHookInstruction, getAccountLenForMint,
  getAssociatedTokenAddressSync, getExtensionTypes, getMint, getTransferHook } from '@solana/spl-token'
import { AccountsType, DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, SwapMode, TokenType, deriveDammV2PoolAddress, deriveDbcEventAuthority,
  deriveDbcPoolAddress, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm, SwapMode as AmmSwapMode } from '@meteora-ag/cp-amm-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { EARLY_ACCESS_HOOK_PROGRAM_ID as HOOK, MAX_EARLY_ACCESS_SECONDS, addWalletsInstruction, closeAllowListInstruction, decodeAllowList, decodeMintConfig, decodePlatform,
  earlyAccessAddresses, hookErrorName, initMintInstruction, initPlatformInstruction, platformAddress, removeWalletsInstruction,
  setPlatformInstruction, transferHookAccounts } from '../src/early-access-hook.mjs'

// Contributor early access (docs/EARLY_ACCESS.md) on the programs mainnet runs (scripts/ci/start-early-access-validator.sh):
// the hook from tests/fixtures/validator/early_access_hook.so on an early access DBC config (the builders curve, Token-2022,
// this hook), launched in one v0 transaction, traded in and after its window, graduated into DAMM v2 and traded there.
// Nothing here touches mainnet beyond the validator script reading its programs once.
const RPC = process.env.EARLY_ACCESS_CHAIN_RPC ?? `http://127.0.0.1:${process.env.EARLY_ACCESS_VALIDATOR_RPC_PORT ?? 8929}`
const WINDOW_SECONDS = 90
const DBC_PROGRAM = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
const MAX = new BN('18446744073709551615')

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

test('contributor early access on mainnet\'s programs: one-transaction launch, the window, graduation, DAMM v2', { timeout: 600_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.EARLY_ACCESS_CHAIN_WORK_DIR, started = false
  const connection = new Connection(RPC, 'confirmed')
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-early-access-'))
      started = true
      const run = spawnSync('scripts/ci/start-early-access-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'early access validator started')
    }
    assert.ok(work, 'the validator work dir with the hook upgrade authority')
    const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'hook-authority.json'), 'utf8'))))
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
    const airdrop = async (to, lamports) => {
      const signature = await connection.requestAirdrop(to, lamports)
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    }
    const funded = async lamports => { const keypair = Keypair.generate(); await airdrop(keypair.publicKey, lamports); return keypair }
    // The hook's error from a refused transaction (the hook's own failure line), or the message when another program refused it.
    const refusal = async run => {
      try { await run() } catch (error) {
        const logs = error?.logs ?? await error?.getLogs?.(connection).catch(() => []) ?? []
        return hookErrorName(logs.join('\n')) ?? String(error?.message ?? error).match(/Error Code: \w+|custom program error: 0x[0-9a-f]+/)?.[0] ?? String(error)
      }
      return 'landed'
    }
    // getBlockTime can miss a block that is not available yet (src/chain-clock.mjs): retry.
    const chainTime = async () => {
      for (let i = 0; ; i++) {
        try { const time = await connection.getBlockTime(await connection.getSlot('confirmed')); if (time) return time } catch (error) { if (i >= 20) throw error }
        await sleep(250)
      }
    }
    const units = async signature => (await connection.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })).meta.computeUnitsConsumed
    await airdrop(upgradeAuthority.publicKey, 5_000_000_000)
    const creator = await funded(5_000_000_000) // the launch co-signer and the hook admin
    const oracle = await funded(2_000_000_000), partner = await funded(5_000_000_000), launcher = await funded(5_000_000_000)
    const contributor = await funded(10_000_000_000), outsider = await funded(10_000_000_000), whale = await funded(150_000_000_000)

    await t.test('the platform is set once, by the program\'s upgrade authority', async () => {
      const intruder = await funded(1_000_000_000)
      assert.equal(await refusal(() => send(new Transaction().add(initPlatformInstruction({ upgradeAuthority: intruder.publicKey,
        admin: intruder.publicKey, oracle: intruder.publicKey })), [intruder])), 'NotUpgradeAuthority')
      await send(new Transaction().add(initPlatformInstruction({ upgradeAuthority: upgradeAuthority.publicKey, admin: creator.publicKey,
        oracle: oracle.publicKey })), [upgradeAuthority])
      const platform = decodePlatform((await connection.getAccountInfo(platformAddress())).data)
      assert.deepEqual([platform.admin.toBase58(), platform.oracle.toBase58()], [creator.publicKey.toBase58(), oracle.publicKey.toBase58()])
      assert.notEqual(await refusal(() => send(new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
        initPlatformInstruction({ upgradeAuthority: upgradeAuthority.publicKey, admin: outsider.publicKey, oracle: outsider.publicKey })), [upgradeAuthority])), 'landed')
      assert.equal(await refusal(() => send(new Transaction().add(setPlatformInstruction({ admin: outsider.publicKey, newAdmin: outsider.publicKey,
        newOracle: outsider.publicKey })), [outsider])), 'NotAdmin')
      assert.equal(await refusal(() => send(new Transaction().add(setPlatformInstruction({ admin: creator.publicKey, newAdmin: PublicKey.default,
        newOracle: oracle.publicKey })), [creator])), 'BadKey')
      // The admin can hand both roles on (here, to the same keys).
      await send(new Transaction().add(setPlatformInstruction({ admin: creator.publicKey, newAdmin: creator.publicKey, newOracle: oracle.publicKey })), [creator])
      const kept = decodePlatform((await connection.getAccountInfo(platformAddress())).data)
      assert.deepEqual([kept.admin.toBase58(), kept.oracle.toBase58()], [creator.publicKey.toBase58(), oracle.publicKey.toBase58()], 'unchanged by the refused calls')
    })

    // The early access config: the builders curve (flat 1.75%, 1% builder allocation) with a Token-2022 base and this hook.
    const config = Keypair.generate()
    await send(await dbc.partner.createConfigWithTransferHook({ config: config.publicKey, feeClaimer: partner.publicKey, leftoverReceiver: partner.publicKey,
      payer: partner.publicKey, quoteMint: NATIVE_MINT, transferHookProgram: HOOK, ...buildLaunchCurve('builders'), tokenType: TokenType.Token2022 }), [partner, config])
    const mint = Keypair.generate(), pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config.publicKey)
    const { allowList, config: mintConfig } = earlyAccessAddresses(mint.publicKey)
    const ata = owner => getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey ?? owner, false, TOKEN_2022_PROGRAM_ID)
    const held = async owner => BigInt((await connection.getTokenAccountBalance(ata(owner)).catch(() => ({ value: { amount: '0' } }))).value.amount)
    let end

    await t.test('a launch fits one v0 transaction: hook setup, pool, first buy, launcher off the list', async () => {
      // Lamports sent to the allow list's address first do not stop the setup.
      await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: outsider.publicKey, toPubkey: allowList, lamports: 1_000_000 })), [outsider])
      const now = await chainTime()
      const setup = (admin, earlyAccessEnd) => () => send(new Transaction().add(initMintInstruction({ payer: launcher.publicKey, admin: admin.publicKey,
        mint: mint.publicKey, repoId: 1, earlyAccessEnd, wallets: [] })), [launcher, admin].filter((key, index, all) => all.indexOf(key) === index))
      assert.equal(await refusal(setup(outsider, now + WINDOW_SECONDS)), 'NotAdmin')
      assert.equal(await refusal(setup(creator, now + MAX_EARLY_ACCESS_SECONDS + 600)), 'BadWindow')
      assert.equal(await refusal(setup(creator, now - 60)), 'BadWindow')
      end = (await chainTime()) + WINDOW_SECONDS
      const created = await dbc.creator.createPoolWithFirstBuyWithTransferHook({
        createPoolParam: { name: 'Early Access', symbol: 'EARLY', uri: 'https://repo.ing/early.json', payer: launcher.publicKey,
          poolCreator: creator.publicKey, config: config.publicKey, baseMint: mint.publicKey, transferHookProgram: HOOK },
        firstBuyParam: { buyer: launcher.publicKey, buyAmount: new BN(100_000_000), minimumAmountOut: new BN(1), referralTokenAccount: null,
          transferHookAccountsInfo: { slices: [{ accountsType: AccountsType.TransferHookBase, length: 4 }] }, transferHookAccounts: transferHookAccounts(mint.publicKey) } })
      const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        initMintInstruction({ payer: launcher.publicKey, admin: creator.publicKey, mint: mint.publicKey, repoId: 1388219884, earlyAccessEnd: end, wallets: [launcher.publicKey] }),
        ...created.instructions.filter(ix => !ix.programId.equals(ComputeBudgetProgram.programId)),
        removeWalletsInstruction({ authority: creator.publicKey, mint: mint.publicKey, wallets: [launcher.publicKey] })]
      const legacy = new Transaction({ feePayer: launcher.publicKey, ...await connection.getLatestBlockhash() }).add(...instructions)
      assert.throws(() => legacy.serialize({ requireAllSignatures: false, verifySignatures: false }), /too large/, 'too large as a legacy transaction')
      // One lookup table holds what every early access launch on this config shares.
      const [createTable, table] = AddressLookupTableProgram.createLookupTable({ authority: creator.publicKey, payer: creator.publicKey,
        recentSlot: await connection.getSlot('finalized') })
      await send(new Transaction().add(createTable, AddressLookupTableProgram.extendLookupTable({ payer: creator.publicKey, authority: creator.publicKey,
        lookupTable: table, addresses: [deriveDbcPoolAuthority(), deriveDbcEventAuthority(), DBC_PROGRAM, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
          SystemProgram.programId, SYSVAR_INSTRUCTIONS_PUBKEY, NATIVE_MINT, HOOK, platformAddress(), config.publicKey, ASSOCIATED_TOKEN_PROGRAM_ID] })), [creator])
      let lookup
      for (let i = 0; i < 40 && !(lookup?.state.addresses.length); i++) { await sleep(250); lookup = (await connection.getAddressLookupTable(table)).value }
      assert.ok(lookup?.state.addresses.length, 'the lookup table is readable')
      // It is usable from the slot after its last extension.
      for (let i = 0; i < 40 && await connection.getSlot('confirmed') <= lookup.state.lastExtendedSlot; i++) await sleep(250)
      const message = new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions })
        .compileToV0Message([lookup])
      const launch = new VersionedTransaction(message)
      launch.sign([launcher, creator, mint])
      const bytes = launch.serialize().length
      assert.ok(bytes <= 1232, `${bytes} bytes`)
      const signature = await connection.sendTransaction(launch)
      const confirmation = await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
      assert.equal(confirmation.value.err, null)
      console.log(JSON.stringify({ launch: { bytes, computeUnits: await units(signature) } }))
      const minted = await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID)
      assert.deepEqual(getExtensionTypes(minted.tlvData).map(type => ExtensionType[type]).sort(), ['MetadataPointer', 'TokenMetadata', 'TransferHook'])
      assert.deepEqual([getTransferHook(minted).programId.toBase58(), getTransferHook(minted).authority.toBase58(), minted.mintAuthority],
        [HOOK.toBase58(), deriveDbcPoolAuthority().toBase58(), null])
      assert.ok(await held(launcher) > 0n, 'the launcher\'s first buy landed')
      assert.deepEqual(decodeAllowList((await connection.getAccountInfo(allowList)).data).wallets, [], 'the launcher is off the list')
      const stored = decodeMintConfig((await connection.getAccountInfo(mintConfig)).data)
      assert.deepEqual([stored.repoId, stored.earlyAccessEnd, stored.rentReceiver.toBase58()], ['1388219884', end, launcher.publicKey.toBase58()])
    })

    const buy = (wallet, lamports, swapMode = SwapMode.ExactIn) => async () => send(await dbc.pool.swap2WithTransferHook({ owner: wallet.publicKey,
      payer: wallet.publicKey, pool, amountIn: new BN(String(lamports)), minimumAmountOut: new BN(0), swapBaseForQuote: false, swapMode,
      referralTokenAccount: null }), [wallet])
    const sell = (wallet, amount) => async () => send(await dbc.pool.swap2WithTransferHook({ owner: wallet.publicKey, payer: wallet.publicKey, pool,
      amountIn: new BN(String(amount)), minimumAmountOut: new BN(0), swapBaseForQuote: true, swapMode: SwapMode.ExactIn, referralTokenAccount: null }), [wallet])
    const send2022 = (from, to, amount) => async () => send(new Transaction().add(await createTransferCheckedWithTransferHookInstruction(connection,
      ata(from), mint.publicKey, to, from.publicKey, amount, 6, [], 'confirmed', TOKEN_2022_PROGRAM_ID)), [from])

    await t.test('in the window: only listed wallets receive (ATAs only), even the curve-filling buy; sells always work; only the oracle lists', async () => {
      assert.equal(await refusal(buy(launcher, 50_000_000)), 'NotContributor', 'the launcher had its first buy only')
      assert.equal(await refusal(buy(outsider, 50_000_000)), 'NotContributor')
      for (const wallet of [outsider, creator]) {
        assert.equal(await refusal(() => send(new Transaction().add(addWalletsInstruction({ oracle: wallet.publicKey, mint: mint.publicKey,
          wallets: [wallet.publicKey] })), [wallet])), 'NotOracle', 'only the oracle lists wallets, not the launch co-signer')
      }
      await send(new Transaction().add(addWalletsInstruction({ oracle: oracle.publicKey, mint: mint.publicKey, wallets: [contributor.publicKey] })), [oracle])
      // The SDK resolves the hook's accounts itself (from the mint alone).
      const bought = await buy(contributor, 200_000_000)()
      console.log(JSON.stringify({ hookBuyComputeUnits: await units(bought) }))
      await sell(contributor, (await held(contributor)) / 2n)()
      await sell(launcher, (await held(launcher)) / 2n)()
      await send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(outsider.publicKey, ata(outsider), outsider.publicKey,
        mint.publicKey, TOKEN_2022_PROGRAM_ID)), [outsider])
      assert.equal(await refusal(send2022(contributor, ata(outsider), 1_000n)), 'NotContributor')
      // A token account that is not an ATA could change owner later, so it never receives during the window.
      const plain = Keypair.generate(), space = getAccountLenForMint(await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID))
      await send(new Transaction().add(SystemProgram.createAccount({ fromPubkey: contributor.publicKey, newAccountPubkey: plain.publicKey, space,
        lamports: await connection.getMinimumBalanceForRentExemption(space), programId: TOKEN_2022_PROGRAM_ID }),
        createInitializeAccount3Instruction(plain.publicKey, mint.publicKey, contributor.publicKey, TOKEN_2022_PROGRAM_ID)), [contributor, plain])
      assert.equal(await refusal(send2022(contributor, plain.publicKey, 1_000n)), 'NotAssociatedAccount')
      // Fee claims on a hook pool use the *2 instructions.
      await send(await dbc.partner.claimPartnerTradingFee2({ feeClaimer: partner.publicKey, payer: partner.publicKey, pool, maxBaseAmount: MAX,
        maxQuoteAmount: MAX, receiver: partner.publicKey }), [partner])
      await send(await dbc.creator.claimCreatorTradingFee2({ creator: creator.publicKey, payer: creator.publicKey, pool, maxBaseAmount: MAX,
        maxQuoteAmount: MAX, receiver: creator.publicKey }), [creator])
      assert.equal(await refusal(() => send(new Transaction().add(closeAllowListInstruction({ mint: mint.publicKey, rentReceiver: launcher.publicKey,
        oracle: oracle.publicKey })), [outsider])), 'WindowOpen')
      // DBC turns the hook off in the swap that fills the curve; a wallet off the list still cannot make that swap.
      assert.equal(await refusal(buy(whale, 120_000_000_000, SwapMode.PartialFill)), 'NotContributor')
      assert.equal((await getTransferHook(await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID))).programId.toBase58(), HOOK.toBase58())
    })

    await t.test('a long list: wallets are added and removed in place, and the hook still finds a listed wallet', async () => {
      const others = Array.from({ length: 13 * 24 }, () => Keypair.generate().publicKey)
      for (let i = 0; i < others.length; i += 24) {
        await send(new Transaction().add(addWalletsInstruction({ oracle: oracle.publicKey, mint: mint.publicKey, wallets: others.slice(i, i + 24) })), [oracle])
      }
      const removed = others.slice(0, 30)
      await send(new Transaction().add(removeWalletsInstruction({ authority: oracle.publicKey, mint: mint.publicKey, wallets: removed.slice(0, 24) })), [oracle])
      await send(new Transaction().add(removeWalletsInstruction({ authority: creator.publicKey, mint: mint.publicKey, wallets: removed.slice(24) })), [creator])
      const { wallets } = decodeAllowList((await connection.getAccountInfo(allowList)).data)
      const expected = [contributor.publicKey, ...others.slice(30)].map(String).sort((a, b) => Buffer.compare(new PublicKey(a).toBuffer(), new PublicKey(b).toBuffer()))
      assert.deepEqual(wallets.map(String), expected, 'sorted, without the removed wallets')
      assert.equal((await connection.getAccountInfo(allowList)).data.length, 44 + expected.length * 32, 'no space past the last key')
      const bought = await buy(contributor, 20_000_000)()
      console.log(JSON.stringify({ listedWallets: expected.length, hookBuyComputeUnits: await units(bought) }))
    })

    await t.test('after the window: everyone trades; the list closes, its rent back to the launch payer and the oracle', async () => {
      while ((await chainTime()) <= end + 1) await sleep(2_000)
      await buy(outsider, 50_000_000)()
      await send2022(contributor, ata(outsider), 1_000n)()
      assert.equal(await refusal(() => send(new Transaction().add(addWalletsInstruction({ oracle: oracle.publicKey, mint: mint.publicKey,
        wallets: [whale.publicKey] })), [oracle])), 'WindowClosed')
      // The launch payer gets back what it put in at setup, the oracle what it paid for the longer list.
      const { listDeposit } = decodeMintConfig((await connection.getAccountInfo(mintConfig)).data)
      const before = [await connection.getBalance(launcher.publicKey), await connection.getBalance(oracle.publicKey)], rent = await connection.getBalance(allowList)
      await send(new Transaction().add(closeAllowListInstruction({ mint: mint.publicKey, rentReceiver: launcher.publicKey, oracle: oracle.publicKey })), [outsider])
      const refunds = [await connection.getBalance(launcher.publicKey) - before[0], await connection.getBalance(oracle.publicKey) - before[1]]
      assert.deepEqual(refunds, [Number(listDeposit), rent - Number(listDeposit)])
      assert.ok(refunds[1] > 0, 'the oracle paid for the longer list')
      assert.equal(await connection.getAccountInfo(allowList), null)
      await buy(contributor, 50_000_000)()
    })

    await t.test('graduation: the filling swap revokes the hook; migration, leftover, DAMM v2 trades and locked-position fees work', async () => {
      await buy(whale, 120_000_000_000, SwapMode.PartialFill)()
      const graduated = await getMint(connection, mint.publicKey, 'confirmed', TOKEN_2022_PROGRAM_ID)
      assert.deepEqual([getTransferHook(graduated).programId, getTransferHook(graduated).authority].map(String),
        [PublicKey.default, PublicKey.default].map(String), 'no hook after the curve is full')
      await send(new Transaction().add(createTransferCheckedInstruction(ata(whale), mint.publicKey, ata(outsider), whale.publicKey, 1_000n, 6, [],
        TOKEN_2022_PROGRAM_ID)), [whale])
      await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: whale.publicKey, toPubkey: deriveDbcPoolAuthority(), lamports: 1_000_000_000 })), [whale])
      const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[(await dbc.state.getPoolConfig(config.publicKey)).migrationFeeOption]
      const migration = await dbc.migration.migrateToDammV2({ pool, dammConfig, payer: whale.publicKey })
      await send(migration.transaction, [whale, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair])
      // The leftover (the builder allocation's source) goes to the leftover receiver after the migration.
      await send(await dbc.migration.withdrawLeftover({ pool, payer: whale.publicKey }), [whale])
      assert.ok(await held(partner) > 0n, 'the leftover reached the leftover receiver')
      const amm = new CpAmm(connection), dammPool = deriveDammV2PoolAddress(dammConfig, mint.publicKey, NATIVE_MINT)
      const poolState = await amm.fetchPoolState(dammPool)
      assert.ok(poolState.tokenAMint.equals(mint.publicKey))
      assert.deepEqual([poolState.tokenAFlag, poolState.tokenBFlag], [1, 0], 'Token-2022 market token, SPL wrapped SOL')
      const tokens = { tokenAMint: poolState.tokenAMint, tokenBMint: poolState.tokenBMint, tokenAVault: poolState.tokenAVault, tokenBVault: poolState.tokenBVault,
        tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID }
      const swap = (buying, amount) => async () => send(await amm.swap2({ payer: outsider.publicKey, pool: dammPool, poolState, swapMode: AmmSwapMode.ExactIn,
        inputTokenMint: buying ? NATIVE_MINT : mint.publicKey, outputTokenMint: buying ? mint.publicKey : NATIVE_MINT, ...tokens, referralTokenAccount: null,
        amountIn: new BN(String(amount)), minimumAmountOut: new BN(1) }), [outsider])
      await swap(true, 500_000_000)()
      await swap(false, (await held(outsider)) / 2n)()
      for (const owner of [creator, partner]) {
        const [position] = await amm.getPositionsByUser(owner.publicKey)
        await send(await amm.claimPositionFee({ owner: owner.publicKey, position: position.position, pool: dammPool,
          positionNftAccount: position.positionNftAccount, ...tokens }), [owner])
      }
    })
  } finally {
    try { connection._rpcWebSocket?.close() } catch {}
    if (started) await stopValidator(work)
  }
})
