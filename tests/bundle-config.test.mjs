import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, DynamicBondingCurveClient, deriveDbcPoolAuthority } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { buildLaunchCurve } from '../src/launch-curve.mjs'
import { BUNDLE_DEFAULTS } from '../src/bundle-launch.mjs'
import { BUNDLE_VAULT_PROGRAM_ID, platformAddress, routerAddress, tokenAccountOf } from '../src/bundle-vault.mjs'
import { METAPLEX_PROGRAM_ID, POOL_CONFIG_DISCRIMINATOR, PROGRAM_CONFIG_OFFSETS, assertBundleConfig, assertBundleConfigTransaction,
  buildBundleConfigTransaction, buildBundleCurve, bundleDammConfig, bundleLookupAddresses, decodeBundleConfig, programConfigFailures } from '../src/bundle-config.mjs'
import { buildBundlePlatformTransaction, bundlePlatformTerms, lookupAddressesSha256, platformDifferences } from '../src/bundle-setup.mjs'

// The pure parts of the Bundle launch mainnet setup kit (src/bundle-config.mjs, src/bundle-setup.mjs): the config's parameters and
// create transaction, the checker on real and tampered account bytes, the lookup table's addresses and the platform's terms. The
// chain test (tests/bundle-setup-chain.test.mjs) runs the same code against the program on a local validator.
const connection = new Connection('http://127.0.0.1:1')
const coder = new DynamicBondingCurveClient(connection, 'confirmed').state.getProgram().coder
const someone = () => Keypair.generate().publicKey
const CREATOR = new PublicKey('FeZX15P6abpTZZdRaFaGgewrudBPHywe7X21iT7DYnX1')
// The live SOL launch-fee config's account (tests/fixtures/launch-fee-config-mainnet.json): its fee claimer is the partner wallet.
const live = JSON.parse(await readFile(new URL('./fixtures/launch-fee-config-mainnet.json', import.meta.url), 'utf8'))
const liveBytes = Buffer.from(live.data, 'base64')
const withBytes = (bytes, offset, value) => { const copy = Buffer.from(bytes); Buffer.from(value).copy(copy, offset); return copy }
// The bundle config as it will be: the live config with the router as its fee claimer and nothing else changed.
const bundleBytes = withBytes(liveBytes, PROGRAM_CONFIG_OFFSETS.feeClaimer, routerAddress().toBuffer())

test('the bundle config is the standard launch-fee curve, created with the router as fee claimer', async () => {
  assert.deepEqual(buildBundleCurve(), buildLaunchCurve('launch-fee'))
  const [config, payer] = [someone(), someone()]
  const built = await buildBundleConfigTransaction({ connection, config, payer, leftoverReceiver: CREATOR })
  assert.ok(built.feeClaimer.equals(routerAddress()))
  assert.match(built.instructionSha256, /^[0-9a-f]{64}$/)
  assert.ok(built.tx.instructions[0].keys[1].pubkey.equals(routerAddress()), 'the fee claimer account is the router PDA')
  const expected = { coder, config, payer, leftoverReceiver: CREATOR }
  assert.equal(assertBundleConfigTransaction(built.tx, expected), true)
  assert.throws(() => assertBundleConfigTransaction(built.tx, { ...expected, feeClaimer: payer }), /accounts differ/)
  assert.throws(() => assertBundleConfigTransaction(built.tx, { ...expected, leftoverReceiver: payer }), /accounts differ/)
  assert.throws(() => assertBundleConfigTransaction(built.tx, { ...expected, curve: { ...built.curve, migrationQuoteThreshold: 86 } }),
    /differ from the launch-fee curve in: migrationQuoteThreshold/)
  const ix = built.tx.instructions[0]
  assert.throws(() => assertBundleConfigTransaction(new Transaction().add(ix, ix), expected), /shape/)
  const other = new TransactionInstruction({ ...ix, data: Buffer.concat([Buffer.alloc(8), ix.data.subarray(8)]) })
  assert.throws(() => assertBundleConfigTransaction(new Transaction().add(other), expected), /not a DBC create_config/)
})

