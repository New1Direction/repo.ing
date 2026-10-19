// The open compiler against the final open-creation build (hook-lab feat/open-creation 36dd07e): its pinned IDL and the
// live vector of a real create_launch_open_v1 the program executed. The instruction data re-encodes byte for byte, the
// control hash follows from the governance commitment, the 40 accounts and their flags come out exactly as the
// program's own builder made them, and the Config bytes 186..204 parse as the owner's menus. No RPC; no ELF needed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { PublicKey } from '@solana/web3.js'
import { loadOpenArtifacts, OPEN_ELF, OPEN_IDL_SHA256, OPEN_SOURCE, NATIVE_ELF, NATIVE_BUILDS, nativeBuildOf } from '../src/hooklab-native-pins.mjs'
import { OPEN_LAUNCH_DISCRIMINATOR, openLaunchAccounts } from '../src/hooklab-max-wallet-launch.mjs'
import { parseLaunchConfigReserved } from '../src/hooklab-launch-config-reserved.mjs'
import { nativeProductionArtifacts } from '../src/hooklab-production-native-bundle.mjs'
import { productionProfileJson } from '../src/hooklab-production-operator-bundle.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest()
const mainnet = JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json', import.meta.url)))

test('the open-creation pins: only the launch program changed; swap, gate and token are e357fdf\'s', () => {
  assert.equal(OPEN_SOURCE.commit, '36dd07e881c7eb39000b92d4c2699997d3a24e33')
  assert.deepEqual(OPEN_ELF.launch, { length: 824544, sha256: '44cbcbf2cb5192ec05f88a6b267263d1b4e8f77c7a159d103ffe216cd2952650',
    trimmedLength: 824529, trimmedSha256: '673d3e3e2657baf4ffdb386d9eeb92e18c7f7328e868df9e61adbf09a0b782ab' })
  assert.equal(OPEN_ELF.swap, NATIVE_ELF.swap); assert.equal(OPEN_IDL_SHA256.swap, NATIVE_BUILDS.e357fdf.idlSha256.swap)
  const { idls } = loadOpenArtifacts(), names = list => list.map(x => x.name)
  for (const name of ['create_launch_open_v1', 'governed_set_open_creation', 'create_launch_custom_v4']) assert.ok(names(idls.launch.instructions).includes(name), name)
  for (const name of ['OpenCreationSet', 'OpenLaunchCreated']) assert.ok(names(idls.launch.events).includes(name), name)
  assert.deepEqual([6120, 6121, 6122, 6123, 6124].map(code => idls.launch.errors.find(e => e.code === code)?.name),
    ['OpenCreationOff', 'OpenChoiceNotOffered', 'OpenConfigNotCreators', 'OpenMenuInvalid', 'OpenCreationUnchanged'])
  // Each bundle names one build: open IDL with open launch ELF, never mixed.
  const open = nativeProductionArtifacts(undefined, { build: 'open-36dd07e' }), e357 = nativeProductionArtifacts()
  assert.equal(nativeBuildOf(open.base, open.elfLengths), 'open-36dd07e'); assert.equal(nativeBuildOf(e357.base, e357.elfLengths), 'e357fdf')
  assert.equal(nativeBuildOf({ ...open.base, idlSha256: e357.base.idlSha256 }, open.elfLengths), null)
})

test('the live create_launch_open_v1: data, control hash, menus and all 40 accounts reproduce exactly', () => {
  const { live, coders } = loadOpenArtifacts(), data = Buffer.from(live.createLaunchOpenV1Data, 'hex')
  // The data: the IDL's own instruction, and v4's argument encoding under the open discriminator (the compiler's way).
  const decoded = coders.launch.instruction.decode(data)
  assert.equal(decoded.name, 'create_launch_open_v1'); assert.deepEqual(data.subarray(0, 8), OPEN_LAUNCH_DISCRIMINATOR)
  const asV4 = coders.launch.instruction.encode('create_launch_custom_v4', decoded.data); OPEN_LAUNCH_DISCRIMINATOR.copy(asV4, 0)
  assert.ok(asV4.equals(data), 'v4 encoding + open discriminator is the program\'s exact data')
  assert.equal(Buffer.from(decoded.data.expected_control_hash).toString('hex'), live.openControlHash)
  assert.equal(Buffer.from(decoded.data.expected_hook_accounts_hash).toString('hex'), live.hookAccountsHash)
  assert.equal(decoded.data.args.virtual_quote.toString(), String(live.virtualQuote)); assert.equal(decoded.data.args.creator_fee_bps, live.creatorFeeBps)
  // expected_control_hash = sha256("hook-lab:open-creation-controls:v1" || launch program || governance commitment)
  assert.equal(sha(Buffer.concat([Buffer.from('hook-lab:open-creation-controls:v1'), new PublicKey(live.launchProgram).toBuffer(), Buffer.from(live.governanceCommitment, 'hex')])).toString('hex'), live.openControlHash)
  // Config bytes 186..204: native on, open on, the owner's menus.
  const reserved = Buffer.alloc(64); Buffer.from(live.configBytes186to204, 'hex').copy(reserved)
  assert.deepEqual(parseLaunchConfigReserved(reserved), { native: true, open: true, creatorFeeBps: [50, 100, 200], capBps: [100, 200, 300, 500] })
  // The 40 accounts: the mainnet launch Config (its treasury and LP fee) with those reserved bytes, the vector's identities.
  const config = Buffer.from(mainnet.accounts['launch-config'].dataBase64, 'base64'); reserved.copy(config, 186)
  const artifacts = nativeProductionArtifacts(undefined, { build: 'open-36dd07e' })
  const envelope = { json: productionProfileJson(artifacts.base), idls: Object.fromEntries(Object.entries(artifacts.idls).map(([role, bytes]) => [role, bytes.toString('base64')])), elfLengths: artifacts.elfLengths }
  const accounts = openLaunchAccounts(envelope, { creator: live.creator, mint: live.mint, selectedConfig: live.selectedConfig }, config)
  assert.deepEqual(accounts.map(a => [a.address, a.signer, a.writable]), live.accounts.map(a => [a.pubkey, a.signer, a.writable]))
  assert.equal(accounts.filter(a => a.signer).length, 2, 'creator and mint only')
})
