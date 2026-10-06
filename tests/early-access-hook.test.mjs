import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { BPS, EARLY_ACCESS_HOOK_PROGRAM_ID, HOOK_ERRORS, MAX_ALLOW_LIST, MAX_EARLY_ACCESS_SECONDS, MAX_WALLETS_PER_CALL, RULES, addWalletsInstruction,
  closeAllowListInstruction, dbcBaseVault, reportStarsInstruction, walletCapBps, decodeAllowList, decodeMintConfig,
  decodePlatform, earlyAccessAddresses, hookErrorName, initMintInstruction, initPlatformInstruction, platformAddress, programDataAddress,
  removeWalletsInstruction, setPlatformInstruction, transferHookAccounts } from '../src/early-access-hook.mjs'
const vault = Keypair.generate().publicKey, pool = Keypair.generate().publicKey

const discriminator = name => createHash('sha256').update(name).digest().subarray(0, 8)
const mint = new PublicKey('So11111111111111111111111111111111111111112')

const program = path => new URL(`../programs/early-access-hook/${path}`, import.meta.url)

test('the client and the program agree on the program id, the limits and the error numbers', async () => {
  const source = await readFile(program('src/lib.rs'), 'utf8')
  assert.equal(source.match(/declare_id!\("(\w+)"\)/)[1], EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58())
  const constant = name => source.match(new RegExp(`pub const ${name}: \\w+ = ([^;]+);`))[1]
  assert.equal(constant('MAX_EARLY_ACCESS_SECS').split('*').reduce((product, factor) => product * Number(factor), 1), MAX_EARLY_ACCESS_SECONDS)
  assert.equal(Number(constant('MAX_WALLETS_PER_CALL')), MAX_WALLETS_PER_CALL)
  assert.equal(Number(constant('MAX_ALLOW_LIST')), MAX_ALLOW_LIST)
  assert.deepEqual([Number(constant('RULE_EARLY_ACCESS')), Number(constant('RULE_FAIR_RAMP')), Number(constant('RULE_STAR_UNLOCKS'))],
    [RULES.EARLY_ACCESS, RULES.FAIR_RAMP, RULES.STAR_UNLOCKS])
  assert.equal(Number(constant('BPS').replace('_', '')), BPS)
  const variants = [...source.slice(source.indexOf('pub enum HookError')).split('\n}')[0].matchAll(/^\s{4}(\w+),$/gm)].map(match => match[1])
  assert.deepEqual(variants, Object.values(HOOK_ERRORS))
})

test('the program fixture was built from the sources in the tree (rebuild with scripts/build-early-access-hook.sh)', async () => {
  const hash = createHash('sha256')
  for (const path of ['Cargo.toml', 'Cargo.lock', 'src/lib.rs']) hash.update(await readFile(program(path)))
  const recorded = (await readFile(new URL('fixtures/validator/early_access_hook.sources.sha256', import.meta.url), 'utf8')).trim()
  assert.equal(hash.digest('hex'), recorded)
})

test('a mint\'s accounts are the program\'s PDAs of the mint, and a transfer names them and the vault before the hook and its list', () => {
  const addresses = earlyAccessAddresses(mint)
  const seeded = seed => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], EARLY_ACCESS_HOOK_PROGRAM_ID)[0]
  assert.deepEqual([addresses.config, addresses.allowList, addresses.extraAccountMetas].map(String),
    [seeded('config'), seeded('allow'), seeded('extra-account-metas')].map(String))
  assert.deepEqual(transferHookAccounts(mint, vault).map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]), [
    [addresses.config.toBase58(), false, false], [addresses.allowList.toBase58(), false, false], [vault.toBase58(), false, false],
    [EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58(), false, false], [addresses.extraAccountMetas.toBase58(), false, false]])
  const pool = Keypair.generate().publicKey, dbc = new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN')
  assert.equal(dbcBaseVault(mint, pool).toBase58(),
    PublicKey.findProgramAddressSync([Buffer.from('token_vault'), mint.toBuffer(), pool.toBuffer()], dbc)[0].toBase58(), 'DBC\'s base vault PDA')
  assert.notEqual(earlyAccessAddresses(Keypair.generate().publicKey).config.toBase58(), addresses.config.toBase58())
})

