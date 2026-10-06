import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Keypair, PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
import { ACC_SCALE, BPS, BUNDLE_ERRORS, BUNDLE_VAULT_PROGRAM_ID, MAX_FLOOR_BPS, MAX_OPS_BPS, MIN_LAUNCH_COOLDOWN_SECS, MIN_LAUNCH_GRACE_SECS,
  STATUS, backerAddress, backerShareBps, bundleAccounts, bundleAddress, bundleErrorName, cancelBundleInstruction, claimBackerFeesInstruction,
  createBundleInstruction, decodeBacker, decodePlatform, depositInstruction, failRaiseInstruction, initPlatformInstruction, launchAmounts,
  openVaultInstruction, pendingBackerFees, platformAddress, policyValid, recordGraduationInstruction, refundInstruction, releaseInstruction,
  routeCurveFeesInstruction, routePoolFeesInstruction, routerAddress, setPausedInstruction, setPlatformInstruction, setPolicyInstruction,
  settleInstruction, splitClaim, tighterOrEqual, tokenAccountOf, vaultAddress, vaultSwapCurveInstruction, vaultSwapPoolInstruction } from '../src/bundle-vault.mjs'
import { BUNDLE_DEFAULTS, BUNDLE_LAUNCHES_READY, bundleLaunchable, bundleLaunchesEnabled, prepareBundleLaunch } from '../src/bundle-launch.mjs'

const program = path => new URL(`../programs/bundle-vault/${path}`, import.meta.url)
const discriminator = name => createHash('sha256').update(name).digest().subarray(0, 8)
const someone = () => Keypair.generate().publicKey
const POLICY = { maxTradeBps: 200, maxDailyBuyBps: 1_000, maxDailySellBps: 100, floorBps: 10_000, gapSecs: 600 }

test('the client and the program agree on the program id, the constants, the error numbers and every instruction\'s accounts', async () => {
  const source = await readFile(program('src/lib.rs'), 'utf8')
  assert.equal(source.match(/declare_id!\("(\w+)"\)/)[1], BUNDLE_VAULT_PROGRAM_ID.toBase58())
  const constant = name => Number(source.match(new RegExp(`pub const ${name}: \\w+ = ([^;]+);`))[1].replaceAll('_', ''))
  assert.deepEqual([constant('BPS'), BigInt(constant('ACC_SCALE')), constant('MIN_LAUNCH_COOLDOWN_SECS'), constant('MIN_LAUNCH_GRACE_SECS'),
    constant('MAX_OPS_BPS'), constant('MAX_FLOOR_BPS')], [BPS, ACC_SCALE, MIN_LAUNCH_COOLDOWN_SECS, MIN_LAUNCH_GRACE_SECS, MAX_OPS_BPS, MAX_FLOOR_BPS])
  assert.deepEqual([constant('STATUS_RAISING'), constant('STATUS_LAUNCHED'), constant('STATUS_FAILED')], [STATUS.RAISING, STATUS.LAUNCHED, STATUS.FAILED])
  const variants = [...source.slice(source.indexOf('pub enum BundleError')).split('\n}')[0].matchAll(/^\s{4}(\w+),$/gm)].map(match => match[1])
  assert.deepEqual(variants, Object.values(BUNDLE_ERRORS))
  // Each instruction's accounts, in the order of its Accounts struct.
  const fields = name => [...source.slice(source.indexOf(`pub struct ${name}<'info> {`)).split('\n}')[0].matchAll(/^\s{4}pub (\w+):/gm)].map(m => m[1])
  const k = () => someone()
  const cases = {
    InitPlatform: initPlatformInstruction({ upgradeAuthority: k(), treasury: k(), admin: k(), launchSigner: k(), operators: [k()], opsWallet: k(),
      curveConfig: k(), dammConfig: k(), backerBps: 8_000, opsBps: 500, launchCooldownSecs: 180, launchGraceSecs: 60, limits: POLICY }),
    SetPlatform: setPlatformInstruction({ admin: k(), treasury: k(), launchSigner: k(), operators: [k()], opsWallet: k(), curveConfig: k(), dammConfig: k(),
      backerBps: 8_000, opsBps: 500, launchCooldownSecs: 180, launchGraceSecs: 60, limits: POLICY }),
    CreateBundle: createBundleInstruction({ creator: k(), admin: k(), id: 1, repoId: 2, target: 10n ** 9n, minDeposit: 10n ** 6n, deadline: 1, policy: POLICY }),
    Deposit: depositInstruction({ wallet: k(), id: 1, lamports: 1 }),
    AdminBundle: cancelBundleInstruction({ admin: k(), id: 1 }),
    FailRaise: failRaiseInstruction({ id: 1 }),
    Refund: refundInstruction({ wallet: k(), id: 1 }),
    Release: releaseInstruction({ launchSigner: k(), opsWallet: k(), id: 1 }),
    Settle: settleInstruction({ launchSigner: k(), id: 1, pool: k(), mint: k(), minTokens: 1 }),
    OpenVault: openVaultInstruction({ payer: k(), id: 1 }),
    VaultSwapCurve: vaultSwapCurveInstruction({ operator: k(), id: 1, mint: k(), pool: k(), config: k(), baseVault: k(), quoteVault: k(), buy: true,
      amountIn: 1, minimumOut: 1 }),
    RecordGraduation: recordGraduationInstruction({ admin: k(), id: 1, pool: k(), dammPool: k(), position: k(), positionNftAccount: k() }),
    VaultSwapPool: vaultSwapPoolInstruction({ operator: k(), id: 1, mint: k(), dammPool: k(), tokenAVault: k(), tokenBVault: k(), position: k(), buy: false,
      amountIn: 1, minimumOut: 1 }),
    RouteCurveFees: routeCurveFeesInstruction({ id: 1, mint: k(), pool: k(), config: k(), baseVault: k(), quoteVault: k(), treasury: k() }),
    RoutePoolFees: routePoolFeesInstruction({ id: 1, mint: k(), dammPool: k(), position: k(), positionNftAccount: k(), tokenAVault: k(), tokenBVault: k(),
      treasury: k() }),
    ClaimBackerFees: claimBackerFeesInstruction({ wallet: k(), id: 1 }),
  }
  for (const [name, ix] of Object.entries(cases)) {
    assert.equal(ix.keys.length, fields(name).length, `${name}: ${fields(name).join(', ')}`)
    assert.ok(ix.programId.equals(BUNDLE_VAULT_PROGRAM_ID))
  }
  assert.deepEqual(setPolicyInstruction({ admin: k(), id: 1, policy: POLICY }).data.subarray(0, 8), discriminator('global:set_policy'))
  assert.deepEqual(setPausedInstruction({ admin: k(), id: 1, paused: true }).data, Buffer.concat([discriminator('global:set_paused'), Buffer.from([1])]))
})

