// launch-usd-bounds: compiles (never signs or sends) the governed_set_config that widens the launch virtual-quote
// bounds to [5.625, 112.5] SOL, from the observed public mainnet launch config. Scripted readers; no RPC or keys.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { loadArtifacts } from '../src/hooklab-owner-driver/artifacts.mjs'
import { loadConfig, assertExecutable, APPROVAL_FLAG_STAGES, STAGE_DECISIONS } from '../src/hooklab-owner-driver/config.mjs'
import { STAGES, STAGE_ORDER } from '../src/hooklab-owner-driver/context.mjs'
import { describe } from '../src/hooklab-owner-driver/plan.mjs'
import { decodeMessage, addressBook, plain, renderPreview } from '../src/hooklab-owner-driver/preview.mjs'
import { parseArgs } from '../src/hooklab-owner-driver/cli.mjs'
import * as ix from '../src/hooklab-owner-driver/instructions.mjs'
import { nextState } from '../src/hooklab-owner-driver/stages/common.mjs'
import { boundByteOffsets } from '../src/hooklab-owner-driver/stages/launch-bounds.mjs'
import { MAINNET_GENESIS, MAINNET_ROLES, PROGRAMS, QUOTE_MINT, SYSTEM, derivedAddresses } from '../src/hooklab-owner-driver/pins.mjs'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/hooklab-mainnet-public-accounts.json', import.meta.url)))
const { coders } = loadArtifacts(), d = derivedAddresses(PROGRAMS, QUOTE_MINT)
const liveConfig = Buffer.from(fixture.accounts['launch-config'].dataBase64, 'base64'), liveGovernance = Buffer.from(fixture.accounts['creation-control'].dataBase64, 'base64')
const config = coders.launch.accounts.decode('Config', liveConfig), governance = coders.launch.accounts.decode('Governance', liveGovernance)
const MIN = '5625000000', MAX = '112500000000'
const withBounds = (raw, min, max) => Buffer.concat([raw.subarray(0, 8), coders.launch.types.encode('Config', { ...coders.launch.accounts.decode('Config', raw), min_virtual_quote: new BN(min), max_virtual_quote: new BN(max) })])

// Two providers agreeing on the same finalized state.
function readers(accounts, slot = fixture.slot) {
  const connection = {
    getMultipleAccountsInfoAndContext: async keys => ({ context: { slot }, value: keys.map(k => { const a = accounts.get(k.toBase58())
      return a ? { owner: new PublicKey(a.owner), executable: false, lamports: a.lamports ?? 1_000_000, data: a.data } : null }) }),
    getLatestBlockhashAndContext: async () => ({ context: { slot }, value: { blockhash: '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi', lastValidBlockHeight: 1_150 } }),
    isBlockhashValid: async () => ({ context: { slot }, value: true }), getBlockHeight: async () => 1_000, getSlot: async () => slot,
  }
  return [{ provider: 'primary', url: 'https://a.example', connection }, { provider: 'secondary', url: 'https://b.example', connection }]
}
const chain = (configBytes = liveConfig, governanceBytes = liveGovernance) => new Map([
  [d.launchConfig, { owner: PROGRAMS.launch, data: configBytes }], [d.launchGovernance, { owner: PROGRAMS.launch, data: governanceBytes }],
  [MAINNET_ROLES.payer, { owner: SYSTEM, data: Buffer.alloc(0), lamports: 4_251_200_000 }]])
const template = loadConfig(new URL('../hooklab-owner.config.json', import.meta.url))
// The plan's address book looks for a canary lookup-table record beside the journal; an empty directory has none.
const journal = { dir: path.join(mkdtempSync(path.join(tmpdir(), 'hooklab-usd-bounds-')), 'journal') }
const context = accounts => ({ config: template, readers: readers(accounts), genesis: MAINNET_GENESIS, network: 'mainnet-beta', roles: MAINNET_ROLES,
  programs: PROGRAMS, quoteMint: QUOTE_MINT, envelope: { expectedSha256: 'aa'.repeat(32) }, journal })
after(() => rmSync(path.dirname(journal.dir), { recursive: true, force: true }))
const stage = STAGES['launch-usd-bounds']

