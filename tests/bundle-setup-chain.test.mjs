import test from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AddressLookupTableProgram, Connection, Keypair, PACKET_DATA_SIZE, PublicKey, SystemProgram, Transaction, TransactionMessage,
  VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, deriveDbcPoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BUNDLE_DEFAULTS } from '../src/bundle-launch.mjs'
import { BUNDLE_ERRORS, STATUS, bundleAccounts, bundleAddress, bundleBuyQuote, bundleLaunchInstructions, createBundleInstruction, decodeBundle,
  depositInstruction, launchAmounts, platformAddress, routerAddress } from '../src/bundle-vault.mjs'
import { assertBundleConfig, assertBundleConfigTransaction, buildBundleConfigTransaction, bundleLookupAddresses, readBundleConfig } from '../src/bundle-config.mjs'
import { buildBundleLookupTableTransaction, buildBundlePlatformTransaction, bundlePlatformTerms, bundleProgramState, platformDifferences,
  readBundlePlatform, reviewBundleConfig, simulateSetup, verifyCreatedBundleConfig } from '../src/bundle-setup.mjs'
import { configDifferences } from '../src/launch-fee-config.mjs'
import { createFixedConfig } from './fixed-config.mjs'

// The Bundle launch mainnet setup kit (docs/BUNDLE_LAUNCH.md, "Mainnet setup") on the programs mainnet runs
// (scripts/ci/start-bundle-validator.sh): the code scripts/create-bundle-config.mjs, scripts/init-bundle-platform.mjs and
// scripts/create-bundle-lookup-table.mjs run, in their order, with their refusals; then one real bundle launch on exactly that
// config, platform and lookup table. Nothing here touches mainnet beyond the validator script reading its programs once.
const RPC = process.env.BUNDLE_CHAIN_RPC ?? `http://127.0.0.1:${process.env.BUNDLE_VALIDATOR_RPC_PORT ?? 8939}`
const SOL = 1_000_000_000n
// The creator signer on mainnet, the leftover receiver of the launch-fee config and the bundle config (an address: it signs nothing).
const LEFTOVER = new PublicKey('FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1')
// The live SOL launch-fee config's account, which scripts/create-bundle-config.mjs reviews the new config against on mainnet.
const LIVE_LAUNCH_FEE_CONFIG = JSON.parse(await readFile(new URL('./fixtures/launch-fee-config-mainnet.json', import.meta.url), 'utf8'))

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

