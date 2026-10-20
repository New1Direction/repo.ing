// Native-SOL launch helpers against the reviewed hook-lab vectors (feat/native-sol e357fdf): the launch Config's switch
// byte, the v4 economics hashes, the governed switch digest and the two new launch instructions. No RPC or keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { loadNativeArtifacts, NATIVE_ELF, NATIVE_IDL_SHA256 } from '../src/hooklab-native-pins.mjs'
import { PROGRAMS } from '../src/hooklab-owner-driver/pins.mjs'
import { NATIVE_LAUNCHES_FLAG, nativeLaunchesEnabled, nativeLaunchesSwitch, nativeEconomicsHash, nativeLaunchesDigest, governedSetNativeLaunches,
  claimCreatorFeesSol, launchIsNative, poolIsNative, isNativeElfPin, nativeProgramDataMatches, CREATE_LAUNCH_V3_DISCRIMINATOR, CREATE_LAUNCH_V4_DISCRIMINATOR } from '../src/hooklab-native-launch.mjs'

const { vectors, coders } = loadNativeArtifacts()
const key = n => new PublicKey(Buffer.alloc(32, n)).toBase58()
const disc = name => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)
const config = (switchByte = 0, tail = {}) => { const b = Buffer.alloc(250); disc('Config').copy(b); b[186] = switchByte; for (const [i, v] of Object.entries(tail)) b[i] = v; return b }

test('the switch is HOOK_NATIVE_LAUNCHES_ENABLED=true, off by default', () => {
  assert.equal(NATIVE_LAUNCHES_FLAG, 'HOOK_NATIVE_LAUNCHES_ENABLED')
  assert.equal(nativeLaunchesEnabled({}), false); assert.equal(nativeLaunchesEnabled({ HOOK_NATIVE_LAUNCHES_ENABLED: '1' }), false)
  assert.equal(nativeLaunchesEnabled({ HOOK_NATIVE_LAUNCHES_ENABLED: 'true' }), true)
})

test('the native-launches switch is launch Config byte 186, 0 or 1; the rest of the reserved bytes hold open creation or zero', () => {
  assert.equal(nativeLaunchesSwitch(config(0)), false); assert.equal(nativeLaunchesSwitch(config(1)), true)
  assert.equal(nativeLaunchesSwitch(config(1, { 187: 1, 188: 50, 196: 100 })), true, 'open creation on, with one-choice menus')
  assert.throws(() => nativeLaunchesSwitch(config(2)), /switch byte 186 is 2/)
  assert.throws(() => nativeLaunchesSwitch(config(1, { 187: 2 })), /reserved bytes after the switch are not a state/)
  assert.throws(() => nativeLaunchesSwitch(config(1, { 249: 1 })), /reserved bytes after the switch are not a state/)
  assert.throws(() => nativeLaunchesSwitch(config(0).subarray(0, 249)), /Not a launch Config/)
  const wrong = config(0); wrong[0] ^= 1; assert.throws(() => nativeLaunchesSwitch(wrong), /Not a launch Config/)
})

test('v4 economics layer the quote form on the v3 hashes exactly as the reviewed vectors', () => {
  for (const [name, role] of [['pool', 'pool'], ['launch_none', 'launch'], ['launch_selected', 'launch']])
    for (const form of [0, 1])
      assert.equal(nativeEconomicsHash(role, Buffer.from(vectors[`${name}_v3_hash`], 'hex'), form).toString('hex'), vectors[`${name}_v4_form${form}_hash`], `${name} form ${form}`)
  assert.equal(nativeEconomicsHash('pool', Buffer.from(vectors.pool_v3_hash, 'hex')).toString('hex'), vectors.pool_v4_form1_hash, 'native is the default form')
  assert.throws(() => nativeEconomicsHash('swap', Buffer.alloc(32)), /economics role/)
  assert.throws(() => nativeEconomicsHash('pool', Buffer.alloc(31)), /32-byte v3/)
})

test('the governed switch: its recorded digest and its instruction bytes and accounts', () => {
  for (const on of [false, true]) assert.equal(nativeLaunchesDigest(PROGRAMS.launch, key(9), on).toString('hex'), vectors[`native_launches_on${Number(on)}_digest`])
  const ix = governedSetNativeLaunches({ launchProgram: PROGRAMS.launch, admin: key(1), expected: Buffer.alloc(32, 12), on: true })
  assert.equal(ix.data.toString('hex'), vectors.governed_set_native_launches_data)
  const [config, governance, events] = ['config', 'governance', '__event_authority'].map(seed => PublicKey.findProgramAddressSync([Buffer.from(seed)], new PublicKey(PROGRAMS.launch))[0].toBase58())
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[key(1), true, false], [config, false, true], [governance, false, true], [events, false, false], [PROGRAMS.launch, false, false]])
  assert.equal(governedSetNativeLaunches({ launchProgram: PROGRAMS.launch, admin: key(1), expected: Buffer.alloc(32, 12), on: false }).data.at(-1), 0)
  assert.throws(() => governedSetNativeLaunches({ launchProgram: PROGRAMS.launch, admin: key(1), expected: Buffer.alloc(31), on: true }), /32-byte/)
  assert.throws(() => governedSetNativeLaunches({ launchProgram: PROGRAMS.launch, admin: key(1), expected: Buffer.alloc(32), on: 1 }), /on must be true or false/)
})