test('the checker reads the bytes init_platform reads, at the program\'s own offsets', async () => {
  const source = await readFile(new URL('../programs/bundle-vault/src/lib.rs', import.meta.url), 'utf8')
  const offset = name => Number(source.match(new RegExp(`const ${name}: usize = (\\d+);`))[1])
  assert.deepEqual(PROGRAM_CONFIG_OFFSETS, { quoteMint: offset('DBC_CONFIG_QUOTE_MINT'), feeClaimer: offset('DBC_CONFIG_FEE_CLAIMER'),
    collectFeeMode: offset('DBC_CONFIG_COLLECT_FEE_MODE'), tokenType: offset('DBC_CONFIG_TOKEN_TYPE') })
  assert.deepEqual([...POOL_CONFIG_DISCRIMINATOR], source.match(/const DBC_CONFIG_DISC: \[u8; 8\] = \[([^\]]+)\]/)[1].split(',').map(Number))
  // The decoder agrees with those offsets on the live config.
  const decoded = coder.accounts.decode('poolConfig', liveBytes)
  assert.equal(decoded.feeClaimer.toBase58(), 'H7TKxmpTzCrujJQETuCTL5sjCgaZ8g4yW94ZEQPC7RY3')
  assert.ok(new PublicKey(liveBytes.subarray(PROGRAM_CONFIG_OFFSETS.feeClaimer, PROGRAM_CONFIG_OFFSETS.feeClaimer + 32)).equals(decoded.feeClaimer))
  assert.ok(new PublicKey(liveBytes.subarray(PROGRAM_CONFIG_OFFSETS.quoteMint, PROGRAM_CONFIG_OFFSETS.quoteMint + 32)).equals(NATIVE_MINT))
  assert.deepEqual([liveBytes[PROGRAM_CONFIG_OFFSETS.collectFeeMode], liveBytes[PROGRAM_CONFIG_OFFSETS.tokenType]], [decoded.collectFeeMode, decoded.tokenType])
  // Both are 0 on the live config: a flipped byte must change exactly the field the program reads there.
  const flipped = field => coder.accounts.decode('poolConfig', withBytes(liveBytes, PROGRAM_CONFIG_OFFSETS[field], [1]))
  assert.deepEqual([flipped('collectFeeMode').collectFeeMode, flipped('collectFeeMode').tokenType], [1, 0])
  assert.deepEqual([flipped('tokenType').tokenType, flipped('tokenType').collectFeeMode], [1, 0])

  assert.deepEqual(programConfigFailures(bundleBytes), [])
  assert.deepEqual(programConfigFailures(liveBytes), ['fee claimer is not the bundle router'], 'the live config pays the partner wallet')
  assert.deepEqual(programConfigFailures(withBytes(bundleBytes, PROGRAM_CONFIG_OFFSETS.quoteMint, someone().toBuffer())), ['quote mint is not wrapped SOL'])
  assert.deepEqual(programConfigFailures(withBytes(bundleBytes, PROGRAM_CONFIG_OFFSETS.collectFeeMode, [1])), ['fees are not collected in SOL only'])
  assert.deepEqual(programConfigFailures(withBytes(bundleBytes, PROGRAM_CONFIG_OFFSETS.tokenType, [1])), ['mints are not SPL Token'])
  assert.deepEqual(programConfigFailures(withBytes(bundleBytes, 0, Buffer.alloc(8))), ['not a DBC PoolConfig account'])
  assert.deepEqual(programConfigFailures(bundleBytes, someone()), ['fee claimer is not the bundle router'], 'another program\'s router')
})

