// The reviewed native-SOL builds of the swap and launch programs, vendored for the website: every file is checked
// against its pin, the IDLs name the production programs and the native instructions, and errors decode per program.
import test from 'node:test'
import assert from 'node:assert/strict'
import { NATIVE_ELF, NATIVE_FLAGS, NATIVE_SOURCE, loadNativeArtifacts, nativeErrorName } from '../src/hooklab-native-pins.mjs'
import { PROGRAMS } from '../src/hooklab-owner-driver/pins.mjs'

test('vendored native IDLs load only with their reviewed bytes and name the production programs', () => {
  const { idls, coders, vectors } = loadNativeArtifacts()
  assert.equal(idls.swap.address, PROGRAMS.swap); assert.equal(idls.launch.address, PROGRAMS.launch)
  const names = list => list.map(x => x.name)
  for (const name of ['swap', 'swap_v2', 'create_pool_v4', 'collect_protocol_fees_sol']) assert.ok(names(idls.swap.instructions).includes(name), name)
  for (const name of ['graduate', 'create_launch_custom_v4', 'governed_set_native_launches', 'claim_creator_fees_sol']) assert.ok(names(idls.launch.instructions).includes(name), name)
  for (const name of ['Swapped', 'SwappedNative']) assert.ok(names(idls.swap.events).includes(name), name)
  for (const name of ['CreatorFeesClaimedSol', 'NativeLaunchesSet', 'NativeLaunchCreated']) assert.ok(names(idls.launch.events).includes(name), name)
  assert.ok(coders.swap && coders.launch)
  assert.equal(vectors.schema, 'hook-lab/native-sol-v4/vectors/1')
  assert.equal(NATIVE_SOURCE.commit, 'e357fdf')
})

test('the reviewed ELFs and the flag bytes the native code reads are pinned exactly', () => {
  assert.deepEqual(NATIVE_ELF.swap, { length: 613136, sha256: '35e231338971fa71b9ca0717f2476e0a4be2ea0e2ee844ca5b0553a66c2b4ab8',
    trimmedLength: 613121, trimmedSha256: '85e178c3730fabf54031df220af65cc14e9bfd2b85566368152727cf381db438' })
  assert.deepEqual(NATIVE_ELF.launch, { length: 798576, sha256: '7c5d880f55106e5e9318a90c013f7b9aa8a9e23c0c5abec57f618bbe83fd9121',
    trimmedLength: 798561, trimmedSha256: 'acbd9a6060fb2a86e93b54a2c637dca2d9a59dfca770edf2857e662213d48547' })
  assert.deepEqual(NATIVE_FLAGS, { pool: 351, poolWithoutHook: 319, launch: 560, launchWithoutHook: 528, configNativeLaunches: 186 })
})

test('errors decode by program and code: the same name has a different number in each program', () => {
  assert.equal(nativeErrorName(PROGRAMS.swap, 6110), 'NotNativePool'); assert.equal(nativeErrorName(PROGRAMS.launch, 6103), 'NativeLaunchesOff')
  assert.equal(nativeErrorName(PROGRAMS.launch, 6106), 'QuoteFormMismatch'); assert.equal(nativeErrorName(PROGRAMS.swap, 6113), 'QuoteFormMismatch')
  assert.equal(nativeErrorName(PROGRAMS.swap, 6106), null, 'a launch code read as a swap code is unknown, never mislabelled')
  assert.equal(nativeErrorName(PROGRAMS.token, 6110), null)
})
