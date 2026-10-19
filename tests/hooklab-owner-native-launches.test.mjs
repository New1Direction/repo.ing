// native-launches --to on|off: reads launch Config byte 186 first (review I-2), refuses a no-op flip and an unupgraded
// launch program, and compiles (never signs or sends) governed_set_native_launches against the full launch governance
// commitment, previewing the byte change and the revision bump. Scripted readers over the observed public mainnet
// accounts; the compile cases also need the reviewed native launch ELF (HOOKLAB_NATIVE_ELF_DIR).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PublicKey } from '@solana/web3.js'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { loadConfig, assertExecutable, APPROVAL_FLAG_STAGES, STAGE_DECISIONS } from '../src/hooklab-owner-driver/config.mjs'
import { STAGES, STAGE_ORDER } from '../src/hooklab-owner-driver/context.mjs'
import { describe } from '../src/hooklab-owner-driver/plan.mjs'
import { decodeMessage, addressBook, plain, renderPreview } from '../src/hooklab-owner-driver/preview.mjs'
import { parseArgs } from '../src/hooklab-owner-driver/cli.mjs'
import * as ix from '../src/hooklab-owner-driver/instructions.mjs'
import { nextState } from '../src/hooklab-owner-driver/stages/common.mjs'
import { LOADER, MAINNET_GENESIS, MAINNET_ROLES, PROGRAMS, QUOTE_MINT, SYSTEM, derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'
import { NATIVE_ELF } from '../src/hooklab-native-pins.mjs'
import { nativeLaunchesDigest } from '../src/hooklab-native-launch.mjs'
import { missingArtifactEnv, testRequiring } from './fixtures/hooklab-generated-artifact.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json', import.meta.url)))
const { coders } = loadArtifacts(), d = derivedAddresses()
const liveConfig = Buffer.from(fixture.accounts['launch-config'].dataBase64, 'base64'), liveGovernance = Buffer.from(fixture.accounts['creation-control'].dataBase64, 'base64')
const governance = coders.launch.accounts.decode('Governance', liveGovernance)
const switched = (value, at = 186) => { const b = Buffer.from(liveConfig); b[at] = value; return b }
const programData = elf => { const header = Buffer.alloc(45); header.writeUInt32LE(3); header.writeBigUInt64LE(458000000n, 4); header[12] = 1; new PublicKey(MAINNET_ROLES.upgrade).toBuffer().copy(header, 13); return Buffer.concat([header, elf, Buffer.alloc(64)]) }
const nativeElf = (name = 'bordrless_launch') => readFileSync(path.join(process.env.HOOKLAB_NATIVE_ELF_DIR, `${name}.so`))
const nativeElfs = () => ({ launchElf: nativeElf(), swapElf: nativeElf('bordrless_swap') })