test('the program fixture was built from the sources in the tree (rebuild with scripts/build-bundle-vault.sh)', async () => {
  const hash = createHash('sha256')
  for (const path of ['Cargo.toml', 'Cargo.lock', 'src/lib.rs']) hash.update(await readFile(program(path)))
  const recorded = (await readFile(new URL('fixtures/validator/bundle_vault.sources.sha256', import.meta.url), 'utf8')).trim()
  assert.equal(hash.digest('hex'), recorded)
})

test('a bundle\'s accounts are the program\'s PDAs; settle names the bundle third, where release looks for it', () => {
  const id = 42, bundle = bundleAddress(id), wallet = someone(), mint = someone()
  const seeded = (...seeds) => PublicKey.findProgramAddressSync(seeds, BUNDLE_VAULT_PROGRAM_ID)[0].toBase58()
  const id8 = Buffer.alloc(8); id8.writeBigUInt64LE(42n)
  assert.equal(bundle.toBase58(), seeded(Buffer.from('bundle'), id8))
  assert.equal(backerAddress(bundle, wallet).toBase58(), seeded(Buffer.from('backer'), bundle.toBuffer(), wallet.toBuffer()))
  assert.equal(vaultAddress(bundle).toBase58(), seeded(Buffer.from('vault'), bundle.toBuffer()))
  assert.equal(routerAddress().toBase58(), seeded(Buffer.from('router')))
  assert.equal(platformAddress().toBase58(), seeded(Buffer.from('platform')))
  const accounts = bundleAccounts({ id, mint })
  assert.deepEqual([accounts.vaultSol, accounts.pot, accounts.vaultTokens, accounts.routerSol].map(String),
    [tokenAccountOf(accounts.vault, NATIVE_MINT), tokenAccountOf(bundle, NATIVE_MINT), tokenAccountOf(accounts.vault, mint), tokenAccountOf(accounts.router, NATIVE_MINT)].map(String))
  const settle = settleInstruction({ launchSigner: someone(), id, pool: someone(), mint, minTokens: 5 })
  assert.equal(settle.keys[2].pubkey.toBase58(), bundle.toBase58())
  assert.deepEqual(settle.data, Buffer.concat([discriminator('global:settle'), Buffer.from([5, 0, 0, 0, 0, 0, 0, 0])]))
})

