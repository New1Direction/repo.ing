import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { EARLY_ACCESS_HOOK_PROGRAM_ID, HOOK_ERRORS, MAX_ALLOW_LIST, MAX_EARLY_ACCESS_SECONDS, MAX_WALLETS_PER_CALL, addWalletsInstruction, closeAllowListInstruction, decodeAllowList, decodeMintConfig,
  decodePlatform, earlyAccessAddresses, hookErrorName, initMintInstruction, initPlatformInstruction, platformAddress, programDataAddress,
  removeWalletsInstruction, setPlatformInstruction, transferHookAccounts } from '../src/early-access-hook.mjs'

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
  const variants = [...source.slice(source.indexOf('pub enum HookError')).split('\n}')[0].matchAll(/^\s{4}(\w+),$/gm)].map(match => match[1])
  assert.deepEqual(variants, Object.values(HOOK_ERRORS))
})

test('the program fixture was built from the sources in the tree (rebuild with scripts/build-early-access-hook.sh)', async () => {
  const hash = createHash('sha256')
  for (const path of ['Cargo.toml', 'Cargo.lock', 'src/lib.rs']) hash.update(await readFile(program(path)))
  const recorded = (await readFile(new URL('fixtures/validator/early_access_hook.sources.sha256', import.meta.url), 'utf8')).trim()
  assert.equal(hash.digest('hex'), recorded)
})

test('a mint\'s accounts are the program\'s PDAs of the mint, and a transfer names them before the hook and its list', () => {
  const addresses = earlyAccessAddresses(mint)
  const seeded = seed => PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], EARLY_ACCESS_HOOK_PROGRAM_ID)[0]
  assert.deepEqual([addresses.config, addresses.allowList, addresses.extraAccountMetas].map(String),
    [seeded('config'), seeded('allow'), seeded('extra-account-metas')].map(String))
  assert.deepEqual(transferHookAccounts(mint).map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]), [
    [addresses.config.toBase58(), false, false], [addresses.allowList.toBase58(), false, false],
    [EARLY_ACCESS_HOOK_PROGRAM_ID.toBase58(), false, false], [addresses.extraAccountMetas.toBase58(), false, false]])
  assert.notEqual(earlyAccessAddresses(Keypair.generate().publicKey).config.toBase58(), addresses.config.toBase58())
})

test('init_mint carries the repo id, the window end and the wallets after its discriminator; payer and admin sign', () => {
  const payer = Keypair.generate().publicKey, admin = Keypair.generate().publicKey, wallet = Keypair.generate().publicKey
  const ix = initMintInstruction({ payer, admin, mint, repoId: 1388219884, earlyAccessEnd: 1_791_250_000, wallets: [wallet] })
  assert.deepEqual(ix.data.subarray(0, 8), discriminator('global:init_mint'))
  assert.equal(ix.data.readBigUInt64LE(8), 1388219884n)
  assert.equal(ix.data.readBigInt64LE(16), 1_791_250_000n)
  assert.equal(ix.data.readUInt32LE(24), 1)
  assert.deepEqual(ix.data.subarray(28, 60), wallet.toBuffer())
  assert.equal(ix.data.length, 60)
  const { config, allowList, extraAccountMetas } = earlyAccessAddresses(mint)
  assert.deepEqual(ix.keys.map(meta => [meta.pubkey.toBase58(), meta.isSigner, meta.isWritable]), [
    [payer.toBase58(), true, true], [admin.toBase58(), true, false], [platformAddress().toBase58(), false, false], [mint.toBase58(), false, false],
    [config.toBase58(), false, true], [allowList.toBase58(), false, true], [extraAccountMetas.toBase58(), false, true],
    [SystemProgram.programId.toBase58(), false, false]])
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 1.5 }), /unix time/)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 0 }), /unix time/, 'no "off" window')
  const tooMany = Array.from({ length: MAX_WALLETS_PER_CALL + 1 }, () => Keypair.generate().publicKey)
  assert.throws(() => initMintInstruction({ payer, admin, mint, repoId: 1, earlyAccessEnd: 1, wallets: tooMany }), /At most 24/)
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
  const config = Buffer.concat([discriminator('account:MintConfig'), mint.toBuffer(), Buffer.alloc(8), Buffer.alloc(8), receiver.toBuffer(), Buffer.alloc(8),
    Buffer.from([253, 254])])
  config.writeBigUInt64LE(42n, 40); config.writeBigInt64LE(1_791_250_000n, 48); config.writeBigUInt64LE(1_670_400n, 88)
  assert.deepEqual({ ...decodeMintConfig(config), mint: undefined, rentReceiver: undefined },
    { mint: undefined, repoId: '42', earlyAccessEnd: 1_791_250_000, rentReceiver: undefined, listDeposit: 1_670_400n, allowBump: 253, bump: 254 })
  assert.equal(decodeMintConfig(config).rentReceiver.toBase58(), receiver.toBase58())
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