test('the checker accepts exactly the launch-fee config with the router as fee claimer, and refuses each look-alike', () => {
  const reference = coder.accounts.decode('poolConfig', liveBytes)
  const options = { leftoverReceiver: CREATOR, reference }
  const decoded = decodeBundleConfig(bundleBytes, coder, options)
  assert.ok(decoded.feeClaimer.equals(routerAddress()))
  assert.throws(() => decodeBundleConfig(liveBytes, coder, options), /program would refuse this config: fee claimer is not the bundle router/)
  assert.throws(() => decodeBundleConfig(withBytes(bundleBytes, PROGRAM_CONFIG_OFFSETS.tokenType, [1]), coder, options), /mints are not SPL Token/)
  assert.throws(() => decodeBundleConfig(bundleBytes, coder, { ...options, leftoverReceiver: someone() }), /another leftover receiver/)

  const tampered = (field, value) => ({ ...decoded, [field]: value })
  assert.throws(() => assertBundleConfig(reference, options), /another fee claimer/)
  assert.throws(() => assertBundleConfig(tampered('quoteTokenFlag', 1), options), /does not quote wrapped SOL/)
  assert.throws(() => assertBundleConfig(tampered('collectFeeMode', 1), options), /fees in SOL only/)
  assert.throws(() => assertBundleConfig(tampered('tokenType', 1), options), /SPL Token/)
  assert.throws(() => assertBundleConfig(tampered('sqrtStartPrice', decoded.sqrtStartPrice.addn(1)), options), /launch-fee curve in: sqrtStartPrice/)
  assert.throws(() => assertBundleConfig(tampered('migrationQuoteThreshold', decoded.migrationQuoteThreshold.addn(1)), options), /migrationQuoteThreshold/)
  assert.throws(() => assertBundleConfig(tampered('enableFirstSwapWithMinFee', 0), options), /approved launch fee/)
  assert.throws(() => assertBundleConfig(tampered('poolFees', { ...decoded.poolFees, dynamicFee: { ...decoded.poolFees.dynamicFee, initialized: 1 } }), options),
    /dynamic fee/)
  assert.throws(() => assertBundleConfig(decoded, { ...options, reference: { ...reference, partnerLiquidityPercentage: 1 } }),
    /beyond the fee claimer: partnerLiquidityPercentage/)
  // Fields the curve check does not cover (migration fees, migrated pool fees, vesting) are caught only by the reference.
  for (const [field, value] of [['migrationFeePercentage', 1], ['migratedPoolFeeBps', 1], ['migratedCollectFeeMode', 1]]) {
    assert.equal(assertBundleConfig(tampered(field, value), { leftoverReceiver: CREATOR }), true, `${field} without a reference`)
    assert.throws(() => assertBundleConfig(tampered(field, value), options), new RegExp(`beyond the fee claimer: ${field}`))
  }
  assert.throws(() => assertBundleConfig(decoded, { ...options, router: routerAddress(someone()) }), /another fee claimer/)
  // Without a reference (the launch path): the program's checks and every curve term still apply.
  assert.equal(assertBundleConfig(decoded, { leftoverReceiver: CREATOR }), true)
  assert.ok(bundleDammConfig(decoded).equals(new PublicKey('Hv8Lmzmnju6m7kcokVKvwqz7QPmdX9XfKjJsXz8RXcjp')), 'FixedBps100, the DAMM v2 config SOL curves use')
  assert.throws(() => bundleDammConfig({ migrationFeeOption: 99 }), /unknown migration fee option/)
})

test('the lookup table holds the 14 keys every bundle launch shares, the platform and the operations wallet last', () => {
  const [config, opsWallet] = [someone(), someone()]
  const addresses = bundleLookupAddresses(config, opsWallet)
  assert.equal(addresses.length, 14)
  assert.equal(new Set(addresses.map(String)).size, 14)
  assert.ok(addresses[0].equals(deriveDbcPoolAuthority()))
  assert.deepEqual(addresses.slice(7, 12).map(String), [BUNDLE_VAULT_PROGRAM_ID, config, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', METAPLEX_PROGRAM_ID,
    ComputeBudgetProgram.programId].map(String))
  assert.deepEqual(addresses.slice(-2).map(String), [platformAddress(), opsWallet].map(String))
  assert.match(lookupAddressesSha256(addresses), /^[0-9a-f]{64}$/)
  assert.notEqual(lookupAddressesSha256(addresses), lookupAddressesSha256(bundleLookupAddresses(config, someone())))
})