test('create_bundle and deposit carry their arguments after the discriminator; launcher, admin and backer sign', () => {
  const creator = someone(), admin = someone(), wallet = someone()
  const create = createBundleInstruction({ creator, admin, id: 7, repoId: 1388219884, target: 20n * 10n ** 9n, minDeposit: 5n * 10n ** 8n,
    deadline: 1_791_250_000, policy: POLICY })
  assert.deepEqual(create.data.subarray(0, 8), discriminator('global:create_bundle'))
  assert.deepEqual([create.data.readBigUInt64LE(8), create.data.readBigUInt64LE(16), create.data.readBigUInt64LE(24), create.data.readBigUInt64LE(32),
    create.data.readBigInt64LE(40)], [7n, 1388219884n, 20n * 10n ** 9n, 5n * 10n ** 8n, 1_791_250_000n])
  assert.deepEqual([create.data.readUInt16LE(48), create.data.readUInt16LE(50), create.data.readUInt16LE(52), create.data.readUInt16LE(54),
    create.data.readUInt32LE(56)], [200, 1_000, 100, 10_000, 600])
  assert.equal(create.data.length, 60)
  assert.deepEqual(create.keys.filter(meta => meta.isSigner).map(meta => meta.pubkey.toBase58()), [creator, admin].map(String))
  const deposit = depositInstruction({ wallet, id: 7, lamports: 123n })
  assert.equal(deposit.data.readBigUInt64LE(8), 123n)
  assert.deepEqual(deposit.keys.filter(meta => meta.isSigner).map(meta => meta.pubkey.toBase58()), [wallet.toBase58()])
  assert.throws(() => createBundleInstruction({ creator, admin, id: 1, repoId: 1, target: 1, minDeposit: 1, deadline: 1, policy: { ...POLICY, maxTradeBps: 10_001 } }))
  assert.throws(() => initPlatformInstruction({ upgradeAuthority: someone(), treasury: someone(), admin, launchSigner: admin, operators: [],
    opsWallet: admin, curveConfig: admin, dammConfig: admin, backerBps: 8_000, opsBps: 500, launchCooldownSecs: 180, launchGraceSecs: 60, limits: POLICY }),
  /operators/)
})

test('the launch pays 5% to operations and buys with the rest', () => {
  assert.deepEqual(launchAmounts(20n * 10n ** 9n, 500), { ops: 10n ** 9n, buy: 19n * 10n ** 9n })
  assert.deepEqual(launchAmounts(1_000_000_001n, 500), { ops: 50_000_000n, buy: 950_000_001n }, 'rounding goes to the buy')
})

test('a routed claim pays the vault its own partner fees first; backers get 80% of the rest, repo.ing the remainder with the rounding', () => {
  assert.deepEqual(splitClaim(1_000n, 300n, 8_000, 20n * 10n ** 9n), { rebate: 300n, toBackers: 560n, toTreasury: 140n,
    accIncrement: 560n * ACC_SCALE / (20n * 10n ** 9n) })
  assert.deepEqual(splitClaim(200n, 300n, 8_000, 1n).rebate, 200n, 'a claim smaller than what the vault is owed all goes back to the vault')
  assert.deepEqual(splitClaim(200n, 300n, 8_000, 1n).toBackers, 0n)
  assert.deepEqual(splitClaim(7n, 0n, 8_000, 3n), { rebate: 0n, toBackers: 5n, toTreasury: 2n, accIncrement: 5n * ACC_SCALE / 3n })
  // Many claims and odd shares: the backers' payouts never exceed their income, and lose at most one lamport each to rounding.
  let seed = 7
  const random = max => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return BigInt(seed) % max }
  const shares = [9_999_999_999n, 7_000_000_003n, 2_999_999_998n, 1n], raised = shares.reduce((a, b) => a + b, 0n)
  const bundle = { accPerShare: 0n, raised }
  let income = 0n, owed = 0n
  for (let i = 0; i < 500; i++) {
    owed += random(5_000n)
    const split = splitClaim(random(100_000n) + 1n, owed, 8_000, raised)
    owed -= split.rebate
    income += split.toBackers
    bundle.accPerShare += split.accIncrement
    assert.equal(split.rebate + split.toBackers + split.toTreasury >= split.rebate, true)
  }
  const paid = shares.map(value => pendingBackerFees(bundle, { shares: value, paid: 0n }))
  const total = paid.reduce((a, b) => a + b, 0n)
  // Each routing can leave less than raised / ACC_SCALE per share unpaid, each claim less than one lamport.
  const bound = BigInt(shares.length) + (500n * raised + ACC_SCALE - 1n) / ACC_SCALE
  assert.ok(total <= income && income - total <= bound, `${income} income, ${total} paid`)
  assert.equal(pendingBackerFees(bundle, { shares: shares[0], paid: paid[0] }), 0n, 'nothing twice')
  assert.equal(backerShareBps({ raised }, { shares: shares[0] }), 4_999)
})