test('the creator claim: creator signs and is paid, the launch PDA is debited; no amount argument', () => {
  const mint = key(4), ix = claimCreatorFeesSol({ launchProgram: PROGRAMS.launch, creator: key(5), mint })
  assert.equal(ix.data.toString('hex'), vectors.claim_creator_fees_sol_data)
  const launch = PublicKey.findProgramAddressSync([Buffer.from('launch'), new PublicKey(mint).toBuffer()], new PublicKey(PROGRAMS.launch))[0].toBase58()
  const events = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(PROGRAMS.launch))[0].toBase58()
  assert.deepEqual(ix.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[key(5), true, true], [launch, false, true], [events, false, false], [PROGRAMS.launch, false, false]])
})

test('create_launch_custom_v4 is v3 with the quote form after the fee model, under its own discriminator', () => {
  const data = Buffer.from(vectors.create_launch_custom_v4_data, 'hex'), decoded = coders.launch.instruction.decode(data)
  assert.equal(decoded.name, 'create_launch_custom_v4'); assert.equal(decoded.data.quote_form, 1); assert.equal(decoded.data.fee_model, 2)
  assert.ok(data.subarray(0, 8).equals(CREATE_LAUNCH_V4_DISCRIMINATOR))
  assert.ok(coders.launch.instruction.encode('create_launch_custom_v4', decoded.data).equals(data))
  const { quote_form: ignored, ...v3 } = decoded.data, v3Data = coders.launch.instruction.encode('create_launch_custom_v3', v3)
  assert.ok(v3Data.subarray(0, 8).equals(CREATE_LAUNCH_V3_DISCRIMINATOR))
  assert.ok(Buffer.concat([CREATE_LAUNCH_V4_DISCRIMINATOR, v3Data.subarray(8, -64), Buffer.from([1]), v3Data.subarray(-64)]).equals(data))
  assert.equal(decoded.data.guard.expected_launch_economics_hash.length, 32); assert.ok(BN.isBN(decoded.data.args.virtual_quote))
})

test('the flag bytes: launch 560 (528 without a hook) and pool 351 (319 without), read by the Option tag', () => {
  const launch = (tag, flag) => { const b = Buffer.alloc(565); disc('Launch').copy(b); b[498] = tag; if (flag !== undefined) b[tag === 1 ? 560 : 528] = flag; return b }
  const pool = (tag, flag) => { const b = Buffer.alloc(411); disc('Pool').copy(b); b[171] = tag; if (flag !== undefined) b[tag === 1 ? 351 : 319] = flag; return b }
  assert.equal(launchIsNative(launch(1, 1)), true); assert.equal(launchIsNative(launch(1, 0)), false); assert.equal(launchIsNative(launch(0, 1)), true)
  assert.equal(poolIsNative(pool(1, 1)), true); assert.equal(poolIsNative(pool(0, 0)), false); assert.equal(poolIsNative(pool(0, 1)), true)
  assert.throws(() => launchIsNative(launch(2)), /option tag/); assert.throws(() => launchIsNative(launch(1, 2)), /flag byte/)
  assert.throws(() => poolIsNative(pool(1).subarray(0, 410)), /Not a Pool/); assert.throws(() => launchIsNative(pool(1)), /Not a Launch/)
})

test('native profiles pin the reviewed ELFs, raw or trimmed, and the vendored IDLs', () => {
  for (const role of ['launch', 'swap']) {
    const e = NATIVE_ELF[role]
    assert.equal(isNativeElfPin(role, e.sha256, e.length), true); assert.equal(isNativeElfPin(role, e.trimmedSha256, e.trimmedLength), true)
    assert.equal(isNativeElfPin(role, e.sha256, e.trimmedLength), false); assert.equal(isNativeElfPin(role, e.trimmedSha256, e.length), false)
  }
  assert.equal(isNativeElfPin('gate', NATIVE_ELF.launch.sha256, NATIVE_ELF.launch.length), false)
  assert.deepEqual(Object.keys(NATIVE_IDL_SHA256).sort(), ['launch', 'swap'])
  // A ProgramData holds the trimmed ELF then zeros; anything else (the old build, a short account, a non-zero tail) differs.
  const header = Buffer.alloc(45); header.writeUInt32LE(3)
  assert.equal(nativeProgramDataMatches('launch', Buffer.concat([header, Buffer.alloc(NATIVE_ELF.launch.trimmedLength)])), false)
  assert.equal(nativeProgramDataMatches('launch', header), false)
  assert.equal(nativeProgramDataMatches('gate', header), false)
})