test('the Bundle launch setup kit on mainnet\'s programs: config, platform, lookup table, then a real launch on them', { timeout: 600_000 }, async t => {
  assert.match(RPC, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/, 'a local validator only')
  let work = process.env.BUNDLE_CHAIN_WORK_DIR, started = false
  const connection = new Connection(RPC, 'confirmed')
  try {
    if (!await healthy()) {
      work = await mkdtemp(join(tmpdir(), 'repoing-bundle-setup-'))
      started = true
      const run = spawnSync('scripts/ci/start-bundle-validator.sh', [work], { stdio: 'inherit', timeout: 300_000 })
      assert.equal(run.status, 0, 'bundle validator started')
    }
    assert.ok(work, 'the validator work dir with the program upgrade authority')
    assert.equal(await connection.getAccountInfo(platformAddress()), null, 'a fresh bundle validator: the platform account is created once')
    const upgradeAuthority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(join(work, 'bundle-authority.json'), 'utf8'))))
    const dbc = new DynamicBondingCurveClient(connection, 'confirmed')
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
    const send = (tx, signers) => sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
    const sendIx = (instructions, signers) => send(new Transaction().add(...[instructions].flat()), signers)
    const airdrop = async (to, lamports) => {
      const signature = await connection.requestAirdrop(to, Number(lamports))
      await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash('confirmed') }, 'confirmed')
    }
    const funded = async sol => { const keypair = Keypair.generate(); await airdrop(keypair.publicKey, BigInt(sol) * SOL); return keypair }
    // "landed", or this program's error name (or the first Anchor error code) in the refused transaction's logs.
    const refusal = run => Promise.resolve().then(run).then(() => 'landed', async error => {
      const logs = error?.logs ?? await error?.getLogs?.(connection).catch(() => []) ?? []
      const custom = String(error?.message ?? error).match(/"Custom":(\d+)/)?.[1]
      return logs.join('\n').match(/Error Code: (\w+)/)?.[1] ?? (custom ? BUNDLE_ERRORS[Number(custom)] ?? `Custom ${custom}` : String(error?.message ?? error).slice(0, 200))
    })
    const chainTime = async () => { for (;;) { const time = await connection.getBlockTime(await connection.getSlot('confirmed')).catch(() => null); if (time) return time; await sleep(250) } }

    await airdrop(upgradeAuthority.publicKey, 5n * SOL)
    // partner: the config's payer and the table's authority (the partner wallet on mainnet); creator: the launch's pool creator.
    const partner = await funded(5), creator = await funded(2), admin = await funded(5), launchSigner = await funded(1), outsider = await funded(5)
    const [agent, agent2, opsWallet, treasuryOwner] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()]
    // The live SOL launch-fee config's twin: the same curve and leftover receiver, the partner as its fee claimer.
    const { config: reference } = await createFixedConfig(connection, 'launch-fee', { leftoverReceiver: LEFTOVER })
    const configKey = Keypair.generate(), config = configKey.publicKey
    const costs = {}
    let poolConfig, lookup

    await t.test('the bundle config: the launch-fee curve with the router as fee claimer, reviewed, created and checked; look-alikes refused', async () => {
      const built = await buildBundleConfigTransaction({ connection, config, payer: partner.publicKey, leftoverReceiver: LEFTOVER })
      assert.ok(built.feeClaimer.equals(routerAddress()))
      const review = await reviewBundleConfig({ connection, tx: built.tx, config, payer: partner.publicKey, leftoverReceiver: LEFTOVER, reference })
      assert.deepEqual(review.differences, ['feeClaimer'], 'exactly the launch-fee config but its fee claimer')
      assert.equal(review.totalDebitLamports, review.rentLamports + review.networkFeeLamports)
      built.tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
      await send(built.tx, [partner, configKey])
      poolConfig = await verifyCreatedBundleConfig({ connection, config, accountDataSha256: review.accountDataSha256, leftoverReceiver: LEFTOVER,
        commitment: 'confirmed' })
      assert.ok(assertBundleConfig(await readBundleConfig(connection, config, { leftoverReceiver: LEFTOVER, reference }), { leftoverReceiver: LEFTOVER }),
        'as the platform and lookup table scripts read it')
      costs.config = { bytes: review.accountBytes, rentLamports: review.rentLamports, debitLamports: review.totalDebitLamports }
      // A config mainnet's DBC creates today differs from the live launch-fee config in its fee claimer only: the mainnet dry run's check.
      const live = dbc.state.getProgram().coder.accounts.decode('poolConfig', Buffer.from(LIVE_LAUNCH_FEE_CONFIG.data, 'base64'))
      assert.deepEqual(configDifferences(poolConfig, live), ['feeClaimer'])

      // The same curve with another fee claimer (the partner wallet) is not a bundle config: the program's own check fails first.
      await assert.rejects(readBundleConfig(connection, reference, { leftoverReceiver: LEFTOVER }),
        /program would refuse this config: fee claimer is not the bundle router/)
      const coder = dbc.state.getProgram().coder
      const partnerClaimed = coder.accounts.decode('poolConfig', (await connection.getAccountInfo(reference)).data)
      assert.throws(() => assertBundleConfig(partnerClaimed, { leftoverReceiver: LEFTOVER }), /another fee claimer/)
      await assert.rejects(readBundleConfig(connection, config, { leftoverReceiver: outsider.publicKey }), /another leftover receiver/)
      // A create transaction whose fee claimer is not the router is refused before it is simulated.
      const lookAlike = await dbc.partner.createConfig({ config: Keypair.generate().publicKey, feeClaimer: partner.publicKey,
        leftoverReceiver: LEFTOVER, payer: partner.publicKey, quoteMint: NATIVE_MINT, ...built.curve })
      assert.throws(() => assertBundleConfigTransaction(lookAlike, { coder, config: lookAlike.instructions[0].keys[0].pubkey, payer: partner.publicKey,
        leftoverReceiver: LEFTOVER }), /accounts differ/)
    })

    const wallets = { admin: admin.publicKey, launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, treasuryOwner: treasuryOwner.publicKey }
    await t.test('the platform: only the upgrade authority, only the bundle config, then exactly the reviewed terms; later changes by the admin', async () => {
      const program = await bundleProgramState(connection, { program: await readFile('tests/fixtures/validator/bundle_vault.so') })
      assert.ok(program.upgradeAuthority.equals(upgradeAuthority.publicKey))
      assert.equal(program.matchesReviewedBuild, true, 'the deployed program is the reviewed build')
      assert.equal((await bundleProgramState(connection, { program: Buffer.from('another build') })).matchesReviewedBuild, false)
      costs.program = { programDataBytes: program.programDataBytes, programDataRentLamports: program.programDataLamports }
      const terms = bundlePlatformTerms({ ...wallets, operators: [agent.publicKey], config, poolConfig })
      assert.ok(terms.dammConfig.equals(DAMM_V2_MIGRATION_FEE_ADDRESS[poolConfig.migrationFeeOption]))

      // Another config (the partner as fee claimer): the program refuses it too, and nothing is created.
      const wrongConfig = await buildBundlePlatformTransaction({ connection, mode: 'init', signer: upgradeAuthority.publicKey,
        terms: { ...terms, curveConfig: reference } })
      await assert.rejects(simulateSetup({ connection, tx: wrongConfig.tx, payer: upgradeAuthority.publicKey, created: wrongConfig.created }), /Unsigned simulation failed/)
      assert.equal(await refusal(() => send(wrongConfig.tx, [upgradeAuthority])), 'BadSettings')
      // Another signer than the upgrade authority.
      const wrongSigner = await buildBundlePlatformTransaction({ connection, mode: 'init', signer: outsider.publicKey, terms })
      await assert.rejects(simulateSetup({ connection, tx: wrongSigner.tx, payer: outsider.publicKey, created: wrongSigner.created }), /Unsigned simulation failed/)
      assert.equal(await refusal(() => send(wrongSigner.tx, [outsider])), 'NotUpgradeAuthority')
      assert.equal(await connection.getAccountInfo(platformAddress()), null)

      // Anyone can send lamports to the public platform and treasury addresses first: both accounts are still created there.
      const PREFUNDED = 1_000_000
      await sendIx([platformAddress(), terms.treasury].map(toPubkey => SystemProgram.transfer({ fromPubkey: outsider.publicKey, toPubkey,
        lamports: PREFUNDED })), [outsider])
      assert.equal(await readBundlePlatform(connection), null, 'lamports alone are not a platform')
      const built = await buildBundlePlatformTransaction({ connection, mode: 'init', signer: upgradeAuthority.publicKey, terms })
      assert.deepEqual(built.createdTokenAccounts.map(String), [terms.routerSol, terms.treasury].map(String), 'both wrapped SOL accounts are created first')
      const review = await simulateSetup({ connection, tx: built.tx, payer: upgradeAuthority.publicKey, created: built.created })
      assert.equal(review.totalDebitLamports, review.rentLamports + review.networkFeeLamports)
      assert.equal(review.rentLamports, review.accounts.reduce((sum, account) => sum + account.lamports, 0) - 2 * PREFUNDED, 'the payer tops up the rest')
      await send(built.tx, [upgradeAuthority])
      assert.deepEqual(platformDifferences(await readBundlePlatform(connection), terms), [], 'the platform holds exactly the reviewed terms')
      costs.platform = { rentLamports: review.rentLamports + 2 * PREFUNDED, accounts: review.accounts.map(account => account.lamports) }
      const again = await buildBundlePlatformTransaction({ connection, mode: 'init', signer: upgradeAuthority.publicKey, terms })
      assert.deepEqual(again.createdTokenAccounts, [], 'the token accounts exist now')
      await assert.rejects(simulateSetup({ connection, tx: again.tx, payer: upgradeAuthority.publicKey, created: again.created }), /Already exists/)
      assert.notEqual(await refusal(() => send(again.tx, [upgradeAuthority])), 'landed', 'the program runs init_platform once')
      assert.deepEqual(platformDifferences(await readBundlePlatform(connection), terms), [])

      // set_platform: a second operator. Only the admin.
      const more = bundlePlatformTerms({ ...wallets, operators: [agent.publicKey, agent2.publicKey], config, poolConfig })
      const byOutsider = await buildBundlePlatformTransaction({ connection, mode: 'set', signer: outsider.publicKey, terms: more })
      assert.equal(await refusal(() => send(byOutsider.tx, [outsider])), 'NotAdmin')
      const set = await buildBundlePlatformTransaction({ connection, mode: 'set', signer: admin.publicKey, terms: more })
      const setReview = await simulateSetup({ connection, tx: set.tx, payer: admin.publicKey, created: set.created })
      assert.deepEqual([set.created, setReview.rentLamports, setReview.totalDebitLamports], [[], 0, setReview.networkFeeLamports], 'a change pays the fee only')
      await send(set.tx, [admin])
      assert.deepEqual(platformDifferences(await readBundlePlatform(connection), more), [])
      assert.deepEqual(platformDifferences(await readBundlePlatform(connection), terms), ['operators'])
    })

    await t.test('the lookup table: the 14 keys every bundle launch shares, the operations wallet read from the platform', async () => {
      const platform = await readBundlePlatform(connection)
      assert.ok(platform.curveConfig.equals(config))
      const addresses = bundleLookupAddresses(config, platform.opsWallet)
      const { tx, table } = await buildBundleLookupTableTransaction({ connection, authority: partner.publicKey, addresses })
      const review = await simulateSetup({ connection, tx, payer: partner.publicKey, created: [table] })
      assert.equal(review.accounts[0].owner, AddressLookupTableProgram.programId.toBase58())
      await send(tx, [partner])
      for (let i = 0; i < 40 && !(lookup?.state.addresses.length); i++) { await sleep(250); lookup = (await connection.getAddressLookupTable(table)).value }
      for (let i = 0; i < 40 && await connection.getSlot('confirmed') <= lookup.state.lastExtendedSlot; i++) await sleep(250)
      assert.deepEqual(lookup.state.addresses.map(String), addresses.map(String))
      assert.ok(lookup.state.authority.equals(partner.publicKey))
      costs.lookupTable = { addresses: addresses.length, rentLamports: review.rentLamports, debitLamports: review.totalDebitLamports }
    })

    await t.test('a real bundle launch on that config, platform and table: one v0 transaction, the vault holds the quoted tokens', async () => {
      const launcher = await funded(3), backerA = await funded(4), backerB = await funded(3)
      const ID = 1, target = 5n * SOL
      await sendIx(createBundleInstruction({ creator: launcher.publicKey, admin: admin.publicKey, id: ID, repoId: 4_242, target, minDeposit: SOL / 2n,
        deadline: await chainTime() + 900, policy: BUNDLE_DEFAULTS.policy }), [launcher, admin])
      await sendIx(depositInstruction({ wallet: backerA.publicKey, id: ID, lamports: 3n * SOL }), [backerA])
      await sendIx(depositInstruction({ wallet: backerB.publicKey, id: ID, lamports: 2n * SOL }), [backerB])
      const mint = Keypair.generate(), pool = deriveDbcPoolAddress(NATIVE_MINT, mint.publicKey, config)
      const accounts = bundleAccounts({ id: ID, mint: mint.publicKey })
      const { ops, buy } = launchAmounts(target, BUNDLE_DEFAULTS.opsBps)
      const minimumTokens = bundleBuyQuote(dbc, await dbc.state.getPoolConfig(config), buy)
      const created = await dbc.creator.createPoolWithFirstBuy({
        createPoolParam: { baseMint: mint.publicKey, config, name: 'Bundle Setup', symbol: 'BSET', uri: 'https://repo.ing/bundle.json',
          payer: launcher.publicKey, poolCreator: creator.publicKey },
        firstBuyParam: { buyer: launchSigner.publicKey, receiver: accounts.vault, buyAmount: new BN(buy.toString()),
          minimumAmountOut: new BN(minimumTokens.toString()), referralTokenAccount: null } })
      const instructions = bundleLaunchInstructions({ launchSigner: launchSigner.publicKey, opsWallet: opsWallet.publicKey, id: ID, pool,
        mint: mint.publicKey, minimumTokens, created })
      const message = new TransactionMessage({ payerKey: launcher.publicKey, recentBlockhash: (await connection.getLatestBlockhash()).blockhash, instructions })
        .compileToV0Message([lookup])
      const tx = new VersionedTransaction(message)
      tx.sign([launcher, creator, launchSigner, mint])
      const bytes = tx.serialize().length
      assert.ok(bytes <= PACKET_DATA_SIZE, `the launch fits one transaction (${bytes} bytes)`)
      assert.equal(message.addressTableLookups.length, 1, 'read through the setup\'s lookup table')
      const opsBefore = BigInt(await connection.getBalance(opsWallet.publicKey))
      const signature = await connection.sendTransaction(tx)
      const result = await connection.confirmTransaction({ signature, ...await connection.getLatestBlockhash() }, 'confirmed')
      assert.equal(result.value.err, null)

      const bundle = decodeBundle((await connection.getAccountInfo(bundleAddress(ID))).data)
      const vaultTokens = BigInt((await connection.getTokenAccountBalance(accounts.vaultTokens)).value.amount)
      assert.equal(vaultTokens, minimumTokens, 'the vault received exactly the quote at DBC\'s minimum fee')
      assert.deepEqual([bundle.status, bundle.released, bundle.opsPaid, bundle.costTokens], [STATUS.LAUNCHED, buy, ops, minimumTokens])
      assert.ok(bundle.curveConfig.equals(config) && bundle.dammConfig.equals(DAMM_V2_MIGRATION_FEE_ADDRESS[poolConfig.migrationFeeOption]))
      assert.equal(BigInt(await connection.getBalance(opsWallet.publicKey)) - opsBefore, ops, 'the operations share went to the platform\'s wallet')
      console.log(JSON.stringify({ bundleSetup: { costs, launchBytes: bytes, vaultTokens: String(vaultTokens) } }))
    })
  } finally {
    try { connection._rpcWebSocket?.close() } catch {}
    if (started) await stopValidator(work)
  }
})