test('the platform\'s terms: named wallets, the config\'s DAMM v2 config and BUNDLE_DEFAULTS; init or set with the missing token accounts first', async () => {
  const poolConfig = coder.accounts.decode('poolConfig', bundleBytes)
  const wallets = { admin: someone(), launchSigner: someone(), opsWallet: someone(), treasuryOwner: someone(), config: someone() }
  const operators = [someone(), someone()]
  const terms = bundlePlatformTerms({ ...wallets, operators, poolConfig })
  assert.ok(terms.treasury.equals(tokenAccountOf(wallets.treasuryOwner, NATIVE_MINT)))
  assert.ok(terms.routerSol.equals(tokenAccountOf(routerAddress(), NATIVE_MINT)))
  assert.ok(terms.dammConfig.equals(DAMM_V2_MIGRATION_FEE_ADDRESS[poolConfig.migrationFeeOption]))
  assert.deepEqual([terms.backerBps, terms.opsBps, terms.launchCooldownSecs, terms.launchGraceSecs, terms.limits],
    [BUNDLE_DEFAULTS.backerBps, BUNDLE_DEFAULTS.opsBps, BUNDLE_DEFAULTS.launchCooldownSecs, BUNDLE_DEFAULTS.launchGraceSecs, BUNDLE_DEFAULTS.limits])
  assert.throws(() => bundlePlatformTerms({ ...wallets, operators: [], poolConfig }), /1 to 4 operators/)
  assert.throws(() => bundlePlatformTerms({ ...wallets, operators: [1, 2, 3, 4, 5].map(someone), poolConfig }), /1 to 4 operators/)
  assert.throws(() => bundlePlatformTerms({ ...wallets, operators: [operators[0], operators[0]], poolConfig }), /distinct/)
  assert.throws(() => bundlePlatformTerms({ ...wallets, admin: undefined, operators, poolConfig }), /admin must be a public key/)
  assert.throws(() => bundlePlatformTerms({ ...wallets, opsWallet: PublicKey.default, operators, poolConfig }), /opsWallet must be a public key/)

  // A decoded platform holding exactly the terms, and one with another operator list.
  const platform = { ...terms, bump: 255 }
  assert.deepEqual(platformDifferences(platform, terms), [])
  assert.deepEqual(platformDifferences({ ...platform, operators: operators.slice(0, 1) }, terms), ['operators'])
  assert.deepEqual(platformDifferences({ ...platform, limits: { ...terms.limits, gapSecs: 1 } }, terms), ['limits'])

  // The router's wrapped SOL account is missing, the treasury's exists: init creates the first, then the platform.
  const tokenAccount = { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(165) }
  const stub = { getMultipleAccountsInfo: async keys => keys.map(k => k.equals(terms.treasury) ? tokenAccount : null) }
  const signer = someone()
  const init = await buildBundlePlatformTransaction({ connection: stub, mode: 'init', signer, terms })
  assert.deepEqual(init.createdTokenAccounts.map(String), [terms.routerSol.toBase58()])
  assert.deepEqual(init.created.map(String), [terms.routerSol, platformAddress()].map(String))
  assert.equal(init.tx.instructions.length, 2)
  assert.ok(init.tx.instructions[1].programId.equals(BUNDLE_VAULT_PROGRAM_ID))
  assert.ok(init.tx.instructions[1].keys[0].pubkey.equals(signer) && init.tx.instructions[1].keys[0].isSigner, 'the upgrade authority signs')
  assert.equal((await buildBundlePlatformTransaction({ connection: stub, mode: 'init', signer, terms })).instructionSha256, init.instructionSha256)
  // Lamports someone sent to the router's account address do not make it a token account: it is still created.
  const funded = { getMultipleAccountsInfo: async keys => keys.map(k => k.equals(terms.treasury) ? tokenAccount
    : { lamports: 1_000_000, owner: SystemProgram.programId, data: Buffer.alloc(0) }) }
  assert.deepEqual((await buildBundlePlatformTransaction({ connection: funded, mode: 'init', signer, terms })).createdTokenAccounts.map(String),
    [terms.routerSol.toBase58()])
  const set = await buildBundlePlatformTransaction({ connection: { getMultipleAccountsInfo: async keys => keys.map(() => tokenAccount) },
    mode: 'set', signer, terms })
  assert.deepEqual(set.created, [], 'set_platform creates nothing when both token accounts exist')
  assert.equal(set.tx.instructions.length, 1)
  assert.ok(set.tx.instructions[0].keys[0].pubkey.equals(signer), 'the current admin signs')
  assert.notEqual(set.instructionSha256, init.instructionSha256)
  await assert.rejects(buildBundlePlatformTransaction({ connection: stub, mode: 'other', signer, terms }), /init or set/)
})