test('compiles one governed_set_config that changes only the two virtual-quote bounds', async () => {
  const ctx = context(chain()), built = await stage.build(ctx, null)
  const [budgetLimit, budgetPrice, call] = decodeMessage(built.review.messageBase64, { programs: PROGRAMS, book: addressBook({ programs: PROGRAMS, quoteMint: QUOTE_MINT, roles: MAINNET_ROLES }) })
  assert.deepEqual([budgetLimit.instruction, budgetPrice.instruction, call.instruction], ['SetComputeUnitLimit', 'SetComputeUnitPrice', 'launch.governed_set_config'])
  const before = plain(ix.launchConfigArgs(config))
  assert.deepEqual(call.args.args, { ...before, min_virtual_quote: MIN, max_virtual_quote: MAX }, 'every other ConfigArgs field is the live value')
  assert.equal(call.args.expected, plain(ix.governanceCommitment('launch', governance.state)), 'expects the live governance commitment')
  assert.deepEqual(call.accounts.map(a => [a.name, a.label, a.signer, a.writable]), [['authority', 'admin', true, false], ['config', 'launchConfig', false, true], ['governance', 'launchGovernance', false, true]])
  assert.deepEqual(built.review.requiredSigners, [MAINNET_ROLES.payer, MAINNET_ROLES.admin])

  const after = { ...ix.launchConfigArgs(config), min_virtual_quote: new BN(MIN), max_virtual_quote: new BN(MAX) }
  const afterState = nextState(governance.state, { config_digest: [...ix.economicsDigest('launch', PROGRAMS.launch, after)], roles: { treasury: after.treasury } })
  assert.deepEqual(built.expect, { role: 'launch', config: plain(after), commitment: plain(ix.governanceCommitment('launch', afterState)) })

  const text = renderPreview(describe(ctx, 'launch-usd-bounds', built))
  for (const line of [/min_virtual_quote: "1000000000" -> "5625000000" \(1 SOL -> 5\.625 SOL: the opening quote when SOL is \$1,000\)/,
    /max_virtual_quote: "1000000000" -> "112500000000" \(1 SOL -> 112\.5 SOL: the opening quote when SOL is \$50\)/,
    /config account bytes change only at offsets 139-154/, /unchanged: admin, treasury, quote_mint, launch_fee_lamports/,
    /execute requires  --message-sha256 [0-9a-f]{64} --approved launch-usd-bounds:/, /revision\s+0 -> 1/,
    /refresh: launch governance commitment/, /refresh: launch guard expected_launch_economics_hash/, /refresh: production bundle/,
    /HOOK_LAUNCH_USD_PRICING=true/, /no SOL or token transfer besides the network fee/]) assert.match(text, line)
})

test('the bound fields are exactly bytes 139-154 of the config account', () => {
  assert.deepEqual(boundByteOffsets(coders.launch, config), Array.from({ length: 16 }, (_, i) => 139 + i))
  const moved = withBounds(liveConfig, MIN, MAX)
  assert.deepEqual([...moved.keys()].filter(i => moved[i] !== liveConfig[i]).every(i => i >= 139 && i <= 154), true)
})

test('already-applied bounds plan nothing; a live config another stage changed refuses to guess', async () => {
  const applied = await stage.build(context(chain(withBounds(liveConfig, MIN, MAX))), null)
  assert.match(applied.blocked, /already applied/); assert.equal(applied.review, undefined)
  const half = await stage.build(context(chain(withBounds(liveConfig, MIN, '1000000000'))), null)
  assert.match(renderPreview(describe(context(chain()), 'launch-usd-bounds', half)), /max_virtual_quote: "1000000000" -> "112500000000"/)
  assert.doesNotMatch(renderPreview(describe(context(chain()), 'launch-usd-bounds', half)), /min_virtual_quote:/, 'only the field that differs is listed')
})

test('verify accepts only the reviewed bounds and the predicted governance commitment', async () => {
  const built = await stage.build(context(chain()), null)
  const after = { ...ix.launchConfigArgs(config), min_virtual_quote: new BN(MIN), max_virtual_quote: new BN(MAX) }
  const state = nextState(governance.state, { config_digest: [...ix.economicsDigest('launch', PROGRAMS.launch, after)], roles: { treasury: after.treasury } })
  const encoded = await coders.launch.accounts.encode('Governance', { ...governance, state })
  const governed = Buffer.concat([encoded, Buffer.alloc(liveGovernance.length - encoded.length)])
  assert.match((await stage.verify(context(chain(withBounds(liveConfig, MIN, MAX), governed)), built.expect)).join(' '), /matches reviewed values/)
  await assert.rejects(stage.verify(context(chain(withBounds(liveConfig, MIN, '112500000001'), governed)), built.expect), /differs from the reviewed values/)
  await assert.rejects(stage.verify(context(chain(withBounds(liveConfig, MIN, MAX))), built.expect), /commitment differs/)
})

test('registered as an approval-flag stage that the committed template does not approve', () => {
  assert.ok(STAGE_ORDER.includes('launch-usd-bounds')); assert.equal(parseArgs(['plan', 'launch-usd-bounds']).stage, 'launch-usd-bounds')
  assert.ok(APPROVAL_FLAG_STAGES.has('launch-usd-bounds')); assert.deepEqual(STAGE_DECISIONS['launch-usd-bounds'], ['computeUnitPriceMicroLamports'])
  assert.throws(() => assertExecutable(template, 'launch-usd-bounds'), /not approved/)
})