test('init_mint carries its arguments after the discriminator; payer and admin sign', () => {
  const payer = Keypair.generate().publicKey, admin = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey
  const ix = initMintInstruction({ payer, admin, mint, repoId: 1388219884, earlyAccessEnd: 1_791_250_000, wallets: [wallet], pool, vault })
  assert.deepEqual(ix.data.subarray(0, 8), discriminator('global:init_mint'))
  assert.equal(ix.data.readBigUInt64LE(8), 1388219884n)
  assert.equal(ix.data[16], RULES.EARLY_ACCESS, 'early access by default')
  assert.equal(ix.data.readBigInt64LE(17), 1_791_250_000n)
  assert.equal(ix.data.readUInt32LE(25), 1)
  assert.deepEqual(ix.data.subarray(29, 61), wallet.toBuffer())
  assert.deepEqual(ix.data.subarray(61), Buffer.from([0]), 'no ramp settings (None)')
  assert.equal(ix.data.length, 62)
  const { config, allowList, extraAccountMetas } = earlyAccessAddresses(mint)
  assert.deepEqual(ix.keys.map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]), [
    [payer.toBase58(), true, true], [admin.toBase58(), true, false], [platformAddress().toBase58(), false, false], [mint.toBase58(), false, false],
    [pool.toBase58(), false, false], [vault.toBase58(), false, false], [config.toBase58(), false, true], [allowList.toBase58(), false, true], [extraAccountMetas.toBase58(), false, true],
    [SystemProgram.programId.toBase58(), false, false]])
  // The fair ramp with star unlocks, no early access: the ramp settings in order (u16, u16, u64, u64, u32, u32, u16).
  const ramp = initMintInstruction({ payer, admin, mint, repoId: 7, rules: RULES.FAIR_RAMP | RULES.STAR_UNLOCKS, vault,
    pool, ramp: { startBps: 200, endCapBps: 1000, vaultStart: 10n ** 15n, vaultEnd: 4n * 10n ** 14n, starsAtLaunch: 12, starStep: 100, starBonusBps: 50,
      starMaxBonusBps: 500 } })
  const data = ramp.data
  assert.deepEqual([data[16], data.readBigInt64LE(17), data.readUInt32LE(25)], [6, 0n, 0])
  assert.deepEqual([data[29], data.readUInt16LE(30), data.readUInt16LE(32), data.readBigUInt64LE(34), data.readBigUInt64LE(42), data.readUInt32LE(50),
    data.readUInt32LE(54), data.readUInt16LE(58), data.readUInt16LE(60), data.length], [1, 200, 1000, 10n ** 15n, 4n * 10n ** 14n, 12, 100, 50, 500, 62])
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 1.5, vault, pool }), /unix time/)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 0, vault, pool }), /unix time/, 'no "off" window with early access')
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, rules: RULES.FAIR_RAMP, earlyAccessEnd: 5, vault, pool }), /no window/)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, rules: RULES.STAR_UNLOCKS, vault, pool }), /needs the fair ramp/)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, rules: 0, vault, pool }), /non-empty/)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 5, pool }), /base vault/)
  const tooMany = Array.from({ length: MAX_WALLETS_PER_CALL + 1 }, () => Keypair.generate().publicKey)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 1, wallets: tooMany, vault, pool }), /At most 24/)
})

test('report_stars: the oracle signs, the mint config is written', () => {
  const oracle = Keypair.generate().publicKey, ix = reportStarsInstruction({ oracle, mint, stars: 1234 })
  assert.deepEqual(ix.data, Buffer.concat([discriminator('global:report_stars'), Buffer.from([0xd2, 0x04, 0, 0])]))
  assert.deepEqual(ix.keys.map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]), [[oracle.toBase58(), true, false],
    [platformAddress().toBase58(), false, false], [earlyAccessAddresses(mint).config.toBase58(), false, true]])
  assert.throws(() => reportStarsInstruction({ oracle, mint, stars: -1 }), /whole number/)
})

test('the wallet limit: 2% rising to 10% across the ramp, none past it, stars add 0.5% per 100 up to their cap', () => {
  const ramp = { startBps: 200, endCapBps: 1000, vaultStart: 1000n, vaultEnd: 600n, starsAtLaunch: 50, starStep: 100, starBonusBps: 50, starMaxBonusBps: 500 }
  const config = (rules, starsNow = 50) => ({ rules, ramp, starsNow })
  assert.equal(walletCapBps(config(RULES.EARLY_ACCESS), 1000n), null, 'no ramp, no limit')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 1000n), 200)
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 800n), 600, 'halfway: 6%')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 601n), 998)
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 600n), null, 'the ramp is over')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 1200n), 200, 'a vault above its start counts as nothing sold')
  // A wallet's own tokens are not progress for it: the one that bought all 200 sold so far still sees 2%.
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 800n, 200n), 200)
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 800n, 50n), 500, '150 sold by others: 5%')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 500n, 50n), null, 'others sold the span')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP), 500n, 150n), 900, 'without its own 150, others sold 350 of 400: 9%')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP | RULES.STAR_UNLOCKS, 349), 1000n), 300, '299 stars gained: 2 steps')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP | RULES.STAR_UNLOCKS, 10), 1000n), 200, 'stars lost never lower the start')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP | RULES.STAR_UNLOCKS, 4_000_000_000), 1000n), 700, 'any star count adds at most the cap (+5%)')
  assert.equal(walletCapBps(config(RULES.FAIR_RAMP, 99999), 1000n), 200, 'stars count only with star unlocks')
})