function readers(accounts, slot = fixture.slot) {
  const connection = {
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot }, value: keys.map(k => { const a = accounts.get(k.toBase58())
      return a ? { owner: new PublicKey(a.owner), executable: false, lamports: a.lamports ?? 1_000_000, data: a.data } : null }) }),
    getLatestBlockhashAndContext: async () => ({ context: { slot }, value: { blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', lastValidBlockHeight: 1_150 } }),
    isBlockhashValid: async () => ({ context: { slot }, value: true }), getBlockHeight: async () => 1_000, getSlot: async () => slot,
  }
  return [{ provider: 'primary', url: 'https://a.example', connection }, { provider: 'secondary', url: 'https://b.example', connection }]
}
const chain = ({ config = liveConfig, governanceBytes = liveGovernance, launchElf = Buffer.alloc(1000, 7), swapElf = Buffer.alloc(1000, 8) } = {}) => new Map([
  [d.launchConfig, { owner: PROGRAMS.launch, data: config }], [d.launchGovernance, { owner: PROGRAMS.launch, data: governanceBytes }],
  [d.launchProgramData, { owner: LOADER, data: programData(launchElf) }], [d.swapProgramData, { owner: LOADER, data: programData(swapElf) }],
  [MAINNET_ROLES.payer, { owner: SYSTEM, data: Buffer.alloc(0), lamports: 4_251_200_000 }]])
const template = loadConfig(new URL('../hooklab-owner.config.json', import.meta.url))
const journal = { dir: path.join(mkdtempSync(path.join(tmpdir(), 'hooklab-native-launches-')), 'journal') }
const context = (accounts, to = 'on') => ({ config: template, readers: readers(accounts), genesis: MAINNET_GENESIS, network: 'mainnet-beta', roles: MAINNET_ROLES,
  programs: PROGRAMS, quoteMint: QUOTE_MINT, envelope: { expectedSha256: 'aa'.repeat(32) }, journal, options: { to } })
after(() => rmSync(path.dirname(journal.dir), { recursive: true, force: true }))
const stage = STAGES['native-launches']

test('needs --to on or off, and reads byte 186 before anything else', async () => {
  for (const to of [undefined, 'yes', 'true']) await assert.rejects(stage.build({ ...context(chain()), options: { to } }, null), /requires --to on or --to off/)
  await assert.rejects(stage.build(context(chain({ config: switched(2) })), null), /byte 186 is 2, not 0 or 1/)
  await assert.rejects(stage.build(context(chain({ config: switched(1, 200) })), null), /reserved bytes after the switch are not a state the reviewed programs write/)
})

test('a flip to the value the switch already has is refused, since it would still stale every signed launch', async () => {
  const off = await stage.build(context(chain(), 'off'), null)
  assert.match(off.blocked, /native launches are already OFF \(launch Config byte 186 = 0\)\. Refusing a flip to the same value: it would still bump the launch governance revision/)
  assert.equal(off.review, undefined)
  const on = await stage.build(context(chain({ config: switched(1) }), 'on'), null)
  assert.match(on.blocked, /already ON \(launch Config byte 186 = 1\)/)
  assert.match(renderPreview(describe(context(chain(), 'off'), 'native-launches', off)), /BLOCKED: native launches are already OFF/)
})

test('refuses while the deployed launch program is not the reviewed native build', async () => {
  const built = await stage.build(context(chain()), null)
  assert.match(built.blocked, /deployed launch program is not the reviewed native-SOL build \(hook-lab e357fdf, ELF acbd9a6060fb…\); upgrade it first/)
  const missing = chain(); missing.delete(d.launchProgramData)
  assert.match((await stage.build(context(missing), null)).blocked, /upgrade it first/)
})

test('registered as an approval-flag stage the committed template does not approve, with --to on the command line', () => {
  assert.ok(STAGE_ORDER.includes('native-launches')); assert.deepEqual(STAGE_DECISIONS['native-launches'], ['computeUnitPriceMicroLamports'])
  assert.ok(APPROVAL_FLAG_STAGES.has('native-launches')); assert.throws(() => assertExecutable(template, 'native-launches'), /not approved/)
  const args = parseArgs(['plan', 'native-launches', '--to', 'on']); assert.equal(args.stage, 'native-launches'); assert.equal(args.to, 'on')
  assert.throws(() => parseArgs(['plan', 'native-launches', '--to']), /incomplete/)
})

const withElf = testRequiring(missingArtifactEnv(['HOOKLAB_NATIVE_ELF_DIR'], 'the reviewed native launch ELF (hook-lab e357fdf)'))
withElf('on the native build: one governed_set_native_launches against the live commitment; preview shows the byte and the revision', async () => {
  const elf = nativeElf(); assert.equal(elf.length, NATIVE_ELF.launch.length)
  assert.match((await stage.build(context(chain({ launchElf: elf })), null)).blocked, /deployed swap program is not the reviewed native-SOL build \(hook-lab e357fdf, ELF 85e178c3730f…\)/, 'the swap is upgraded too')
  for (const [to, config, from, next] of [['on', liveConfig, 0, 1], ['off', switched(1), 1, 0]]) {
    const ctx = context(chain({ config, ...nativeElfs() }), to), built = await stage.build(ctx, null)
    assert.equal(built.blocked, undefined, built.blocked)
    const [limit, price, call] = decodeMessage(built.review.messageBase64, { programs: PROGRAMS, book: addressBook({ programs: PROGRAMS, quoteMint: QUOTE_MINT, roles: MAINNET_ROLES }) })
    assert.deepEqual([limit.instruction, price.instruction, call.instruction], ['SetComputeUnitLimit', 'SetComputeUnitPrice', 'launch.governed_set_native_launches'])
    assert.deepEqual(call.args, { expected: plain(ix.governanceCommitment('launch', governance.state)), on: to === 'on' }, 'the full live commitment and the switch')
    assert.deepEqual(call.accounts.map(a => [a.name, a.label, a.signer, a.writable]).slice(0, 3), [['authority', 'admin', true, false], ['config', 'launchConfig', false, true], ['governance', 'launchGovernance', false, true]])
    assert.deepEqual(built.review.requiredSigners, [MAINNET_ROLES.payer, MAINNET_ROLES.admin])
    const afterState = nextState(governance.state, {})
    assert.deepEqual(built.expect, { on: to === 'on', commitment: plain(ix.governanceCommitment('launch', afterState)) })
    const text = renderPreview(describe(ctx, 'native-launches', built))
    for (const line of [new RegExp(`byte 186: ${from} -> ${next} \\(native launches ${from ? 'ON' : 'OFF'} -> ${next ? 'ON' : 'OFF'}\\)`), /revision\s+0 -> 1/,
      /execute requires  --message-sha256 [0-9a-f]{64} --approved native-launches:/, /config account bytes change only at offset 186/,
      new RegExp(`recorded policy change digest ${nativeLaunchesDigest(PROGRAMS.launch, d.launchConfig, to === 'on').toString('hex')}`),
      /any launch reviewed or co-signed before this lands fails on chain \(CreationPolicyChanged/, /refresh: production bundle launch-config pin/,
      /no SOL or token transfer besides the network fee/, to === 'on' ? /website release that keeps working with this byte on must be live: launch preparation, native launches and trading \(swap_v2\) with HOOK_NATIVE_LAUNCHES_ENABLED=true/ : /claim their fees/,
      to === 'on' ? /owner agent is the native-aware build/ : /native coins already launched keep trading/]) assert.match(text, line)
  }
})

withElf('verify accepts only the switched byte and the predicted commitment', async () => {
  const built = await stage.build(context(chain(nativeElfs())), null)
  const encoded = await coders.launch.accounts.encode('Governance', { ...governance, state: nextState(governance.state, {}) })
  const governed = Buffer.concat([encoded, Buffer.alloc(liveGovernance.length - encoded.length)])
  assert.match((await stage.verify(context(chain({ config: switched(1), governanceBytes: governed })), built.expect)).join(' '), /native launches ON/)
  await assert.rejects(stage.verify(context(chain({ governanceBytes: governed })), built.expect), /byte 186 differs from the reviewed post-state/)
  await assert.rejects(stage.verify(context(chain({ config: switched(1) })), built.expect), /commitment differs/)
})