test('vault policies: the program\'s checks; the defaults are within the limits', () => {
  assert.equal(policyValid(POLICY), true)
  for (const bad of [{ maxTradeBps: 10_001 }, { maxDailyBuyBps: -1 }, { maxDailySellBps: 1.5 }, { floorBps: MAX_FLOOR_BPS + 1 }, { gapSecs: -1 }]) {
    assert.equal(policyValid({ ...POLICY, ...bad }), false, JSON.stringify(bad))
  }
  assert.equal(tighterOrEqual(BUNDLE_DEFAULTS.policy, BUNDLE_DEFAULTS.limits), true)
  assert.equal(tighterOrEqual({ ...BUNDLE_DEFAULTS.policy, floorBps: 9_999 }, BUNDLE_DEFAULTS.limits), false, 'a lower floor is looser')
  assert.equal(tighterOrEqual({ ...BUNDLE_DEFAULTS.policy, gapSecs: 1 }, BUNDLE_DEFAULTS.limits), false, 'a shorter gap is looser')
  assert.deepEqual([BUNDLE_DEFAULTS.opsBps, BUNDLE_DEFAULTS.backerBps, BUNDLE_DEFAULTS.launchCooldownSecs], [500, 8_000, MIN_LAUNCH_COOLDOWN_SECS])
})

test('bundle launches are dark: off unless exactly "true", and closed by the code gate even then', () => {
  assert.equal(BUNDLE_LAUNCHES_READY, false)
  assert.equal(bundleLaunchesEnabled({}), false)
  for (const value of ['TRUE', '1', 'yes', ' true']) assert.equal(bundleLaunchesEnabled({ BUNDLE_LAUNCHES_ENABLED: value }), false, value)
  assert.equal(bundleLaunchesEnabled({ BUNDLE_LAUNCHES_ENABLED: 'true' }), true)
  assert.equal(bundleLaunchable({ BUNDLE_LAUNCHES_ENABLED: 'true' }), false)
  assert.throws(() => prepareBundleLaunch({}, { BUNDLE_LAUNCHES_ENABLED: 'true' }), error => error.code === 'BUNDLE_LAUNCHES_DISABLED')
})

test('errors: only a failure that starts in this program is named as its error', () => {
  const ours = BUNDLE_VAULT_PROGRAM_ID.toBase58()
  const hex = number => `0x${number.toString(16)}`
  assert.equal(bundleErrorName(`Program ${ours} failed: custom program error: ${hex(6026)}`), 'LaunchCooldown')
  assert.equal(bundleErrorName(`Program ${ours} failed: custom program error: ${hex(7000)}`), null, 'not one of its numbers')
  // DBC refuses inside a vault trade: the same number, but not this program's error.
  assert.equal(bundleErrorName(`Program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN failed: custom program error: ${hex(6026)}\n` +
    `Program ${ours} failed: custom program error: ${hex(6026)}`), null)
  assert.equal(bundleErrorName('nothing'), null)
})

test('accounts decode from the program\'s layout', () => {
  const key = () => someone()
  const platform = [key(), key(), key(), PublicKey.default, PublicKey.default, PublicKey.default, key(), key(), key(), key(), key()]
  // admin, launch signer, 4 operator slots, ops wallet, treasury, router SOL, curve config, DAMM config; then the numbers, then reserved bytes.
  const buffer = Buffer.concat([discriminator('account:Platform'), ...platform.map(value => value.toBuffer()),
    Buffer.from([0x40, 0x1f, 0xf4, 0x01]), Buffer.from([180, 0, 0, 0, 60, 0, 0, 0]),
    Buffer.from([200, 0, 232, 3, 100, 0, 16, 39, 88, 2, 0, 0]), Buffer.from([254]), Buffer.alloc(64)])
  const decoded = decodePlatform(buffer)
  assert.deepEqual([decoded.admin, decoded.launchSigner, decoded.operators[0], decoded.opsWallet, decoded.dammConfig].map(String),
    [platform[0], platform[1], platform[2], platform[6], platform[10]].map(String))
  assert.equal(decoded.operators.length, 1, 'unused operator slots are dropped')
  assert.deepEqual([decoded.backerBps, decoded.opsBps, decoded.launchCooldownSecs, decoded.launchGraceSecs, decoded.limits, decoded.bump],
    [8_000, 500, 180, 60, POLICY, 254])
  const backer = Buffer.concat([discriminator('account:Backer'), key().toBuffer(), key().toBuffer(), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]),
    Buffer.from([2, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([9])])
  assert.deepEqual([decodeBacker(backer).shares, decodeBacker(backer).paid, decodeBacker(backer).bump], [1n, 2n, 9])
  assert.throws(() => decodeBacker(buffer), /Not a bundle backer/)
})