test('the other instructions carry their discriminators and accounts', () => {
  const authority = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey
  const add = addWalletsInstruction({ oracle: authority, mint, wallets: [wallet] }), remove = removeWalletsInstruction({ authority, mint, wallets: [wallet] })
  assert.deepEqual([add.data.subarray(0, 8), remove.data.subarray(0, 8)], [discriminator('global:add_wallets'), discriminator('global:remove_wallets')])
  assert.deepEqual(add.keys.map(meta => [meta.isSigner, meta.isWritable]), [[true, true], [false, false], [false, false], [false, true], [false, false]])
  assert.deepEqual(remove.keys.map(meta => [meta.isSigner, meta.isWritable]), [[true, false], [false, false], [false, false], [false, true]])
  const oracle = Keypair.generate().publicKey
  const close = closeAllowListInstruction({ mint, rentReceiver: authority, oracle })
  assert.deepEqual(close.data, discriminator('global:close_allow_list'))
  assert.deepEqual(close.keys.map(meta => [meta.pubkey.toBase58(), meta.isWritable]), [[earlyAccessAddresses(mint).config.toBase58(), false],
    [platformAddress().toBase58(), false], [earlyAccessAddresses(mint).allowList.toBase58(), true], [authority.toBase58(), true], [oracle.toBase58(), true]])
  const set = setPlatformInstruction({ admin: authority, newAdmin: wallet, newOracle: authority })
  assert.deepEqual(set.data, Buffer.concat([discriminator('global:set_platform'), wallet.toBuffer(), authority.toBuffer()]))
  assert.deepEqual(set.keys.map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]),
    [[authority.toBase58(), true, false], [platformAddress().toBase58(), false, true]])
  const platform = initPlatformInstruction({ upgradeAuthority: authority, admin: wallet, oracle: wallet })
  assert.equal(platform.keys[3].pubkey.toBase58(), programDataAddress().toBase58())
  assert.equal(platform.data.length, 8 + 64)
})

test('accounts decode from their layouts and refuse anything else', () => {
  const wallets = [Keypair.generate().publicKey, Keypair.generate().publicKey]
  const list = Buffer.concat([Buffer.from('ea-allow'), mint.toBuffer(), Buffer.from([2, 0, 0, 0]), ...wallets.map(wallet => wallet.toBuffer())])
  const decoded = decodeAllowList(list)
  assert.deepEqual([decoded.mint.toBase58(), decoded.wallets.map(String)], [mint.toBase58(), wallets.map(String)])
  assert.throws(() => decodeAllowList(list.subarray(0, list.length - 1)), /shorter/)
  const receiver = Keypair.generate().publicKey
  const config = Buffer.alloc(175)
  discriminator('account:MintConfig').copy(config, 0); mint.toBuffer().copy(config, 8); config.writeBigUInt64LE(42n, 40); config[48] = 7
  config.writeBigInt64LE(1_791_250_000n, 49); receiver.toBuffer().copy(config, 57); config.writeBigUInt64LE(1_670_400n, 89); config[97] = 253; config[98] = 254
  vault.toBuffer().copy(config, 99); config.writeUInt16LE(200, 131); config.writeUInt16LE(1000, 133); config.writeBigUInt64LE(1000n, 135)
  config.writeBigUInt64LE(600n, 143); config.writeUInt32LE(50, 151); config.writeUInt32LE(100, 155); config.writeUInt16LE(50, 159); config.writeUInt16LE(500, 161)
  config.writeUInt32LE(450, 163); config.writeBigInt64LE(1_791_000_000n, 167)
  const decodedConfig = decodeMintConfig(config)
  assert.deepEqual({ ...decodedConfig, mint: undefined, rentReceiver: undefined, vault: undefined }, { mint: undefined, repoId: '42', rules: 7,
    earlyAccessEnd: 1_791_250_000, rentReceiver: undefined, listDeposit: 1_670_400n, allowBump: 253, bump: 254, vault: undefined,
    ramp: { startBps: 200, endCapBps: 1000, vaultStart: 1000n, vaultEnd: 600n, starsAtLaunch: 50, starStep: 100, starBonusBps: 50, starMaxBonusBps: 500 },
    starsNow: 450, starsUpdatedAt: 1_791_000_000 })
  assert.deepEqual([decodedConfig.rentReceiver.toBase58(), decodedConfig.vault.toBase58()], [receiver.toBase58(), vault.toBase58()])
  assert.equal(walletCapBps(decodedConfig, 1000n), 400, 'the decoded config feeds the limit: 2% + 4 star steps')
  assert.throws(() => decodeMintConfig(list), /mint config/)
  const platform = Buffer.concat([discriminator('account:Platform'), receiver.toBuffer(), mint.toBuffer(), Buffer.from([255])])
  assert.deepEqual([decodePlatform(platform).admin.toBase58(), decodePlatform(platform).oracle.toBase58()], [receiver.toBase58(), mint.toBase58()])
})

test('a hook error is named only from the hook\'s own failure', () => {
  const hook = EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58()
  assert.equal(hookErrorName(`Program ${hook} failed: custom program error: 0x177a`), 'NotContributor')
  assert.equal(hookErrorName(`Program ${hook} failed: custom program error: 0x1779`), 'NotAssociatedAccount')
  // DBC (and Token-2022) report the same number when the hook fails inside them, and DBC has its own errors in that range.
  assert.equal(hookErrorName('Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: 0x1770'), null)
  assert.equal(hookErrorName(undefined), null)
})
